import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Search, MapPin, Sparkles, Filter, LayoutGrid, Map as MapIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { discoverEvents, fetchCategories, fetchCities, computeRange, type DiscoveredEvent, type QuickRange } from "@/lib/queries";
import { EventCard, EventCardSkeleton } from "@/components/event-card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "EVENTA — Découvre les événements ce soir, ce week-end, près de toi" },
      { name: "description", content: "Concerts, soirées, festivals, expositions, sports, famille. Trouve les meilleurs événements maintenant, ce soir ou ce week-end." },
    ],
  }),
  component: Discover,
});

type City = { id: string; slug: string; name: string; timezone: string; latitude: number | null; longitude: number | null };
type Category = { slug: string; name_fr: string; icon: string | null };

const QUICK: { key: QuickRange; label: string }[] = [
  { key: "now", label: "Maintenant" },
  { key: "tonight", label: "Ce soir" },
  { key: "today", label: "Aujourd'hui" },
  { key: "tomorrow", label: "Demain" },
  { key: "weekend", label: "Ce week-end" },
];

function Discover() {
  const [cities, setCities] = useState<City[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [cityId, setCityId] = useState<string | null>(null);
  const [range, setRange] = useState<QuickRange>("week");
  const [cats, setCats] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [view, setView] = useState<"list" | "map">("list");
  const [events, setEvents] = useState<DiscoveredEvent[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchCities().then((c) => {
      setCities(c as City[]);
      if (!cityId && c.length) setCityId((c[0] as City).id);
    });
    fetchCategories().then((c) => setCategories(c as Category[]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { from, to } = useMemo(() => computeRange(range), [range]);

  useEffect(() => {
    setLoading(true);
    discoverEvents({
      lat: coords?.lat ?? null,
      lon: coords?.lon ?? null,
      radiusKm: coords ? 25 : 500,
      cityId,
      categorySlugs: cats.size ? [...cats] : null,
      freeOnly,
      query,
      from,
      to,
      limit: 60,
    })
      .then((d) => setEvents(d))
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [cityId, cats, freeOnly, query, from, to, coords]);

  const requestGeo = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => setCoords({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => {},
      { enableHighAccuracy: false, timeout: 6000 }
    );
  };

  const toggleCat = (slug: string) => {
    const next = new Set(cats);
    next.has(slug) ? next.delete(slug) : next.add(slug);
    setCats(next);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 pt-6 md:px-6 md:pt-10">
      {/* Hero */}
      <section className="mb-6 md:mb-10">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Découvrir</p>
        <h1 className="mt-1 text-3xl font-bold md:text-5xl">
          Qu'est-ce qu'il se passe <span className="text-gradient">ce soir</span> ?
        </h1>
      </section>

      {/* Search + city + geo + view toggle */}
      <div className="glass mb-4 flex flex-col gap-2 rounded-2xl p-3 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Concert gratuit ce soir, festival ce week-end…"
            className="border-transparent bg-transparent pl-9"
          />
        </div>
        <select
          value={cityId ?? ""}
          onChange={(e) => setCityId(e.target.value || null)}
          className="rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-primary"
        >
          <option value="">Toutes les villes</option>
          {cities.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <button
          onClick={requestGeo}
          className="flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm hover:bg-accent"
          style={coords ? { borderColor: "var(--color-primary)", color: "var(--color-primary)" } : undefined}
        >
          <MapPin className="h-4 w-4" />{coords ? "Position OK" : "Ma position"}
        </button>
        <div className="flex overflow-hidden rounded-lg border">
          <button onClick={() => setView("list")} className="px-3 py-2" style={view === "list" ? { background: "var(--color-primary)", color: "var(--color-primary-foreground)" } : {}}>
            <LayoutGrid className="h-4 w-4" />
          </button>
          <Link to="/map" className="px-3 py-2">
            <MapIcon className="h-4 w-4" />
          </Link>
        </div>
      </div>

      {/* Quick ranges */}
      <div className="no-scrollbar mb-3 flex gap-2 overflow-x-auto pb-1">
        {QUICK.map((q) => (
          <button
            key={q.key}
            onClick={() => setRange(q.key)}
            className="shrink-0 rounded-full border px-4 py-1.5 text-sm font-medium transition-all"
            style={range === q.key ? { background: "var(--color-primary)", color: "var(--color-primary-foreground)", borderColor: "transparent" } : {}}
          >
            {q.label}
          </button>
        ))}
        <button
          onClick={() => setFreeOnly((v) => !v)}
          className="shrink-0 rounded-full border px-4 py-1.5 text-sm font-medium"
          style={freeOnly ? { background: "var(--color-secondary)", color: "var(--color-secondary-foreground)", borderColor: "transparent" } : {}}
        >
          Gratuit
        </button>
      </div>

      {/* Categories */}
      <div className="no-scrollbar mb-6 flex gap-2 overflow-x-auto pb-1">
        {categories.map((c) => (
          <button
            key={c.slug}
            onClick={() => toggleCat(c.slug)}
            className="shrink-0 rounded-full border px-3 py-1 text-xs font-medium capitalize"
            style={cats.has(c.slug) ? { background: "var(--color-accent)", borderColor: "var(--color-primary)", color: "var(--color-primary)" } : {}}
          >
            {c.name_fr}
          </button>
        ))}
      </div>

      {/* Sections */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => <EventCardSkeleton key={i} />)}
        </div>
      ) : events && events.length ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {events.map((e) => <EventCard key={e.occurrence_id} ev={e} />)}
        </div>
      ) : (
        <div className="glass flex flex-col items-center justify-center rounded-2xl p-12 text-center">
          <Sparkles className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="font-medium">Aucun événement trouvé</p>
          <p className="mt-1 text-sm text-muted-foreground">Essaie une autre plage horaire ou une autre ville.</p>
        </div>
      )}
    </div>
  );
}
