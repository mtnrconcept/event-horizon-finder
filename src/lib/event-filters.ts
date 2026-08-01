export const MUSIC_GENRES = [
  ["techno", "Techno"],
  ["house", "House"],
  ["afro-house", "Afro house"],
  ["electro", "Électro"],
  ["trance", "Trance"],
  ["drum-and-bass", "Drum & bass"],
  ["hip-hop", "Hip-hop / rap"],
  ["r-and-b", "R&B"],
  ["reggaeton", "Reggaeton"],
  ["afrobeat", "Afrobeat"],
  ["dancehall", "Dancehall"],
  ["reggae", "Reggae / dub"],
  ["disco", "Disco"],
  ["funk", "Funk"],
  ["soul", "Soul"],
  ["blues", "Blues"],
  ["jazz", "Jazz"],
  ["rock", "Rock"],
  ["metal", "Metal"],
  ["punk", "Punk"],
  ["indie", "Indie"],
  ["pop", "Pop"],
  ["latin", "Latin"],
  ["classical", "Classique"],
  ["opera", "Opéra"],
  ["world", "Musiques du monde"],
  ["folk-country", "Folk / country"],
  ["ambient", "Ambient"],
  ["experimental", "Expérimental"],
  ["gospel", "Gospel"],
] as const;

export const PLACE_CATEGORIES = [
  ["attraction", "Attractions et monuments", "🏛️"],
  ["culture", "Musées, art et patrimoine", "🎨"],
  ["nature", "Parcs, jardins et nature", "🌿"],
  ["family", "Famille et loisirs", "🎡"],
  ["sports-outdoors", "Sports et plein air", "🛹"],
  ["food-drink", "Marchés et gastronomie", "🧺"],
] as const;

export const GENRE_LABELS = Object.fromEntries(MUSIC_GENRES) as Record<string, string>;

export type PriceMode = "all" | "free" | "under-20" | "under-40" | "over-40" | "known";
export type CapacityMode = "all" | "intimate" | "club" | "large" | "festival" | "unknown";
export type DiscoveryContentMode = "events" | "places" | "all";

export interface AdvancedEventFilters {
  contentMode: DiscoveryContentMode;
  placeCategories: string[];
  openNowOnly: boolean;
  freePlacesOnly: boolean;
  priceMode: PriceMode;
  capacityMode: CapacityMode;
  genres: string[];
  subcategories: string[];
  ticketsOnly: boolean;
  verifiedOnly: boolean;
  accessibleOnly: boolean;
  venueOnly: boolean;
}

export const DEFAULT_ADVANCED_FILTERS: AdvancedEventFilters = {
  contentMode: "events",
  placeCategories: [],
  openNowOnly: false,
  freePlacesOnly: false,
  priceMode: "all",
  capacityMode: "all",
  genres: [],
  subcategories: [],
  ticketsOnly: false,
  verifiedOnly: false,
  accessibleOnly: false,
  venueOnly: false,
};

export function toDiscoveryFilters(filters: AdvancedEventFilters, filterValues?: string[]) {
  const price = {
    freeOnly: filters.priceMode === "free",
    pricedOnly: filters.priceMode !== "all" && filters.priceMode !== "free",
    minPrice: filters.priceMode === "over-40" ? 40 : null,
    maxPrice: filters.priceMode === "under-20" ? 20 : filters.priceMode === "under-40" ? 40 : null,
  };
  const capacity = {
    capacityMin:
      filters.capacityMode === "club"
        ? 201
        : filters.capacityMode === "large"
          ? 801
          : filters.capacityMode === "festival"
            ? 5001
            : null,
    capacityMax:
      filters.capacityMode === "intimate"
        ? 200
        : filters.capacityMode === "club"
          ? 800
          : filters.capacityMode === "large"
            ? 5000
            : null,
    capacityUnknown: filters.capacityMode === "unknown",
  };

  return {
    contentMode: filters.contentMode,
    placeCategories: filters.placeCategories.length ? [...new Set(filters.placeCategories)] : null,
    openNowOnly: filters.openNowOnly,
    freePlacesOnly: filters.freePlacesOnly,
    ...price,
    ...capacity,
    genres: (filterValues ?? [...filters.genres, ...filters.subcategories]).length
      ? [...new Set(filterValues ?? [...filters.genres, ...filters.subcategories])]
      : null,
    ticketsOnly: filters.ticketsOnly,
    verifiedOnly: filters.verifiedOnly,
    accessibleOnly: filters.accessibleOnly,
    venueOnly: filters.venueOnly,
  };
}

export function countAdvancedFilters(filters: AdvancedEventFilters) {
  return (
    Number(filters.contentMode !== "events") +
    filters.placeCategories.length +
    Number(filters.openNowOnly) +
    Number(filters.freePlacesOnly) +
    Number(filters.priceMode !== "all") +
    Number(filters.capacityMode !== "all") +
    filters.genres.length +
    filters.subcategories.length +
    Number(filters.ticketsOnly) +
    Number(filters.verifiedOnly) +
    Number(filters.accessibleOnly) +
    Number(filters.venueOnly)
  );
}
