export const BRAND_ARRIVAL_COMPLETE_EVENT = "global-party:brand-arrival-complete";

const BRAND_ARRIVAL_COMPLETE_DATASET_KEY = "brandArrivalComplete";
const BRAND_ARRIVAL_SESSION_KEY = "global-party:brand-arrival-seen-v1";

function sessionHasCompleted() {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(BRAND_ARRIVAL_SESSION_KEY) === "true";
  } catch {
    return false;
  }
}

export function markBrandArrivalComplete() {
  document.documentElement.dataset[BRAND_ARRIVAL_COMPLETE_DATASET_KEY] = "true";
  try {
    window.sessionStorage.setItem(BRAND_ARRIVAL_SESSION_KEY, "true");
  } catch {
    // Storage can be disabled. The in-document marker still prevents a replay.
  }
  window.dispatchEvent(new Event(BRAND_ARRIVAL_COMPLETE_EVENT));
}

export function hasBrandArrivalCompleted() {
  return (
    (typeof document !== "undefined" &&
      document.documentElement.dataset[BRAND_ARRIVAL_COMPLETE_DATASET_KEY] === "true") ||
    sessionHasCompleted()
  );
}
