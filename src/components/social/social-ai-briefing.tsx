import { useMemo, useState } from "react";
import { BrainCircuit, ChevronDown, Sparkles, WandSparkles } from "lucide-react";
import { buildFeedBriefing, type FeedIntent } from "@/lib/feed-intelligence";
import type { SocialPost } from "@/lib/social-queries";
import { useTranslation } from "@/lib/i18n";

const intents: Array<{ value: FeedIntent; label: string }> = [
  { value: "all", label: "Tout voir" },
  { value: "tonight", label: "Ce soir" },
  { value: "free", label: "Plans gratuits" },
  { value: "nearby", label: "Autour de moi" },
  { value: "popular", label: "Ça buzz" },
];

export function SocialAiBriefing({
  posts,
  intent,
  onIntentChange,
}: {
  posts: SocialPost[];
  intent: FeedIntent;
  onIntentChange: (intent: FeedIntent) => void;
}) {
  const { tr } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const briefing = useMemo(() => buildFeedBriefing(posts), [posts]);

  return (
    <section
      className="relative mb-4 overflow-hidden rounded-3xl border border-primary/25 bg-[linear-gradient(135deg,oklch(0.25_0.08_295_/_0.85),oklch(0.17_0.035_265_/_0.95))] p-4 shadow-[0_18px_55px_oklch(0.1_0.08_295_/_0.35)]"
      aria-label={tr("Briefing IA du fil")}
    >
      <div className="pointer-events-none absolute -right-8 -top-12 h-36 w-36 rounded-full bg-primary/20 blur-3xl" />
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="relative flex w-full items-center gap-3 text-left"
        aria-expanded={expanded}
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-glow">
          <BrainCircuit className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm font-black">
            <Sparkles className="h-3.5 w-3.5 text-secondary" /> {tr("Pulse IA")}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {tr("Ton radar intelligent, actualisé avec le fil")}
          </span>
        </span>
        <ChevronDown className={`h-5 w-5 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && (
        <div className="relative mt-4">
          <p className="text-sm leading-relaxed">
            {briefing.postCount
              ? tr("{count} nouveautés analysées · {free} plans gratuits · {comments} réactions.", {
                  count: briefing.postCount,
                  free: briefing.freeCount,
                  comments: briefing.conversationCount,
                })
              : tr("Le briefing apparaîtra dès les premières publications.")}
            {briefing.topPlace
              ? ` ${tr("Le signal monte à {place}.", { place: briefing.topPlace })}`
              : ""}
            {briefing.topTopic
              ? ` ${tr("Tendance : #{topic}.", { topic: briefing.topTopic })}`
              : ""}
          </p>
          <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto pb-1">
            {intents.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => onIntentChange(item.value)}
                aria-pressed={intent === item.value}
                className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-bold transition ${intent === item.value ? "border-primary bg-primary text-primary-foreground" : "border-white/10 bg-background/35 hover:border-primary/50"}`}
              >
                <WandSparkles className="h-3.5 w-3.5" />
                {tr(item.label)}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">
            {tr("Analyse privée sur cet appareil · aucun contenu envoyé à un service tiers")}
          </p>
        </div>
      )}
    </section>
  );
}
