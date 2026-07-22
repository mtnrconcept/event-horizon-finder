import { useQuery } from "@tanstack/react-query";
import { BrainCircuit, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { EventCard } from "@/components/event-card";
import { getPersonalizedEvents } from "@/lib/personalized-discovery";
import { useTranslation } from "@/lib/i18n";

export function PersonalizedEventRail() {
  const { tr } = useTranslation();
  const recommendations = useQuery({
    queryKey: ["personalized-event-recommendations"],
    queryFn: () => getPersonalizedEvents(8),
    staleTime: 5 * 60_000,
  });
  if (!recommendations.data?.length) return null;

  return (
    <section className="my-7 rounded-[2rem] border border-primary/20 bg-primary/5 p-4 md:p-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-xs font-black uppercase tracking-wider text-primary">
            <BrainCircuit className="h-4 w-4" /> {tr("Boussole IA")}
          </p>
          <h2 className="mt-1 text-2xl font-black">{tr("Rien que pour toi")}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {tr(
              "Tes réponses, favoris et recherches consenties deviennent des idées de sortie explicables — jamais une boîte noire.",
            )}
          </p>
        </div>
        <Link
          to="/profile"
          className="inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-bold"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" /> {tr("Ajuster mes goûts")}
        </Link>
      </div>
      <div className="no-scrollbar grid auto-cols-[min(82vw,280px)] grid-flow-col gap-3 overflow-x-auto pb-2 md:auto-cols-[300px]">
        {recommendations.data.map((event) => (
          <div key={event.occurrence_id} className="relative pt-7">
            <div className="absolute left-2 top-0 z-20 flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-[10px] font-bold text-primary-foreground">
              <span>{tr("{score}% compatible", { score: event.matchScore })}</span>
              <span aria-hidden>·</span>
              <span className="truncate">{event.matchReasons[0]}</span>
            </div>
            <EventCard ev={event} variant="compact" />
          </div>
        ))}
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" />{" "}
        {tr("Tu contrôles tes préférences et peux supprimer ton historique depuis ton profil.")}
      </p>
    </section>
  );
}
