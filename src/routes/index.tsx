import { Link, createFileRoute } from "@tanstack/react-router";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  CircleAlert,
  Crosshair,
  Flame,
  LayoutGrid,
  Map as MapIcon,
  MapPin,
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
  fetchCities,
  computeRange,
  type DiscoveredEvent,
  type QuickRange,
} from "@/lib/queries";
import { EventCard, EventCardSkeleton } from "@/components/event-card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

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

type City = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  latitude: number | null;
  longitude: number | null;
};
type Category = { slug: string; name_fr: string; icon: string | null };
type SortMode = "soon" | "distance" | "popular";

const QUICK: { key: QuickRange; label: string; helper: string }[] = [
  { key: "now", label: "Maintenant", helper: "2 prochaines heures" },
  { key: "tonight", label: "Ce soir", helper: "18h → 6h" },
  { key: "today", label: "Aujourd'hui", helper: "Jusqu'à minuit" },
  { key: "tomorrow", label: "Demain", helper: "Toute la journée" },
  { key: "weekend", label: "Ce week-end", helper: "Vendredi → dimanche" },
  { key: "week", label: "7 jours", helper: "Planning complet" },
  { key: "month", label: "30 jours", helper: "Tous les événements" },
];

function Discover() {
  const [cities, setCities] = useState<City[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [cityId, setCityId] = useState<string | null>(null);
  const [range, setRange] = useState<QuickRange>("month");
  const [cats, setCats] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [sort, setSort] = useState<SortMode>("soon");
  const [events, setEvents] = useState<DiscoveredEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const deferredQuery = useDeferredValue(query.trim());

  useEffect(() => {
    fetchCities().then((c) => {
      setCities(c as City[]);
      const geneva = (c as City[]).find((city) => city.slug === "geneve");
      if (!cityId && c.length) setCityId(geneva?.id ?? (c[0] as City).id);
    });
    fetchCategories().then((c) => setCategories(c as Category[]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { from, to } = useMemo(() => computeRange(range), [range]);
  const selectedCity = useMemo(() => cities.find((c) => c.id === cityId) ?? null, [cities, cityId]);
  const activeCategoryNames = useMemo(
    () => categories.filter((c) => cats.has(c.slug)).map((c) => c.name_fr),
    [categories, cats],
  );

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    discoverEvents({
      lat: coords?.lat ?? null,
      lon: coords?.lon ?? null,
      radiusKm: coords ? 25 : 500,
      cityId,
      categorySlugs: cats.size ? [...cats] : null,
      freeOnly,
      query: deferredQuery,
      from,
      to,
      limit: 120,
    })
      .then((data) => {
        if (current) setEvents(data);
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
  }, [cityId, cats, freeOnly, deferredQuery, from, to, coords, reloadKey]);

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
      (p) => setCoords({ lat: p.coords.latitude, lon: p.coords.longitude }),
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
    setCats(new Set());
    setQuery("");
    setFreeOnly(false);
    setCoords(null);
    setRange("month");
    setSort("soon");
  };

  return (
    <div className="mx-auto max-w-7xl px-4 pt-6 md:px-6 md:pt-10">
      <section className="relative mb-6 overflow-hidden rounded-[2rem] border p-5 md:mb-8 md:p-8">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_20%_10%,oklch(0.68_0.22_295_/_0.35),transparent_32%),radial-gradient(circle_at_82%_18%,oklch(0.72_0.18_35_/_0.22),transparent_30%),linear-gradient(135deg,oklch(0.19_0.03_265_/_0.92),oklch(0.12_0.03_265_/_0.86))]" />
        <div className="grid gap-8 lg:grid-cols-[1.35fr_0.65fr] lg:items-end">
          <div>
            <Badge className="mb-5 border-transparent bg-primary/15 px-3 py-1 text-primary">
              <Flame className="mr-1.5 h-3.5 w-3.5" /> Genève & Suisse romande · catalogue live
            </Badge>
            <h1 className="max-w-4xl text-4xl font-black leading-[0.95] md:text-7xl">
              Trouve le bon plan avant qu'il ne disparaisse.
            </h1>
            <p className="mt-5 max-w-2xl text-base text-muted-foreground md:text-lg">
              EVENTA transforme la région en radar culturel : clubs, concerts, festivals et sorties
              gratuites réunis depuis les agendas officiels, puis vérifiés et dédupliqués.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 lg:grid-cols-1">
            <HeroStat
              icon={CalendarDays}
              label="événements"
              value={loading ? "…" : stats.total.toString()}
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
          <select
            value={cityId ?? ""}
            onChange={(e) => setCityId(e.target.value || null)}
            className="h-12 rounded-2xl border bg-surface/70 px-4 text-sm outline-none focus:border-primary"
          >
            <option value="">Toutes les villes</option>
            {cities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
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
            onClick={() => setFreeOnly((v) => !v)}
            className="shrink-0 rounded-2xl border px-4 py-2 text-sm font-semibold"
            style={
              freeOnly
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

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">
            {loading ? "Recherche des meilleurs plans…" : `${sortedEvents.length} sorties trouvées`}
          </p>
          <p className="text-xs text-muted-foreground">
            {selectedCity ? selectedCity.name : "Toutes les villes"}
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {sortedEvents.map((e) => (
            <EventCard key={e.occurrence_id} ev={e} />
          ))}
        </div>
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
