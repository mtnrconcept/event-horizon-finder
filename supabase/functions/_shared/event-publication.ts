import type { NormalizedEvent } from "./event-precision.ts";

type PublicSummaryEvent = Pick<
  NormalizedEvent,
  "title" | "category" | "venueName" | "city" | "language"
>;

function clean(value: string | null | undefined, maximum: number): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

/**
 * Builds original visitor copy from factual fields only.
 *
 * Scraped prose is deliberately excluded: the source description remains in
 * the private audit record, while this deterministic summary is safe to
 * publish, cache and translate.
 */
export function buildPublicEventSummary(event: PublicSummaryEvent): string {
  const title = clean(event.title, 500) ?? "Event";
  const category = clean(event.category, 200);
  const venue = clean(event.venueName, 300);
  const city = clean(event.city, 200);
  const location = [venue, city].filter(Boolean).join(", ");
  const language = (clean(event.language, 32) ?? "en").toLowerCase().split("-")[0];

  switch (language) {
    case "fr":
      return `« ${title} » est ${category ? `un événement de type ${category}` : "un événement"}${
        location ? ` proposé à ${location}` : ""
      }. Retrouvez ici les dates, horaires, tarifs et modalités de réservation disponibles.`;
    case "de":
      return `„${title}“ ist ${
        category ? `eine Veranstaltung der Kategorie ${category}` : "eine Veranstaltung"
      }${location ? ` in ${location}` : ""}. Hier finden Sie die verfügbaren Angaben zu Datum, Uhrzeit, Preis und Reservierung.`;
    case "it":
      return `“${title}” è ${category ? `un evento della categoria ${category}` : "un evento"}${
        location ? ` a ${location}` : ""
      }. Qui trovi le informazioni disponibili su date, orari, prezzi e prenotazioni.`;
    case "es":
      return `«${title}» es ${category ? `un evento de la categoría ${category}` : "un evento"}${
        location ? ` en ${location}` : ""
      }. Consulta aquí la información disponible sobre fechas, horarios, precios y reservas.`;
    case "pt":
      return `“${title}” é ${category ? `um evento da categoria ${category}` : "um evento"}${
        location ? ` em ${location}` : ""
      }. Consulte aqui as informações disponíveis sobre datas, horários, preços e reservas.`;
    default:
      return `“${title}” is ${category ? `an event in the ${category} category` : "an event"}${
        location ? ` at ${location}` : ""
      }. View the available date, time, pricing and booking information here.`;
  }
}

/** Remote media is publishable only when a separate licensing step approves it. */
export function publicScrapedImageUrl(): null {
  return null;
}
