import { Link, createFileRoute } from "@tanstack/react-router";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleAlert,
  Crosshair,
  FerrisWheel,
  Flame,
  Gift,
  Map as MapIcon,
  MapPin,
  LoaderCircle,
  Music2,
  PartyPopper,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  Ticket,
  TrendingUp,
  X,
} from "lucide-react";
import {
  discoverEventStats,
  discoverEvents,
  fetchCategories,
  fetchGeographies,
  searchGeographyCities,
  computeRange,
  type CityOption,
  type CountryOption,
  type DiscoveryStats,
  type DiscoveredEvent,
  type QuickRange,
  type RegionOption,
} from "@/lib/queries";
import { EventCard, EventCardSkeleton } from "@/components/event-card";
import { EventFilterPanel } from "@/components/event-filter-panel";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { TargetedCampaigns } from "@/components/targeted-campaigns";
import { GeographyFilter, type GeographySelection } from "@/components/geography-filter";
import {
  countAdvancedFilters,
  DEFAULT_ADVANCED_FILTERS,
  toDiscoveryFilters,
} from "@/lib/event-filters";
import { useVisualViewportHeight } from "@/hooks/useVisualViewportHeight";
import { BrandLogo } from "@/components/brand/brand-logo";
import { LiveEventCounter } from "@/components/live-event-counter";
import { useTranslation } from "@/lib/i18n";
import type { UiTranslationPhrase } from "@/lib/ui-translations";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Global Party — Découvre les événements ce soir, ce week-end, près de toi" },
      {
        name: "description",
        content:
          "Concerts, soirées, festivals, expositions, sports, famille. Trouve les meilleurs événements maintenant, ce soir ou ce week-end.",
      },
    ],
  }),
  component: Discover,
});

type Category = { slug: string; name_fr: string; icon: string | null };
type SortMode = "soon" | "distance" | "popular";
const EVENT_PAGE_SIZE = 48;
const COUNT_FORMATTER = new Intl.NumberFormat("fr-CH");

const QUICK: { key: QuickRange; label: UiTranslationPhrase; helper: UiTranslationPhrase }[] = [
  { key: "now", label: "Maintenant", helper: "2 prochaines heures" },
  { key: "tonight", label: "Ce soir", helper: "18h → 6h" },
  { key: "today", label: "Aujourd'hui", helper: "Jusqu'à minuit" },
  { key: "tomorrow", label: "Demain", helper: "Toute la journée" },
  { key: "weekend", label: "Ce week-end", helper: "Vendredi → dimanche" },
  { key: "week", label: "7 jours", helper: "Planning complet" },
  { key: "month", label: "30 jours", helper: "Prochains événements" },
  { key: "year", label: "Tout à venir", helper: "Catalogue sur 12 mois" },
];

const VIBES = [
  {
    id: "tonight",
    label: "Ce soir",
    helper: "Les plans de dernière minute",
    icon: Flame,
    range: "tonight" as QuickRange,
  },
  {
    id: "nightlife",
    label: "Nightlife",
    helper: "Clubs, DJ sets et rooftops",
    icon: PartyPopper,
    categories: ["soirees"],
  },
  {
    id: "live",
    label: "Live music",
    helper: "Concerts et scènes locales",
    icon: Music2,
    categories: ["concerts"],
  },
  {
    id: "festivals",
    label: "Festivals",
    helper: "Les grands rendez-vous",
    icon: FerrisWheel,
    categories: ["festivals"],
  },
  {
    id: "free",
    label: "Gratuit",
    helper: "Sortir sans dépasser son budget",
    icon: Gift,
    freeOnly: true,
  },
] as const;

type LandingCollections = {
  top: DiscoveredEvent[];
  free: DiscoveredEvent[];
  nightlife: DiscoveredEvent[];
  festivals: DiscoveredEvent[];
};

