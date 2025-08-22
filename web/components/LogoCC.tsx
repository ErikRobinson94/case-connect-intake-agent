// web/components/LogoCC.tsx
import React from "react";

type Props = {
  className?: string;
  /** If true, stacks the wordmark under the icon (nice for narrow layouts). */
  stacked?: boolean;
};

export default function LogoCC({ className = "", stacked = false }: Props) {
  return (
    <div className={className}>
      <div className={stacked ? "flex flex-col items-start gap-3" : "flex items-center gap-3"}>
        {/* Monogram icon with halo ring */}
        <svg
          width="44"
          height="44"
          viewBox="0 0 100 100"
          role="img"
          aria-label="Case Connect logo"
          className="rounded-full halo"
        >
          {/* Outer glow ring */}
          <circle cx="50" cy="50" r="46" fill="none" stroke="#2AE1D6" strokeWidth="6" />
          {/* Inner ring */}
          <circle cx="50" cy="50" r="26" fill="none" stroke="#2AE1D6" strokeWidth="6" />
          {/* Small node dot */}
          <circle cx="50" cy="20" r="4" fill="#2AE1D6" />
          {/* CC letters */}
          <text
            x="32"
            y="60"
            fontFamily="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto"
            fontSize="30"
            fontWeight="800"
            fill="#2AE1D6"
          >
            CC
          </text>
        </svg>

        {/* Wordmark */}
        <div className={stacked ? "leading-none" : "leading-none"}>
          <div className="text-2xl font-extrabold tracking-wide text-accent">CASE</div>
          <div className="text-sm font-extrabold tracking-[0.2em] text-accent/90">CONNECT</div>
        </div>
      </div>
    </div>
  );
}
