import { Link } from "@tanstack/react-router";
import { CalendarDays, Ticket } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EventArtworkImage } from "@/components/event-artwork-image";
import { useTranslation } from "@/lib/i18n";
import type { VenueEventSummary } from "@/lib/venue-detail";

function eventTimeZone(event: VenueEventSummary): string {
  if (!event.timezone) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: event.timezone }).format(new Date(0));
    return event.timezone;
  } catch {
    return "UTC";
  }
}

export function VenueEventList({
  events,
  emptyLabel,
  compact = false,
}: {
  events: VenueEventSummary[];
  emptyLabel: string;
  compact?: boolean;
}) {
  const { tr, localeTag } = useTranslation();
  if (!events.length) {
    return (
      <div className="rounded-2xl border border-dashed p-5 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className={compact ? "grid gap-2" : "grid gap-3 sm:grid-cols-2"}>
      {events.map((event) => (
        <Link
          key={`${event.id}-${event.starts_at}`}
          to="/event/$slug"
          params={{ slug: event.slug }}
          className={
            compact
              ? "group flex min-h-20 gap-3 rounded-2xl border bg-background p-2.5 hover:border-primary"
              : "group overflow-hidden rounded-2xl border bg-surface hover:border-primary"
          }
          style={{ contentVisibility: "auto", containIntrinsicSize: compact ? "0 80px" : "0 260px" }}
        >
          <div
            className={
              compact
                ? "h-16 w-20 shrink-0 overflow-hidden rounded-xl bg-muted"
                : "aspect-[16/9] w-full overflow-hidden bg-muted"
            }
          >
            <EventArtworkImage
              eventId={event.id}
              sourceUrl={event.cover_image_url}
              alt={event.title}
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
              fallback={
                <div className="grid h-full w-full place-items-center bg-[linear-gradient(135deg,var(--color-muted),var(--color-accent))]">
                  <CalendarDays className="h-7 w-7 text-primary" />
                </div>
              }
            />
          </div>
          <div className={compact ? "min-w-0 flex-1 py-0.5" : "p-3.5"}>
            <div className="flex flex-wrap gap-1.5">
              {event.category?.name_fr && <Badge variant="outline">{event.category.name_fr}</Badge>}
              {event.is_free && <Badge>{tr("Gratuit")}</Badge>}
              {event.status === "sold_out" && (
                <Badge variant="destructive">{tr("Complet")}</Badge>
              )}
              {event.status === "postponed" && (
                <Badge variant="outline">{tr("Reporté")}</Badge>
              )}
            </div>
            <h3 className={compact ? "mt-1.5 truncate text-sm font-black" : "mt-2 line-clamp-2 font-black"}>
              {event.title}
            </h3>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5 shrink-0 text-primary" />
              {new Intl.DateTimeFormat(localeTag, {
                timeZone: eventTimeZone(event),
                dateStyle: compact ? "medium" : "full",
                timeStyle: "short",
              }).format(new Date(event.starts_at))}
            </p>
            {!compact && event.short_description && (
              <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                {event.short_description}
              </p>
            )}
            {!compact && (
              <span className="mt-3 inline-flex items-center gap-1 text-xs font-black text-primary">
                <Ticket className="h-3.5 w-3.5" /> {tr("Voir l’événement")}
              </span>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}
