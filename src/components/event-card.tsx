import { Link } from "@tanstack/react-router";
import {
  Accessibility,
  BadgeCheck,
  Clock,
  Heart,
  MapPin,
  Sparkles,
  Ticket,
  Users,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { DiscoveredEvent } from "@/lib/queries";
import { Badge } from "@/components/ui/badge";
import { EventArtworkImage } from "@/components/event-artwork-image";
import { toast } from "sonner";
import { GENRE_LABELS } from "@/lib/event-filters";

function formatLocalTime(iso: string, tz: string) {
  try {
    return new Intl.DateTimeFormat("fr-FR", {
      timeZone: tz,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString("fr-FR");
  }
}

const CATEGORY_LABELS: Record<string, string> = {
  concerts: "Concert",
  festivals: "Festival",
  soirees: "Soirée",
  expositions: "Exposition",
  theatre: "Spectacle",
  famille: "Famille",
  "sports-outdoor": "Sport & plein air",
  heritage: "Visites & patrimoine",
  gastronomy: "Gastronomie & marchés",
  activities: "Ateliers & activités",
  conferences: "Conférences & rencontres",
  cinema: "Cinéma & projections",
  leisure: "Jeux & loisirs",
  other: "Autres événements",
};

async function fetchViewerId() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

async function fetchFavoriteEventIds(userId: string) {
  const { data, error } = await supabase.from("favorites").select("event_id").eq("user_id", userId);
  if (error) throw error;
  return (data ?? []).map((row) => row.event_id);
}

export function EventCard({ ev }: { ev: DiscoveredEvent }) {
  const queryClient = useQueryClient();
  const viewer = useQuery({
    queryKey: ["viewer-id"],
    queryFn: fetchViewerId,
    staleTime: 60_000,
  });
  const userId = viewer.data ?? null;
  const favorites = useQuery({
    queryKey: ["favorite-event-ids", userId],
    queryFn: () => fetchFavoriteEventIds(userId!),
    enabled: Boolean(userId),
    staleTime: 30_000,
  });
  const fav = favorites.data?.includes(ev.event_id) ?? false;

  const toggleFav = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!userId) {
      toast.error("Connecte-toi pour enregistrer un événement");
      return;
    }
    if (fav) {
      const { error } = await supabase
        .from("favorites")
        .delete()
        .eq("user_id", userId)
        .eq("event_id", ev.event_id);
      if (error) return toast.error("Impossible de retirer ce favori");
    } else {
      const { error } = await supabase
        .from("favorites")
        .insert({ user_id: userId, event_id: ev.event_id });
      if (error) return toast.error("Impossible d'enregistrer ce favori");
    }
    queryClient.setQueryData<string[]>(["favorite-event-ids", userId], (current = []) =>
      fav ? current.filter((id) => id !== ev.event_id) : [...current, ev.event_id],
    );
  };

  const cancelled = ev.status === "cancelled";
  const priceLabel = ev.is_free
    ? "Gratuit"
    : ev.price_from != null
      ? `Dès ${Number(ev.price_from).toLocaleString("fr-CH")}`
      : ev.has_tickets
        ? "Billets disponibles"
        : null;

  return (
    <article className="glass group relative flex flex-col overflow-hidden rounded-2xl transition-all hover:-translate-y-0.5 hover:shadow-[var(--shadow-card)]">
      <Link
        to="/event/$slug"
        params={{ slug: ev.slug }}
        aria-label={`Ouvrir l'événement ${ev.title}`}
        className="absolute inset-0 z-10 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        <span className="sr-only">Ouvrir l'événement {ev.title}</span>
      </Link>
      <div className="relative aspect-[16/10] overflow-hidden bg-muted">
        <EventArtworkImage
          eventId={ev.event_id}
          sourceUrl={ev.cover_image_url}
          alt={ev.title}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          fallback={
            <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_75%_20%,oklch(0.72_0.18_35_/_0.38),transparent_30%),linear-gradient(135deg,oklch(0.3_0.12_295),oklch(0.16_0.04_265))] text-white">
              <div className="text-center">
                <Sparkles className="mx-auto mb-2 h-8 w-8 opacity-70" />
                <p className="text-3xl font-black">
                  {new Intl.DateTimeFormat("fr-FR", { day: "2-digit" }).format(
                    new Date(ev.starts_at),
                  )}
                </p>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] opacity-75">
                  {new Intl.DateTimeFormat("fr-FR", { month: "short" }).format(
                    new Date(ev.starts_at),
                  )}
                </p>
              </div>
            </div>
          }
        />
        <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
          <div className="flex flex-wrap gap-1.5">
            {ev.is_demo && (
              <Badge
                variant="outline"
                className="border-transparent"
                style={{
                  background: "var(--color-demo)",
                  color: "var(--color-primary-foreground)",
                }}
              >
                Démonstration
              </Badge>
            )}
            {ev.is_free && (
              <Badge
                style={{
                  background: "var(--color-secondary)",
                  color: "var(--color-secondary-foreground)",
                }}
              >
                Gratuit
              </Badge>
            )}
            {cancelled && <Badge variant="destructive">Annulé</Badge>}
          </div>
          <button
            type="button"
            onClick={toggleFav}
            aria-label={fav ? "Retirer des favoris" : "Ajouter aux favoris"}
            className="glass relative z-20 flex h-11 w-11 items-center justify-center rounded-full transition-transform active:scale-90"
          >
            <Heart
              className="h-4 w-4"
              fill={fav ? "currentColor" : "none"}
              style={{ color: fav ? "var(--color-primary)" : "inherit" }}
            />
          </button>
        </div>
        {ev.category_slug && (
          <div className="absolute bottom-3 left-3">
            <Badge
              className="border-transparent"
              style={{ background: "oklch(0 0 0 / 0.55)", color: "white" }}
            >
              {CATEGORY_LABELS[ev.category_slug] ?? ev.category_slug}
            </Badge>
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 text-base font-semibold leading-tight">{ev.title}</h3>
          {ev.is_verified && (
            <BadgeCheck className="h-4 w-4 shrink-0" style={{ color: "var(--color-primary)" }} />
          )}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          <span>{formatLocalTime(ev.starts_at, ev.timezone)}</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MapPin className="h-3.5 w-3.5" />
          <span className="truncate">
            {ev.venue_name ?? "Lieu à confirmer"}
            {ev.city_name ? ` · ${ev.city_name}` : ""}
          </span>
          {ev.distance_km != null && (
            <span className="ml-auto shrink-0 text-[10px]">{ev.distance_km} km</span>
          )}
        </div>
        {(priceLabel || ev.capacity != null || ev.wheelchair) && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-medium text-muted-foreground">
            {priceLabel && (
              <span className="inline-flex items-center gap-1 text-foreground">
                <Ticket className="h-3.5 w-3.5 text-primary" /> {priceLabel}
              </span>
            )}
            {ev.capacity != null && (
              <span className="inline-flex items-center gap-1">
                <Users className="h-3.5 w-3.5" /> {ev.capacity.toLocaleString("fr-CH")} pers.
              </span>
            )}
            {ev.wheelchair && (
              <span className="inline-flex items-center gap-1">
                <Accessibility className="h-3.5 w-3.5" /> PMR
              </span>
            )}
          </div>
        )}
        {ev.genres?.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {ev.genres.slice(0, 3).map((genre) => (
              <span
                key={genre}
                className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium"
              >
                {GENRE_LABELS[genre] ?? genre}
              </span>
            ))}
          </div>
        )}
        {ev.location_precision === "city" && (
          <span className="text-[10px] text-amber-700 dark:text-amber-300">
            Position approximative au niveau de la ville
          </span>
        )}
      </div>
    </article>
  );
}

export function EventCardSkeleton() {
  return (
    <div className="glass overflow-hidden rounded-2xl">
      <div className="aspect-[16/10] animate-pulse bg-muted" />
      <div className="space-y-2 p-4">
        <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}
