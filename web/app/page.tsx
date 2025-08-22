// web/app/page.tsx
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

// ----- logging helpers -----
const t0 = performance.now();
const ts = () => (performance.now() - t0).toFixed(1).padStart(7, " ");
const RS = (ws?: WebSocket | null) =>
  !ws
    ? "n/a"
    : ws.readyState === WebSocket.CONNECTING
    ? "CONNECTING"
    : ws.readyState === WebSocket.OPEN
    ? "OPEN"
    : ws.readyState === WebSocket.CLOSING
    ? "CLOSING"
    : ws.readyState === WebSocket.CLOSED
    ? "CLOSED"
    : String(ws.readyState);

function log(...args: any[]) {
  console.log(`[${ts()}]`, ...args);
}
function warn(...args: any[]) {
  console.warn(`[${ts()}]`, ...args);
}
function err(...args: any[]) {
  console.error(`[${ts()}]`, ...args);
}

// Compute WS base at runtime (works locally and on Render)
function getWSBase(): string {
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const base = `${proto}://${window.location.host}/web-demo/ws`;
  log("[getWSBase]", { proto, host: window.location.host, base });
  return base;
}

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
    const s0 = input[idx] ?? input[input.length - 1] ?? 0;
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
  const streamRef = useRef<MediaStream | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // Global error visibility
  useEffect(() => {
    const onrej = (e: PromiseRejectionEvent) => {
      err("[unhandledrejection]", e.reason);
      addMsg("System", `UnhandledRejection: ${String(e.reason)}`);
    };
    const onerr = (ev: ErrorEvent) => {
      err("[window.onerror]", ev.message, ev.error);
      addMsg("System", `Error: ${ev.message}`);
    };
    window.addEventListener("unhandledrejection", onrej);
    window.addEventListener("error", onerr);
    return () => {
      window.removeEventListener("unhandledrejection", onrej);
      window.removeEventListener("error", onerr);
    };
  }, []);

  useEffect(() => () => stopDemo(), []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcript.length, partialAgent, partialUser]);

  const addMsg = (role: Msg["role"], text: string) =>
    setTranscript((prev) => [...prev, { role, text, id: crypto.randomUUID() }]);

  async function ensureAudioContext() {
    if (audioCtxRef.current) return audioCtxRef.current;
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) {
      err("[ensureAudioContext] No AudioContext available");
      addMsg("System", "No AudioContext available in this browser.");
      throw new Error("No AudioContext");
    }
    const ctx: AudioContext = new Ctx();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
        log("[ensureAudioContext] resumed");
      } catch (e) {
        warn("[ensureAudioContext] resume failed", e);
      }
    }
    log("[ensureAudioContext] created", { sampleRate: ctx.sampleRate, state: ctx.state });
    audioCtxRef.current = ctx;
    return ctx;
  }

  async function preflightWorklet(url: string) {
    try {
      const r = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
      log("[worklet fetch]", url, "→", r.status);
      if (!r.ok) addMsg("System", `Failed to fetch ${url}: ${r.status}`);
    } catch (e) {
      err("[worklet fetch error]", url, e);
      addMsg("System", `Fetch error for ${url}: ${String(e)}`);
    }
  }

  async function loadWorklets(ctx: AudioContext) {
    const mods = ["/worklets/pcm-processor.js", "/worklets/pcm-player.js"];
    for (const m of mods) await preflightWorklet(m);
    for (const m of mods) {
      try {
        await ctx.audioWorklet.addModule(m);
        log("[audioWorklet.addModule] ok", m);
      } catch (e) {
        err("[audioWorklet.addModule] fail", m, e);
        addMsg("System", `AudioWorklet addModule failed for ${m}`);
        throw e;
      }
    }
  }

  async function getMic() {
    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      log("[getUserMedia] granted", constraints);
      return stream;
    } catch (e: any) {
      err("[getUserMedia] denied", e?.name || e, e);
      addMsg("System", `Mic permission error: ${e?.name || String(e)}`);
      throw e;
    }
  }

  async function startDemo() {
    setTranscript([]);
    setPartialAgent("");
    setPartialUser("");
    setStatus("connecting");

    // Smoke-test basic WS endpoints to isolate proxy issues
    await wsSmokeTest();

    try {
      const ctx = await ensureAudioContext();
      log("[startDemo] AudioContext", { rate: ctx.sampleRate, state: ctx.state });

      await loadWorklets(ctx);

      const stream = await getMic();
      const srcNode = ctx.createMediaStreamSource(stream);
      sourceRef.current = srcNode;

      // Player worklet (Float32 at ctx rate)
      const player = new AudioWorkletNode(ctx, "pcm-player");
      player.connect(ctx.destination);
      playerWorkletRef.current = player;
      log("[player] ready");

      // Mic worklet (outputs PCM16 16k 20ms frames via port)
      const micNode = new AudioWorkletNode(ctx, "pcm-processor");
      micWorkletRef.current = micNode;
      const silence = ctx.createGain();
      silence.gain.value = 0;
      micNode.connect(silence).connect(ctx.destination);

      // Build WS URL
      const base = getWSBase();
      const wsUrl = `${base}?voiceId=${selected}`;
      log("[web-demo] opening WS", wsUrl);

      // Construct WS
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (e) {
        err("[web-demo] new WebSocket threw", e);
        addMsg("System", `WebSocket ctor error: ${String(e)}`);
        setStatus("stopped");
        return;
      }

      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      // ReadyState logger (poller) for extra visibility
      let rsPoll: number | undefined;
      const startRSPoll = () => {
        stopRSPoll();
        rsPoll = window.setInterval(() => {
          if (!wsRef.current) return;
          log("[ws readyState]", RS(wsRef.current));
          if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CLOSED) {
            stopRSPoll();
          }
        }, 500);
      };
      const stopRSPoll = () => {
        if (rsPoll) {
          clearInterval(rsPoll);
          rsPoll = undefined;
        }
      };
      startRSPoll();

      ws.onopen = () => {
        log("[web-demo] ws open", { url: wsUrl });
        addMsg("System", `WebSocket open: ${wsUrl}`);
        setStatus("live");
      };

      ws.onclose = (ev) => {
        warn("[web-demo] ws close", { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
        addMsg("System", `WS close code=${ev.code} reason="${ev.reason || "(none)"}" clean=${ev.wasClean}`);
        setStatus("stopped");
      };

      ws.onerror = (ev) => {
        // Browsers hide details by design; still log the event object
        err("[web-demo] ws error event", ev);
        addMsg("System", "WebSocket error (see console for details).");
        setStatus("stopped");
      };

      ws.onmessage = async (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          // Agent TTS PCM16 @16k -> Float32 -> resample -> play
          const pcm16 = new Int16Array(ev.data);
          log("[audio<-ws] tts frame bytes", pcm16.byteLength);
          const f16 = new Float32Array(pcm16.length);
          for (let i = 0; i < pcm16.length; i++) f16[i] = Math.max(-1, Math.min(1, pcm16[i] / 0x8000));
          const out = resampleFloat(f16, 16000, audioCtxRef.current!.sampleRate);
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
            log("[status]", payload.text);
            addMsg("System", payload.text);
            return;
          }

          if (payload.type === "settings") {
            const s = `Settings: STT=${payload.sttModel}, TTS=${payload.ttsVoice}, LLM=${payload.llmModel} (T=${payload.temperature}). Greeting="${payload.greeting}". Prompt chars=${payload.prompt_len}.`;
            log("[settings]", s);
            addMsg("System", s);
            return;
          }
        } catch (e) {
          warn("[ws onmessage] non-JSON text?", e, ev.data);
        }
      };

      // Mic → WS frames (delegated by worklet)
      micNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        const buf = e.data;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(buf);
        } else {
          // Helpful when the socket never opens
          warn("[audio->ws] dropping frame; ws state:", RS(ws));
        }
      };

      srcNode.connect(micNode);
      log("[graph] mic -> worklet -> (silence)");

      // Resume audio on tab focus if needed
      document.addEventListener(
        "visibilitychange",
        async () => {
          if (document.visibilityState === "visible" && audioCtxRef.current?.state === "suspended") {
            try {
              await audioCtxRef.current.resume();
              log("[visibility] resumed AudioContext");
            } catch (e) {
              warn("[visibility] resume failed", e);
            }
          }
        },
        { passive: true }
      );
    } catch (e) {
      err("[startDemo] failed", e);
      addMsg("System", `Start failed: ${String(e)}`);
      setStatus("stopped");
    }
  }

  function stopDemo() {
    log("[stopDemo] begin");
    try {
      if (wsRef.current) {
        log("[stopDemo] closing ws", RS(wsRef.current));
        try {
          wsRef.current.close();
        } catch {}
      }
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
      streamRef.current?.getTracks()?.forEach((t) => t.stop());
    } catch {}
    try {
      audioCtxRef.current?.close();
    } catch {}
    micWorkletRef.current = null;
    playerWorkletRef.current = null;
    sourceRef.current = null;
    streamRef.current = null;
    audioCtxRef.current = null;

    setStatus("stopped");
    log("[stopDemo] done");
  }

  // Quick WS smoke test to isolate proxy issues (runs each Start)
  async function wsSmokeTest() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const base = `${proto}://${location.host}`;
    const tryOpen = (path: string, label: string) =>
      new Promise<void>((resolve) => {
        try {
          const w = new WebSocket(base + path);
          let done = false;
          const finish = (ok: boolean, extra?: any) => {
            if (done) return;
            done = true;
            if (ok) log(`[smoke] ${label} OPEN ok`);
            else warn(`[smoke] ${label} FAILED`, extra);
            try {
              w.close();
            } catch {}
            resolve();
          };
          w.onopen = () => finish(true);
          w.onerror = (ev) => finish(false, ev);
          // give it 2s
          setTimeout(() => finish(false, "timeout"), 2000);
        } catch (e) {
          warn(`[smoke] ${label} ctor threw`, e);
          resolve();
        }
      });

    log("[smoke] begin", { base });
    await tryOpen("/ws-echo", "ws-echo");
    await tryOpen("/ws-ping", "ws-ping");
    // Don't attempt /web-demo/ws here (it may consume resources); the main Start flow will.
    log("[smoke] end");
  }

  return (
    <main className="min-h-screen w-full px-4 py-10">
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
