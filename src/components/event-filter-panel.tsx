import { BadgeCheck, MapPinCheck, TicketCheck, Accessibility } from "lucide-react";
import {
  MUSIC_GENRES,
  type AdvancedEventFilters,
  type CapacityMode,
  type PriceMode,
} from "@/lib/event-filters";

export function EventFilterPanel({
  value,
  onChange,
  compact = false,
}: {
  value: AdvancedEventFilters;
  onChange: (next: AdvancedEventFilters) => void;
  compact?: boolean;
}) {
  const update = <K extends keyof AdvancedEventFilters>(key: K, next: AdvancedEventFilters[K]) =>
    onChange({ ...value, [key]: next });

  const toggleGenre = (genre: string) => {
    update(
      "genres",
      value.genres.includes(genre)
        ? value.genres.filter((item) => item !== genre)
        : [...value.genres, genre],
    );
  };

  return (
    <div className={compact ? "space-y-3" : "space-y-4 rounded-3xl border bg-surface/40 p-4"}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-xs font-semibold">
          Prix d'entrée / ticket
          <select
            value={value.priceMode}
            onChange={(event) => update("priceMode", event.target.value as PriceMode)}
            className="h-11 w-full rounded-2xl border bg-background/80 px-3 text-sm font-normal outline-none focus:border-primary"
          >
            <option value="all">Tous les prix</option>
            <option value="free">Gratuit</option>
            <option value="under-20">Jusqu'à CHF 20</option>
            <option value="under-40">Jusqu'à CHF 40</option>
            <option value="over-40">Dès CHF 40</option>
            <option value="known">Prix renseigné</option>
          </select>
        </label>
        <label className="space-y-1.5 text-xs font-semibold">
          Nombre de personnes
          <select
            value={value.capacityMode}
            onChange={(event) => update("capacityMode", event.target.value as CapacityMode)}
            className="h-11 w-full rounded-2xl border bg-background/80 px-3 text-sm font-normal outline-none focus:border-primary"
          >
            <option value="all">Toutes les jauges</option>
            <option value="intimate">Intime · jusqu'à 200</option>
            <option value="club">Club · 201 à 800</option>
            <option value="large">Grande salle · 801 à 5 000</option>
            <option value="festival">Festival · plus de 5 000</option>
            <option value="unknown">Capacité non précisée</option>
          </select>
        </label>
      </div>

      <fieldset>
        <legend className="mb-2 text-xs font-semibold">Style musical</legend>
        <div className="no-scrollbar flex max-h-24 flex-wrap gap-1.5 overflow-y-auto pr-1">
          {MUSIC_GENRES.map(([slug, label]) => {
            const active = value.genres.includes(slug);
            return (
              <button
                key={slug}
                type="button"
                aria-pressed={active}
                onClick={() => toggleGenre(slug)}
                className="rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
                style={
                  active
                    ? {
                        borderColor: "var(--color-primary)",
                        color: "var(--color-primary)",
                        background: "var(--color-accent)",
                      }
                    : undefined
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-2">
        <FilterToggle
          active={value.ticketsOnly}
          icon={TicketCheck}
          label="Billets disponibles"
          onClick={() => update("ticketsOnly", !value.ticketsOnly)}
        />
        <FilterToggle
          active={value.verifiedOnly}
          icon={BadgeCheck}
          label="Événements vérifiés"
          onClick={() => update("verifiedOnly", !value.verifiedOnly)}
        />
        <FilterToggle
          active={value.accessibleOnly}
          icon={Accessibility}
          label="Accessible PMR"
          onClick={() => update("accessibleOnly", !value.accessibleOnly)}
        />
        <FilterToggle
          active={value.venueOnly}
          icon={MapPinCheck}
          label="Lieu confirmé"
          onClick={() => update("venueOnly", !value.venueOnly)}
        />
      </div>
    </div>
  );
}

function FilterToggle({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: typeof TicketCheck;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="flex min-h-11 items-center gap-2 rounded-2xl border px-3 py-2 text-left text-xs font-medium transition-colors hover:bg-accent"
      style={
        active
          ? {
              borderColor: "var(--color-primary)",
              color: "var(--color-primary)",
              background: "var(--color-accent)",
            }
          : undefined
      }
    >
      <Icon className="h-4 w-4 shrink-0" /> {label}
    </button>
  );
}
