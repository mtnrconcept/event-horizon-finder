import { useEffect, useId, useRef, useState } from "react";
import { Building2, LoaderCircle } from "lucide-react";
import { searchGeographyCities, type CityOption } from "@/lib/queries";
import { useTranslation } from "@/lib/i18n";

export function CitySearchInput({
  value,
  onChange,
  initialLabel = "",
  placeholder,
}: {
  value: string;
  onChange: (cityId: string) => void;
  initialLabel?: string;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const [query, setQuery] = useState(initialLabel);
  const [options, setOptions] = useState<CityOption[]>([]);
  const [loading, setLoading] = useState(false);
  const onChangeRef = useRef(onChange);
  const selectedLabelRef = useRef(initialLabel);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (value && initialLabel) {
      selectedLabelRef.current = initialLabel;
      setQuery(initialLabel);
    }
  }, [initialLabel, value]);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2 || (value && normalized === selectedLabelRef.current)) return;
    let current = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      searchGeographyCities({ query: normalized, limit: 40 })
        .then((rows) => {
          if (!current) return;
          setOptions(rows);
          const exact = rows.find(
            (city) => city.name.toLocaleLowerCase() === normalized.toLocaleLowerCase(),
          );
          if (exact) {
            selectedLabelRef.current = exact.name;
            onChangeRef.current(exact.id);
          }
        })
        .catch(() => {
          if (current) setOptions([]);
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query, value]);

  return (
    <div className="relative">
      <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <input
        aria-label={t("geo.primaryCity")}
        list={listId}
        value={query}
        autoComplete="off"
        placeholder={placeholder ?? t("geo.startCity")}
        onChange={(event) => {
          const next = event.target.value;
          setQuery(next);
          const exact = options.find(
            (city) => city.name.toLocaleLowerCase() === next.trim().toLocaleLowerCase(),
          );
          selectedLabelRef.current = exact?.name ?? "";
          onChange(exact?.id ?? "");
        }}
        className="field-control pl-9 pr-9"
      />
      {loading && (
        <LoaderCircle className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-primary" />
      )}
      <datalist id={listId}>
        {options.map((city) => (
          <option key={city.id} value={city.name} />
        ))}
      </datalist>
    </div>
  );
}
