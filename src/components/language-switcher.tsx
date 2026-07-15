import { Languages } from "lucide-react";
import { LOCALE_OPTIONS, useTranslation } from "@/lib/i18n";

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useTranslation();
  const selected = LOCALE_OPTIONS.find((option) => option.value === locale) ?? LOCALE_OPTIONS[0];

  return (
    <label
      className={`relative inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border bg-surface/70 px-2.5 text-xs font-semibold transition-colors hover:bg-accent ${
        compact ? "min-w-11" : "min-w-[7.5rem]"
      }`}
      title={t("language.choose")}
    >
      <Languages className="h-4 w-4 text-primary" aria-hidden="true" />
      <span aria-hidden="true">{selected.flag}</span>
      {!compact && <span className="hidden lg:inline">{selected.label}</span>}
      <span className="sr-only">{t("language.choose")}</span>
      <select
        value={locale}
        aria-label={t("language.choose")}
        onChange={(event) => setLocale(event.target.value as typeof locale)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      >
        {LOCALE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.flag} {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
