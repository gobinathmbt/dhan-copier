import type { IntelV2Snapshot } from "@/lib/intelV2Types";
import { V2Card, V2_TONE } from "./common";

/**
 * AI MARKET STORY — narrator card.
 * ========================================================================
 * Renders the human-readable paragraph synthesised by the backend.
 * Sources: heroZero, frvpInstitutional.engine, atmBlk, marketDirection,
 * verdict, delta, vwap, vp.  All already computed — this card is pure
 * presentation.
 *
 *   Heading  — "🟢 CE Bias" / "🔴 PE Bias" / "🚀 HERO CE — 24000" / "💀 ZERO"
 *   Body     — synthesised paragraph (5–7 sentences)
 *   Bullets  — same lines also rendered as a bullet list for scan-ability
 */
export function MarketStoryCard({ data }: { data: IntelV2Snapshot | null }) {
  const story = data?.dashboard?.marketStory;
  if (!story) {
    return (
      <V2Card title="🧠 AI Market Story">
        <div className="flex h-full items-center justify-center text-[12px] text-white/40">
          Synthesising signals…
        </div>
      </V2Card>
    );
  }
  const t = V2_TONE[story.tone];
  return (
    <V2Card
      title={
        <span className="flex items-center gap-2">
          <span>🧠</span>
          AI Market Story
          <span className="text-[9px] font-normal text-white/45">(Auto-generated narrative)</span>
        </span>
      }
      accent={story.tone}
    >
      <div className="-m-1.5 flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-1.5">
        {/* Headline pill */}
        <div className="flex items-center justify-between">
          <span
            className="rounded-md border px-2.5 py-1 text-[12px] font-bold uppercase tracking-[0.16em]"
            style={{
              background: t.soft,
              borderColor: t.border,
              color: t.color,
            }}
          >
            {story.headline}
          </span>
          <span className="font-mono text-[9px] text-white/45">
            {new Date(story.builtAt).toLocaleTimeString("en-IN", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false,
              timeZone: "Asia/Kolkata",
            })}
          </span>
        </div>

        {/* Paragraph — long-form narrator */}
        <p
          className="rounded-md border px-3 py-2 text-[12px] leading-relaxed"
          style={{
            background: "rgba(255,255,255,0.02)",
            borderColor: "rgba(255,255,255,0.06)",
            color: "rgba(255,255,255,0.85)",
          }}
        >
          {story.paragraph}
        </p>

        {/* Bullet list — same lines, scannable */}
        <ul className="flex flex-col gap-1 text-[11px] leading-tight text-white/70">
          {story.lines.map((line, i) => (
            <li key={i} className="flex items-start gap-1.5">
              <span className="mt-0.5 shrink-0" style={{ color: t.color }}>
                ▸
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>
    </V2Card>
  );
}