function Discover() {
  const { t, tr, categoryLabel, formatNumber } = useTranslation();
  const [countries, setCountries] = useState<CountryOption[]>([]);
  const [regions, setRegions] = useState<RegionOption[]>([]);
  const [cities, setCities] = useState<CityOption[]>([]);
  const [cityLoading, setCityLoading] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [geographyReady, setGeographyReady] = useState(false);
  const [geography, setGeography] = useState<GeographySelection>({
    countryId: null,
    regionId: null,
    cityId: null,
  });
  const { countryId, regionId, cityId } = geography;
  const [range, setRange] = useState<QuickRange>("year");
  const [cats, setCats] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [advancedFilters, setAdvancedFilters] = useState({ ...DEFAULT_ADVANCED_FILTERS });
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [sort, setSort] = useState<SortMode>("soon");
  const [events, setEvents] = useState<DiscoveredEvent[] | null>(null);
  const [discoveryStats, setDiscoveryStats] = useState<DiscoveryStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [landingCollections, setLandingCollections] = useState<LandingCollections | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageMayHaveMore, setPageMayHaveMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const requestVersionRef = useRef(0);
  const cityRequestVersionRef = useRef(0);
  const deferredQuery = useDeferredValue(query.trim());
  const advancedCount = countAdvancedFilters(advancedFilters);
  const viewportHeight = useVisualViewportHeight();

  useEffect(() => {
    if (!mobileFiltersOpen) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileFiltersOpen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [mobileFiltersOpen]);

  const searchCities = useCallback(
    async (cityQuery: string) => {
      if (!countryId) return;
      const requestVersion = ++cityRequestVersionRef.current;
      setCityLoading(true);
      try {
        const rows = await searchGeographyCities({
          countryId,
          regionId,
          query: cityQuery,
          limit: 100,
        });
        if (requestVersion !== cityRequestVersionRef.current) return;
        setCities((current) => {
          const merged = new Map(current.map((city) => [city.id, city]));
          rows.forEach((city) => merged.set(city.id, city));
          return [...merged.values()];
        });
      } catch {
        // Event discovery remains usable at country/region level when city
        // suggestions are temporarily unavailable.
      } finally {
        if (requestVersion === cityRequestVersionRef.current) setCityLoading(false);
      }
    },
    [countryId, regionId],
  );

  useEffect(() => {
    let current = true;
    Promise.all([fetchGeographies(), fetchCategories()])
      .then(([data, categoryRows]) => {
        if (!current) return;
        setCountries(data.countries);
        setRegions(data.regions);
        setCities(data.cities);
        setCategories(categoryRows as Category[]);
        const geneva = data.cities.find((city) => city.slug === "geneve");
        if (geneva) {
          setGeography({
            countryId: geneva.country_id,
            regionId: geneva.region_id,
            cityId: geneva.id,
          });
        }
        setGeographyReady(true);
      })
      .catch(() => {
        if (current) {
          setError("Les filtres géographiques n'ont pas pu être chargés.");
          // Keep worldwide discovery available when the geography catalogue
          // is temporarily unavailable.
          setGeographyReady(true);
        }
      });
    return () => {
      current = false;
    };
  }, []);

  const { from, to } = useMemo(() => computeRange(range), [range]);
  const selectedCity = useMemo(() => cities.find((c) => c.id === cityId) ?? null, [cities, cityId]);
  const selectedRegion = useMemo(
    () => regions.find((region) => region.id === regionId) ?? null,
    [regions, regionId],
  );
  const selectedCountry = useMemo(
    () => countries.find((country) => country.id === countryId) ?? null,
    [countries, countryId],
  );
  const activeCategoryNames = useMemo(
    () => categories.filter((c) => cats.has(c.slug)).map((c) => categoryLabel(c.slug, c.name_fr)),
    [categories, categoryLabel, cats],
  );

  const discoveryParams = useMemo(
    () => ({
      lat: coords?.lat ?? null,
      lon: coords?.lon ?? null,
      radiusKm: coords ? 25 : 500,
      countryId,
      regionId,
      cityId,
      categorySlugs: cats.size ? [...cats] : null,
      query: deferredQuery,
      from,
      to,
      ...toDiscoveryFilters(advancedFilters),
    }),
    [advancedFilters, cats, cityId, coords, countryId, deferredQuery, from, regionId, to],
  );

  useEffect(() => {
    if (!geographyReady) return;
    let current = true;
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setLoadingMore(false);
    setEvents(null);
    setDiscoveryStats(null);
    setStatsLoading(true);
    setNextOffset(0);
    setPageMayHaveMore(false);
    setError(null);

    void discoverEvents({
      ...discoveryParams,
      limit: EVENT_PAGE_SIZE,
      offset: 0,
    })
      .then((data) => {
        if (!current || requestVersion !== requestVersionRef.current) return;
        setEvents(data);
        setNextOffset(data.length);
        setPageMayHaveMore(data.length === EVENT_PAGE_SIZE);
      })
      .catch(() => {
        if (!current) return;
        setEvents([]);
        setError("Le catalogue n'a pas pu être chargé. Réessaie dans un instant.");
      })
      .finally(() => {
        if (current && requestVersion === requestVersionRef.current) setLoading(false);
      });

    // The aggregate request is deliberately independent: a transient failure
    // must not hide the event cards that have already loaded successfully.
    void discoverEventStats(discoveryParams)
      .then((nextStats) => {
        if (!current || requestVersion !== requestVersionRef.current) return;
        setDiscoveryStats(nextStats);
      })
      .catch(() => {
        if (!current || requestVersion !== requestVersionRef.current) return;
        setDiscoveryStats(null);
      })
      .finally(() => {
        if (current && requestVersion === requestVersionRef.current) setStatsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [discoveryParams, geographyReady, reloadKey]);

  useEffect(() => {
    if (!geographyReady) return;
    let current = true;
    const landingRange = computeRange("year");
    const geographyParams = { countryId, regionId, cityId };
    setLandingCollections(null);

    // Load editorial rails in sequence. Four simultaneous worldwide scans,
    // on top of the main catalogue request, can exhaust PostgREST's short
    // statement budget on a cold cache even though every query is fast alone.
    const loadCollections = async () => {
      const top = await discoverEvents({
        ...geographyParams,
        ...landingRange,
        verifiedOnly: true,
        limit: 8,
      });
      if (!current) return;
      const free = await discoverEvents({
        ...geographyParams,
        ...landingRange,
        freeOnly: true,
        limit: 8,
      });
      if (!current) return;
      const nightlife = await discoverEvents({
        ...geographyParams,
        ...landingRange,
        categorySlugs: ["soirees"],
        limit: 8,
      });
      if (!current) return;
      const festivals = await discoverEvents({
        ...geographyParams,
        ...landingRange,
        categorySlugs: ["festivals"],
        limit: 8,
      });
      if (current) setLandingCollections({ top, free, nightlife, festivals });
    };

    void loadCollections().catch(() => {
      if (current) setLandingCollections(null);
    });
    return () => {
      current = false;
    };
  }, [cityId, countryId, geographyReady, regionId]);

  const loadMore = async () => {
    if (loading || loadingMore || !hasMore) return;
    const requestVersion = requestVersionRef.current;
    const offset = nextOffset;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await discoverEvents({
        ...discoveryParams,
        limit: EVENT_PAGE_SIZE,
        offset,
      });
      if (requestVersion !== requestVersionRef.current) return;
      setEvents((current) => {
        const known = new Set((current ?? []).map((event) => event.occurrence_id));
        return [...(current ?? []), ...page.filter((event) => !known.has(event.occurrence_id))];
      });
      setNextOffset(offset + page.length);
      setPageMayHaveMore(page.length === EVENT_PAGE_SIZE);
    } catch {
      if (requestVersion === requestVersionRef.current) {
        setError("La page suivante n'a pas pu être chargée. Réessaie dans un instant.");
      }
    } finally {
      if (requestVersion === requestVersionRef.current) setLoadingMore(false);
    }
  };

  const sortedEvents = useMemo(() => {
    const list = [...(events ?? [])];
    if (sort === "distance")
      return list.sort((a, b) => (a.distance_km ?? 9999) - (b.distance_km ?? 9999));
    if (sort === "popular")
      return list.sort(
        (a, b) =>
          Number(b.is_verified) - Number(a.is_verified) || Number(b.is_free) - Number(a.is_free),
      );
    return list.sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  }, [events, sort]);

  const localStats = useMemo(() => {
    const list = events ?? [];
    return {
      total_count: list.length,
      free_count: list.filter((e) => e.is_free).length,
      verified_count: list.filter((e) => e.is_verified).length,
    };
  }, [events]);
  const stats = discoveryStats ?? localStats;
  const hasMore = discoveryStats ? nextOffset < discoveryStats.total_count : pageMayHaveMore;
  const nextPageCount = discoveryStats
    ? Math.min(EVENT_PAGE_SIZE, Math.max(discoveryStats.total_count - nextOffset, 0))
    : EVENT_PAGE_SIZE;

  const requestGeo = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setGeography({ countryId: null, regionId: null, cityId: null });
        setCoords({ lat: p.coords.latitude, lon: p.coords.longitude });
      },
      () => {},
      { enableHighAccuracy: false, timeout: 6000 },
    );
  };

  const toggleCat = (slug: string) => {
    const next = new Set(cats);
    if (next.has(slug)) {
      next.delete(slug);
    } else {
      next.add(slug);
    }
    setCats(next);
  };

  const resetFilters = () => {
    const geneva = cities.find((city) => city.slug === "geneve");
    setCats(new Set());
    setQuery("");
    setAdvancedFilters({ ...DEFAULT_ADVANCED_FILTERS, genres: [] });
    setGeography(
      geneva
        ? {
            countryId: geneva.country_id,
            regionId: geneva.region_id,
            cityId: geneva.id,
          }
        : { countryId: null, regionId: null, cityId: null },
    );
    setCoords(null);
    setRange("year");
    setSort("soon");
  };

  const applyVibe = (vibe: (typeof VIBES)[number]) => {
    setQuery("");
    setCoords(null);
    setCats(new Set("categories" in vibe ? [...vibe.categories] : []));
    setRange("range" in vibe ? vibe.range : "year");
    setAdvancedFilters({
      ...DEFAULT_ADVANCED_FILTERS,
      genres: [],
      priceMode: "freeOnly" in vibe && vibe.freeOnly ? "free" : "all",
    });
    setSort("soon");
  };

  const landingMode =
    !deferredQuery &&
    cats.size === 0 &&
    advancedCount === 0 &&
    range === "year" &&
    sort === "soon" &&
    !coords;
  const mobileFilterCount =
    advancedCount +
    cats.size +
    Number(range !== "year") +
    Number(sort !== "soon") +
    Number(Boolean(coords));

  return (
    <div className="mx-auto max-w-7xl px-4 pt-2 md:px-6 md:pt-10">
      <div className="glass sticky top-0 z-30 mb-4 rounded-2xl p-2 shadow-[var(--shadow-card)] md:hidden">
        <div className="flex items-center gap-2">
          <Link
            to="/"
            aria-label={t("brand.home")}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-surface/70 outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <BrandLogo variant="mark" className="h-9 w-10" />
          </Link>
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("home.searchPlaceholder")}
              aria-label={t("home.searchAria")}
              className="h-11 rounded-2xl border-transparent bg-surface/70 pl-9 text-sm"
            />
          </div>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={mobileFiltersOpen}
            onClick={() => setMobileFiltersOpen(true)}
            className="relative inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-2xl border bg-surface px-3 text-xs font-bold"
          >
            <SlidersHorizontal className="h-4 w-4 text-primary" />
            {t("common.filters")}
            {mobileFilterCount > 0 && (
              <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full border-2 border-background bg-primary px-1 text-[10px] text-primary-foreground">
                {mobileFilterCount}
              </span>
            )}
          </button>
        </div>
      </div>

      <section className="global-party-hero relative mb-6 overflow-hidden rounded-[2rem] border p-5 md:mb-8 md:p-8">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_20%_10%,oklch(0.68_0.22_295_/_0.35),transparent_32%),radial-gradient(circle_at_82%_18%,oklch(0.72_0.18_35_/_0.22),transparent_30%),linear-gradient(135deg,oklch(0.19_0.03_265_/_0.92),oklch(0.12_0.03_265_/_0.86))]" />
        <div className="global-party-hero__beam" aria-hidden="true" />
        <div className="grid gap-6 lg:grid-cols-[0.7fr_1.25fr_0.58fr] lg:items-center lg:gap-8">
          <div className="global-party-hero__brand">
            <div className="global-party-hero__brand-halo" aria-hidden="true" />
            <BrandLogo
              variant="lockup"
              className="global-party-hero__logo"
              label="Global Party — Clubbing & Festivals"
            />
            <div className="global-party-hero__brand-line" aria-hidden="true" />
          </div>
          <div>
            <Badge className="mb-5 border-transparent bg-primary/15 px-3 py-1 text-primary">
              <Flame className="mr-1.5 h-3.5 w-3.5" /> {t("home.catalogBadge")}
            </Badge>
            <h1 className="max-w-4xl text-4xl font-black leading-[0.95] md:text-7xl">
              {t("home.heroTitle")}
            </h1>
            <p className="mt-5 max-w-2xl text-base text-muted-foreground md:text-lg">
              {t("home.heroBody")}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
            <LiveEventCounter />
            <HeroStat
              icon={Ticket}
              label={t("home.free")}
              value={loading || statsLoading ? "…" : formatNumber(stats.free_count)}
            />
            <HeroStat
              icon={Star}
              label={t("home.verified")}
              value={loading || statsLoading ? "…" : formatNumber(stats.verified_count)}
            />
          </div>
        </div>
      </section>

      <TargetedCampaigns placement="discover" />

      <section className="mb-7" aria-labelledby="vibe-title">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              {t("home.inspiration")}
            </p>
            <h2 id="vibe-title" className="mt-1 text-2xl font-black md:text-3xl">
              {t("home.chooseVibe")}
            </h2>
          </div>
          <Link to="/map" className="hidden text-sm font-semibold text-primary sm:inline-flex">
            {t("home.openMap")} →
          </Link>
        </div>
        <div className="no-scrollbar flex gap-3 overflow-x-auto pb-2">
          {VIBES.map((vibe, index) => {
            const Icon = vibe.icon;
            return (
              <button
                key={vibe.id}
                type="button"
                onClick={() => applyVibe(vibe)}
                className="group relative min-h-32 min-w-[13.5rem] overflow-hidden rounded-3xl border p-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-[var(--shadow-card)]"
              >
                <div
                  className="absolute inset-0 -z-10 opacity-90"
                  style={{
                    background: `radial-gradient(circle at 85% 15%, oklch(0.72 0.18 ${35 + index * 42} / 0.32), transparent 42%), linear-gradient(145deg, var(--color-surface-2), var(--color-background))`,
                  }}
                />
                <Icon className="mb-7 h-5 w-5 text-primary transition-transform group-hover:scale-110" />
                <span className="block text-lg font-black">{tr(vibe.label)}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{tr(vibe.helper)}</span>
              </button>
            );
          })}
        </div>
      </section>

      {mobileFiltersOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="home-mobile-filter-title"
          className="fixed inset-0 z-[80] flex flex-col bg-background md:hidden"
          style={{ height: viewportHeight ? `${viewportHeight}px` : "100dvh" }}
        >
          <header
            className="flex shrink-0 items-center justify-between gap-3 border-b px-4 pb-3"
            style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top, 0px))" }}
          >
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-primary">
                {t("discovery.refine")}
              </p>
              <h2 id="home-mobile-filter-title" className="text-xl font-black">
                {t("common.filters")}
              </h2>
            </div>
            <button
              type="button"
              aria-label={t("discovery.closeFilters")}
              onClick={() => setMobileFiltersOpen(false)}
              className="grid h-11 w-11 place-items-center rounded-full border bg-surface"
            >
              <X className="h-5 w-5" />
            </button>
          </header>

          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4 overscroll-contain">
            <section>
              <h3 className="mb-2 text-sm font-black">{t("home.destination")}</h3>
              <div className="mb-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={requestGeo}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border text-xs font-bold"
                  style={
                    coords
                      ? { borderColor: "var(--color-primary)", color: "var(--color-primary)" }
                      : undefined
                  }
                >
                  <Crosshair className="h-4 w-4" />
                  {coords ? t("home.nearMe") : t("home.locate")}
                </button>
                <Link
                  to="/map"
                  onClick={() => setMobileFiltersOpen(false)}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl bg-primary px-3 text-xs font-bold text-primary-foreground"
                >
                  <MapIcon className="h-4 w-4" /> {t("home.liveMap")}
                </Link>
              </div>
              <GeographyFilter
                countries={countries}
                regions={regions}
                cities={cities}
                value={geography}
                cityLoading={cityLoading}
                onCityQuery={searchCities}
                onChange={(next) => {
                  setCoords(null);
                  setGeography(next);
                }}
                compact
              />
            </section>

            <section>
              <h3 className="mb-2 text-sm font-black">{t("home.date")}</h3>
              <div className="grid grid-cols-2 gap-2">
                {QUICK.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    aria-pressed={range === item.key}
                    onClick={() => setRange(item.key)}
                    className="min-h-11 rounded-2xl border px-3 py-2 text-left text-xs"
                    style={
                      range === item.key
                        ? {
                            background: "var(--color-accent)",
                            borderColor: "var(--color-primary)",
                            color: "var(--color-primary)",
                          }
                        : undefined
                    }
                  >
                    <span className="block font-bold">{tr(item.label)}</span>
                    <span className="block text-[10px] opacity-70">{tr(item.helper)}</span>
                  </button>
                ))}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-black">{t("home.sort")}</h3>
              <div className="grid grid-cols-3 gap-2">
                <SortButton
                  active={sort === "soon"}
                  onClick={() => setSort("soon")}
                  icon={TrendingUp}
                  label={t("home.soon")}
                />
                <SortButton
                  active={sort === "distance"}
                  onClick={() => setSort("distance")}
                  icon={MapPin}
                  label={t("home.distance")}
                />
                <SortButton
                  active={sort === "popular"}
                  onClick={() => setSort("popular")}
                  icon={Sparkles}
                  label={t("home.top")}
                />
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-black">{t("home.categories")}</h3>
              <div className="flex flex-wrap gap-2">
                {categories.map((category) => (
                  <button
                    key={category.slug}
                    type="button"
                    aria-pressed={cats.has(category.slug)}
                    onClick={() => toggleCat(category.slug)}
                    className="min-h-11 rounded-full border px-3 text-xs font-semibold"
                    style={
                      cats.has(category.slug)
                        ? {
                            background: "var(--color-accent)",
                            borderColor: "var(--color-primary)",
                            color: "var(--color-primary)",
                          }
                        : undefined
                    }
                  >
                    {category.icon ? `${category.icon} ` : ""}
                    {categoryLabel(category.slug, category.name_fr)}
                  </button>
                ))}
              </div>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-black">{t("home.advanced")}</h3>
              <div className="rounded-2xl border p-3">
                <EventFilterPanel value={advancedFilters} onChange={setAdvancedFilters} compact />
              </div>
            </section>
          </div>

          <footer
            className="grid shrink-0 grid-cols-[auto_1fr] gap-2 border-t bg-background px-4 pt-3"
            style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom, 0px))" }}
          >
            <button
              type="button"
              onClick={resetFilters}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border px-3 text-xs font-bold"
            >
              <RotateCcw className="h-4 w-4" /> {t("common.reset")}
            </button>
            <button
              type="button"
              onClick={() => setMobileFiltersOpen(false)}
              className="min-h-12 rounded-2xl bg-primary px-4 text-sm font-black text-primary-foreground"
            >
              {statsLoading
                ? "Calcul du total…"
                : `Voir ${COUNT_FORMATTER.format(stats.total_count)} sortie${stats.total_count > 1 ? "s" : ""}`}
            </button>
          </footer>
        </div>
      )}

      <div className="glass sticky top-16 z-30 mb-4 hidden rounded-3xl p-3 shadow-[var(--shadow-card)] md:block md:top-20">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("home.searchLongPlaceholder")}
              aria-label={t("home.searchAria")}
              className="h-12 rounded-2xl border-transparent bg-surface/70 pl-11 text-base"
            />
          </div>
          <button
            onClick={requestGeo}
            className="flex h-12 items-center justify-center gap-2 rounded-2xl border px-4 text-sm font-medium hover:bg-accent"
            style={
              coords
                ? { borderColor: "var(--color-primary)", color: "var(--color-primary)" }
                : undefined
            }
          >
            <Crosshair className="h-4 w-4" />
            {coords ? t("home.nearMe") : t("home.locate")}
          </button>
          <Link
            to="/map"
            className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground btn-glow"
          >
            <MapIcon className="h-4 w-4" /> {t("home.liveMap")}
          </Link>
        </div>
        <div className="mt-3 border-t pt-3">
          <GeographyFilter
            countries={countries}
            regions={regions}
            cities={cities}
            value={geography}
            cityLoading={cityLoading}
            onCityQuery={searchCities}
            onChange={(next) => {
              setCoords(null);
              setGeography(next);
            }}
          />
        </div>
      </div>

      <div className="mb-4 hidden gap-3 md:grid lg:grid-cols-[1fr_auto] lg:items-center">
        <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
          {QUICK.map((q) => (
            <button
              key={q.key}
              onClick={() => setRange(q.key)}
              className="group shrink-0 rounded-2xl border px-4 py-2 text-left transition-all hover:bg-accent"
              style={
                range === q.key
                  ? {
                      background: "var(--color-primary)",
                      color: "var(--color-primary-foreground)",
                      borderColor: "transparent",
                    }
                  : {}
              }
            >
              <span className="block text-sm font-semibold">{tr(q.label)}</span>
              <span className="block text-[11px] opacity-70">{tr(q.helper)}</span>
            </button>
          ))}
          <button
            onClick={() =>
              setAdvancedFilters((current) => ({
                ...current,
                priceMode: current.priceMode === "free" ? "all" : "free",
              }))
            }
            aria-pressed={advancedFilters.priceMode === "free"}
            className="shrink-0 rounded-2xl border px-4 py-2 text-sm font-semibold"
            style={
              advancedFilters.priceMode === "free"
                ? {
                    background: "var(--color-secondary)",
                    color: "var(--color-secondary-foreground)",
                    borderColor: "transparent",
                  }
                : {}
            }
          >
            <Ticket className="mb-1 h-4 w-4" /> {t("common.free")}
          </button>
        </div>
        <div className="flex gap-2">
          <SortButton
            active={sort === "soon"}
            onClick={() => setSort("soon")}
            icon={TrendingUp}
            label={t("home.soon")}
          />
          <SortButton
            active={sort === "distance"}
            onClick={() => setSort("distance")}
            icon={MapPin}
            label={t("home.distance")}
          />
          <SortButton
            active={sort === "popular"}
            onClick={() => setSort("popular")}
            icon={Sparkles}
            label={t("home.top")}
          />
        </div>
      </div>

      <div className="no-scrollbar mb-5 hidden gap-2 overflow-x-auto pb-1 md:flex">
        {categories.map((c) => (
          <button
            key={c.slug}
            onClick={() => toggleCat(c.slug)}
            className="shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium capitalize transition-colors hover:bg-accent"
            style={
              cats.has(c.slug)
                ? {
                    background: "var(--color-accent)",
                    borderColor: "var(--color-primary)",
                    color: "var(--color-primary)",
                  }
                : {}
            }
          >
            {c.icon ? `${c.icon} ` : ""}
            {categoryLabel(c.slug, c.name_fr)}
          </button>
        ))}
      </div>

      <details className="glass mb-5 hidden rounded-3xl border md:block" open={advancedCount > 0}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold">
          <span className="inline-flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-primary" /> {t("home.advanced")}
          </span>
          <Badge variant={advancedCount ? "default" : "outline"}>
            {advancedCount ? advancedCount : t("common.all")}
          </Badge>
        </summary>
        <div className="border-t p-3">
          <EventFilterPanel value={advancedFilters} onChange={setAdvancedFilters} compact />
        </div>
      </details>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">
            {loading
              ? t("home.searching")
              : statsLoading
                ? `${COUNT_FORMATTER.format(sortedEvents.length)} sorties chargées · calcul du total…`
                : `${COUNT_FORMATTER.format(stats.total_count)} sorties au total · ${COUNT_FORMATTER.format(sortedEvents.length)} chargées`}
          </p>
          <p className="text-xs text-muted-foreground">
            {coords
              ? "Autour de moi"
              : (selectedCity?.name ??
                selectedRegion?.name ??
                selectedCountry?.name ??
                t("home.world"))}
            {activeCategoryNames.length
              ? ` · ${activeCategoryNames.join(", ")}`
              : ` · ${t("home.allCategories")}`}
          </p>
        </div>
        <button
          onClick={resetFilters}
          className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" /> {t("common.reset")}
        </button>
      </div>

      {landingMode && landingCollections && (
        <div className="mb-10 space-y-9">
          <EventCollection
            title={tr("Les incontournables")}
            eyebrow={tr("Sélection Global Party")}
            events={landingCollections.top}
            onSeeAll={() => setSort("popular")}
          />
          <EventCollection
            title={tr("Sortir gratuitement")}
            eyebrow={tr("Petits budgets, grandes idées")}
            events={landingCollections.free}
            onSeeAll={() => setAdvancedFilters((current) => ({ ...current, priceMode: "free" }))}
          />
          <EventCollection
            title={tr("La nuit t’appartient")}
            eyebrow={tr("Clubs & soirées")}
            events={landingCollections.nightlife}
            onSeeAll={() => setCats(new Set(["soirees"]))}
          />
          <EventCollection
            title={tr("Festivals à ne pas manquer")}
            eyebrow={tr("Prépare ton prochain week-end")}
            events={landingCollections.festivals}
            onSeeAll={() => setCats(new Set(["festivals"]))}
          />
          <div className="border-t pt-8">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              {tr("Catalogue complet")}
            </p>
            <h2 className="mt-1 text-2xl font-black">{tr("Tout ce qui arrive bientôt")}</h2>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <span className="flex items-center gap-2">
            <CircleAlert className="h-4 w-4" /> {error}
          </span>
          <button
            onClick={() => setReloadKey((value) => value + 1)}
            className="font-semibold underline"
          >
            {t("common.retry")}
          </button>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <EventCardSkeleton key={i} />
          ))}
        </div>
      ) : sortedEvents.length ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {sortedEvents.map((e) => (
              <EventCard key={e.occurrence_id} ev={e} />
            ))}
          </div>
          {hasMore && (
            <div className="flex flex-col items-center gap-2 py-8">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="btn-glow inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-primary px-7 py-3 text-sm font-semibold text-primary-foreground disabled:cursor-wait disabled:opacity-70"
              >
                {loadingMore && <LoaderCircle className="h-4 w-4 animate-spin" />}
                {loadingMore
                  ? t("common.loading")
                  : `Charger ${COUNT_FORMATTER.format(nextPageCount)} événements supplémentaires`}
              </button>
              <p className="text-xs text-muted-foreground">
                {tr("Aucun plafond global : continue jusqu'au dernier événement correspondant.")}
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="glass flex flex-col items-center justify-center rounded-3xl p-12 text-center">
          <SlidersHorizontal className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="font-semibold">{tr("Aucun événement ne matche ces critères")}</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {tr(
              "Élargis la période, retire une catégorie ou explore la carte pour trouver des idées proches.",
            )}
          </p>
          <button
            onClick={resetFilters}
            className="mt-5 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground"
          >
            {tr("Voir toutes les sorties")}
          </button>
        </div>
      )}
    </div>
  );
}

