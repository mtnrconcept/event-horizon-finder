import { useEffect, useId, useMemo, useState } from "react";
import { Building2, Globe2, LoaderCircle, MapPinned, Search } from "lucide-react";
import type { CityOption, CountryOption, RegionOption } from "@/lib/queries";
import { useTranslation, type TranslationKey } from "@/lib/i18n";

export interface GeographySelection {
  countryId: string | null;
  regionId: string | null;
  cityId: string | null;
}

function subdivisionLabelKey(countryCode?: string): TranslationKey {
  switch (countryCode) {
    case "CH":
      return "geo.canton";
    case "FR":
      return "geo.regionDepartment";
    case "US":
      return "geo.state";
    case "CA":
      return "geo.province";
    default:
      return "geo.regionProvince";
  }
}

export function GeographyFilter({
  countries,
  regions,
  cities,
  value,
  onChange,
  onCityQuery,
  cityLoading = false,
  compact = false,
}: {
  countries: CountryOption[];
  regions: RegionOption[];
  cities: CityOption[];
  value: GeographySelection;
  onChange: (next: GeographySelection) => void;
  onCityQuery?: (query: string) => void;
  cityLoading?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const cityListId = useId();
  const [cityQuery, setCityQuery] = useState("");
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
  const regionLabel = t(subdivisionLabelKey(selectedCountry?.code));
  const selectedCity = useMemo(
    () => cities.find((city) => city.id === value.cityId) ?? null,
    [cities, value.cityId],
  );

  useEffect(() => {
    setCityQuery(selectedCity?.name ?? "");
  }, [selectedCity?.id, selectedCity?.name, value.countryId, value.regionId]);

  useEffect(() => {
    if (!onCityQuery || !value.countryId) return;
    const timer = window.setTimeout(() => {
      const normalized = cityQuery.trim();
      if (!value.cityId || normalized !== selectedCity?.name) onCityQuery(normalized);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [cityQuery, onCityQuery, selectedCity?.name, value.cityId, value.countryId]);
  const selectClass = compact
    ? "h-10 min-w-0 rounded-xl border bg-background/80 px-2 text-xs outline-none focus:border-primary"
    : "h-12 min-w-0 rounded-2xl border bg-surface/70 px-3 text-sm outline-none focus:border-primary";

  return (
    <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
      <label className="relative min-w-0">
        <Globe2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <select
          aria-label={t("common.country")}
          value={value.countryId ?? ""}
          onChange={(event) =>
            onChange({ countryId: event.target.value || null, regionId: null, cityId: null })
          }
          className={`${selectClass} w-full pl-9`}
        >
          <option value="">{t("geo.allCountries")}</option>
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
              ? t("geo.chooseCountry")
              : availableRegions.length
                ? t("geo.allRegion", { region: regionLabel.toLocaleLowerCase() })
                : t("geo.unspecifiedRegion", { region: regionLabel })}
          </option>
          {availableRegions.map((region) => (
            <option key={region.id} value={region.id}>
              {region.name}
            </option>
          ))}
        </select>
      </label>

      <label className="relative min-w-0">
        {cityQuery ? (
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        ) : (
          <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        )}
        <input
          aria-label={t("common.city")}
          list={cityListId}
          value={cityQuery}
          disabled={!value.countryId}
          placeholder={value.countryId ? t("geo.searchCity") : t("geo.chooseCountry")}
          autoComplete="off"
          onFocus={() => {
            if (!cityQuery && value.countryId) onCityQuery?.("");
          }}
          onChange={(event) => {
            const nextQuery = event.target.value;
            setCityQuery(nextQuery);
            const exact = availableCities.find(
              (city) => city.name.toLocaleLowerCase() === nextQuery.trim().toLocaleLowerCase(),
            );
            onChange({ ...value, cityId: exact?.id ?? null });
          }}
          className={`${selectClass} w-full pl-9 pr-8 disabled:cursor-not-allowed disabled:opacity-55`}
        />
        {cityLoading && (
          <LoaderCircle className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-primary" />
        )}
        <datalist id={cityListId}>
          {availableCities.map((city) => (
            <option key={city.id} value={city.name} />
          ))}
        </datalist>
      </label>
    </div>
  );
}
