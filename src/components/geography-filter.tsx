import { useMemo } from "react";
import { Building2, Globe2, MapPinned } from "lucide-react";
import type { CityOption, CountryOption, RegionOption } from "@/lib/queries";

export interface GeographySelection {
  countryId: string | null;
  regionId: string | null;
  cityId: string | null;
}

function subdivisionLabel(countryCode?: string) {
  switch (countryCode) {
    case "CH":
      return "Canton";
    case "FR":
      return "Région / département";
    case "US":
      return "État";
    case "CA":
      return "Province";
    default:
      return "Région / province";
  }
}

export function GeographyFilter({
  countries,
  regions,
  cities,
  value,
  onChange,
  compact = false,
}: {
  countries: CountryOption[];
  regions: RegionOption[];
  cities: CityOption[];
  value: GeographySelection;
  onChange: (next: GeographySelection) => void;
  compact?: boolean;
}) {
  const selectedCountry = useMemo(
    () => countries.find((country) => country.id === value.countryId),
    [countries, value.countryId],
  );
  const availableRegions = useMemo(
    () =>
      value.countryId ? regions.filter((region) => region.country_id === value.countryId) : [],
    [regions, value.countryId],
  );
  const availableCities = useMemo(
    () =>
      value.countryId
        ? cities.filter(
            (city) =>
              city.country_id === value.countryId &&
              (!value.regionId || city.region_id === value.regionId),
          )
        : [],
    [cities, value.countryId, value.regionId],
  );
  const regionLabel = subdivisionLabel(selectedCountry?.code);
  const selectClass = compact
    ? "h-10 min-w-0 rounded-xl border bg-background/80 px-2 text-xs outline-none focus:border-primary"
    : "h-12 min-w-0 rounded-2xl border bg-surface/70 px-3 text-sm outline-none focus:border-primary";

  return (
    <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
      <label className="relative min-w-0">
        <Globe2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <select
          aria-label="Pays"
          value={value.countryId ?? ""}
          onChange={(event) =>
            onChange({ countryId: event.target.value || null, regionId: null, cityId: null })
          }
          className={`${selectClass} w-full pl-9`}
        >
          <option value="">Tous les pays</option>
          {countries.map((country) => (
            <option key={country.id} value={country.id}>
              {country.name}
            </option>
          ))}
        </select>
      </label>

      <label className="relative min-w-0">
        <MapPinned className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <select
          aria-label={regionLabel}
          value={value.regionId ?? ""}
          disabled={!value.countryId || availableRegions.length === 0}
          onChange={(event) =>
            onChange({ ...value, regionId: event.target.value || null, cityId: null })
          }
          className={`${selectClass} w-full pl-9 disabled:cursor-not-allowed disabled:opacity-55`}
        >
          <option value="">
            {!value.countryId
              ? "Choisir un pays"
              : availableRegions.length
                ? `Tous · ${regionLabel.toLowerCase()}`
                : `${regionLabel} non précisé`}
          </option>
          {availableRegions.map((region) => (
            <option key={region.id} value={region.id}>
              {region.name}
            </option>
          ))}
        </select>
      </label>

      <label className="relative min-w-0">
        <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <select
          aria-label="Ville"
          value={value.cityId ?? ""}
          disabled={!value.countryId}
          onChange={(event) => onChange({ ...value, cityId: event.target.value || null })}
          className={`${selectClass} w-full pl-9 disabled:cursor-not-allowed disabled:opacity-55`}
        >
          <option value="">{value.countryId ? "Toutes les villes" : "Choisir un pays"}</option>
          {availableCities.map((city) => (
            <option key={city.id} value={city.id}>
              {city.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
