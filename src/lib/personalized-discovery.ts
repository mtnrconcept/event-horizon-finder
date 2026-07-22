/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { computeRange, discoverEvents, type DiscoveredEvent } from "@/lib/queries";

const db = supabase as unknown as SupabaseClient<any>;

export type PersonalizedEvent = DiscoveredEvent & { matchScore: number; matchReasons: string[] };

export async function recordSearchInterest(query: string): Promise<void> {
  const value = query.trim().toLocaleLowerCase().slice(0, 100);
  if (value.length < 3) return;
  const { data } = await db.auth.getUser();
  if (!data.user) return;
  const { data: profile } = await db
    .from("profiles")
    .select("analytics_consent")
    .eq("id", data.user.id)
    .maybeSingle();
  if (!profile?.analytics_consent) return;
  await db.from("event_interest_signals").insert({
    user_id: data.user.id,
    signal_type: "search",
    value,
    weight: 1,
  });
}

export async function getPersonalizedEvents(limit = 8): Promise<PersonalizedEvent[]> {
  const { data } = await db.auth.getUser();
  if (!data.user) return [];
  const [profileResult, favoritesResult, signalsResult] = await Promise.all([
    db
      .from("profiles")
      .select("music_preferences,event_preferences,home_city_id,preferred_price,discovery_mood")
      .eq("id", data.user.id)
      .maybeSingle(),
    db
      .from("favorites")
      .select("event:events(genres,category:event_categories(slug))")
      .eq("user_id", data.user.id)
      .limit(50),
    db
      .from("event_interest_signals")
      .select("value")
      .eq("user_id", data.user.id)
      .order("created_at", { ascending: false })
      .limit(12),
  ]);
  const profile = profileResult.data;
  if (!profile) return [];
  const favoriteEvents = (favoritesResult.data ?? []).map((row: any) => row.event).filter(Boolean);
  const genres = new Set<string>(profile.music_preferences ?? []);
  const categories = new Set<string>(profile.event_preferences ?? []);
  favoriteEvents.forEach((event: any) => {
    (event.genres ?? []).forEach((genre: string) => genres.add(genre));
    const category = Array.isArray(event.category) ? event.category[0] : event.category;
    if (category?.slug) categories.add(category.slug);
  });
  const searches = (signalsResult.data ?? []).map((row: any) => String(row.value));
  const range = computeRange("year");
  const candidates = await discoverEvents({
    ...range,
    cityId: profile.home_city_id || null,
    freeOnly: profile.preferred_price === "free",
    limit: Math.max(24, limit * 3),
  });

  return candidates
    .map((event) => {
      const genreMatches = event.genres.filter((genre) => genres.has(genre));
      const categoryMatch = Boolean(event.category_slug && categories.has(event.category_slug));
      const haystack = `${event.title} ${event.short_description ?? ""}`.toLocaleLowerCase();
      const searchMatch = searches.find((term) => haystack.includes(term));
      const reasons = [
        genreMatches.length ? `Tes goûts : ${genreMatches.slice(0, 2).join(", ")}` : null,
        categoryMatch ? "Une catégorie que tu apprécies" : null,
        searchMatch ? `Inspiré par ta recherche « ${searchMatch} »` : null,
        event.is_free && profile.preferred_price !== "premium" ? "Dans ton budget" : null,
        event.is_verified ? "Événement vérifié" : null,
      ].filter((reason): reason is string => Boolean(reason));
      const matchScore = Math.min(
        99,
        55 +
          genreMatches.length * 13 +
          Number(categoryMatch) * 16 +
          Number(Boolean(searchMatch)) * 10,
      );
      return {
        ...event,
        matchScore,
        matchReasons: reasons.length ? reasons : ["Populaire près de toi"],
      };
    })
    .sort((a, b) => b.matchScore - a.matchScore || a.starts_at.localeCompare(b.starts_at))
    .slice(0, limit);
}
