export const MOBILE_LIST_BATCH_SIZE = 24;
export const MAP_EVENT_PAGE_SIZE = 48;

export const MAP_INITIAL_GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  maximumAge: 10 * 60_000,
  timeout: 4_000,
};

export const MAP_REFINEMENT_GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 60_000,
  timeout: 15_000,
};
