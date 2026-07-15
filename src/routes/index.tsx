import { Link, createFileRoute } from "@tanstack/react-router";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
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
} from "lucide-react";
import {
  discoverEvents,
  fetchCategories,
  fetchGeographies,
  searchGeographyCities,
  computeRange,
  type CityOption,
  type CountryOption,
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

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "EVENTA — Découvre les événements ce soir, ce week-end, près de toi" },
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

const QUICK: { key: QuickRange; label: string; helper: string }[] = [
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
  const [landingCollections, setLandingCollections] = useState<LandingCollections | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const requestVersionRef = useRef(0);
  const cityRequestVersionRef = useRef(0);
  const deferredQuery = useDeferredValue(query.trim());
  const advancedCount = countAdvancedFilters(advancedFilters);

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
    () => categories.filter((c) => cats.has(c.slug)).map((c) => c.name_fr),
    [categories, cats],
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
    setNextOffset(0);
    setHasMore(false);
    setError(null);
    discoverEvents({
      ...discoveryParams,
      limit: EVENT_PAGE_SIZE,
      offset: 0,
    })
      .then((data) => {
        if (!current || requestVersion !== requestVersionRef.current) return;
        setEvents(data);
        setNextOffset(data.length);
        setHasMore(data.length === EVENT_PAGE_SIZE);
      })
      .catch(() => {
        if (!current) return;
        setEvents([]);
        setError("Le catalogue n'a pas pu être chargé. Réessaie dans un instant.");
      })
      .finally(() => {
        if (current) setLoading(false);
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
      setHasMore(page.length === EVENT_PAGE_SIZE);
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

  const stats = useMemo(() => {
    const list = events ?? [];
    return {
      total: list.length,
      free: list.filter((e) => e.is_free).length,
      verified: list.filter((e) => e.is_verified).length,
    };
  }, [events]);

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

  return (
    <div className="mx-auto max-w-7xl px-4 pt-6 md:px-6 md:pt-10">
      <section className="relative mb-6 overflow-hidden rounded-[2rem] border p-5 md:mb-8 md:p-8">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_20%_10%,oklch(0.68_0.22_295_/_0.35),transparent_32%),radial-gradient(circle_at_82%_18%,oklch(0.72_0.18_35_/_0.22),transparent_30%),linear-gradient(135deg,oklch(0.19_0.03_265_/_0.92),oklch(0.12_0.03_265_/_0.86))]" />
        <div className="grid gap-8 lg:grid-cols-[1.35fr_0.65fr] lg:items-end">
          <div>
            <Badge className="mb-5 border-transparent bg-primary/15 px-3 py-1 text-primary">
              <Flame className="mr-1.5 h-3.5 w-3.5" /> Catalogue mondial · mis à jour en continu
            </Badge>
            <h1 className="max-w-4xl text-4xl font-black leading-[0.95] md:text-7xl">
              Trouve le bon plan avant qu'il ne disparaisse.
            </h1>
            <p className="mt-5 max-w-2xl text-base text-muted-foreground md:text-lg">
              EVENTA transforme le monde en radar culturel : clubs, concerts, festivals et sorties
              réunis depuis les agendas officiels, puis vérifiés et dédupliqués.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 lg:grid-cols-1">
            <HeroStat
              icon={CalendarDays}
              label="chargés"
              value={loading ? "…" : `${stats.total}${hasMore ? "+" : ""}`}
            />
            <HeroStat
              icon={Ticket}
              label="gratuits"
              value={loading ? "…" : stats.free.toString()}
            />
            <HeroStat
              icon={Star}
              label="vérifiés"
              value={loading ? "…" : stats.verified.toString()}
            />
          </div>
        </div>
      </section>

      <TargetedCampaigns placement="discover" />

      <section className="mb-7" aria-labelledby="vibe-title">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Inspiration instantanée
            </p>
            <h2 id="vibe-title" className="mt-1 text-2xl font-black md:text-3xl">
              Tu cherches quelle ambiance ?
            </h2>
          </div>
          <Link to="/map" className="hidden text-sm font-semibold text-primary sm:inline-flex">
            Explorer la carte →
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
                <span className="block text-lg font-black">{vibe.label}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{vibe.helper}</span>
              </button>
            );
          })}
        </div>
      </section>

      <div className="glass sticky top-16 z-30 mb-4 rounded-3xl p-3 shadow-[var(--shadow-card)] md:top-20">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Concert gratuit ce soir, rooftop, expo immersive…"
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
            {coords ? "Autour de moi" : "Me localiser"}
          </button>
          <Link
            to="/map"
            className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground btn-glow"
          >
            <MapIcon className="h-4 w-4" /> Carte live
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

      <div className="mb-4 grid gap-3 lg:grid-cols-[1fr_auto] lg:items-center">
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
              <span className="block text-sm font-semibold">{q.label}</span>
              <span className="block text-[11px] opacity-70">{q.helper}</span>
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
            <Ticket className="mb-1 h-4 w-4" /> Gratuit
          </button>
        </div>
        <div className="flex gap-2">
          <SortButton
            active={sort === "soon"}
            onClick={() => setSort("soon")}
            icon={TrendingUp}
            label="Bientôt"
          />
          <SortButton
            active={sort === "distance"}
            onClick={() => setSort("distance")}
            icon={MapPin}
            label="Distance"
          />
          <SortButton
            active={sort === "popular"}
            onClick={() => setSort("popular")}
            icon={Sparkles}
            label="Top"
          />
        </div>
      </div>

      <div className="no-scrollbar mb-5 flex gap-2 overflow-x-auto pb-1">
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
            {c.name_fr}
          </button>
        ))}
      </div>

      <details className="glass mb-5 rounded-3xl border" open={advancedCount > 0}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold">
          <span className="inline-flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-primary" /> Prix, musique, jauge et accès
          </span>
          <Badge variant={advancedCount ? "default" : "outline"}>
            {advancedCount ? `${advancedCount} actifs` : "Tous"}
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
              ? "Recherche des meilleurs plans…"
              : `${sortedEvents.length} sorties chargées${hasMore ? " · d'autres sont disponibles" : ""}`}
          </p>
          <p className="text-xs text-muted-foreground">
            {coords
              ? "Autour de moi"
              : (selectedCity?.name ??
                selectedRegion?.name ??
                selectedCountry?.name ??
                "Monde entier")}
            {activeCategoryNames.length
              ? ` · ${activeCategoryNames.join(", ")}`
              : " · Toutes catégories"}
          </p>
        </div>
        <button
          onClick={resetFilters}
          className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Réinitialiser
        </button>
      </div>

      {landingMode && landingCollections && (
        <div className="mb-10 space-y-9">
          <EventCollection
            title="Les incontournables"
            eyebrow="Sélection EVENTA"
            events={landingCollections.top}
            onSeeAll={() => setSort("popular")}
          />
          <EventCollection
            title="Sortir gratuitement"
            eyebrow="Petits budgets, grandes idées"
            events={landingCollections.free}
            onSeeAll={() => setAdvancedFilters((current) => ({ ...current, priceMode: "free" }))}
          />
          <EventCollection
            title="La nuit t’appartient"
            eyebrow="Clubs & soirées"
            events={landingCollections.nightlife}
            onSeeAll={() => setCats(new Set(["soirees"]))}
          />
          <EventCollection
            title="Festivals à ne pas manquer"
            eyebrow="Prépare ton prochain week-end"
            events={landingCollections.festivals}
            onSeeAll={() => setCats(new Set(["festivals"]))}
          />
          <div className="border-t pt-8">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Catalogue complet
            </p>
            <h2 className="mt-1 text-2xl font-black">Tout ce qui arrive bientôt</h2>
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
            Réessayer
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
                  ? "Chargement…"
                  : `Charger ${EVENT_PAGE_SIZE} événements supplémentaires`}
              </button>
              <p className="text-xs text-muted-foreground">
                Aucun plafond global : continue jusqu'au dernier événement correspondant.
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="glass flex flex-col items-center justify-center rounded-3xl p-12 text-center">
          <SlidersHorizontal className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="font-semibold">Aucun événement ne matche ces critères</p>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Élargis la période, retire une catégorie ou explore la carte pour trouver des idées
            proches.
          </p>
          <button
            onClick={resetFilters}
            className="mt-5 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground"
          >
            Voir toutes les sorties
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
          Voir tout →
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
      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs font-semibold transition-colors hover:bg-accent"
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
