import { Link } from "@tanstack/react-router";
import { CalendarDays, MapPin, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EventArtworkImage } from "@/components/event-artwork-image";
import type { SocialEvent } from "@/lib/social-queries";
import { useTranslation } from "@/lib/i18n";

function eventDate(event: SocialEvent, localeTag: string, fallback: string) {
  if (!event.starts_at) return fallback;
  try {
    return new Intl.DateTimeFormat(localeTag, {
      timeZone: event.timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(event.starts_at));
  } catch {
    return new Date(event.starts_at).toLocaleString(localeTag);
  }
}

export function SocialEventAttachment({ event }: { event: SocialEvent }) {
  const { tr, t, localeTag } = useTranslation();
  return (
    <Link
      to="/event/$slug"
      params={{ slug: event.slug }}
      className="group mx-4 mb-4 flex overflow-hidden rounded-2xl border bg-surface/60 transition-colors hover:bg-accent/60"
    >
      <div className="h-28 w-28 shrink-0 overflow-hidden bg-muted sm:h-32 sm:w-40">
        <EventArtworkImage
          eventId={event.id}
          sourceUrl={event.cover_image_url}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          fallback={
            <div className="flex h-full items-center justify-center">
              <Sparkles className="h-7 w-7 text-muted-foreground" />
            </div>
          }
        />
      </div>
      <div className="min-w-0 flex-1 p-3">
        <div className="mb-1 flex items-center gap-2">
          <Badge variant="outline" className="border-primary/30 text-[10px] text-primary">
            {tr("Événement")}
          </Badge>
          {event.is_free && (
            <Badge className="border-transparent bg-secondary text-[10px] text-secondary-foreground">
              {t("common.free")}
            </Badge>
          )}
        </div>
        <p className="line-clamp-2 text-sm font-semibold leading-tight sm:text-base">
          {event.title}
        </p>
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground sm:text-xs">
          <CalendarDays className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{eventDate(event, localeTag, tr("Date à confirmer"))}</span>
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
