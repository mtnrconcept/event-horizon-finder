import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDays, LoaderCircle, Ticket } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useTranslation } from "@/lib/i18n";

interface PlaceUpcomingEvent {
  occurrence_id: string;
  event_id: string;
  slug: string;
  title: string;
  short_description: string | null;
  cover_image_url: string | null;
  is_free: boolean;
  starts_at: string;
  ends_at: string | null;
  timezone: string;
  category_slug: string | null;
  category_name: string | null;
  venue_name: string | null;
  ticket_url: string | null;
}

interface PlaceUpcomingEventBatch {
  items: PlaceUpcomingEvent[];
  totalCount: number;
  hasMore: boolean;
}

const PAGE_SIZE = 24;

function isPlaceUpcomingEvent(value: unknown): value is PlaceUpcomingEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PlaceUpcomingEvent>;
  return (
    typeof candidate.occurrence_id === "string" &&
    typeof candidate.event_id === "string" &&
    typeof candidate.slug === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.starts_at === "string"
  );
}

function parseBatch(value: unknown): PlaceUpcomingEventBatch {
  const payload = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const items = Array.isArray(payload.items) ? payload.items.filter(isPlaceUpcomingEvent) : [];
  const totalCount = Number(payload.total_count ?? items.length);
  return {
    items,
    totalCount: Number.isFinite(totalCount) ? Math.max(0, Math.round(totalCount)) : items.length,
    hasMore: payload.has_more === true,
  };
}

export function PlaceUpcomingEventsTab({ placeId }: { placeId: string }) {
  const { t, tr, localeTag } = useTranslation();
  const [batch, setBatch] = useState<PlaceUpcomingEventBatch>({
    items: [],
    totalCount: 0,
    hasMore: false,
  });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersionRef = useRef(0);

  const load = useCallback(
    async (offset: number, append: boolean) => {
      const requestVersion = ++requestVersionRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);

      try {
        // Generated database types may lag one additive RPC migration.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error: requestError } = await (supabase as any).rpc(
          "get_place_upcoming_events_v1",
          {
            _place_id: placeId,
            _limit: PAGE_SIZE,
            _offset: offset,
          },
        );
        if (requestError) throw requestError;
        if (requestVersion !== requestVersionRef.current) return;

        const next = parseBatch(data);
        setBatch((current) => {
          if (!append) return next;
          const merged = [...current.items, ...next.items];
          const unique = [
            ...new Map(merged.map((event) => [event.occurrence_id, event] as const)).values(),
          ];
          return {
            items: unique,
            totalCount: next.totalCount,
            hasMore: next.hasMore && unique.length < next.totalCount,
          };
        });
      } catch {
        if (requestVersion !== requestVersionRef.current) return;
        setError(tr("Impossible de charger les prochains événements de ce lieu."));
      } finally {
        if (requestVersion === requestVersionRef.current) {
          if (append) setLoadingMore(false);
          else setLoading(false);
        }
      }
    },
    [placeId, tr],
  );

  useEffect(() => {
    setBatch({ items: [], totalCount: 0, hasMore: false });
    void load(0, false);
    return () => {
      requestVersionRef.current += 1;
    };
  }, [load]);

  if (loading) {
    return (
      <div className="grid min-h-52 place-items-center rounded-2xl border bg-muted/30 p-6">
        <div className="text-center text-sm text-muted-foreground">
          <LoaderCircle className="mx-auto mb-3 h-7 w-7 animate-spin text-primary" />
          {tr("Chargement des prochains événements…")}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm"
      >
        <p>{error}</p>
        <Button
          type="button"
          variant="outline"
          className="mt-3 min-h-11"
          onClick={() => void load(0, false)}
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  if (!batch.items.length) {
    return (
      <div className="grid min-h-52 place-items-center rounded-2xl border border-dashed p-6 text-center">
        <div>
          <CalendarDays className="mx-auto mb-3 h-8 w-8 text-primary" />
          <p className="font-black">{tr("Aucun événement à venir pour le moment")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {tr("La fiche sera actualisée automatiquement dès qu’une nouvelle date sera publiée.")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-black">
            {tr("{count} événement(s) à venir", { count: batch.totalCount })}
          </p>
          <p className="text-xs text-muted-foreground">
            {tr("Dates reliées directement à la fiche de ce lieu")}
          </p>
        </div>
        <CalendarDays className="h-5 w-5 shrink-0 text-primary" />
      </div>

      <div className="grid gap-3">
        {batch.items.map((event) => (
          <article
            key={event.occurrence_id}
            className="overflow-hidden rounded-2xl border bg-background"
            style={{ contentVisibility: "auto", containIntrinsicSize: "0 132px" }}
          >
            <div className="flex min-h-28 gap-3 p-3">
              {event.cover_image_url && (
                <img
                  src={event.cover_image_url}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  className="h-24 w-24 shrink-0 rounded-xl object-cover"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap gap-1.5">
                  {event.category_name && <Badge variant="outline">{event.category_name}</Badge>}
                  {event.is_free && <Badge>{t("common.free")}</Badge>}
                </div>
                <h3 className="mt-2 line-clamp-2 font-black leading-tight">{event.title}</h3>
                <time
                  dateTime={event.starts_at}
                  className="mt-1 block text-xs font-bold text-primary"
                >
                  {new Intl.DateTimeFormat(localeTag, {
                    dateStyle: "full",
                    timeStyle: "short",
                    timeZone: event.timezone || undefined,
                  }).format(new Date(event.starts_at))}
                </time>
                {event.short_description && (
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {event.short_description}
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
              <Button asChild size="sm" className="min-h-10">
                <Link to="/event/$slug" params={{ slug: event.slug }}>
                  {tr("Voir l’événement")}
                </Link>
              </Button>
              {event.ticket_url && (
                <a
                  href={event.ticket_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border px-3 text-xs font-black text-primary"
                >
                  <Ticket className="h-3.5 w-3.5" /> {tr("Réserver")}
                </a>
              )}
            </div>
          </article>
        ))}
      </div>

      {batch.hasMore && (
        <Button
          type="button"
          variant="outline"
          className="mt-4 min-h-11 w-full"
          disabled={loadingMore}
          onClick={() => void load(batch.items.length, true)}
        >
          {loadingMore ? t("common.loading") : tr("Afficher plus d’événements")}
        </Button>
      )}
    </div>
  );
}
