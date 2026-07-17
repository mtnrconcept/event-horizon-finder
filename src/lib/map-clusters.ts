import type { Feature, FeatureCollection, Point } from "geojson";
import { eventCategoryVisual, normalizeEventCategorySlug } from "@/lib/event-category-style";
import type { DiscoveredEvent } from "@/lib/queries";

export type MapPointProperties = {
  kind: "event";
  entity_id: string;
  label: string;
  category_slug: string;
  category_color: string;
  category_icon_image: string;
  is_free: 0 | 1;
  approximate: 0 | 1;
};

export type MapPointCollection = FeatureCollection<Point, MapPointProperties>;

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
): boolean {
  if (!validLatitude(latitude) || !validLongitude(longitude)) return false;
  if (countryCode?.trim().toUpperCase() !== "ES") return true;

  const isMainlandOrBalearic =
    latitude >= 35 && latitude <= 44.5 && longitude >= -10 && longitude <= 5;
  const isCanaryIsland = latitude >= 27 && latitude <= 30 && longitude >= -19 && longitude <= -13;

  return isMainlandOrBalearic || isCanaryIsland;
}

export function buildMapPointCollection({
  events,
  showEvents,
  countryCode = null,
}: {
  events: DiscoveredEvent[];
  showEvents: boolean;
  countryCode?: string | null;
}): MapPointCollection {
  const features: Array<Feature<Point, MapPointProperties>> = [];

  if (showEvents) {
    for (const event of events) {
      if (
        !validLongitude(event.longitude) ||
        !validLatitude(event.latitude) ||
        !isMapCoordinatePlausibleForCountry(countryCode, event.latitude, event.longitude)
      ) {
        continue;
      }
      const categorySlug = normalizeEventCategorySlug(event.category_slug);
      const categoryVisual = eventCategoryVisual(categorySlug);
      features.push({
        type: "Feature",
        id: `event:${event.occurrence_id}`,
        geometry: { type: "Point", coordinates: [event.longitude, event.latitude] },
        properties: {
          kind: "event",
          entity_id: event.occurrence_id,
          label: event.title,
          category_slug: categorySlug,
          category_color: categoryVisual.color,
          category_icon_image: categoryVisual.imageId,
          is_free: event.is_free ? 1 : 0,
          approximate: event.location_precision === "city" ? 1 : 0,
        },
      });
    }
  }

  return { type: "FeatureCollection", features };
}
