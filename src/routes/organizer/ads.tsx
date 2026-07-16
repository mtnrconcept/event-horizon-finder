import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  CalendarClock,
  ChevronLeft,
  CircleDollarSign,
  Eye,
  Megaphone,
  MousePointerClick,
  Pause,
  Play,
  Plus,
  Target,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { fetchCities } from "@/lib/queries";
import { MUSIC_GENRES } from "@/lib/event-filters";
import {
  createAdCampaign,
  estimateAdAudience,
  fetchAdCampaigns,
  fetchOrganizerAdContext,
  updateAdCampaignStatus,
  type AdCampaign,
  type AdPlacement,
  type CampaignStatus,
  type OrganizerOption,
  type PromotableEvent,
  type PromotablePost,
} from "@/lib/ad-queries";
import { useTranslation } from "@/lib/i18n";

export const Route = createFileRoute("/organizer/ads")({
  head: () => ({ meta: [{ title: "Publicité et ciblage — Global Party" }] }),
  component: OrganizerAds,
});

type City = { id: string; name: string };

function toLocalInput(date: Date) {
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
}

function defaultForm() {
  return {
    organizerId: "",
    name: "",
    objective: "event_visits",
    promotedContent: "brand",
    headline: "",
    body: "",
    imageUrl: "",
    ctaLabel: "Découvrir",
    ctaUrl: "",
    placements: ["discover", "social"] as AdPlacement[],
    cityIds: [] as string[],
    ageMin: "",
    ageMax: "",
    genres: [] as string[],
    startsAt: toLocalInput(new Date(Date.now() + 60 * 60_000)),
    endsAt: toLocalInput(new Date(Date.now() + 8 * 24 * 60 * 60_000)),
    dailyBudget: "10",
    totalBudget: "70",
    activateNow: false,
  };
}

