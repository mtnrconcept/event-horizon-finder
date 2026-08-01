import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  discoverPlacePinsInBounds,
  discoverPlacesInBounds,
  EMPTY_PLACE_PIN_BATCH,
  PLACE_LIST_PAGE_SIZE,
  PLACE_SERVER_CLUSTER_MAX_ZOOM,
  placeDiscoveryFilterKey,
  type DiscoverPlaceParams,
  type PlaceListBatch,
  type PlaceMapPinBatch,
  type PlaceOfInterest,
} from "@/lib/place-discovery";
import {
  clearSessionPlacePinCache,
  loadSessionPlacePins,
  readSessionPlacePins,
} from "@/lib/place-pin-session-cache";
import type { MapViewportBounds } from "@/lib/map-viewport";

const EMPTY_LIST: PlaceListBatch = {
  items: [],
  totalCount: 0,
  hasMore: false,
};

export interface UsePlaceMapDiscoveryInput {
  enabled: boolean;
  listEnabled: boolean;
  bounds: MapViewportBounds | null;
  zoom: number;
  categories: readonly string[];
  query: string;
  accessibleOnly: boolean;
  freeOnly: boolean;
  hasHoursOnly: boolean;
}

export interface PlaceMapDiscoveryState {
  pinBatch: PlaceMapPinBatch;
  places: PlaceOfInterest[];
  pinsLoading: boolean;
  listLoading: boolean;
  listLoadingMore: boolean;
  listReady: boolean;
  pinError: string | null;
  listError: string | null;
  listTotalCount: number;
  listHasMore: boolean;
  retryPins: () => void;
  retryList: () => void;
  loadMore: () => void;
}

function quantizePlacePinZoom(zoom: number): number {
  const normalized = Number.isFinite(zoom) ? Math.max(0, Math.min(22, zoom)) : 0;
  return normalized < PLACE_SERVER_CLUSTER_MAX_ZOOM
    ? Math.floor(normalized)
    : PLACE_SERVER_CLUSTER_MAX_ZOOM;
}

