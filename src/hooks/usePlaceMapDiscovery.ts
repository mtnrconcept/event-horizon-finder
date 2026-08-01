import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  discoverPlacePinsInBounds,
  discoverPlacesInBounds,
  PLACE_LIST_PAGE_SIZE,
  type PlaceListBatch,
  type PlaceMapPinBatch,
  type PlaceOfInterest,
} from "@/lib/place-discovery";
import type { MapViewportBounds } from "@/lib/map-viewport";

const EMPTY_PINS: PlaceMapPinBatch = {
  pins: [],
  totalCount: 0,
  clustered: false,
  truncated: false,
};

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
  pinError: string | null;
  listError: string | null;
  listTotalCount: number;
  listHasMore: boolean;
  retryPins: () => void;
  retryList: () => void;
  loadMore: () => void;
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
  const [pinBatch, setPinBatch] = useState<PlaceMapPinBatch>(EMPTY_PINS);
  const [placeList, setPlaceList] = useState<PlaceListBatch>(EMPTY_LIST);
  const [pinsLoading, setPinsLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listLoadingMore, setListLoadingMore] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [pinReloadKey, setPinReloadKey] = useState(0);
  const [listReloadKey, setListReloadKey] = useState(0);
  const pinRequestVersionRef = useRef(0);
  const listRequestVersionRef = useRef(0);

  const categoriesKey = [...categories].sort().join("|");
  const requestParams = useMemo(
    () =>
      bounds
        ? {
            bounds,
            zoom,
            categories: categoriesKey ? categoriesKey.split("|") : null,
            query: query.trim() || null,
            accessibleOnly,
            freeOnly,
            hasHoursOnly,
          }
        : null,
    [accessibleOnly, bounds, categoriesKey, freeOnly, hasHoursOnly, query, zoom],
  );

  useEffect(() => {
    if (!enabled || !requestParams) {
      pinRequestVersionRef.current += 1;
      setPinBatch(EMPTY_PINS);
      setPinsLoading(false);
      setPinError(null);
      return;
    }

    let current = true;
    const controller = new AbortController();
    const requestVersion = ++pinRequestVersionRef.current;
    setPinsLoading(true);
    setPinError(null);

    void discoverPlacePinsInBounds(requestParams, controller.signal)
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
  }, [enabled, pinReloadKey, requestParams]);

  useEffect(() => {
    if (!enabled || !listEnabled || !requestParams) {
      listRequestVersionRef.current += 1;
      setPlaceList(EMPTY_LIST);
      setListLoading(false);
      setListLoadingMore(false);
      setListError(null);
      return;
    }

    let current = true;
    const controller = new AbortController();
    const requestVersion = ++listRequestVersionRef.current;
    setListLoading(true);
    setListLoadingMore(false);
    setListError(null);

    void discoverPlacesInBounds(
      { ...requestParams, limit: PLACE_LIST_PAGE_SIZE, offset: 0 },
      controller.signal,
    )
      .then((nextList) => {
        if (!current || requestVersion !== listRequestVersionRef.current) return;
        setPlaceList(nextList);
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
  }, [enabled, listEnabled, listReloadKey, requestParams]);

  const loadMore = useCallback(() => {
    if (
      !enabled ||
      !listEnabled ||
      !requestParams ||
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
      ...requestParams,
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
  }, [enabled, listEnabled, listLoading, listLoadingMore, placeList, requestParams]);

  return {
    pinBatch,
    places: placeList.items,
    pinsLoading,
    listLoading,
    listLoadingMore,
    pinError,
    listError,
    listTotalCount: placeList.totalCount,
    listHasMore: placeList.hasMore,
    retryPins: () => setPinReloadKey((key) => key + 1),
    retryList: () => setListReloadKey((key) => key + 1),
    loadMore,
  };
}
