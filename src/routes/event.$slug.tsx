import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { fetchEventBySlug } from "@/lib/queries";
import { getEventArtworkUrl } from "@/lib/event-artwork";
import { supabase } from "@/integrations/supabase/client";
import { EventArtworkImage } from "@/components/event-artwork-image";
import { TargetedCampaigns } from "@/components/targeted-campaigns";
import { trackClientEvent } from "@/lib/client-analytics";
import { Badge } from "@/components/ui/badge";
import {
  Calendar,
  MapPin,
  Ticket,
  BadgeCheck,
  Share2,
  Heart,
  Flag,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@/lib/i18n";

export const Route = createFileRoute("/event/$slug")({
  loader: async ({ params }) => {
    const ev = await fetchEventBySlug(params.slug);
    if (!ev) throw notFound();
    return ev;
  },
  head: ({ loaderData }) => {
    if (!loaderData)
      return {
        meta: [
          { title: "Événement introuvable — Global Party" },
          { name: "robots", content: "noindex" },
        ],
      };
    const e = loaderData;
    const artworkUrl = getEventArtworkUrl(e.id, e.cover_image_url);
    return {
      meta: [
        { title: `${e.title} — Global Party` },
        { name: "description", content: e.short_description ?? e.title },
        { property: "og:title", content: e.title },
        { property: "og:description", content: e.short_description ?? "" },
        ...(artworkUrl ? ([{ property: "og:image", content: artworkUrl }] as const) : []),
      ],
    };
  },
  errorComponent: ({ error }) => (
    <div className="p-10 text-center text-muted-foreground">{error.message}</div>
  ),
  notFoundComponent: EventNotFound,
  component: EventDetail,
});

function EventNotFound() {
  const { tr } = useTranslation();
  return <div className="p-10 text-center">{tr("Événement introuvable")}</div>;
}

function resolveTimeZone(...candidates: unknown[]) {
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    try {
      new Intl.DateTimeFormat("fr-FR", { timeZone: candidate }).format(new Date(0));
      return candidate;
    } catch {
      // Try the city timezone and finally UTC when imported data is malformed.
    }
  }
  return "UTC";
}