export function usePlaceMapDiscovery({
  enabled,
  listEnabled,
  bounds,
  zoom,
  categories,
  query,
  accessibleOnly,
  freeOnly,
  hasHoursOnly,
}: UsePlaceMapDiscoveryInput): PlaceMapDiscoveryState {
  const [pinBatch, setPinBatch] = useState<PlaceMapPinBatch>(EMPTY_PLACE_PIN_BATCH);
  const [placeList, setPlaceList] = useState<PlaceListBatch>(EMPTY_LIST);
  const [pinsLoading, setPinsLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listLoadingMore, setListLoadingMore] = useState(false);
  const [listReady, setListReady] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [pinReloadKey, setPinReloadKey] = useState(0);
  const [listReloadKey, setListReloadKey] = useState(0);
  const pinRequestVersionRef = useRef(0);
  const listRequestVersionRef = useRef(0);
  const activePinFilterKeyRef = useRef<string | null>(null);

  const categoriesKey = [...new Set(categories)].sort().join("|");
  const normalizedQuery = query.trim();
  const filterKey = useMemo(
    () =>
      placeDiscoveryFilterKey({
        categories: categoriesKey ? categoriesKey.split("|") : null,
        query: normalizedQuery || null,
        accessibleOnly,
        freeOnly,
        hasHoursOnly,
      }),
    [accessibleOnly, categoriesKey, freeOnly, hasHoursOnly, normalizedQuery],
  );
  const baseRequestParams = useMemo<Omit<DiscoverPlaceParams, "zoom"> | null>(
    () =>
      bounds
        ? {
            bounds,
            categories: categoriesKey ? categoriesKey.split("|") : null,
            query: normalizedQuery || null,
            accessibleOnly,
            freeOnly,
            hasHoursOnly,
          }
        : null,
    [accessibleOnly, bounds, categoriesKey, freeOnly, hasHoursOnly, normalizedQuery],
  );
  const pinRequestParams = useMemo<DiscoverPlaceParams | null>(
    () =>
      baseRequestParams
        ? {
            ...baseRequestParams,
            zoom: quantizePlacePinZoom(zoom),
          }
        : null,
    [baseRequestParams, zoom],
  );
  const listRequestParams = useMemo<DiscoverPlaceParams | null>(
    () =>
      baseRequestParams
        ? {
            ...baseRequestParams,
            // The list RPC does not change with visual zoom. Keeping this
            // stable prevents a second rich query during every cluster zoom.
            zoom: PLACE_SERVER_CLUSTER_MAX_ZOOM,
          }
        : null,
    [baseRequestParams],
  );

  useEffect(() => {
    if (!enabled || !pinRequestParams) {
      pinRequestVersionRef.current += 1;
      activePinFilterKeyRef.current = null;
      setPinBatch(EMPTY_PLACE_PIN_BATCH);
      setPinsLoading(false);
      setPinError(null);
      return;
    }

    const filterChanged = activePinFilterKeyRef.current !== filterKey;
    activePinFilterKeyRef.current = filterKey;
    const cached = readSessionPlacePins(
      filterKey,
      pinRequestParams.bounds,
      pinRequestParams.zoom,
    );
    if (cached) {
      setPinBatch(cached);
      setPinsLoading(false);
      setPinError(null);
      return;
    }

    if (filterChanged) setPinBatch(EMPTY_PLACE_PIN_BATCH);
    let current = true;
    const controller = new AbortController();
    const requestVersion = ++pinRequestVersionRef.current;
    setPinsLoading(true);
    setPinError(null);

    void loadSessionPlacePins({
      filterKey,
      viewport: pinRequestParams.bounds,
      zoom: pinRequestParams.zoom,
      signal: controller.signal,
      fetchPins: (requestBounds, signal) =>
        discoverPlacePinsInBounds(
          {
            ...pinRequestParams,
            bounds: requestBounds,
          },
          signal,
        ),
    })
      .then((nextBatch) => {
        if (!current || requestVersion !== pinRequestVersionRef.current) return;
        setPinBatch(nextBatch);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        if (!current || requestVersion !== pinRequestVersionRef.current) return;
        setPinError("Impossible d’actualiser les lieux de la zone visible.");
      })
      .finally(() => {
        if (current && requestVersion === pinRequestVersionRef.current) {
          setPinsLoading(false);
        }
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [enabled, filterKey, pinReloadKey, pinRequestParams]);

  useEffect(() => {
    if (!enabled || !listEnabled || !listRequestParams) {
      listRequestVersionRef.current += 1;
      setPlaceList(EMPTY_LIST);
      setListLoading(false);
      setListLoadingMore(false);
      setListReady(false);
      setListError(null);
      return;
    }

    let current = true;
    const controller = new AbortController();
    const requestVersion = ++listRequestVersionRef.current;
    // Never expose the previous viewport/filter total as the current result.
    setPlaceList(EMPTY_LIST);
    setListLoading(true);
    setListLoadingMore(false);
    setListReady(false);
    setListError(null);

    void discoverPlacesInBounds(
      { ...listRequestParams, limit: PLACE_LIST_PAGE_SIZE, offset: 0 },
      controller.signal,
    )
      .then((nextList) => {
        if (!current || requestVersion !== listRequestVersionRef.current) return;
        setPlaceList(nextList);
        setListReady(true);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        if (!current || requestVersion !== listRequestVersionRef.current) return;
        setListError("Impossible de charger la liste des lieux.");
      })
      .finally(() => {
        if (current && requestVersion === listRequestVersionRef.current) {
          setListLoading(false);
        }
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [enabled, listEnabled, listReloadKey, listRequestParams]);

  const loadMore = useCallback(() => {
    if (
      !enabled ||
      !listEnabled ||
      !listReady ||
      !listRequestParams ||
      !placeList.hasMore ||
      listLoading ||
      listLoadingMore
    ) {
      return;
    }

    const requestVersion = listRequestVersionRef.current;
    setListLoadingMore(true);
    setListError(null);
    void discoverPlacesInBounds({
      ...listRequestParams,
      limit: PLACE_LIST_PAGE_SIZE,
      offset: placeList.items.length,
    })
      .then((nextList) => {
        if (requestVersion !== listRequestVersionRef.current) return;
        setPlaceList((current) => {
          const merged = [...current.items, ...nextList.items];
          const unique = [...new Map(merged.map((place) => [place.id, place])).values()];
          return {
            items: unique,
            totalCount: nextList.totalCount,
            hasMore: nextList.hasMore && unique.length < nextList.totalCount,
          };
        });
      })
      .catch(() => {
        if (requestVersion !== listRequestVersionRef.current) return;
        setListError("Impossible de charger davantage de lieux.");
      })
      .finally(() => {
        if (requestVersion === listRequestVersionRef.current) {
          setListLoadingMore(false);
        }
      });
  }, [
    enabled,
    listEnabled,
    listLoading,
    listLoadingMore,
    listReady,
    listRequestParams,
    placeList,
  ]);

  const retryPins = useCallback(() => {
    clearSessionPlacePinCache(filterKey);
    setPinReloadKey((key) => key + 1);
  }, [filterKey]);
  const retryList = useCallback(() => setListReloadKey((key) => key + 1), []);

  return {
    pinBatch,
    places: placeList.items,
    pinsLoading,
    listLoading,
    listLoadingMore,
    listReady,
    pinError,
    listError,
    listTotalCount: placeList.totalCount,
    listHasMore: placeList.hasMore,
    retryPins,
    retryList,
    loadMore,
  };
}
