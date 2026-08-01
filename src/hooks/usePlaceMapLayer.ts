import { useEffect, useMemo, useRef } from "react";
import maplibregl, {
  type GeoJSONSource,
  type MapLayerMouseEvent,
  type MapMouseEvent,
} from "maplibre-gl";
import {
  buildPlaceFeatureCollection,
  PLACE_SERVER_CLUSTER_MAX_ZOOM,
  placeFromFeatureProperties,
  type PlaceFeatureCollection,
  type PlaceFeatureProperties,
  type PlaceMapPinBatch,
  type PlaceOfInterest,
} from "@/lib/place-discovery";

export const MAP_PLACE_SOURCE_ID = "global-party-places";
export const MAP_PLACE_CLIENT_CLUSTER_HALO_ID = "global-party-place-client-cluster-halo";
export const MAP_PLACE_CLIENT_CLUSTER_ID = "global-party-place-client-cluster";
export const MAP_PLACE_CLIENT_CLUSTER_COUNT_ID = "global-party-place-client-cluster-count";
export const MAP_PLACE_SERVER_CLUSTER_HALO_ID = "global-party-place-server-cluster-halo";
export const MAP_PLACE_SERVER_CLUSTER_ID = "global-party-place-server-cluster";
export const MAP_PLACE_SERVER_CLUSTER_COUNT_ID = "global-party-place-server-cluster-count";
export const MAP_PLACE_POINT_ID = "global-party-place-point";
export const MAP_PLACE_LABEL_ID = "global-party-place-label";

const PLACE_CLUSTER_RADIUS = 108;
const PLACE_CLUSTER_MAX_ZOOM = 14;

const EMPTY_COLLECTION: PlaceFeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

const PLACE_CATEGORY_COLOR_EXPRESSION = [
  "match",
  ["get", "category"],
  "nature",
  "#16a34a",
  "culture",
  "#8b5cf6",
  "family",
  "#f59e0b",
  "sports-outdoors",
  "#ef4444",
  "food-drink",
  "#f97316",
  "attraction",
  "#0ea5e9",
  "#0f766e",
] as const;

function placeCount(properties: Record<string, unknown> | null | undefined): number {
  const raw = properties?.place_total ?? properties?.place_count ?? properties?.point_count;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
}

