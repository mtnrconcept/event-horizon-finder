import { Link } from "@tanstack/react-router";
import { CalendarDays, MapPin, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { SocialEvent } from "@/lib/social-queries";

function eventDate(event: SocialEvent) {
  if (!event.starts_at) return "Date à confirmer";
  try {
    return new Intl.DateTimeFormat("fr-CH", {
      timeZone: event.timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(event.starts_at));
  } catch {
    return new Date(event.starts_at).toLocaleString("fr-CH");
  }
}

export function SocialEventAttachment({ event }: { event: SocialEvent }) {
  return (
    <Link
      to="/event/$slug"
      params={{ slug: event.slug }}
      className="group mx-4 mb-4 flex overflow-hidden rounded-2xl border bg-surface/60 transition-colors hover:bg-accent/60"
    >
      <div className="h-28 w-28 shrink-0 overflow-hidden bg-muted sm:h-32 sm:w-40">
        {event.cover_image_url ? (
          <img
            src={event.cover_image_url}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Sparkles className="h-7 w-7 text-muted-foreground" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 p-3">
        <div className="mb-1 flex items-center gap-2">
          <Badge variant="outline" className="border-primary/30 text-[10px] text-primary">
            Événement
          </Badge>
          {event.is_free && (
            <Badge className="border-transparent bg-secondary text-[10px] text-secondary-foreground">
              Gratuit
            </Badge>
          )}
        </div>
        <p className="line-clamp-2 text-sm font-semibold leading-tight sm:text-base">
          {event.title}
        </p>
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground sm:text-xs">
          <CalendarDays className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{eventDate(event)}</span>
        </p>
        {(event.venue_name || event.city_name) && (
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground sm:text-xs">
            <MapPin className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {[event.venue_name, event.city_name].filter(Boolean).join(" · ")}
            </span>
          </p>
        )}
      </div>
    </Link>
  );
}
