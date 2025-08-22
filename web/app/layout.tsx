import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Intake Demo",
  description: "Deterministic, on-rails intake with barge-in.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-black text-white">{children}</body>
    </html>
  );
}