function EventDetail() {
  const { tr, t, categoryLabel, localeTag } = useTranslation();
  const e = Route.useLoaderData();
  const [fav, setFav] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
  const occ =
    [...(e.occurrences ?? [])]
      .sort((left, right) => left.starts_at.localeCompare(right.starts_at))
      .find((item) => new Date(item.starts_at).getTime() >= Date.now() - 2 * 60 * 60 * 1000) ??
    [...(e.occurrences ?? [])].sort((left, right) =>
      right.starts_at.localeCompare(left.starts_at),
    )[0];

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const id = data.session?.user.id ?? null;
      setUid(id);
      if (id)
        supabase
          .from("favorites")
          .select("event_id")
          .eq("user_id", id)
          .eq("event_id", e.id)
          .maybeSingle()
          .then(({ data }) => setFav(!!data));
    });
  }, [e.id]);

  const toggleFav = async () => {
    if (!uid) return toast.error(tr("Connecte-toi pour ajouter aux favoris"));
    if (fav) {
      await supabase.from("favorites").delete().eq("user_id", uid).eq("event_id", e.id);
      setFav(false);
    } else {
      await supabase.from("favorites").insert({ user_id: uid, event_id: e.id });
      setFav(true);
      toast.success(tr("Ajouté aux favoris"));
      void trackClientEvent("event_favorite", { entityType: "event", entityId: e.id });
    }
  };

  const addToAgenda = async () => {
    if (!uid || !occ) return toast.error(tr("Connecte-toi pour utiliser l'agenda"));
    await supabase
      .from("calendar_items")
      .upsert(
        { user_id: uid, event_id: e.id, occurrence_id: occ.id },
        { onConflict: "user_id,occurrence_id" },
      );
    toast.success(tr("Ajouté à ton agenda"));
    void trackClientEvent("event_agenda_add", { entityType: "event", entityId: e.id });
  };

  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: e.title, url });
      else {
        await navigator.clipboard.writeText(url);
        toast.success(tr("Lien copié"));
      }
    } catch {
      /* no-op */
    }
  };

  const report = async () => {
    if (!uid) return toast.error(tr("Connecte-toi pour signaler"));
    const reason = window.prompt(tr("Motif du signalement ?"));
    if (!reason) return;
    await supabase.from("event_reports").insert({ event_id: e.id, reported_by: uid, reason });
    toast.success(tr("Signalement envoyé"));
  };

  const cancelled = e.status === "cancelled";
  const postponed = e.status === "postponed";
  const offer = (e.offers ?? [])[0];
  const tz = resolveTimeZone(occ?.timezone, e.venue?.city?.timezone, "UTC");
  const bookingUrl = offer?.ticket_url || e.official_url;
  const priceLabel = (() => {
    if (offer?.is_free || e.is_free) return t("common.free");
    if (!offer || (offer.price_min == null && offer.price_max == null))
      return tr("Prix sur le site");
    const currency = offer.currency ? ` ${offer.currency}` : "";
    if (offer.price_min != null && offer.price_max != null && offer.price_min !== offer.price_max) {
      return `${offer.price_min} – ${offer.price_max}${currency}`;
    }
    return `Dès ${offer.price_min ?? offer.price_max}${currency}`;
  })();

  return (
    <div className="mx-auto max-w-4xl">
      <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted md:aspect-[21/9]">
        <EventArtworkImage
          eventId={e.id}
          sourceUrl={e.cover_image_url}
          alt={e.title}
          className="h-full w-full object-cover"
          fallback={
            <div className="h-full w-full bg-[radial-gradient(circle_at_75%_20%,oklch(0.72_0.18_35_/_0.38),transparent_30%),linear-gradient(135deg,oklch(0.3_0.12_295),oklch(0.16_0.04_265))]" />
          }
        />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/50 to-transparent" />
      </div>
      <div className="px-4 pb-40 md:px-6 md:pb-32">
        {cancelled && (
          <div
            className="glass mb-4 rounded-xl border p-4"
            style={{ borderColor: "var(--color-destructive)", color: "var(--color-destructive)" }}
          >
            {tr("Cet événement est annulé.")}
          </div>
        )}
        {postponed && (
          <div
            className="glass mb-4 rounded-xl border p-4"
            style={{ borderColor: "var(--color-secondary)" }}
          >
            {tr("Cet événement est reporté.")}
          </div>
        )}

        <div className="mb-3 flex flex-wrap gap-1.5">
          {e.is_demo && (
            <Badge
              style={{ background: "var(--color-demo)", color: "var(--color-primary-foreground)" }}
            >
              {tr("Démonstration")}
            </Badge>
          )}
          {e.is_verified && (
            <Badge variant="outline" className="gap-1">
              <BadgeCheck className="h-3 w-3" />
              {tr("Vérifié")}
            </Badge>
          )}
          {e.category && (
            <Badge variant="outline">{categoryLabel(e.category.slug, e.category.name_fr)}</Badge>
          )}
          {e.is_free && (
            <Badge
              style={{
                background: "var(--color-secondary)",
                color: "var(--color-secondary-foreground)",
              }}
            >
              {t("common.free")}
            </Badge>
          )}
        </div>

        <h1 className="text-3xl font-bold md:text-4xl">{e.title}</h1>
        {e.short_description && (
          <p className="mt-2 text-lg text-muted-foreground">{e.short_description}</p>
        )}

        <div className="mt-6">
          <TargetedCampaigns placement="event" />
        </div>

        <div className="mt-6 grid gap-3 md:grid-cols-2">
          {occ && (
            <div className="glass flex items-start gap-3 rounded-xl p-4">
              <Calendar className="mt-0.5 h-5 w-5" style={{ color: "var(--color-primary)" }} />
              <div>
                <p className="text-xs uppercase text-muted-foreground">{t("home.date")}</p>
                <p className="font-medium">
                  {new Intl.DateTimeFormat(localeTag, {
                    timeZone: tz,
                    dateStyle: "full",
                    timeStyle: "short",
                  }).format(new Date(occ.starts_at))}
                </p>
                <p className="text-xs text-muted-foreground">
                  {tr("Fuseau : {timezone}", { timezone: tz })}
                </p>
              </div>
            </div>
          )}
          {e.venue && (
            <div className="glass flex items-start gap-3 rounded-xl p-4">
              <MapPin className="mt-0.5 h-5 w-5" style={{ color: "var(--color-primary)" }} />
              <div>
                <p className="text-xs uppercase text-muted-foreground">{tr("Lieu")}</p>
                <p className="font-medium">{e.venue.name}</p>
                <p className="text-xs text-muted-foreground">
                  {e.venue.address} · {e.venue.city?.name}
                </p>
                {e.venue.latitude != null && e.venue.longitude != null && (
                  <a
                    href={`https://www.openstreetmap.org/?mlat=${e.venue.latitude}&mlon=${e.venue.longitude}#map=17/${e.venue.latitude}/${e.venue.longitude}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-xs text-primary"
                  >
                    {tr("Itinéraire")} <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          )}
          {offer && (
            <div className="glass flex items-start gap-3 rounded-xl p-4">
              <Ticket className="mt-0.5 h-5 w-5" style={{ color: "var(--color-primary)" }} />
              <div>
                <p className="text-xs uppercase text-muted-foreground">{tr("Billets")}</p>
                <p className="font-medium">{priceLabel}</p>
                {offer.ticket_url && !cancelled && (
                  <a
                    href={offer.ticket_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-xs text-primary"
                  >
                    {tr("Billetterie")} <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          )}
          {!offer && e.official_url && (
            <div className="glass flex items-start gap-3 rounded-xl p-4">
              <ExternalLink className="mt-0.5 h-5 w-5" style={{ color: "var(--color-primary)" }} />
              <div>
                <p className="text-xs uppercase text-muted-foreground">{tr("Source officielle")}</p>
                <a
                  href={e.official_url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-primary"
                >
                  {tr("Horaires, détails et réservation")}
                </a>
              </div>
            </div>
          )}
          {e.organizer && (
            <div className="glass flex items-start gap-3 rounded-xl p-4">
              <BadgeCheck className="mt-0.5 h-5 w-5" style={{ color: "var(--color-primary)" }} />
              <div>
                <p className="text-xs uppercase text-muted-foreground">{tr("Organisateur")}</p>
                <p className="font-medium">{e.organizer.name}</p>
                {e.organizer.website && (
                  <a
                    href={e.organizer.website}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-primary"
                  >
                    {tr("Site officiel")}
                  </a>
                )}
              </div>
            </div>
          )}
        </div>

        {e.description && (
          <div className="mt-8 prose prose-invert max-w-none whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
            {e.description}
          </div>
        )}

        <div className="mt-8 flex flex-wrap gap-2">
          <button
            onClick={addToAgenda}
            disabled={cancelled}
            className="btn-glow rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-40"
          >
            {tr("Ajouter à l'agenda")}
          </button>
          <button
            onClick={toggleFav}
            className="flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-medium hover:bg-accent"
          >
            <Heart className="h-4 w-4" fill={fav ? "currentColor" : "none"} />{" "}
            {fav ? tr("Favori") : tr("Ajouter aux favoris")}
          </button>
          <button
            onClick={share}
            className="flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-medium hover:bg-accent"
          >
            <Share2 className="h-4 w-4" /> {tr("Partager")}
          </button>
          <button
            onClick={report}
            className="flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-medium hover:bg-accent"
          >
            <Flag className="h-4 w-4" /> {tr("Signaler")}
          </button>
        </div>

        <div className="mt-6 text-xs text-muted-foreground">
          {e.is_demo ? "Données de démonstration Global Party · " : ""}
          <Link to="/" className="underline">
            ← {tr("Retour à la découverte")}
          </Link>
        </div>
      </div>

      {bookingUrl && !cancelled && (
        <div className="fixed inset-x-3 bottom-[4.75rem] z-30 mx-auto max-w-3xl md:bottom-5">
          <div className="glass flex items-center justify-between gap-4 rounded-2xl border p-3 shadow-[0_18px_60px_oklch(0_0_0_/_0.45)] md:p-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{e.title}</p>
              <p className="text-xs text-muted-foreground">{priceLabel}</p>
            </div>
            <a
              href={bookingUrl}
              target="_blank"
              rel="noreferrer"
              onClick={() =>
                void trackClientEvent("ticket_click", {
                  entityType: "event",
                  entityId: e.id,
                })
              }
              className="btn-glow inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground"
            >
              <Ticket className="h-4 w-4" /> {tr("Réserver")}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
