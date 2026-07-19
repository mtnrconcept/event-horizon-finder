export const BRAND_ARRIVAL_COMPLETE_EVENT = "global-party:brand-arrival-complete";

const BRAND_ARRIVAL_COMPLETE_DATASET_KEY = "brandArrivalComplete";

export function markBrandArrivalComplete() {
  document.documentElement.dataset[BRAND_ARRIVAL_COMPLETE_DATASET_KEY] = "true";
  window.dispatchEvent(new Event(BRAND_ARRIVAL_COMPLETE_EVENT));
}

export function hasBrandArrivalCompleted() {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset[BRAND_ARRIVAL_COMPLETE_DATASET_KEY] === "true"
  );
}
