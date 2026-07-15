import type { Feature, FeatureCollection, Point } from "geojson";
import type { DiscoveredEvent, DiscoveredVenue } from "@/lib/queries";

export type MapPointProperties = {
  kind: "event" | "venue";
  entity_id: string;
  label: string;
  marker_label: string;
  is_free: 0 | 1;
  approximate: 0 | 1;
};

export type MapPointCollection = FeatureCollection<Point, MapPointProperties>;

function markerPrice(event: DiscoveredEvent): string {
  if (event.is_free) return "0";
  if (event.price_from == null) return "★";
  const price = Math.max(0, Math.round(Number(event.price_from)));
  if (price >= 1_000) return `${Math.round(price / 100) / 10}k`;
  return price.toString();
}

function validLongitude(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= -180 && value <= 180;
}

function validLatitude(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function buildMapPointCollection({
  events,
  venues,
  showEvents,
  showVenues,
}: {
  events: DiscoveredEvent[];
  venues: DiscoveredVenue[];
  showEvents: boolean;
  showVenues: boolean;
}): MapPointCollection {
  const features: Array<Feature<Point, MapPointProperties>> = [];

  if (showEvents) {
    for (const event of events) {
      if (!validLongitude(event.longitude) || !validLatitude(event.latitude)) continue;
      features.push({
        type: "Feature",
        id: `event:${event.occurrence_id}`,
        geometry: { type: "Point", coordinates: [event.longitude, event.latitude] },
        properties: {
          kind: "event",
          entity_id: event.occurrence_id,
          label: event.title,
          marker_label: markerPrice(event),
          is_free: event.is_free ? 1 : 0,
          approximate: event.location_precision === "city" ? 1 : 0,
        },
      });
    }
  }

  if (showVenues) {
    for (const venue of venues) {
      if (!validLongitude(venue.longitude) || !validLatitude(venue.latitude)) continue;
      features.push({
        type: "Feature",
        id: `venue:${venue.id}`,
        geometry: { type: "Point", coordinates: [venue.longitude, venue.latitude] },
        properties: {
          kind: "venue",
          entity_id: venue.id,
          label: venue.name,
          marker_label: "L",
          is_free: 0,
          approximate: venue.location_precision === "city" ? 1 : 0,
        },
      });
    }
  }

  return { type: "FeatureCollection", features };
}
