import {
  Accessibility,
  BadgeCheck,
  CircleDollarSign,
  Clock3,
  Landmark,
  MapPinCheck,
  TicketCheck,
  type LucideIcon,
} from "lucide-react";
import {
  PLACE_CATEGORIES,
  type AdvancedEventFilters,
  type CapacityMode,
  type DiscoveryContentMode,
  type PriceMode,
} from "@/lib/event-filters";
import {
  SEARCH_CATEGORIES,
  searchCategoryLabel,
  searchSubcategoryLabel,
} from "@/lib/event-search-taxonomy";
import { useTranslation } from "@/lib/i18n";

export function EventFilterPanel({
  value,
  onChange,
  selectedCategorySlugs = [],
  compact = false,
}: {
  value: AdvancedEventFilters;
  onChange: (next: AdvancedEventFilters) => void;
  selectedCategorySlugs?: readonly string[];
  compact?: boolean;
}) {
  const { t, tr, locale } = useTranslation();
  const update = <K extends keyof AdvancedEventFilters>(key: K, next: AdvancedEventFilters[K]) =>
    onChange({ ...value, [key]: next });
  const selectedCategorySet = new Set(selectedCategorySlugs);
  const selectedCategories = SEARCH_CATEGORIES.filter((category) =>
    selectedCategorySet.has(category.slug),
  );
  const showEvents = value.contentMode !== "places";
  const showPlaces = value.contentMode !== "events";

  const toggleGenre = (genre: string) => {
    update(
      "genres",
      value.genres.includes(genre)
        ? value.genres.filter((item) => item !== genre)
        : [...value.genres, genre],
    );
  };

  const toggleSubcategory = (subcategory: string) => {
    update(
      "subcategories",
      value.subcategories.includes(subcategory)
        ? value.subcategories.filter((item) => item !== subcategory)
        : [...value.subcategories, subcategory],
    );
  };

  const togglePlaceCategory = (category: string) => {
    update(
      "placeCategories",
      value.placeCategories.includes(category)
        ? value.placeCategories.filter((item) => item !== category)
        : [...value.placeCategories, category],
    );
  };

  return (
    <div className={compact ? "space-y-3" : "space-y-4 rounded-3xl border bg-surface/40 p-4"}>
      <fieldset className="rounded-2xl border bg-background/45 p-3">
        <legend className="px-1 text-xs font-semibold">{tr("Type de contenu")}</legend>
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {([
            ["events", tr("Événements")],
            ["places", tr("Lieux à visiter")],
            ["all", tr("Tout")],
          ] as const).map(([mode, label]) => {
            const active = value.contentMode === mode;
            return (
              <button
                key={mode}
                type="button"
                aria-pressed={active}
                onClick={() => update("contentMode", mode as DiscoveryContentMode)}
                className="min-h-10 rounded-xl border px-2 text-[11px] font-bold transition-colors hover:bg-accent"
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

      {showPlaces && (
        <fieldset className="rounded-2xl border bg-background/45 p-3">
          <legend className="px-1 text-xs font-semibold">{tr("Lieux d’intérêt")}</legend>
          <div className="mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
            {PLACE_CATEGORIES.map(([slug, label, icon]) => {
              const active = value.placeCategories.includes(slug);
              return (
                <button
                  key={slug}
                  type="button"
                  aria-pressed={active}
                  onClick={() => togglePlaceCategory(slug)}
                  className="min-h-9 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
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
                  <span aria-hidden="true">{icon} </span>
                  {label}
                </button>
              );
            })}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <FilterToggle
              active={value.openNowOnly}
              icon={Clock3}
              label={tr("Horaires renseignés")}
              onClick={() => update("openNowOnly", !value.openNowOnly)}
            />
            <FilterToggle
              active={value.freePlacesOnly}
              icon={CircleDollarSign}
              label={tr("Accès gratuit")}
              onClick={() => update("freePlacesOnly", !value.freePlacesOnly)}
            />
          </div>
        </fieldset>
      )}

      {showEvents && (
        <>
          <fieldset>
            <legend className="mb-2 text-xs font-semibold">{t("filters.subcategories")}</legend>
            {selectedCategories.length ? (
              <div className="space-y-3">
                {selectedCategories.map((category) => (
                  <div key={category.slug} className="rounded-2xl border bg-background/45 p-3">
                    <p className="mb-2 text-xs font-black" style={{ color: category.color }}>
                      {category.icon} {searchCategoryLabel(locale, category)}
                    </p>
                    <div className="no-scrollbar flex max-h-36 flex-wrap gap-1.5 overflow-y-auto pr-1">
                      {category.subcategories.map((subcategory) => {
                        const active =
                          subcategory.kind === "genre"
                            ? value.genres.includes(subcategory.slug)
                            : value.subcategories.includes(subcategory.slug);
                        return (
                          <button
                            key={subcategory.slug}
                            type="button"
                            aria-pressed={active}
                            onClick={() =>
                              subcategory.kind === "genre"
                                ? toggleGenre(subcategory.slug)
                                : toggleSubcategory(subcategory.slug)
                            }
                            className="min-h-9 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
                            style={
                              active
                                ? {
                                    borderColor: category.color,
                                    color: category.color,
                                    background: `${category.color}18`,
                                  }
                                : undefined
                            }
                          >
                            <span aria-hidden="true">{subcategory.icon} </span>
                            {searchSubcategoryLabel(locale, subcategory)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-2xl border border-dashed px-3 py-4 text-xs text-muted-foreground">
                {t("filters.chooseCategory")}
              </p>
            )}
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs font-semibold">
              {t("filters.price")}
              <select
                value={value.priceMode}
                onChange={(event) => update("priceMode", event.target.value as PriceMode)}
                className="h-11 w-full rounded-2xl border bg-background/80 px-3 text-sm font-normal outline-none focus:border-primary"
              >
                <option value="all">{t("filters.allPrices")}</option>
                <option value="free">{t("common.free")}</option>
                <option value="under-20">{t("filters.under20")}</option>
                <option value="under-40">{t("filters.under40")}</option>
                <option value="over-40">{t("filters.over40")}</option>
                <option value="known">{t("filters.knownPrice")}</option>
              </select>
            </label>
            <label className="space-y-1.5 text-xs font-semibold">
              {t("filters.capacity")}
              <select
                value={value.capacityMode}
                onChange={(event) => update("capacityMode", event.target.value as CapacityMode)}
                className="h-11 w-full rounded-2xl border bg-background/80 px-3 text-sm font-normal outline-none focus:border-primary"
              >
                <option value="all">{t("filters.allCapacities")}</option>
                <option value="intimate">{t("filters.intimate")}</option>
                <option value="club">{t("filters.club")}</option>
                <option value="large">{t("filters.large")}</option>
                <option value="festival">{t("filters.festival")}</option>
                <option value="unknown">{t("filters.unknownCapacity")}</option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <FilterToggle
              active={value.ticketsOnly}
              icon={TicketCheck}
              label={t("filters.tickets")}
              onClick={() => update("ticketsOnly", !value.ticketsOnly)}
            />
            <FilterToggle
              active={value.verifiedOnly}
              icon={BadgeCheck}
              label={t("filters.verified")}
              onClick={() => update("verifiedOnly", !value.verifiedOnly)}
            />
            <FilterToggle
              active={value.venueOnly}
              icon={MapPinCheck}
              label={t("filters.confirmedVenue")}
              onClick={() => update("venueOnly", !value.venueOnly)}
            />
            <FilterToggle
              active={value.accessibleOnly}
              icon={Accessibility}
              label={t("filters.accessible")}
              onClick={() => update("accessibleOnly", !value.accessibleOnly)}
            />
          </div>
        </>
      )}

      {!showEvents && (
        <FilterToggle
          active={value.accessibleOnly}
          icon={Accessibility}
          label={t("filters.accessible")}
          onClick={() => update("accessibleOnly", !value.accessibleOnly)}
        />
      )}

      {showPlaces && !showEvents && (
        <div className="flex items-center gap-2 rounded-2xl border border-dashed p-3 text-xs text-muted-foreground">
          <Landmark className="h-4 w-4 shrink-0 text-primary" />
          {tr("Les lieux se regroupent automatiquement sur la carte et s’ouvrent dans une fiche détaillée.")}
        </div>
      )}
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
  icon: LucideIcon;
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
