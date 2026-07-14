import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  BadgeCheck,
  CalendarDays,
  Eye,
  Megaphone,
  MousePointerClick,
  Plus,
  Radio,
  Settings,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { SocialPostComposer } from "@/components/social/social-post-composer";
import { fetchAdCampaigns, type AdCampaign } from "@/lib/ad-queries";
import { toast } from "sonner";

export const Route = createFileRoute("/organizer/")({
  head: () => ({ meta: [{ title: "Dashboard organisateur — EVENTA" }] }),
  component: OrganizerHome,
});

type OrgRow = {
  organizer_id: string;
  role: string;
  organizer: { name: string; slug: string; is_verified: boolean };
};
type EventRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  is_demo: boolean;
  updated_at: string;
};

function OrganizerHome() {
  const navigate = useNavigate();
  const [userId, setUserId] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [campaigns, setCampaigns] = useState<AdCampaign[]>([]);
  const [postCount, setPostCount] = useState(0);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");

  const loadOrganizerData = useCallback(async () => {
    const { data, error: userError } = await supabase.auth.getUser();
    if (!data.user) {
      navigate({ to: "/auth", search: { redirect: "/organizer" } });
      return;
    }
    if (userError) {
      toast.error(userError.message);
      return;
    }
    setUserId(data.user.id);

    const { data: membershipRows, error: membershipsError } = await supabase
      .from("organizer_members")
      .select("organizer_id, role, organizer:organizers(name,slug,is_verified)")
      .eq("user_id", data.user.id);
    if (membershipsError) throw membershipsError;

    const memberships = (membershipRows ?? []) as OrgRow[];
    setOrgs(memberships);
    const organizerIds = memberships.map((membership) => membership.organizer_id);
    if (!organizerIds.length) {
      setEvents([]);
      setCampaigns([]);
      setPostCount(0);
      setLoading(false);
      return;
    }

    const [{ data: eventRows, error: eventsError }, { count, error: postsError }, campaignRows] =
      await Promise.all([
        supabase
          .from("events")
          .select("id,slug,title,status,is_demo,updated_at")
          .in("organizer_id", organizerIds)
          .order("updated_at", { ascending: false }),
        supabase
          .from("social_posts")
          .select("id", { count: "exact", head: true })
          .in("organizer_id", organizerIds),
        fetchAdCampaigns(organizerIds),
      ]);
    if (eventsError) throw eventsError;
    if (postsError) throw postsError;
    setEvents((eventRows ?? []) as EventRow[]);
    setPostCount(count ?? 0);
    setCampaigns(campaignRows);
    setLoading(false);
  }, [navigate]);

  useEffect(() => {
    void loadOrganizerData().catch((error) => {
      setLoading(false);
      toast.error(error instanceof Error ? error.message : "Impossible de charger le dashboard");
    });
  }, [loadOrganizerData]);

  const createOrg = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || submitting) return;
    const slugRoot =
      trimmedName
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "organisation";
    const slug = `${slugRoot}-${crypto.randomUUID().slice(0, 6)}`;

    setSubmitting(true);
    const { error } = await supabase.rpc("create_organizer", { _name: trimmedName, _slug: slug });
    setSubmitting(false);
    if (error) return toast.error(error.message);
    toast.success("Organisation créée");
    setCreating(false);
    setName("");
    await loadOrganizerData();
  };

  const stats = useMemo(() => {
    const activeCampaigns = campaigns.filter((campaign) => campaign.status === "active").length;
    const impressions = campaigns.reduce((sum, campaign) => sum + campaign.impression_count, 0);
    const clicks = campaigns.reduce((sum, campaign) => sum + campaign.click_count, 0);
    return { activeCampaigns, impressions, clicks };
  }, [campaigns]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-6">
      <section className="relative mb-7 overflow-hidden rounded-[2rem] border p-6 md:p-8">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_15%_20%,oklch(0.68_0.22_295_/_0.38),transparent_35%),radial-gradient(circle_at_88%_15%,oklch(0.72_0.18_35_/_0.20),transparent_30%),linear-gradient(135deg,oklch(0.19_0.03_265_/_0.95),oklch(0.12_0.03_265_/_0.9))]" />
        <p className="text-xs font-semibold uppercase text-primary">Espace professionnel</p>
        <h1 className="mt-2 text-3xl font-black md:text-5xl">Dashboard organisateur</h1>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground md:text-base">
          Crée tes événements, anime ton audience et pilote tes campagnes depuis un seul espace.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Link
            to="/organizer/new"
            className="btn-glow inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
          >
            <Plus className="h-4 w-4" /> Créer un événement
          </Link>
          <a
            href="#publier"
            className="inline-flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-semibold hover:bg-accent"
          >
            <Radio className="h-4 w-4" /> Publier sur le fil
          </a>
          <Link
            to="/organizer/ads"
            className="inline-flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-semibold hover:bg-accent"
          >
            <Megaphone className="h-4 w-4" /> Lancer une campagne
          </Link>
        </div>
      </section>

      {loading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          Chargement de tes données…
        </div>
      ) : orgs.length === 0 ? (
        <section className="glass rounded-3xl p-7 text-center">
          <Settings className="mx-auto h-10 w-10 text-muted-foreground" />
          <h2 className="mt-3 text-xl font-bold">Crée ton organisation</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Elle regroupera tes événements, publications, collaborateurs et campagnes.
          </p>
          {!creating ? (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="mt-5 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground"
            >
              Commencer
            </button>
          ) : (
            <form onSubmit={createOrg} className="mx-auto mt-5 flex max-w-md gap-2">
              <input
                required
                minLength={2}
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Nom de l'organisation"
                className="field-control"
              />
              <button
                type="submit"
                disabled={submitting}
                className="rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
              >
                {submitting ? "…" : "Créer"}
              </button>
            </form>
          )}
        </section>
      ) : (
        <>
          <div className="mb-7 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <DashboardMetric
              icon={CalendarDays}
              label="Événements"
              value={events.length.toString()}
            />
            <DashboardMetric icon={Radio} label="Publications" value={postCount.toString()} />
            <DashboardMetric
              icon={Megaphone}
              label="Campagnes actives"
              value={stats.activeCampaigns.toString()}
            />
            <DashboardMetric
              icon={Eye}
              label="Impressions"
              value={stats.impressions.toLocaleString("fr-CH")}
            />
            <DashboardMetric
              icon={MousePointerClick}
              label="Clics"
              value={stats.clicks.toLocaleString("fr-CH")}
            />
          </div>

          <section className="mb-7 grid gap-3 md:grid-cols-2">
            {orgs.map((membership) => (
              <article key={membership.organizer_id} className="glass rounded-3xl p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-bold">{membership.organizer.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Rôle : {membership.role}</p>
                  </div>
                  {membership.organizer.is_verified && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-semibold text-primary">
                      <BadgeCheck className="h-3.5 w-3.5" /> Vérifié
                    </span>
                  )}
                </div>
              </article>
            ))}
          </section>

          {userId && (
            <section id="publier" className="mb-7 scroll-mt-24">
              <div className="mb-3 flex items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase text-primary">Communication</p>
                  <h2 className="text-2xl font-bold">Publier sur le fil</h2>
                </div>
                <Link to="/social" className="text-xs font-semibold text-primary">
                  Voir le fil
                </Link>
              </div>
              <SocialPostComposer userId={userId} />
            </section>
          )}

          <section className="mb-7">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase text-primary">Programmation</p>
                <h2 className="text-2xl font-bold">Tes événements</h2>
              </div>
              <Link
                to="/organizer/new"
                className="inline-flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground"
              >
                <Plus className="h-4 w-4" /> Nouveau
              </Link>
            </div>
            <div className="glass overflow-hidden rounded-3xl">
              {events.length === 0 ? (
                <p className="p-7 text-sm text-muted-foreground">Aucun événement pour l'instant.</p>
              ) : (
                <ul className="divide-y">
                  {events.slice(0, 12).map((event) => (
                    <li key={event.id} className="flex items-center justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{event.title}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Statut : {event.status}
                          {event.is_demo ? " · démo" : ""}
                        </p>
                      </div>
                      <Link
                        to="/event/$slug"
                        params={{ slug: event.slug }}
                        className="shrink-0 text-sm font-semibold text-primary"
                      >
                        Voir
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase text-primary">Acquisition</p>
                <h2 className="text-2xl font-bold">Publicité</h2>
              </div>
              <Link
                to="/organizer/ads"
                className="inline-flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold hover:bg-accent"
              >
                <BarChart3 className="h-4 w-4" /> Module complet
              </Link>
            </div>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {campaigns.slice(0, 3).map((campaign) => (
                <article key={campaign.id} className="glass rounded-3xl p-5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-semibold">{campaign.name}</p>
                    <span className="rounded-full border px-2 py-0.5 text-[10px]">
                      {campaign.status}
                    </span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                    {campaign.headline}
                  </p>
                  <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                    <span>{campaign.impression_count.toLocaleString("fr-CH")} impressions</span>
                    <span>{campaign.click_count.toLocaleString("fr-CH")} clics</span>
                  </div>
                </article>
              ))}
              {!campaigns.length && (
                <div className="glass rounded-3xl p-6 md:col-span-2 lg:col-span-3">
                  <p className="font-semibold">Transforme ta visibilité en audience</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Crée une campagne ciblée et estime sa portée avant activation.
                  </p>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function DashboardMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CalendarDays;
  label: string;
  value: string;
}) {
  return (
    <div className="glass rounded-2xl p-4">
      <Icon className="mb-2 h-4 w-4 text-primary" />
      <p className="text-2xl font-black">{value}</p>
      <p className="text-[10px] text-muted-foreground sm:text-[11px]">{label}</p>
    </div>
  );
}
