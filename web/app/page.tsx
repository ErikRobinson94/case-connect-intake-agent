"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";

type Voice = { id: number; name: string; src: string; scale?: string };
type Msg = { role: "User" | "Agent" | "System"; text: string; id: string };
type Payload =
  | { type: "transcript"; role: "User" | "Agent"; text: string; partial?: boolean }
  | { type: "status"; text: string }
  | {
      type: "settings";
      sttModel: string;
      ttsVoice: string;
      llmModel: string;
      temperature: number;
      greeting: string;
      prompt_len: number;
    };

const VOICES: Voice[] = [
  { id: 1, name: "Voice 1", src: "/images/voice-m1.png", scale: "scale-[1.12]" },
  { id: 2, name: "Voice 2", src: "/images/voice-f1.png" },
  { id: 3, name: "Voice 3", src: "/images/voice-m2.png" },
];

// resample 16k -> ctx rate
function resampleFloat(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input;
  const outLen = Math.floor((input.length * outRate) / inRate);
  const out = new Float32Array(outLen);
  const step = inRate / outRate;
  let pos = 0;
  for (let i = 0; i < outLen; i++) {
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = input[idx] ?? input[input.length - 1];
    const s1 = input[idx + 1] ?? s0;
    out[i] = s0 + (s1 - s0) * frac;
    pos += step;
  }
  return out;
}

export default function Home() {
  const [selected, setSelected] = useState<number>(2);
  const [transcript, setTranscript] = useState<Msg[]>([]);
  const [partialAgent, setPartialAgent] = useState("");
  const [partialUser, setPartialUser] = useState("");
  const [status, setStatus] = useState<"idle" | "connecting" | "live" | "stopped">("idle");

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micWorkletRef = useRef<AudioWorkletNode | null>(null);
  const playerWorkletRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => () => stopDemo(), []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcript.length, partialAgent, partialUser]);

  const addMsg = (role: Msg["role"], text: string) =>
    setTranscript((prev) => [...prev, { role, text, id: crypto.randomUUID() }]);

  async function ensureAudioContext() {
    if (audioCtxRef.current) return audioCtxRef.current;
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ctx: AudioContext = new Ctx();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {}
    }
    audioCtxRef.current = ctx;
    return ctx;
  }

  async function startDemo() {
    try {
      setTranscript([]);
      setPartialAgent("");
      setPartialUser("");
      setStatus("connecting");

      // Build WS URL (env override if provided; otherwise same-origin)
      const base =
        process.env.NEXT_PUBLIC_WS_BASE ||
        `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/web-demo/ws`;
      const wsUrl = `${base}?voiceId=${selected}`;

      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("live");
        addMsg("System", `Initializing… chosen avatar voiceId=${selected}`);
      };
      ws.onclose = () => setStatus("stopped");
      ws.onerror = () => setStatus("stopped");

      ws.onmessage = async (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          // Agent TTS PCM16 @16k -> Float32 -> resample -> play
          const pcm16 = new Int16Array(ev.data);
          const f16 = new Float32Array(pcm16.length);
          for (let i = 0; i < pcm16.length; i++) f16[i] = Math.max(-1, Math.min(1, pcm16[i] / 0x8000));
          const ctx = await ensureAudioContext();
          const out = resampleFloat(f16, 16000, ctx.sampleRate);
          playerWorkletRef.current?.port.postMessage(out.buffer, [out.buffer]);
          return;
        }

        try {
          const payload: Payload = JSON.parse(ev.data as string);

          if (payload.type === "transcript") {
            const { role, text, partial } = payload;
            if (partial) {
              if (role === "Agent") setPartialAgent(text);
              else setPartialUser(text);
            } else {
              if (role === "Agent") setPartialAgent("");
              else setPartialUser("");
              addMsg(role, text);
            }
            return;
          }

          if (payload.type === "status") {
            addMsg("System", payload.text);
            return;
          }

          if (payload.type === "settings") {
            addMsg(
              "System",
              `Settings: STT=${payload.sttModel}, TTS=${payload.ttsVoice}, LLM=${payload.llmModel} (T=${payload.temperature}). Greeting="${payload.greeting}". Prompt chars=${payload.prompt_len}.`
            );
            return;
          }
        } catch {}
      };

      // Audio
      const ctx = await ensureAudioContext();
      await ctx.audioWorklet.addModule("/worklets/pcm-processor.js");
      await ctx.audioWorklet.addModule("/worklets/pcm-player.js");

      const player = new AudioWorkletNode(ctx, "pcm-player");
      player.connect(ctx.destination);
      playerWorkletRef.current = player;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      const srcNode = ctx.createMediaStreamSource(stream);
      sourceRef.current = srcNode;

      const micNode = new AudioWorkletNode(ctx, "pcm-processor"); // emits Int16 @16k, 20ms frames
      micWorkletRef.current = micNode;

      const silence = ctx.createGain();
      silence.gain.value = 0;
      micNode.connect(silence).connect(ctx.destination);

      micNode.port.onmessage = (e) => {
        const arrbuf = e.data as ArrayBuffer;
        if (ws.readyState === WebSocket.OPEN) ws.send(arrbuf);
      };

      srcNode.connect(micNode);
    } catch {
      setStatus("stopped");
    }
  }

  function stopDemo() {
    try {
      wsRef.current?.close();
    } catch {}
    wsRef.current = null;
    try {
      micWorkletRef.current?.port?.close?.();
    } catch {}
    try {
      playerWorkletRef.current?.disconnect();
    } catch {}
    try {
      sourceRef.current?.disconnect();
    } catch {}
    try {
      audioCtxRef.current?.close();
    } catch {}
    micWorkletRef.current = null;
    playerWorkletRef.current = null;
    sourceRef.current = null;
    audioCtxRef.current = null;
    setStatus("stopped");
  }

  return (
    <main className="min-h-screen w-full px-4 py-10">
      {/* ... unchanged UI below ... */}
      {/* Keep your existing JSX from here; omitted for brevity since only WS url changed */}
    </main>
  );
}