function ensurePlaceSourceAndLayers(map: maplibregl.Map, data: PlaceFeatureCollection) {
  if (!map.getSource(MAP_PLACE_SOURCE_ID)) {
    map.addSource(MAP_PLACE_SOURCE_ID, {
      type: "geojson",
      data,
      cluster: true,
      clusterRadius: PLACE_CLUSTER_RADIUS,
      clusterMaxZoom: PLACE_CLUSTER_MAX_ZOOM,
      clusterProperties: {
        place_total: ["+", ["get", "place_count"]],
      },
    });
  }

  if (!map.getLayer(MAP_PLACE_CLIENT_CLUSTER_HALO_ID)) {
    map.addLayer({
      id: MAP_PLACE_CLIENT_CLUSTER_HALO_ID,
      type: "circle",
      source: MAP_PLACE_SOURCE_ID,
      filter: ["has", "point_count"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "place_total"], 2, 24, 50, 34, 500, 46],
        "circle-color": "rgba(15, 118, 110, 0.2)",
        "circle-blur": 0.3,
      },
    });
  }

  if (!map.getLayer(MAP_PLACE_CLIENT_CLUSTER_ID)) {
    map.addLayer({
      id: MAP_PLACE_CLIENT_CLUSTER_ID,
      type: "circle",
      source: MAP_PLACE_SOURCE_ID,
      filter: ["has", "point_count"],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "place_total"], 2, 18, 50, 25, 500, 34],
        "circle-color": "#0f766e",
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2.5,
        "circle-opacity": 0.95,
      },
    });
  }

  if (!map.getLayer(MAP_PLACE_CLIENT_CLUSTER_COUNT_ID)) {
    map.addLayer({
      id: MAP_PLACE_CLIENT_CLUSTER_COUNT_ID,
      type: "symbol",
      source: MAP_PLACE_SOURCE_ID,
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["to-string", ["coalesce", ["get", "place_total"], ["get", "point_count"]]],
        "text-size": 12,
        "text-font": ["Noto Sans Bold"],
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "rgba(0,0,0,0.18)",
        "text-halo-width": 1,
      },
    });
  }

  const serverClusterFilter = [
    "all",
    ["!", ["has", "point_count"]],
    ["==", ["get", "entity_kind"], "cluster"],
  ] as const;

  if (!map.getLayer(MAP_PLACE_SERVER_CLUSTER_HALO_ID)) {
    map.addLayer({
      id: MAP_PLACE_SERVER_CLUSTER_HALO_ID,
      type: "circle",
      source: MAP_PLACE_SOURCE_ID,
      filter: serverClusterFilter,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "place_count"], 2, 25, 100, 38, 1000, 50],
        "circle-color": "rgba(15, 118, 110, 0.18)",
        "circle-blur": 0.32,
      },
    });
  }

  if (!map.getLayer(MAP_PLACE_SERVER_CLUSTER_ID)) {
    map.addLayer({
      id: MAP_PLACE_SERVER_CLUSTER_ID,
      type: "circle",
      source: MAP_PLACE_SOURCE_ID,
      filter: serverClusterFilter,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "place_count"], 2, 19, 100, 29, 1000, 39],
        "circle-color": "#0f766e",
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2.5,
        "circle-opacity": 0.94,
      },
    });
  }

  if (!map.getLayer(MAP_PLACE_SERVER_CLUSTER_COUNT_ID)) {
    map.addLayer({
      id: MAP_PLACE_SERVER_CLUSTER_COUNT_ID,
      type: "symbol",
      source: MAP_PLACE_SOURCE_ID,
      filter: serverClusterFilter,
      layout: {
        "text-field": ["to-string", ["get", "place_count"]],
        "text-size": 12,
        "text-font": ["Noto Sans Bold"],
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "rgba(0,0,0,0.18)",
        "text-halo-width": 1,
      },
    });
  }

  const individualPlaceFilter = [
    "all",
    ["!", ["has", "point_count"]],
    ["==", ["get", "entity_kind"], "place"],
  ] as const;

  if (!map.getLayer(MAP_PLACE_POINT_ID)) {
    map.addLayer({
      id: MAP_PLACE_POINT_ID,
      type: "circle",
      source: MAP_PLACE_SOURCE_ID,
      filter: individualPlaceFilter,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 5, 12, 7, 15, 9],
        "circle-color": PLACE_CATEGORY_COLOR_EXPRESSION,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
        "circle-opacity": 0.96,
      },
    });
  }

  if (!map.getLayer(MAP_PLACE_LABEL_ID)) {
    map.addLayer({
      id: MAP_PLACE_LABEL_ID,
      type: "symbol",
      source: MAP_PLACE_SOURCE_ID,
      minzoom: 13.5,
      filter: individualPlaceFilter,
      layout: {
        "text-field": ["get", "name"],
        "text-size": 11,
        "text-offset": [0, 1.25],
        "text-anchor": "top",
        "text-max-width": 14,
        "text-optional": true,
      },
      paint: {
        "text-color": "#0f172a",
        "text-halo-color": "rgba(255,255,255,0.95)",
        "text-halo-width": 1.5,
      },
    });
  }
}

export interface UsePlaceMapLayerInput {
  map: maplibregl.Map | null;
  ready: boolean;
  styleRevision: number;
  enabled: boolean;
  pinBatch: PlaceMapPinBatch;
  onSelect: (place: PlaceOfInterest) => void;
}

