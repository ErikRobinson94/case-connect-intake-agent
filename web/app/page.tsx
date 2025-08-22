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

      // keep mic graph connected but silent
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
    <main className="min-h-screen w-full px-4 py-10 bg-black text-white">
      <div className="mx-auto w-full max-w-7xl grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* LEFT */}
        <section className="lg:col-span-8">
          <div className="w-full max-w-[520px] lg:max-w-none rounded-3xl bg-zinc-950/80 border border-zinc-800 p-6 shadow-xl mx-auto">
            <div className="flex items-center gap-3 justify-center">
              <svg width="34" height="34" viewBox="0 0 24 24" className="text-teal-400">
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M16 8a6 6 0 1 0 0 8" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
              <div className="text-xl font-semibold tracking-wide">
                <span className="text-teal-400">CASE</span> <span className="text-white">CONNECT</span>
              </div>
            </div>

            <h1 className="mt-6 text-center text-2xl font-bold text-amber-400">
              Demo our <span className="font-extrabold">AI</span> intake experience
            </h1>
            <p className="mt-2 text-center text-sm text-neutral-300">
              Speak with our virtual assistant and experience a legal intake done right.
            </p>

            <div className="mt-5 flex justify-center">
              <button
                type="button"
                className="rounded-full bg-amber-500 hover:bg-amber-400 text-black font-medium px-6 py-3 transition"
                onClick={startDemo}
              >
                Speak with AI Assistant
              </button>
            </div>

            <div className="my-6 h-px w-full bg-zinc-800" />

            <p className="text-center font-medium text-white">Choose a voice to sample</p>
            <div className="mt-4 grid grid-cols-3 gap-3">
              {VOICES.map((v) => {
                const isSel = selected === v.id;
                return (
                  <button
                    key={v.id}
                    onClick={() => setSelected(v.id)}
                    className={[
                      "group rounded-2xl border bg-zinc-900 p-2 transition",
                      isSel ? "border-amber-500 ring-2 ring-amber-500/30" : "border-zinc-800",
                    ].join(" ")}
                    aria-pressed={isSel}
                    title={v.name}
                  >
                    <div className="relative w-full h-[180px] rounded-xl overflow-hidden bg-black">
                      <Image
                        src={v.src}
                        alt={v.name}
                        fill
                        sizes="(max-width: 768px) 100vw, 33vw"
                        className={["object-contain transition-transform duration-200", v.scale ?? ""].join(" ")}
                        priority={isSel}
                        unoptimized
                      />
                    </div>
                    <div className="mt-2 text-center text-xs font-medium">
                      <span className={isSel ? "text-amber-400" : "text-neutral-300"}>{v.name}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* RIGHT */}
        <aside className="lg:col-span-4">
          <div className="rounded-3xl bg-zinc-950/80 border border-zinc-800 shadow-xl h-full flex flex-col">
            <header className="px-5 py-4 border-b border-zinc-800">
              <h2 className="text-white font-semibold">Conversation</h2>
              <p className="text-xs text-neutral-400">
                {status === "live" ? "Connected." : status === "connecting" ? "Connecting…" : "Live transcript."}
              </p>
            </header>

            {/* Scrollable transcript */}
            <div className="flex-1 px-5 pt-4 space-y-3 overflow-y-auto" style={{ minHeight: 260 }}>
              {transcript.map((m) => (
                <div
                  key={m.id}
                  className={[
                    "rounded-2xl px-3 py-2 text-sm w-fit max-w-[90%]",
                    m.role === "Agent"
                      ? "bg-zinc-800/60 text-white"
                      : m.role === "User"
                      ? "bg-amber-500/90 text-black ml-auto"
                      : "bg-zinc-700/40 text-neutral-200 mx-auto",
                  ].join(" ")}
                >
                  <span className="font-medium">{m.role}:</span> {m.text}
                </div>
              ))}

              {/* live partials */}
              {partialAgent && (
                <div className="rounded-2xl px-3 py-2 text-sm w-fit max-w-[90%] bg-zinc-800/40 text-white italic">
                  <span className="font-medium">Agent:</span> {partialAgent}
                </div>
              )}
              {partialUser && (
                <div className="rounded-2xl px-3 py-2 text-sm w-fit max-w-[90%] bg-amber-400/70 text-black ml-auto italic">
                  <span className="font-medium">User:</span> {partialUser}
                </div>
              )}

              <div ref={endRef} />
            </div>

            {/* Footer controls */}
            <div className="px-5 pb-4 mt-2 border-t border-zinc-800">
              <div className="flex gap-2">
                <button
                  className="w-full rounded-full px-5 py-3 bg-amber-500 text-black text-sm font-medium hover:bg-amber-400 transition"
                  onClick={startDemo}
                >
                  Start
                </button>
                <button
                  className="rounded-full px-5 py-3 border border-zinc-700 text-sm hover:bg-zinc-800 transition"
                  onClick={stopDemo}
                >
                  Stop
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
