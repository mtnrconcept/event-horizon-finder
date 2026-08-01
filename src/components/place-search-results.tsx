import { Landmark, LoaderCircle } from "lucide-react";
import { PlaceCard } from "@/components/place-card";
import { Button } from "@/components/ui/button";
import type { PlaceOfInterest } from "@/lib/place-discovery";
import { useTranslation } from "@/lib/i18n";

function PlaceCardSkeleton({ compact }: { compact: boolean }) {
  return (
    <div
      className={`animate-pulse overflow-hidden rounded-3xl border bg-surface ${
        compact ? "grid grid-cols-[6.75rem_minmax(0,1fr)]" : "grid sm:grid-cols-[10rem_minmax(0,1fr)]"
      }`}
    >
      <div className={compact ? "min-h-36 bg-muted" : "min-h-44 bg-muted"} />
      <div className="space-y-3 p-4">
        <div className="h-4 w-24 rounded bg-muted" />
        <div className="h-5 w-4/5 rounded bg-muted" />
        <div className="h-3 w-full rounded bg-muted" />
        <div className="h-3 w-2/3 rounded bg-muted" />
      </div>
    </div>
  );
}

export function PlaceSearchResults({
  places,
  totalCount,
  loading,
  loadingMore,
  error,
  hasMore,
  onRetry,
  onLoadMore,
  onSelect,
  compact = true,
  showEmpty = true,
  maximumVisible,
}: {
  places: PlaceOfInterest[];
  totalCount: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
  onSelect: (place: PlaceOfInterest) => void;
  compact?: boolean;
  showEmpty?: boolean;
  maximumVisible?: number;
}) {
  const { tr, formatNumber } = useTranslation();
  const visiblePlaces = maximumVisible ? places.slice(0, maximumVisible) : places;

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-primary">
            {tr("Lieux à visiter")}
          </p>
          <h2 className={compact ? "text-base font-black" : "text-xl font-black"}>
            {tr("{count} lieux", { count: loading && !places.length ? "…" : formatNumber(totalCount) })}
          </h2>
        </div>
        {places.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            {tr("{count} affichés", { count: formatNumber(visiblePlaces.length) })}
          </span>
        )}
      </div>

      {error && (
        <div className="flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 p-3 text-xs text-destructive">
          <span>{error}</span>
          <button type="button" className="min-h-11 shrink-0 font-black underline" onClick={onRetry}>
            {tr("Réessayer")}
          </button>
        </div>
      )}

      {loading && places.length === 0 ? (
        <div className="grid gap-3">
          {Array.from({ length: compact ? 3 : 4 }, (_, index) => (
            <PlaceCardSkeleton key={index} compact={compact} />
          ))}
        </div>
      ) : visiblePlaces.length > 0 ? (
        <div className="grid gap-3">
          {visiblePlaces.map((place, index) => (
            <div
              key={place.id}
              style={{ contentVisibility: "auto", containIntrinsicSize: compact ? "0 144px" : "0 176px" }}
            >
              <PlaceCard
                place={place}
                compact={compact}
                imagePriority={index < 2}
                onSelect={onSelect}
              />
            </div>
          ))}
        </div>
      ) : showEmpty && !error ? (
        <div className="rounded-3xl border p-6 text-center">
          <Landmark className="mx-auto mb-3 h-7 w-7 text-primary" />
          <p className="font-bold">{tr("Aucun lieu d’intérêt trouvé")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {tr("Déplace ou dézoome la carte, ou modifie les filtres.")}
          </p>
        </div>
      ) : null}

      {hasMore && !maximumVisible && (
        <Button
          type="button"
          variant="outline"
          className="min-h-12 w-full rounded-2xl"
          disabled={loading || loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore && <LoaderCircle className="h-4 w-4 animate-spin" />}
          {loadingMore ? tr("Chargement…") : tr("Afficher plus de lieux")}
        </Button>
      )}
    </section>
  );
}