export function usePlaceMapLayer({
  map,
  ready,
  styleRevision,
  enabled,
  pinBatch,
  onSelect,
}: UsePlaceMapLayerInput) {
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const collection = useMemo(() => buildPlaceFeatureCollection(pinBatch), [pinBatch]);

  useEffect(() => {
    if (!map || !ready || !map.isStyleLoaded()) return;
    const nextData = enabled ? collection : EMPTY_COLLECTION;
    ensurePlaceSourceAndLayers(map, nextData);
    const source = map.getSource(MAP_PLACE_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(nextData);
  }, [collection, enabled, map, ready, styleRevision]);

  useEffect(() => {
    if (!map || !ready || !enabled || !map.isStyleLoaded()) return;

    const setPointer = () => {
      map.getCanvas().style.cursor = "pointer";
    };
    const resetPointer = () => {
      map.getCanvas().style.cursor = "";
    };

    const openClientCluster = async (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature || feature.geometry.type !== "Point") return;
      const clusterId = Number(feature.properties?.cluster_id);
      if (!Number.isFinite(clusterId)) return;
      const source = map.getSource(MAP_PLACE_SOURCE_ID) as GeoJSONSource | undefined;
      if (!source) return;
      try {
        const expansionZoom = await source.getClusterExpansionZoom(clusterId);
        const [longitude, latitude] = feature.geometry.coordinates;
        map.easeTo({
          center: [Number(longitude), Number(latitude)],
          zoom: Math.min(18, Math.max(map.getZoom() + 1, expansionZoom)),
          duration: 420,
        });
      } catch {
        // The next viewport refresh will retry with fresh source data.
      }
    };

    const openServerCluster = (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature || feature.geometry.type !== "Point") return;
      const [longitude, latitude] = feature.geometry.coordinates;
      map.easeTo({
        center: [Number(longitude), Number(latitude)],
        zoom: Math.min(
          PLACE_SERVER_CLUSTER_MAX_ZOOM + 0.5,
          Math.max(map.getZoom() + 2, 5),
        ),
        duration: 420,
      });
    };

    const openPlace = (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const place = placeFromFeatureProperties(
        feature.properties as Partial<PlaceFeatureProperties> | undefined,
      );
      if (place) onSelectRef.current(place);
    };

    const handleMapClick = (event: MapMouseEvent) => {
      const hits = map.queryRenderedFeatures(event.point, {
        layers: [MAP_PLACE_POINT_ID],
      });
      if (!hits.length) return;
      const place = placeFromFeatureProperties(
        hits[0]?.properties as Partial<PlaceFeatureProperties> | undefined,
      );
      if (place) onSelectRef.current(place);
    };

    map.on("click", MAP_PLACE_CLIENT_CLUSTER_ID, openClientCluster);
    map.on("click", MAP_PLACE_SERVER_CLUSTER_ID, openServerCluster);
    map.on("click", MAP_PLACE_POINT_ID, openPlace);
    map.on("click", handleMapClick);

    const interactiveLayers = [
      MAP_PLACE_CLIENT_CLUSTER_ID,
      MAP_PLACE_SERVER_CLUSTER_ID,
      MAP_PLACE_POINT_ID,
    ] as const;
    interactiveLayers.forEach((layerId) => map.on("mouseenter", layerId, setPointer));
    interactiveLayers.forEach((layerId) => map.on("mouseleave", layerId, resetPointer));

    return () => {
      map.off("click", MAP_PLACE_CLIENT_CLUSTER_ID, openClientCluster);
      map.off("click", MAP_PLACE_SERVER_CLUSTER_ID, openServerCluster);
      map.off("click", MAP_PLACE_POINT_ID, openPlace);
      map.off("click", handleMapClick);
      interactiveLayers.forEach((layerId) => map.off("mouseenter", layerId, setPointer));
      interactiveLayers.forEach((layerId) => map.off("mouseleave", layerId, resetPointer));
      resetPointer();
    };
  }, [enabled, map, ready, styleRevision]);
}

export function formatPlaceClusterCount(properties: Record<string, unknown>): string {
  return new Intl.NumberFormat("fr-CH").format(placeCount(properties));
}
