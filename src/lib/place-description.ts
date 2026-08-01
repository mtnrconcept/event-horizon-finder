import { placeCategoryLabel, type PlaceOfInterest } from "@/lib/place-discovery";

const CATEGORY_FALLBACKS: Record<string, string> = {
  attraction: "Une attraction ou un monument à découvrir dans la zone.",
  culture: "Un lieu culturel ou patrimonial à découvrir dans la zone.",
  nature: "Un parc, un jardin ou un espace naturel à découvrir dans la zone.",
  family: "Un lieu de loisirs adapté aux sorties en famille.",
  "sports-outdoors": "Un lieu dédié au sport ou aux activités de plein air.",
  "food-drink": "Un marché ou un lieu lié à la gastronomie locale.",
};

export function placeDisplayDescription(
  place: Pick<PlaceOfInterest, "category" | "description" | "address">,
): string {
  const description = place.description?.replace(/\s+/g, " ").trim();
  if (description) return description;

  const fallback =
    CATEGORY_FALLBACKS[place.category] ??
    `Un ${placeCategoryLabel(place.category).toLowerCase()} à découvrir dans la zone.`;
  return place.address ? `${fallback} Adresse : ${place.address}.` : fallback;
}
