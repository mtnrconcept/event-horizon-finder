export type EventInsight = {
  event_id: string;
  title: string;
  short_description?: string | null;
  genres?: string[] | null;
  city_id?: string | null;
  cover_image_url?: string | null;
  official_url?: string | null;
  view_count?: number | string | null;
  like_count?: number | string | null;
  comment_count?: number | string | null;
};

export type AdDraft = {
  name: string;
  objective: "awareness" | "engagement" | "event_visits" | "ticket_sales";
  promotedEventId: string;
  headline: string;
  body: string;
  imageUrl: string;
  ctaUrl: string;
  genres: string[];
  cityIds: string[];
  rationale: string;
};

export function fallbackDraft(event: EventInsight): AdDraft {
  return {
    name: `Promotion — ${event.title}`,
    objective: "event_visits",
    promotedEventId: event.event_id,
    headline: `Ne manque pas ${event.title}`,
    body: event.short_description || `Découvre ${event.title} et réserve ta place dès maintenant.`,
    imageUrl: event.cover_image_url || "",
    ctaUrl: event.official_url || "",
    genres: event.genres || [],
    cityIds: event.city_id ? [event.city_id] : [],
    rationale: `Recommandé d'après ${Number(event.view_count || 0)} vues, ${Number(event.like_count || 0)} likes et ${Number(event.comment_count || 0)} commentaires.`,
  };
}

export function normalizeAdDraft(candidate: unknown, insights: EventInsight[]): AdDraft {
  if (!candidate || typeof candidate !== "object") throw new Error("Réponse IA invalide");
  const value = candidate as Record<string, unknown>;
  const event = insights.find((item) => item.event_id === value.promotedEventId);
  if (!event) throw new Error("L’IA a sélectionné un événement non autorisé");
  const text = (key: string, max: number) => {
    if (typeof value[key] !== "string" || !value[key].trim())
      throw new Error(`Champ IA invalide: ${key}`);
    return value[key].trim().slice(0, max);
  };
  const objectives = ["awareness", "engagement", "event_visits", "ticket_sales"] as const;
  const objective = objectives.find((item) => item === value.objective);
  if (!objective) throw new Error("Objectif IA invalide");
  const requestedGenres = Array.isArray(value.genres)
    ? value.genres.filter((x): x is string => typeof x === "string")
    : [];
  return {
    name: text("name", 120),
    objective,
    promotedEventId: event.event_id,
    headline: text("headline", 140),
    body: text("body", 500),
    // URLs and targeting identifiers are authoritative database data, never model output.
    imageUrl: event.cover_image_url || "",
    ctaUrl: event.official_url || "",
    genres: requestedGenres.filter((genre) => (event.genres || []).includes(genre)).slice(0, 12),
    cityIds: event.city_id ? [event.city_id] : [],
    rationale: text("rationale", 500),
  };
}
