import { useEffect } from "react";

type MetricName = "LCP" | "CLS" | "INP";
type MetricRating = "good" | "needs-improvement" | "poor";

type PerformanceMetric = {
  name: MetricName;
  value: number;
  rating: MetricRating;
  pathname: string;
  navigationType: string;
  timestamp: number;
};

type LayoutShiftEntry = PerformanceEntry & { value: number; hadRecentInput: boolean };
type InteractionEntry = PerformanceEntry & { duration: number; interactionId: number };

function ratingFor(name: MetricName, value: number): MetricRating {
  if (name === "LCP") return value <= 2_500 ? "good" : value <= 4_000 ? "needs-improvement" : "poor";
  if (name === "CLS") return value <= 0.1 ? "good" : value <= 0.25 ? "needs-improvement" : "poor";
  return value <= 200 ? "good" : value <= 500 ? "needs-improvement" : "poor";
}

function navigationType() {
  const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return entry?.type ?? "navigate";
}

function publishMetric(name: MetricName, value: number) {
  const metric: PerformanceMetric = {
    name,
    value,
    rating: ratingFor(name, value),
    pathname: window.location.pathname,
    navigationType: navigationType(),
    timestamp: Date.now(),
  };

  window.dispatchEvent(new CustomEvent<PerformanceMetric>("global-party:performance", { detail: metric }));
  if (import.meta.env.DEV) console.info("[performance]", metric);
}

/** Mesure locale uniquement. Aucun envoi réseau n'est effectué ici. */
export function PerformanceMonitor() {
  useEffect(() => {
    if (!("PerformanceObserver" in window)) return;

    const observers: PerformanceObserver[] = [];
    let lcp = 0;
    let cls = 0;
    let inp = 0;
    let lastSnapshot = "";

    const observe = (
      type: string,
      callback: (entries: PerformanceObserverEntryList) => void,
      options: PerformanceObserverInit,
    ) => {
      if (!PerformanceObserver.supportedEntryTypes.includes(type)) return;
      const observer = new PerformanceObserver(callback);
      observer.observe(options);
      observers.push(observer);
    };

    observe(
      "largest-contentful-paint",
      (list) => {
        const last = list.getEntries().at(-1);
        if (last) lcp = last.startTime;
      },
      { type: "largest-contentful-paint", buffered: true },
    );

    observe(
      "layout-shift",
      (list) => {
        for (const entry of list.getEntries() as LayoutShiftEntry[]) {
          if (!entry.hadRecentInput) cls += entry.value;
        }
      },
      { type: "layout-shift", buffered: true },
    );

    observe(
      "event",
      (list) => {
        for (const entry of list.getEntries() as InteractionEntry[]) {
          if (entry.interactionId > 0) inp = Math.max(inp, entry.duration);
        }
      },
      { type: "event", buffered: true, durationThreshold: 40 } as PerformanceObserverInit,
    );

    const flush = () => {
      const snapshot = `${Math.round(lcp)}:${cls.toFixed(4)}:${Math.round(inp)}`;
      if (snapshot === lastSnapshot) return;
      lastSnapshot = snapshot;
      if (lcp > 0) publishMetric("LCP", Math.round(lcp));
      publishMetric("CLS", Number(cls.toFixed(4)));
      if (inp > 0) publishMetric("INP", Math.round(inp));
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", flush, { once: true });

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", flush);
      observers.forEach((observer) => observer.disconnect());
    };
  }, []);

  return null;
}
