import { supabase } from "@/integrations/supabase/client";

export type QuickRange = "now" | "tonight" | "today" | "tomorrow" | "weekend" | "week";

/**
 * "Ce soir" = nuit événementielle 18h → 6h le lendemain (heure locale de l'utilisateur).
 * Retourne [from, to] en Date UTC.
 */
export function computeRange(range: QuickRange, base: Date = new Date()): { from: Date; to: Date } {
  const b = new Date(base);
  const day = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  switch (range) {
    case "now": {
      const to = new Date(b.getTime() + 2 * 60 * 60 * 1000);
      return { from: b, to };
    }
    case "tonight": {
      // 18h aujourd'hui → 6h demain
      const from = new Date(day);
      from.setHours(18, 0, 0, 0);
      const to = new Date(day);
      to.setDate(to.getDate() + 1);
      to.setHours(6, 0, 0, 0);
      // Si on est déjà passé 6h et avant 18h, "tonight" reste ce soir
      // Si on est après minuit et avant 6h, on affiche encore la nuit en cours
      if (b.getHours() < 6) {
        const yesterday = new Date(day);
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(18, 0, 0, 0);
        return { from: yesterday, to };
      }
      return { from: b > from ? b : from, to };
    }
    case "today": {
      const to = new Date(day);
      to.setDate(to.getDate() + 1);
      return { from: b, to };
    }
    case "tomorrow": {
      const from = new Date(day);
      from.setDate(from.getDate() + 1);
      const to = new Date(from);
      to.setDate(to.getDate() + 1);
      return { from, to };
    }
    case "weekend": {
      // Prochain vendredi 18h → dimanche 23h59
      const dow = b.getDay(); // 0=Sun
      const daysToFri = (5 - dow + 7) % 7;
      const from = new Date(day);
      from.setDate(from.getDate() + daysToFri);
      from.setHours(18, 0, 0, 0);
      const to = new Date(from);
      to.setDate(to.getDate() + 2);
      to.setHours(23, 59, 0, 0);
      return { from, to };
    }
    case "week": {
      const to = new Date(b.getTime() + 7 * 24 * 60 * 60 * 1000);
      return { from: b, to };
    }
  }
}

export interface DiscoverParams {
  lat?: number | null;
  lon?: number | null;
  radiusKm?: number;
  from?: Date;
  to?: Date;
  categorySlugs?: string[] | null;
  cityId?: string | null;
  freeOnly?: boolean;
  query?: string | null;
  limit?: number;
  offset?: number;
}

export interface DiscoveredEvent {
  event_id: string;
  occurrence_id: string;
  slug: string;
  title: string;
  short_description: string | null;
  cover_image_url: string | null;
  category_slug: string | null;
  starts_at: string;
  ends_at: string | null;
  timezone: string;
  venue_name: string | null;
  city_name: string | null;
  is_free: boolean;
  is_verified: boolean;
  is_demo: boolean;
  status: string;
  distance_km: number | null;
  latitude?: number | null;
  longitude?: number | null;
}

export async function discoverEvents(p: DiscoverParams): Promise<DiscoveredEvent[]> {
  const args: Record<string, unknown> = {
    _radius_km: p.radiusKm ?? 25,
    _from: (p.from ?? new Date()).toISOString(),
    _to: (p.to ?? new Date(Date.now() + 30 * 24 * 3600 * 1000)).toISOString(),
    _free_only: p.freeOnly ?? false,
    _limit: p.limit ?? 40,
    _offset: p.offset ?? 0,
  };
  if (p.lat != null) args._lat = p.lat;
  if (p.lon != null) args._lon = p.lon;
  if (p.categorySlugs && p.categorySlugs.length) args._category_slugs = p.categorySlugs;
  if (p.cityId) args._city_id = p.cityId;
  if (p.query && p.query.trim()) args._query = p.query.trim();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await supabase.rpc("discover_events", args as any);
  if (error) throw error;
  return (data ?? []) as DiscoveredEvent[];
}

export async function discoverMapEvents(p: DiscoverParams): Promise<DiscoveredEvent[]> {
  const args: Record<string, unknown> = {
    _radius_km: p.radiusKm ?? 25,
    _from: (p.from ?? new Date()).toISOString(),
    _to: (p.to ?? new Date(Date.now() + 30 * 24 * 3600 * 1000)).toISOString(),
    _free_only: p.freeOnly ?? false,
    _limit: p.limit ?? 500,
    _offset: p.offset ?? 0,
  };
  if (p.lat != null) args._lat = p.lat;
  if (p.lon != null) args._lon = p.lon;
  if (p.categorySlugs && p.categorySlugs.length) args._category_slugs = p.categorySlugs;
  if (p.cityId) args._city_id = p.cityId;
  if (p.query && p.query.trim()) args._query = p.query.trim();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc("discover_map_events", args as any);
  if (error) throw error;
  return (data ?? []) as DiscoveredEvent[];
}

export async function fetchCities() {
  const { data, error } = await supabase
    .from("cities")
    .select("id,slug,name,timezone,latitude,longitude,is_demo")
    .order("name");
  if (error) throw error;
  return data ?? [];
}

export async function fetchCategories() {
  const { data, error } = await supabase.from("event_categories").select("*").order("sort_order");
  if (error) throw error;
  return data ?? [];
}

export async function fetchEventBySlug(slug: string) {
  const { data, error } = await supabase
    .from("events")
    .select(
      `
      *,
      category:event_categories(slug,name_fr,name_en,icon),
      organizer:organizers(id,slug,name,description,website,logo_url,is_verified),
      venue:venues(*, city:cities(slug,name,timezone)),
      occurrences:event_occurrences(*),
      offers:ticket_offers(*),
      media:event_media(*),
      accessibility:event_accessibility(*)
    `,
    )
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  return data;
}
