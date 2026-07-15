import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { List, Map as MapIcon, SlidersHorizontal, X } from "lucide-react";
import { useVisualViewportHeight } from "@/hooks/useVisualViewportHeight";
import { useTranslation } from "@/lib/i18n";
import "./mobile-discovery-layout.css";

type MobileDiscoveryView = "map" | "list";

type MobileDiscoveryLayoutProps = {
  search: ReactNode;
  filters: ReactNode;
  map: ReactNode;
  list: ReactNode;
  selection?: ReactNode;
  resultCount: number;
  activeFilterCount?: number;
  hasSelection?: boolean;
  onMapResizeNeeded?: () => void;
};

export function MobileDiscoveryLayout({
  search,
  filters,
  map,
  list,
  selection,
  resultCount,
  activeFilterCount = 0,
  hasSelection = false,
  onMapResizeNeeded,
}: MobileDiscoveryLayoutProps) {
  const { t, formatNumber } = useTranslation();
  const [view, setView] = useState<MobileDiscoveryView>("map");
  const [listVisited, setListVisited] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const viewportHeight = useVisualViewportHeight();
  const resizeMap = useCallback(() => onMapResizeNeeded?.(), [onMapResizeNeeded]);

  useEffect(() => {
    if (view !== "map") return;
    const animationFrame = window.requestAnimationFrame(resizeMap);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [hasSelection, resizeMap, view, viewportHeight]);

  useEffect(() => {
    if (!filtersOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFiltersOpen(false);
    };
    window.addEventListener("keydown", handleEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleEscape);
    };
  }, [filtersOpen]);

  const style = {
    "--mobile-visual-viewport-height": viewportHeight ? `${viewportHeight}px` : undefined,
  } as CSSProperties;

  return (
    <div className="mobile-discovery-shell" style={style}>
      <header className="mobile-discovery-toolbar">
        <div className="mobile-discovery-search">{search}</div>
        <button
          type="button"
          className="mobile-discovery-filter-trigger"
          aria-haspopup="dialog"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen(true)}
        >
          <SlidersHorizontal aria-hidden="true" />
          <span>{t("common.filters")}</span>
          {activeFilterCount > 0 && (
            <span className="mobile-discovery-filter-count">{activeFilterCount}</span>
          )}
        </button>
      </header>

      <div className="mobile-discovery-content">
        <section
          className="mobile-discovery-map-view"
          data-active={view === "map"}
          aria-hidden={view !== "map"}
        >
          <div className="mobile-discovery-map">{map}</div>
          {selection && <div className="mobile-discovery-selection">{selection}</div>}
        </section>

        <section
          className="mobile-discovery-list-view"
          data-active={view === "list"}
          aria-hidden={view !== "list"}
        >
          {listVisited ? list : null}
        </section>
      </div>

      <nav className="mobile-discovery-switcher" aria-label={t("discovery.display")}>
        <button type="button" aria-pressed={view === "map"} onClick={() => setView("map")}>
          <MapIcon aria-hidden="true" />
          <span>{t("common.map")}</span>
        </button>
        <button
          type="button"
          aria-pressed={view === "list"}
          onClick={() => {
            setListVisited(true);
            setView("list");
          }}
        >
          <List aria-hidden="true" />
          <span>{t("common.list")}</span>
          <span className="mobile-discovery-result-count">{resultCount}</span>
        </button>
      </nav>

      {filtersOpen && (
        <div
          className="mobile-discovery-filter-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobile-filter-title"
        >
          <header>
            <div>
              <p>{t("discovery.refine")}</p>
              <h2 id="mobile-filter-title">{t("common.filters")}</h2>
            </div>
            <button
              type="button"
              aria-label={t("discovery.closeFilters")}
              onClick={() => setFiltersOpen(false)}
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <div className="mobile-discovery-filter-scroll">{filters}</div>
          <footer>
            <button type="button" onClick={() => setFiltersOpen(false)}>
              {t("discovery.showEvents", { count: formatNumber(resultCount) })}
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
