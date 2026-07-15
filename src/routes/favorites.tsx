import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { EventCard } from "@/components/event-card";
import { Heart } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { DiscoveredEvent } from "@/lib/queries";

export const Route = createFileRoute("/favorites")({
  head: () => ({ meta: [{ title: "Mes favoris — EVENTA" }] }),
  component: Favorites,
});

function Favorites() {
  const [events, setEvents] = useState<DiscoveredEvent[] | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setSignedIn(false);
        return;
      }
      setSignedIn(true);
      const { data: favs } = await supabase
        .from("favorites")
        .select("event_id")
        .eq("user_id", user.id);
      const ids = (favs ?? []).map((f) => f.event_id);
      if (!ids.length) {
        setEvents([]);
        return;
      }
      const { data: evs } = await supabase
        .from("events")
        .select(
          "id,slug,title,short_description,cover_image_url,is_free,is_verified,is_demo,status, category:event_categories(slug), venue:venues(name, city:cities(name,timezone)), occurrences:event_occurrences(id,starts_at,ends_at,timezone)",
        )
        .in("id", ids);
      const mapped: DiscoveredEvent[] = (evs ?? []).flatMap((e): DiscoveredEvent[] => {
        const occ = (e.occurrences ?? [])[0];
        if (!occ) return [];
        return [
          {
            event_id: e.id,
            occurrence_id: occ.id,
            slug: e.slug,
            title: e.title,
            short_description: e.short_description,
            cover_image_url: e.cover_image_url,
            category_slug: e.category?.slug ?? null,
            starts_at: occ.starts_at,
            ends_at: occ.ends_at,
            timezone: occ.timezone,
            venue_name: e.venue?.name ?? null,
            city_name: e.venue?.city?.name ?? null,
            is_free: e.is_free,
            is_verified: e.is_verified,
            is_demo: e.is_demo,
            status: e.status,
            distance_km: null,
            venue_id: null,
            genres: [],
            price_from: null,
            price_to: null,
            has_tickets: false,
            capacity: null,
            wheelchair: false,
            location_precision: "venue",
          },
        ];
      });
      setEvents(mapped);
    })();
  }, []);

  if (signedIn === false) {
    return (
      <div className="mx-auto max-w-md px-4 pt-16 text-center">
        <Heart className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
        <h1 className="text-2xl font-bold">Tes favoris</h1>
        <p className="mt-2 text-muted-foreground">
          Connecte-toi pour enregistrer tes événements préférés.
        </p>
        <Link
          to="/auth"
          className="btn-glow mt-6 inline-flex rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground"
        >
          Se connecter
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 pt-8 md:px-6">
      <h1 className="mb-6 text-3xl font-bold">Favoris</h1>
      {!events ? (
        <p className="text-muted-foreground">Chargement…</p>
      ) : events.length === 0 ? (
        <p className="text-muted-foreground">Aucun favori pour l'instant.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {events.map((e) => (
            <EventCard key={e.event_id} ev={e} />
          ))}
        </div>
      )}
    </div>
  );
}