function EventCollection({
  title,
  eyebrow,
  events,
  onSeeAll,
}: {
  title: string;
  eyebrow: string;
  events: DiscoveredEvent[];
  onSeeAll: () => void;
}) {
  const { tr } = useTranslation();
  if (!events.length) return null;
  return (
    <section aria-label={title}>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            {eyebrow}
          </p>
          <h2 className="mt-1 text-2xl font-black md:text-3xl">{title}</h2>
        </div>
        <button
          type="button"
          onClick={onSeeAll}
          className="shrink-0 text-sm font-semibold text-primary"
        >
          {tr("Voir tout →")}
        </button>
      </div>
      <div className="no-scrollbar flex snap-x gap-4 overflow-x-auto pb-3">
        {events.map((event) => (
          <div key={event.occurrence_id} className="w-[17.5rem] shrink-0 snap-start sm:w-[19rem]">
            <EventCard ev={event} />
          </div>
        ))}
      </div>
    </section>
  );
}

function HeroStat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Sparkles;
  label: string;
  value: string;
}) {
  return (
    <div className="glass rounded-2xl p-3 md:p-4">
      <Icon className="mb-2 h-4 w-4 text-primary" />
      <div className="text-2xl font-black md:text-3xl">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

function SortButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Sparkles;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border px-3 py-2 text-xs font-semibold transition-colors hover:bg-accent"
      style={
        active
          ? {
              background: "var(--color-surface-2)",
              borderColor: "var(--color-primary)",
              color: "var(--color-primary)",
            }
          : {}
      }
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}
