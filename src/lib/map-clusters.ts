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

export function isMapCoordinatePlausibleForCountry(
  countryCode: string | null | undefined,
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): latitude is number {
  if (!validLatitude(latitude) || !validLongitude(longitude)) return false;
  if (countryCode?.trim().toUpperCase() !== "ES") return true;

  const isMainlandOrBalearic =
    latitude >= 35 && latitude <= 44.5 && longitude >= -10 && longitude <= 5;
  const isCanaryIsland =
    latitude >= 27 && latitude <= 30 && longitude >= -19 && longitude <= -13;

  return isMainlandOrBalearic || isCanaryIsland;
}

export function buildMapPointCollection({
  events,
  venues,
  showEvents,
  showVenues,
  countryCode = null,
}: {
  events: DiscoveredEvent[];
  venues: DiscoveredVenue[];
  showEvents: boolean;
  showVenues: boolean;
  countryCode?: string | null;
}): MapPointCollection {
  const features: Array<Feature<Point, MapPointProperties>> = [];

  if (showEvents) {
    for (const event of events) {
      if (
        !isMapCoordinatePlausibleForCountry(countryCode, event.latitude, event.longitude)
      ) {
        continue;
      }
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
      if (
        !isMapCoordinatePlausibleForCountry(countryCode, venue.latitude, venue.longitude)
      ) {
        continue;
      }
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
