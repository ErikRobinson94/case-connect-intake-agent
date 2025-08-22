// web/components/VoiceCard.tsx
"use client";
import Image from "next/image";
import clsx from "clsx";

type Props = {
  src: string;          // e.g., "/images/voice-m1.png"
  label: string;        // "Voice 1"
  selected?: boolean;   // highlights when true
  onSelect?: () => void;
};

export default function VoiceCard({
  src,
  label,
  selected = false,
  onSelect,
}: Props) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={clsx(
        "relative w-full max-w-[220px] rounded-2xl bg-[#0f151b] p-4 ring-1 ring-white/5",
        "transition hover:scale-[1.02] hover:ring-white/15 focus:outline-none focus:ring-2 focus:ring-halo/60",
        selected && "ring-halo/60 shadow-glow"
      )}
    >
      <span className="sr-only">{label}</span>

      <div className="relative mx-auto mb-3 aspect-square w-40 overflow-hidden rounded-full ring-2 ring-halo/60 halo">
        <Image
          src={src}
          alt=""
          fill
          sizes="160px"
          className="object-cover"
          priority
        />
      </div>

      <div className="text-center text-lg font-semibold text-sand">{label}</div>

      {selected && (
        <div
          className="pointer-events-none absolute right-3 top-3 h-6 w-6 rounded-full bg-accent/90 text-black"
          aria-hidden="true"
          title="Selected"
        >
          <svg viewBox="0 0 24 24" className="m-[3px] h-4 w-4" aria-hidden="true">
            <path
              fill="currentColor"
              d="M9.2 16.2 4.8 11.8l1.4-1.4 3 3 7.6-7.6 1.4 1.4z"
            />
          </svg>
        </div>
      )}
    </button>
  );
}