function OrganizerAds() {
  const { tr, t, genreLabel, formatNumber, localeTag } = useTranslation();
  const navigate = useNavigate();
  const [userId, setUserId] = useState<string | null>(null);
  const [organizers, setOrganizers] = useState<OrganizerOption[]>([]);
  const [events, setEvents] = useState<PromotableEvent[]>([]);
  const [posts, setPosts] = useState<PromotablePost[]>([]);
  const [cities, setCities] = useState<City[]>([]);
  const [campaigns, setCampaigns] = useState<AdCampaign[]>([]);
  const [form, setForm] = useState(defaultForm);
  const [showComposer, setShowComposer] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [estimatedAudience, setEstimatedAudience] = useState<number | null>(null);

  const loadCampaigns = useCallback(async (nextOrganizers: OrganizerOption[]) => {
    setCampaigns(await fetchAdCampaigns(nextOrganizers.map((organizer) => organizer.id)));
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data } = await supabase.auth.getUser();
      if (!data.user) {
        navigate({ to: "/auth", search: { redirect: "/organizer/ads" } });
        return;
      }
      const [context, cityRows] = await Promise.all([
        fetchOrganizerAdContext(data.user.id),
        fetchCities(),
      ]);
      if (!active) return;
      setUserId(data.user.id);
      setOrganizers(context.organizers);
      setEvents(context.events);
      setPosts(context.posts);
      setCities(cityRows as City[]);
      setForm((current) => ({
        ...current,
        organizerId: current.organizerId || context.organizers[0]?.id || "",
      }));
      await loadCampaigns(context.organizers);
      if (active) setLoading(false);
    })().catch((error) => {
      toast.error(error instanceof Error ? error.message : "Impossible de charger les campagnes");
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [loadCampaigns, navigate]);

  const selectedEvents = events.filter((event) => event.organizer_id === form.organizerId);
  const selectedPosts = posts.filter((post) => post.organizer_id === form.organizerId);
  const activeCampaigns = campaigns.filter((campaign) => campaign.status === "active").length;
  const totalImpressions = campaigns.reduce((sum, campaign) => sum + campaign.impression_count, 0);
  const totalClicks = campaigns.reduce((sum, campaign) => sum + campaign.click_count, 0);
  const averageCtr = totalImpressions ? (totalClicks / totalImpressions) * 100 : 0;
  const selectedOrganizer = organizers.find((organizer) => organizer.id === form.organizerId);

  const promotedEntity = useMemo(() => {
    const [kind, id] = form.promotedContent.split(":");
    return {
      eventId: kind === "event" ? id : null,
      postId: kind === "post" ? id : null,
    };
  }, [form.promotedContent]);

  const set = <K extends keyof ReturnType<typeof defaultForm>>(
    key: K,
    value: ReturnType<typeof defaultForm>[K],
  ) => setForm((current) => ({ ...current, [key]: value }));

  const togglePlacement = (placement: AdPlacement) => {
    set(
      "placements",
      form.placements.includes(placement)
        ? form.placements.filter((item) => item !== placement)
        : [...form.placements, placement],
    );
  };

  const toggleGenre = (genre: string) => {
    set(
      "genres",
      form.genres.includes(genre)
        ? form.genres.filter((item) => item !== genre)
        : [...form.genres, genre],
    );
  };

  const estimate = async () => {
    try {
      const count = await estimateAdAudience({
        cityIds: form.cityIds,
        ageMin: form.ageMin ? Number(form.ageMin) : null,
        ageMax: form.ageMax ? Number(form.ageMax) : null,
        genres: form.genres,
      });
      setEstimatedAudience(count);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Estimation indisponible");
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!userId || !form.organizerId || !form.placements.length) return;
    setSaving(true);
    try {
      await createAdCampaign({
        organizer_id: form.organizerId,
        name: form.name.trim(),
        status: form.activateNow ? "active" : "draft",
        objective: form.objective,
        promoted_event_id: promotedEntity.eventId,
        promoted_post_id: promotedEntity.postId,
        headline: form.headline.trim(),
        body: form.body.trim() || null,
        image_url: form.imageUrl.trim() || null,
        cta_label: form.ctaLabel.trim() || "Découvrir",
        cta_url: form.ctaUrl.trim() || null,
        placements: form.placements,
        target_city_ids: form.cityIds,
        target_age_min: form.ageMin ? Number(form.ageMin) : null,
        target_age_max: form.ageMax ? Number(form.ageMax) : null,
        target_music_genres: form.genres,
        starts_at: new Date(form.startsAt).toISOString(),
        ends_at: new Date(form.endsAt).toISOString(),
        daily_budget: Number(form.dailyBudget),
        total_budget: Number(form.totalBudget),
        currency: "CHF",
      });
      toast.success(form.activateNow ? "Campagne activée" : "Brouillon publicitaire créé");
      const organizerId = form.organizerId;
      setForm({ ...defaultForm(), organizerId });
      setShowComposer(false);
      setEstimatedAudience(null);
      await loadCampaigns(organizers);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Impossible de créer la campagne");
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (campaign: AdCampaign, status: CampaignStatus) => {
    try {
      await updateAdCampaignStatus(campaign.id, status);
      await loadCampaigns(organizers);
      toast.success(status === "active" ? "Campagne activée" : "Campagne mise en pause");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Mise à jour impossible");
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-12 text-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  if (!organizers.length) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <Megaphone className="mx-auto h-12 w-12 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">{tr("Crée d'abord ton organisation")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {tr("Une organisation est nécessaire pour publier et promouvoir du contenu.")}
        </p>
        <Link
          to="/organizer"
          className="mt-5 inline-flex rounded-full bg-primary px-5 py-2 text-sm text-primary-foreground"
        >
          {tr("Portail organisateur")}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-6">
      <Link
        to="/organizer"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> {tr("Dashboard organisateur")}
      </Link>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase text-primary">
            {tr("Audience & acquisition")}
          </p>
          <h1 className="text-3xl font-black md:text-4xl">{tr("Campagnes publicitaires")}</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {tr(
              "Mets en avant un événement, une publication ou ton organisation auprès des clients consentants selon leur ville, leur tranche d'âge et leurs goûts musicaux.",
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowComposer((current) => !current)}
          className="btn-glow inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
        >
          <Plus className="h-4 w-4" /> {tr("Nouvelle campagne")}
        </button>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric icon={Megaphone} label={tr("Actives")} value={formatNumber(activeCampaigns)} />
        <Metric icon={Eye} label={tr("Impressions")} value={formatNumber(totalImpressions)} />
        <Metric
          icon={MousePointerClick}
          label={tr("Clics")}
          value={totalClicks.toLocaleString("fr-CH")}
        />
        <Metric icon={BarChart3} label={tr("CTR moyen")} value={`${averageCtr.toFixed(1)}%`} />
      </div>

      {showComposer && (
        <form onSubmit={submit} className="glass mb-7 rounded-[2rem] p-5 md:p-7">
          <div className="mb-6">
            <p className="text-xs font-semibold uppercase text-primary">{tr("Configuration")}</p>
            <h2 className="text-2xl font-bold">{tr("Créer une campagne ciblée")}</h2>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-4">
              <FormField label={tr("Organisation")}>
                <select
                  value={form.organizerId}
                  onChange={(event) => set("organizerId", event.target.value)}
                  className="field-control"
                >
                  {organizers.map((organizer) => (
                    <option key={organizer.id} value={organizer.id}>
                      {organizer.name}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label={tr("Nom interne de la campagne")}>
                <input
                  required
                  minLength={2}
                  maxLength={120}
                  value={form.name}
                  onChange={(event) => set("name", event.target.value)}
                  placeholder={tr("Lancement festival été")}
                  className="field-control"
                />
              </FormField>
              <FormField label={tr("Objectif")}>
                <select
                  value={form.objective}
                  onChange={(event) => set("objective", event.target.value)}
                  className="field-control"
                >
                  <option value="awareness">{tr("Notoriété")}</option>
                  <option value="engagement">{tr("Engagement sur le fil")}</option>
                  <option value="event_visits">{tr("Visites de la fiche événement")}</option>
                  <option value="ticket_sales">{tr("Ventes de billets")}</option>
                </select>
              </FormField>
              <FormField label={tr("Contenu à promouvoir")}>
                <select
                  value={form.promotedContent}
                  onChange={(event) => set("promotedContent", event.target.value)}
                  className="field-control"
                >
                  <option value="brand">
                    {tr("L'organisation {name}", { name: selectedOrganizer?.name ?? "" })}
                  </option>
                  <optgroup label={tr("Événements publiés")}>
                    {selectedEvents.map((item) => (
                      <option key={item.id} value={`event:${item.id}`}>
                        {item.title}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={tr("Publications du fil")}>
                    {selectedPosts.map((item) => (
                      <option key={item.id} value={`post:${item.id}`}>
                        {item.body?.slice(0, 70) || "Publication avec média"}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </FormField>
              <FormField label={tr("Titre publicitaire")}>
                <input
                  required
                  minLength={2}
                  maxLength={140}
                  value={form.headline}
                  onChange={(event) => set("headline", event.target.value)}
                  placeholder={tr("La nuit que Genève attendait")}
                  className="field-control"
                />
              </FormField>
              <FormField label={tr("Message")}>
                <textarea
                  value={form.body}
                  onChange={(event) => set("body", event.target.value)}
                  rows={3}
                  maxLength={500}
                  className="field-control resize-none"
                />
              </FormField>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label={tr("Image (URL https)")}>
                  <input
                    type="url"
                    value={form.imageUrl}
                    onChange={(event) => set("imageUrl", event.target.value)}
                    placeholder="https://…"
                    className="field-control"
                  />
                </FormField>
                <FormField label={tr("Lien externe (facultatif)")}>
                  <input
                    type="url"
                    value={form.ctaUrl}
                    onChange={(event) => set("ctaUrl", event.target.value)}
                    placeholder={tr("Billetterie https://…")}
                    className="field-control"
                  />
                </FormField>
              </div>
            </div>

            <div className="space-y-5">
              <div className="rounded-2xl border p-4">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <Target className="h-4 w-4 text-primary" /> {tr("Ciblage")}
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <FormField label={tr("Âge minimum")}>
                    <input
                      type="number"
                      min={13}
                      max={100}
                      value={form.ageMin}
                      onChange={(event) => set("ageMin", event.target.value)}
                      placeholder="18"
                      className="field-control"
                    />
                  </FormField>
                  <FormField label={tr("Âge maximum")}>
                    <input
                      type="number"
                      min={13}
                      max={100}
                      value={form.ageMax}
                      onChange={(event) => set("ageMax", event.target.value)}
                      placeholder="45"
                      className="field-control"
                    />
                  </FormField>
                </div>
                <FormField label={tr("Villes (Ctrl/Cmd pour plusieurs)")}>
                  <select
                    multiple
                    size={5}
                    value={form.cityIds}
                    onChange={(event) =>
                      set(
                        "cityIds",
                        Array.from(event.target.selectedOptions, (option) => option.value),
                      )
                    }
                    className="field-control mt-1"
                  >
                    {cities.map((city) => (
                      <option key={city.id} value={city.id}>
                        {city.name}
                      </option>
                    ))}
                  </select>
                </FormField>
                <div className="mt-4">
                  <p className="text-xs font-medium">{tr("Styles musicaux")}</p>
                  <div className="mt-2 flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
                    {MUSIC_GENRES.map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => toggleGenre(value)}
                        className="rounded-full border px-2.5 py-1 text-[11px]"
                        style={
                          form.genres.includes(value)
                            ? { borderColor: "var(--color-primary)", color: "var(--color-primary)" }
                            : undefined
                        }
                      >
                        {genreLabel(value, label)}
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void estimate()}
                  className="mt-4 inline-flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-semibold hover:bg-accent"
                >
                  <Users className="h-4 w-4" /> {tr("Estimer l'audience")}
                </button>
                {estimatedAudience !== null && (
                  <p className="mt-2 text-sm font-semibold text-primary">
                    {estimatedAudience === 0
                      ? "Moins de 20 profils consentants"
                      : `Environ ${estimatedAudience.toLocaleString("fr-CH")} profils`}
                  </p>
                )}
              </div>

              <div className="rounded-2xl border p-4">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <CalendarClock className="h-4 w-4 text-primary" /> {tr("Diffusion")}
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <FormField label={tr("Début")}>
                    <input
                      required
                      type="datetime-local"
                      value={form.startsAt}
                      onChange={(event) => set("startsAt", event.target.value)}
                      className="field-control"
                    />
                  </FormField>
                  <FormField label={tr("Fin")}>
                    <input
                      required
                      type="datetime-local"
                      value={form.endsAt}
                      onChange={(event) => set("endsAt", event.target.value)}
                      className="field-control"
                    />
                  </FormField>
                </div>
                <p className="mt-4 text-xs font-medium">{tr("Emplacements")}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(
                    [
                      ["discover", "Découverte"],
                      ["social", "Fil social"],
                      ["event", "Fiches événements"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => togglePlacement(value)}
                      className="rounded-full border px-3 py-1.5 text-xs"
                      style={
                        form.placements.includes(value)
                          ? { borderColor: "var(--color-primary)", color: "var(--color-primary)" }
                          : undefined
                      }
                    >
                      {tr(label)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border p-4">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <CircleDollarSign className="h-4 w-4 text-primary" /> {tr("Budget indicatif")}
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <FormField label={tr("Par jour (CHF)")}>
                    <input
                      required
                      type="number"
                      min={1}
                      step="0.01"
                      value={form.dailyBudget}
                      onChange={(event) => set("dailyBudget", event.target.value)}
                      className="field-control"
                    />
                  </FormField>
                  <FormField label={tr("Total (CHF)")}>
                    <input
                      required
                      type="number"
                      min={1}
                      step="0.01"
                      value={form.totalBudget}
                      onChange={(event) => set("totalBudget", event.target.value)}
                      className="field-control"
                    />
                  </FormField>
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {tr(
                    "Le paiement et la facturation seront validés séparément avant toute dépense réelle.",
                  )}
                </p>
              </div>

              <label className="flex items-start gap-3 rounded-2xl bg-primary/5 p-4 text-sm">
                <input
                  type="checkbox"
                  checked={form.activateNow}
                  onChange={(event) => set("activateNow", event.target.checked)}
                  className="mt-1 h-4 w-4 accent-[var(--color-primary)]"
                />
                <span>
                  <span className="block font-semibold">{tr("Activer dès la date de début")}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {tr("Sinon, la campagne restera en brouillon.")}
                  </span>
                </span>
              </label>
            </div>
          </div>
          <div className="mt-6 flex justify-end gap-2 border-t pt-5">
            <button
              type="button"
              onClick={() => setShowComposer(false)}
              className="rounded-full border px-5 py-2.5 text-sm"
            >
              {tr("Annuler")}
            </button>
            <button
              type="submit"
              disabled={saving || !form.placements.length}
              className="btn-glow rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              {saving
                ? "Création…"
                : form.activateNow
                  ? "Créer et activer"
                  : "Enregistrer le brouillon"}
            </button>
          </div>
        </form>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xl font-bold">{tr("Toutes les campagnes")}</h2>
          <span className="text-xs text-muted-foreground">
            {tr("{count} campagne(s)", { count: campaigns.length })}
          </span>
        </div>
        {campaigns.length ? (
          <div className="space-y-3">
            {campaigns.map((campaign) => (
              <article key={campaign.id} className="glass rounded-3xl p-4 md:p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-bold">{campaign.name}</h3>
                      <CampaignStatusBadge status={campaign.status} />
                    </div>
                    <p className="mt-1 line-clamp-1 text-sm text-muted-foreground">
                      {campaign.headline}
                    </p>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      {new Date(campaign.starts_at).toLocaleDateString(localeTag)} →{" "}
                      {new Date(campaign.ends_at).toLocaleDateString(localeTag)} ·{" "}
                      {formatNumber(campaign.total_budget)} {campaign.currency}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void changeStatus(
                        campaign,
                        campaign.status === "active" ? "paused" : "active",
                      )
                    }
                    disabled={!["active", "paused", "draft"].includes(campaign.status)}
                    className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                  >
                    {campaign.status === "active" ? (
                      <Pause className="h-3.5 w-3.5" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                    {campaign.status === "active" ? "Pause" : "Activer"}
                  </button>
                </div>
                <div className="mt-4 grid grid-cols-4 gap-2 border-t pt-4 text-center">
                  <SmallMetric
                    label={tr("Impressions")}
                    value={campaign.impression_count.toLocaleString("fr-CH")}
                  />
                  <SmallMetric label={tr("Clics")} value={formatNumber(campaign.click_count)} />
                  <SmallMetric
                    label={tr("Portée")}
                    value={campaign.unique_reach.toLocaleString("fr-CH")}
                  />
                  <SmallMetric label="CTR" value={`${campaign.click_through_rate.toFixed(1)}%`} />
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="glass rounded-3xl p-10 text-center">
            <Megaphone className="mx-auto h-10 w-10 text-muted-foreground" />
            <p className="mt-3 font-semibold">{tr("Aucune campagne pour le moment")}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {tr("Crée un premier brouillon et estime son audience.")}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Megaphone;
  label: string;
  value: string;
}) {
  return (
    <div className="glass rounded-2xl p-4">
      <Icon className="mb-2 h-4 w-4 text-primary" />
      <p className="text-2xl font-black">{value}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

function SmallMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-sm font-bold sm:text-base">{value}</p>
      <p className="truncate text-[9px] text-muted-foreground sm:text-[11px]">{label}</p>
    </div>
  );
}

function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  const labels: Record<CampaignStatus, string> = {
    draft: "Brouillon",
    active: "Active",
    paused: "En pause",
    completed: "Terminée",
    rejected: "Refusée",
  };
  return (
    <span
      className="rounded-full border px-2 py-0.5 text-[10px]"
      style={
        status === "active"
          ? { borderColor: "var(--color-live)", color: "var(--color-live)" }
          : undefined
      }
    >
      {labels[status]}
    </span>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium">
      <span className="mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}
