import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { MUSIC_GENRES } from "@/lib/event-filters";
import { toast } from "sonner";
import { useTranslation } from "@/lib/i18n";

export const Route = createFileRoute("/organizer/new")({
  head: () => ({ meta: [{ title: "Nouvel événement — Global Party" }] }),
  component: NewEvent,
});

const INITIAL_FORM = {
  title: "",
  short_description: "",
  description: "",
  organizer_id: "",
  venue_id: "",
  category_id: "",
  city_id: "",
  starts_at: "",
  ends_at: "",
  timezone: "Europe/Zurich",
  is_free: false,
  official_url: "",
  cover_image_url: "",
  age_restriction: "",
  capacity: "",
  price_min: "",
  price_max: "",
  ticket_url: "",
  genres: [] as string[],
};

function NewEvent() {
  const { tr, t, categoryLabel, genreLabel } = useTranslation();
  const navigate = useNavigate();
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string }>>([]);
  const [venues, setVenues] = useState<Array<{ id: string; name: string }>>([]);
  const [categories, setCategories] = useState<
    Array<{ id: string; slug: string; name_fr: string }>
  >([]);
  const [cities, setCities] = useState<Array<{ id: string; name: string; timezone: string }>>([]);
  const [form, setForm] = useState(INITIAL_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.auth.getUser();
      if (!data.user) {
        navigate({ to: "/auth", search: { redirect: "/organizer/new" } });
        return;
      }
      const [memberships, venueRows, categoryRows, cityRows] = await Promise.all([
        supabase
          .from("organizer_members")
          .select("organizer:organizers(id,name)")
          .eq("user_id", data.user.id),
        supabase.from("venues").select("id,name").order("name").limit(500),
        supabase.from("event_categories").select("id,slug,name_fr").order("sort_order"),
        supabase.from("cities").select("id,name,timezone").order("name").limit(500),
      ]);
      const nextOrganizations = (memberships.data ?? [])
        .map((membership) => membership.organizer)
        .filter(Boolean) as Array<{ id: string; name: string }>;
      setOrgs(nextOrganizations);
      setVenues((venueRows.data ?? []) as Array<{ id: string; name: string }>);
      setCategories(
        (categoryRows.data ?? []) as Array<{ id: string; slug: string; name_fr: string }>,
      );
      setCities((cityRows.data ?? []) as Array<{ id: string; name: string; timezone: string }>);
      setForm((current) => ({
        ...current,
        organizer_id: current.organizer_id || nextOrganizations[0]?.id || "",
      }));
    })();
  }, [navigate]);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const toggleGenre = (genre: string) => {
    set(
      "genres",
      form.genres.includes(genre)
        ? form.genres.filter((item) => item !== genre)
        : [...form.genres, genre],
    );
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.organizer_id || saving) {
      if (!form.organizer_id) toast.error(tr("Choisis une organisation."));
      return;
    }
    setSaving(true);
    try {
      const { data: authData } = await supabase.auth.getUser();
      if (!authData.user) throw new Error(tr("Session expirée"));
      const slugRoot =
        form.title
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "event";
      const slug = `${slugRoot}-${crypto.randomUUID().slice(0, 6)}`;
      const { data: createdEvent, error: eventError } = await supabase
        .from("events")
        .insert({
          slug,
          title: form.title.trim(),
          short_description: form.short_description.trim() || null,
          description: form.description.trim() || null,
          organizer_id: form.organizer_id,
          venue_id: form.venue_id || null,
          category_id: form.category_id || null,
          city_id: form.city_id || null,
          status: "pending_review",
          publication_status: "pending",
          is_free: form.is_free,
          official_url: form.official_url.trim() || null,
          cover_image_url: form.cover_image_url.trim() || null,
          age_restriction: form.age_restriction.trim() || null,
          genres: form.genres,
          created_by: authData.user.id,
        })
        .select("id")
        .single();
      if (eventError) throw eventError;

      const { error: occurrenceError } = await supabase.from("event_occurrences").insert({
        event_id: createdEvent.id,
        starts_at: new Date(form.starts_at).toISOString(),
        ends_at: form.ends_at ? new Date(form.ends_at).toISOString() : null,
        timezone: form.timezone,
        capacity: form.capacity ? Number(form.capacity) : null,
      });
      if (occurrenceError) {
        await supabase.from("events").delete().eq("id", createdEvent.id);
        throw occurrenceError;
      }

      if (form.is_free || form.price_min || form.price_max || form.ticket_url) {
        const { error: ticketError } = await supabase.from("ticket_offers").insert({
          event_id: createdEvent.id,
          name: form.is_free ? "Entrée gratuite" : "Billet standard",
          is_free: form.is_free,
          price_min: form.is_free ? 0 : form.price_min ? Number(form.price_min) : null,
          price_max: form.is_free ? 0 : form.price_max ? Number(form.price_max) : null,
          currency: "CHF",
          ticket_url: form.ticket_url.trim() || null,
          status: form.is_free ? "free" : "available",
        });
        if (ticketError) {
          toast.warning(`Événement créé, mais billetterie incomplète : ${ticketError.message}`);
        }
      }
      toast.success(tr("Événement envoyé pour vérification"));
      navigate({ to: "/organizer" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr("Impossible de créer l'événement"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-6">
      <Link
        to="/organizer"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> {tr("Dashboard organisateur")}
      </Link>
      <p className="text-xs font-semibold uppercase text-primary">{tr("Programmation")}</p>
      <h1 className="mb-6 text-3xl font-black">{tr("Créer un événement")}</h1>
      <form onSubmit={submit} className="glass space-y-5 rounded-[2rem] p-5 md:p-7">
        <FormField label={`${tr("Titre")} *`}>
          <input
            required
            maxLength={180}
            value={form.title}
            onChange={(event) => set("title", event.target.value)}
            className="field-control"
          />
        </FormField>

        <div className="grid gap-4 md:grid-cols-2">
          <FormField label={`${tr("Organisation")} *`}>
            <select
              required
              value={form.organizer_id}
              onChange={(event) => set("organizer_id", event.target.value)}
              className="field-control"
            >
              <option value="">{tr("Sélectionner")}</option>
              {orgs.map((organizer) => (
                <option key={organizer.id} value={organizer.id}>
                  {organizer.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label={tr("Catégorie")}>
            <select
              value={form.category_id}
              onChange={(event) => set("category_id", event.target.value)}
              className="field-control"
            >
              <option value="">{tr("Non précisée")}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {categoryLabel(category.slug, category.name_fr)}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label={tr("Lieu existant")}>
            <select
              value={form.venue_id}
              onChange={(event) => set("venue_id", event.target.value)}
              className="field-control"
            >
              <option value="">{tr("À confirmer")}</option>
              {venues.map((venue) => (
                <option key={venue.id} value={venue.id}>
                  {venue.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label={t("common.city")}>
            <select
              value={form.city_id}
              onChange={(event) => {
                const city = cities.find((item) => item.id === event.target.value);
                set("city_id", event.target.value);
                if (city) set("timezone", city.timezone);
              }}
              className="field-control"
            >
              <option value="">{tr("Non précisée")}</option>
              {cities.map((city) => (
                <option key={city.id} value={city.id}>
                  {city.name}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label={`${tr("Début")} *`}>
            <input
              type="datetime-local"
              required
              value={form.starts_at}
              onChange={(event) => set("starts_at", event.target.value)}
              className="field-control"
            />
          </FormField>
          <FormField label={tr("Fin")}>
            <input
              type="datetime-local"
              value={form.ends_at}
              onChange={(event) => set("ends_at", event.target.value)}
              className="field-control"
            />
          </FormField>
          <FormField label={tr("Fuseau horaire")}>
            <input
              required
              value={form.timezone}
              onChange={(event) => set("timezone", event.target.value)}
              className="field-control"
            />
          </FormField>
          <FormField label={tr("Capacité")}>
            <input
              type="number"
              min={1}
              value={form.capacity}
              onChange={(event) => set("capacity", event.target.value)}
              className="field-control"
            />
          </FormField>
        </div>

        <FormField label={tr("Description courte")}>
          <input
            maxLength={240}
            value={form.short_description}
            onChange={(event) => set("short_description", event.target.value)}
            className="field-control"
          />
        </FormField>
        <FormField label={tr("Description complète")}>
          <textarea
            value={form.description}
            onChange={(event) => set("description", event.target.value)}
            rows={5}
            className="field-control resize-none"
          />
        </FormField>

        <div className="grid gap-4 md:grid-cols-2">
          <FormField label={tr("Image de couverture (URL https)")}>
            <input
              type="url"
              value={form.cover_image_url}
              onChange={(event) => set("cover_image_url", event.target.value)}
              className="field-control"
            />
          </FormField>
          <FormField label={tr("Lien officiel")}>
            <input
              type="url"
              value={form.official_url}
              onChange={(event) => set("official_url", event.target.value)}
              className="field-control"
            />
          </FormField>
          <FormField label={tr("Restriction d'âge")}>
            <input
              value={form.age_restriction}
              onChange={(event) => set("age_restriction", event.target.value)}
              placeholder="18+"
              className="field-control"
            />
          </FormField>
        </div>

        <div className="rounded-2xl border p-4">
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input
              type="checkbox"
              checked={form.is_free}
              onChange={(event) => set("is_free", event.target.checked)}
              className="h-4 w-4 accent-[var(--color-primary)]"
            />{" "}
            {tr("Événement gratuit")}
          </label>
          {!form.is_free && (
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <FormField label={tr("Prix dès CHF")}>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.price_min}
                  onChange={(event) => set("price_min", event.target.value)}
                  className="field-control"
                />
              </FormField>
              <FormField label={tr("Prix maximum CHF")}>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.price_max}
                  onChange={(event) => set("price_max", event.target.value)}
                  className="field-control"
                />
              </FormField>
              <div className="md:col-span-2">
                <FormField label={tr("Lien de billetterie")}>
                  <input
                    type="url"
                    value={form.ticket_url}
                    onChange={(event) => set("ticket_url", event.target.value)}
                    className="field-control"
                  />
                </FormField>
              </div>
            </div>
          )}
        </div>

        <div>
          <p className="text-xs font-medium">{tr("Styles musicaux")}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {MUSIC_GENRES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={form.genres.includes(value)}
                onClick={() => toggleGenre(value)}
                className="rounded-full border px-2.5 py-1 text-xs"
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
          type="submit"
          disabled={saving}
          className="btn-glow w-full rounded-full bg-primary py-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"
        >
          {saving ? tr("Création…") : tr("Créer et envoyer pour vérification")}
        </button>
      </form>
    </div>
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
