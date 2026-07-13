import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { fetchEventBySlug } from "@/lib/queries";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Calendar, MapPin, Ticket, BadgeCheck, Share2, Heart, Flag, ExternalLink } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/event/$slug")({
  loader: async ({ params }) => {
    const ev = await fetchEventBySlug(params.slug);
    if (!ev) throw notFound();
    return ev;
  },
  head: ({ loaderData }) => {
    if (!loaderData) return { meta: [{ title: "Événement introuvable — EVENTA" }, { name: "robots", content: "noindex" }] };
    const e = loaderData;
    return {
      meta: [
        { title: `${e.title} — EVENTA` },
        { name: "description", content: e.short_description ?? e.title },
        { property: "og:title", content: e.title },
        { property: "og:description", content: e.short_description ?? "" },
        ...(e.cover_image_url ? [{ property: "og:image", content: e.cover_image_url }] as const : []),
      ],
    };
  },
  errorComponent: ({ error }) => <div className="p-10 text-center text-muted-foreground">{error.message}</div>,
  notFoundComponent: () => <div className="p-10 text-center">Événement introuvable</div>,
  component: EventDetail,
});

function EventDetail() {
  const e = Route.useLoaderData();
  const [fav, setFav] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
  const occ = (e.occurrences ?? [])[0];

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const id = data.user?.id ?? null; setUid(id);
      if (id) supabase.from("favorites").select("event_id").eq("user_id", id).eq("event_id", e.id).maybeSingle().then(({ data }) => setFav(!!data));
    });
  }, [e.id]);

  const toggleFav = async () => {
    if (!uid) return toast.error("Connecte-toi pour ajouter aux favoris");
    if (fav) { await supabase.from("favorites").delete().eq("user_id", uid).eq("event_id", e.id); setFav(false); }
    else { await supabase.from("favorites").insert({ user_id: uid, event_id: e.id }); setFav(true); toast.success("Ajouté aux favoris"); }
  };

  const addToAgenda = async () => {
    if (!uid || !occ) return toast.error("Connecte-toi pour utiliser l'agenda");
    await supabase.from("calendar_items").upsert({ user_id: uid, event_id: e.id, occurrence_id: occ.id }, { onConflict: "user_id,occurrence_id" });
    toast.success("Ajouté à ton agenda");
  };

  const share = async () => {
    const url = window.location.href;
    try { if (navigator.share) await navigator.share({ title: e.title, url }); else { await navigator.clipboard.writeText(url); toast.success("Lien copié"); } } catch { /* no-op */ }
  };

  const report = async () => {
    if (!uid) return toast.error("Connecte-toi pour signaler");
    const reason = window.prompt("Motif du signalement ?");
    if (!reason) return;
    await supabase.from("event_reports").insert({ event_id: e.id, reported_by: uid, reason });
    toast.success("Signalement envoyé");
  };

  const cancelled = e.status === "cancelled";
  const postponed = e.status === "postponed";
  const offer = (e.offers ?? [])[0];
  const tz = occ?.timezone ?? "Europe/Paris";

  return (
    <div className="mx-auto max-w-4xl">
      {e.cover_image_url && (
        <div className="relative aspect-[16/9] w-full overflow-hidden md:aspect-[21/9]">
          <img src={e.cover_image_url} alt={e.title} className="h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/50 to-transparent" />
        </div>
      )}
      <div className="px-4 pb-16 md:px-6">
        {cancelled && <div className="glass mb-4 rounded-xl border p-4" style={{ borderColor: "var(--color-destructive)", color: "var(--color-destructive)" }}>Cet événement est annulé.</div>}
        {postponed && <div className="glass mb-4 rounded-xl border p-4" style={{ borderColor: "var(--color-secondary)" }}>Cet événement est reporté.</div>}

        <div className="mb-3 flex flex-wrap gap-1.5">
          {e.is_demo && <Badge style={{ background: "var(--color-demo)", color: "var(--color-primary-foreground)" }}>Démonstration</Badge>}
          {e.is_verified && <Badge variant="outline" className="gap-1"><BadgeCheck className="h-3 w-3" />Vérifié</Badge>}
          {e.category && <Badge variant="outline">{e.category.name_fr}</Badge>}
          {e.is_free && <Badge style={{ background: "var(--color-secondary)", color: "var(--color-secondary-foreground)" }}>Gratuit</Badge>}
        </div>

        <h1 className="text-3xl font-bold md:text-4xl">{e.title}</h1>
        {e.short_description && <p className="mt-2 text-lg text-muted-foreground">{e.short_description}</p>}

        <div className="mt-6 grid gap-3 md:grid-cols-2">
          {occ && (
            <div className="glass flex items-start gap-3 rounded-xl p-4">
              <Calendar className="mt-0.5 h-5 w-5" style={{ color: "var(--color-primary)" }} />
              <div>
                <p className="text-xs uppercase text-muted-foreground">Date</p>
                <p className="font-medium">{new Intl.DateTimeFormat("fr-FR", { timeZone: tz, dateStyle: "full", timeStyle: "short" }).format(new Date(occ.starts_at))}</p>
                <p className="text-xs text-muted-foreground">Fuseau : {tz}</p>
              </div>
            </div>
          )}
          {e.venue && (
            <div className="glass flex items-start gap-3 rounded-xl p-4">
              <MapPin className="mt-0.5 h-5 w-5" style={{ color: "var(--color-primary)" }} />
              <div>
                <p className="text-xs uppercase text-muted-foreground">Lieu</p>
                <p className="font-medium">{e.venue.name}</p>
                <p className="text-xs text-muted-foreground">{e.venue.address} · {e.venue.city?.name}</p>
                {e.venue.latitude != null && e.venue.longitude != null && (
                  <a href={`https://www.openstreetmap.org/?mlat=${e.venue.latitude}&mlon=${e.venue.longitude}#map=17/${e.venue.latitude}/${e.venue.longitude}`}
                     target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-primary">
                    Itinéraire <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          )}
          {offer && (
            <div className="glass flex items-start gap-3 rounded-xl p-4">
              <Ticket className="mt-0.5 h-5 w-5" style={{ color: "var(--color-primary)" }} />
              <div>
                <p className="text-xs uppercase text-muted-foreground">Billets</p>
                <p className="font-medium">{offer.is_free ? "Gratuit" : `${offer.price_min ?? "?"} – ${offer.price_max ?? "?"} ${offer.currency ?? ""}`}</p>
                {offer.ticket_url && !cancelled && (
                  <a href={offer.ticket_url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-primary">
                    Billetterie <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          )}
          {e.organizer && (
            <div className="glass flex items-start gap-3 rounded-xl p-4">
              <BadgeCheck className="mt-0.5 h-5 w-5" style={{ color: "var(--color-primary)" }} />
              <div>
                <p className="text-xs uppercase text-muted-foreground">Organisateur</p>
                <p className="font-medium">{e.organizer.name}</p>
                {e.organizer.website && <a href={e.organizer.website} target="_blank" rel="noreferrer" className="text-xs text-primary">Site officiel</a>}
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
          <button onClick={addToAgenda} disabled={cancelled} className="btn-glow rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-40">
            Ajouter à l'agenda
          </button>
          <button onClick={toggleFav} className="flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-medium hover:bg-accent">
            <Heart className="h-4 w-4" fill={fav ? "currentColor" : "none"} /> {fav ? "Favori" : "Ajouter aux favoris"}
          </button>
          <button onClick={share} className="flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-medium hover:bg-accent">
            <Share2 className="h-4 w-4" /> Partager
          </button>
          <button onClick={report} className="flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-medium hover:bg-accent">
            <Flag className="h-4 w-4" /> Signaler
          </button>
        </div>

        <div className="mt-6 text-xs text-muted-foreground">
          {e.is_demo ? "Données de démonstration EVENTA · " : ""}
          <Link to="/" className="underline">← Retour à la découverte</Link>
        </div>
      </div>
    </div>
  );
}
