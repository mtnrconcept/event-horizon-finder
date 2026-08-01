import { Accessibility, Clock3, Landmark, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { placeDisplayDescription } from "@/lib/place-description";
import {
  placeCategoryColor,
  placeCategoryLabel,
  placeIsAccessible,
  placeIsFree,
  type PlaceOfInterest,
} from "@/lib/place-discovery";

function excerpt(value: string, maximum = 180): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > maximum ? `${clean.slice(0, maximum - 1).trimEnd()}…` : clean;
}

export function PlaceCard({
  place,
  onSelect,
  compact = false,
  imagePriority = false,
}: {
  place: PlaceOfInterest;
  onSelect: (place: PlaceOfInterest) => void;
  compact?: boolean;
  imagePriority?: boolean;
}) {
  const description = excerpt(placeDisplayDescription(place));
  const categoryColor = placeCategoryColor(place.category);
  const free = placeIsFree(place);
  const accessible = placeIsAccessible(place);

  return (
    <button
      type="button"
      onClick={() => onSelect(place)}
      className={`group w-full overflow-hidden rounded-3xl border bg-surface text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/70 hover:shadow-lg ${
        compact
          ? "grid grid-cols-[6.75rem_minmax(0,1fr)]"
          : "grid sm:grid-cols-[10rem_minmax(0,1fr)]"
      }`}
    >
      <div
        className={`relative overflow-hidden ${compact ? "min-h-36" : "min-h-44"}`}
        style={{
          background: `linear-gradient(145deg, ${categoryColor}33, ${categoryColor}99)`,
        }}
      >
        <div className="absolute inset-0 grid place-items-center text-white/90">
          <Landmark className={compact ? "h-9 w-9" : "h-12 w-12"} aria-hidden="true" />
        </div>
        {place.image_url && (
          <img
            src={place.image_url}
            alt=""
            loading={imagePriority ? "eager" : "lazy"}
            referrerPolicy="no-referrer"
            className="absolute inset-0 h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-black/5" />
        <Badge className="absolute bottom-2 left-2 border-white/30 bg-black/55 text-[10px] text-white backdrop-blur">
          {placeCategoryLabel(place.category)}
        </Badge>
      </div>

      <div className={compact ? "min-w-0 p-3" : "min-w-0 p-4"}>
        <div className="flex flex-wrap items-center gap-1.5">
          {free && <Badge>Gratuit</Badge>}
          {accessible && (
            <Badge variant="outline" className="gap-1">
              <Accessibility className="h-3 w-3" /> Accessible
            </Badge>
          )}
        </div>
        <h3 className={`mt-2 font-black leading-tight ${compact ? "text-base" : "text-lg"}`}>
          {place.name}
        </h3>
        <p
          className={`mt-1.5 text-muted-foreground ${
            compact ? "line-clamp-3 text-xs" : "line-clamp-3 text-sm"
          }`}
        >
          {description}
        </p>
        <div className="mt-3 grid gap-1 text-[11px] text-muted-foreground">
          {place.address && (
            <span className="flex min-w-0 items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="truncate">{place.address}</span>
            </span>
          )}
          {place.opening_hours && (
            <span className="flex min-w-0 items-center gap-1.5">
              <Clock3 className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="truncate">{place.opening_hours}</span>
            </span>
          )}
        </div>
        <span className="mt-3 inline-flex text-xs font-black text-primary">
          Voir la fiche du lieu
        </span>
      </div>
    </button>
  );
}
