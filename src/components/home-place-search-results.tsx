import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlaceDetailDialog } from "@/components/place-detail-dialog";
import { PlaceSearchResults } from "@/components/place-search-results";
import { useTranslation } from "@/lib/i18n";
import {
  discoverPlacesForHome,
  PLACE_LIST_PAGE_SIZE,
  type PlaceOfInterest,
} from "@/lib/place-discovery";

export function HomePlaceSearchResults({
  enabled,
  countryId,
  regionId,
  cityId,
  categories,
  query,
  accessibleOnly,
  freeOnly,
  hasHoursOnly,
}: {
  enabled: boolean;
  countryId: string | null;
  regionId: string | null;
  cityId: string | null;
  categories: string[];
  query: string;
  accessibleOnly: boolean;
  freeOnly: boolean;
  hasHoursOnly: boolean;
}) {
  const { tr } = useTranslation();
  const [places, setPlaces] = useState<PlaceOfInterest[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedPlace, setSelectedPlace] = useState<PlaceOfInterest | null>(null);
  const requestVersionRef = useRef(0);

  const params = useMemo(
    () => ({
      countryId,
      regionId,
      cityId,
      categories,
      query,
      accessibleOnly,
      freeOnly,
      hasHoursOnly,
    }),
    [accessibleOnly, categories, cityId, countryId, freeOnly, hasHoursOnly, query, regionId],
  );

  useEffect(() => {
    if (!enabled) {
      setPlaces([]);
      setTotalCount(0);
      setHasMore(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setError(null);
    void discoverPlacesForHome({ ...params, limit: PLACE_LIST_PAGE_SIZE, offset: 0 }, controller.signal)
      .then((batch) => {
        if (requestVersion !== requestVersionRef.current) return;
        setPlaces(batch.items);
        setTotalCount(batch.totalCount);
        setHasMore(batch.hasMore);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setPlaces([]);
        setError(cause instanceof Error ? cause.message : tr("Impossible de charger les lieux."));
      })
      .finally(() => {
        if (!controller.signal.aborted && requestVersion === requestVersionRef.current) setLoading(false);
      });
    return () => controller.abort();
  }, [enabled, params, reloadKey, tr]);

  const loadMore = useCallback(async () => {
    if (!enabled || loading || loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const batch = await discoverPlacesForHome({
        ...params,
        limit: PLACE_LIST_PAGE_SIZE,
        offset: places.length,
      });
      setPlaces((current) => {
        const known = new Set(current.map((place) => place.id));
        return [...current, ...batch.items.filter((place) => !known.has(place.id))];
      });
      setTotalCount(batch.totalCount);
      setHasMore(batch.hasMore);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tr("Impossible de charger plus de lieux."));
    } finally {
      setLoadingMore(false);
    }
  }, [enabled, hasMore, loading, loadingMore, params, places.length, tr]);

  if (!enabled) return null;

  return (
    <section className="mb-8" aria-label={tr("Lieux correspondant à la recherche")}>
      <PlaceSearchResults
        places={places}
        totalCount={totalCount}
        loading={loading}
        loadingMore={loadingMore}
        error={error}
        hasMore={hasMore}
        onRetry={() => setReloadKey((value) => value + 1)}
        onLoadMore={() => void loadMore()}
        onSelect={setSelectedPlace}
        showEmpty
      />
      <PlaceDetailDialog
        open={selectedPlace !== null}
        place={selectedPlace}
        onOpenChange={(open) => {
          if (!open) setSelectedPlace(null);
        }}
      />
    </section>
  );
}