/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Heart,
  LogOut,
  Megaphone,
  Settings,
  Shield,
  ShieldCheck,
  Trash2,
  User,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { MUSIC_GENRES } from "@/lib/event-filters";
import { notifyPrivacyUpdated } from "@/lib/client-analytics";
import { CitySearchInput } from "@/components/city-search-input";
import { useTranslation } from "@/lib/i18n";

const profileDb = supabase as unknown as SupabaseClient<any>;

export const Route = createFileRoute("/profile")({
  head: () => ({ meta: [{ title: "Mon profil — Global Party" }] }),
  component: Profile,
});

type ProfileState = {
  display_name: string;
  account_type: "client" | "organizer";
  home_city_id: string;
  birth_year: string;
  music_preferences: string[];
  analytics_consent: boolean;
  personalized_ads_consent: boolean;
};

const EMPTY_PROFILE: ProfileState = {
  display_name: "",
  account_type: "client",
  home_city_id: "",
  birth_year: "",
  music_preferences: [],
  analytics_consent: false,
  personalized_ads_consent: false,
};

function Profile() {
  const { tr, genreLabel } = useTranslation();
  const navigate = useNavigate();
  const [session, setSession] = useState<{ email?: string; id: string } | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [homeCityLabel, setHomeCityLabel] = useState("");
  const [profile, setProfile] = useState<ProfileState>(EMPTY_PROFILE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const { data } = await profileDb.auth.getUser();
      if (!data.user) {
        setSession(null);
        return;
      }
      setSession({ email: data.user.email, id: data.user.id });
      const [{ data: profileRow }, { data: roleRows }] = await Promise.all([
        profileDb
          .from("profiles")
          .select(
            "display_name,account_type,home_city_id,birth_year,music_preferences,analytics_consent,personalized_ads_consent,home_city:cities(name)",
          )
          .eq("id", data.user.id)
          .maybeSingle(),
        profileDb.from("user_roles").select("role").eq("user_id", data.user.id),
      ]);
      if (profileRow) {
        const homeCity = Array.isArray(profileRow.home_city)
          ? profileRow.home_city[0]
          : profileRow.home_city;
        setHomeCityLabel(homeCity?.name ?? "");
        setProfile({
          display_name: profileRow.display_name ?? "",
          account_type: profileRow.account_type === "organizer" ? "organizer" : "client",
          home_city_id: profileRow.home_city_id ?? "",
          birth_year: profileRow.birth_year ? String(profileRow.birth_year) : "",
          music_preferences: profileRow.music_preferences ?? [],
          analytics_consent: Boolean(profileRow.analytics_consent),
          personalized_ads_consent: Boolean(profileRow.personalized_ads_consent),
        });
      }
      setRoles((roleRows ?? []).map((row: { role: string }) => row.role));
    })();
  }, []);

  const toggleGenre = (genre: string) => {
    setProfile((current) => ({
      ...current,
      music_preferences: current.music_preferences.includes(genre)
        ? current.music_preferences.filter((item) => item !== genre)
        : current.music_preferences.length < 20
          ? [...current.music_preferences, genre]
          : current.music_preferences,
    }));
  };

  const saveProfile = async () => {
    if (!session || saving) return;
    setSaving(true);
    const { error } = await profileDb
      .from("profiles")
      .update({
        display_name: profile.display_name.trim(),
        home_city_id: profile.home_city_id || null,
        birth_year: profile.birth_year ? Number(profile.birth_year) : null,
        music_preferences: profile.music_preferences,
        analytics_consent: profile.analytics_consent,
        personalized_ads_consent: profile.personalized_ads_consent,
        consent_updated_at: new Date().toISOString(),
      })
      .eq("id", session.id);
    setSaving(false);
    if (error) return toast.error(error.message);
    notifyPrivacyUpdated();
    toast.success(tr("Profil et préférences enregistrés"));
  };

  const deleteJourney = async () => {
    const confirmed = window.confirm(
      tr("Supprimer définitivement tout l'historique de parcours associé à ton compte ?"),
    );
    if (!confirmed) return;
    const { error } = await profileDb.rpc("delete_my_client_journey");
    if (error) return toast.error(error.message);
    toast.success(tr("Historique de parcours supprimé"));
  };

  const signOut = async () => {
    await profileDb.auth.signOut();
    navigate({ to: "/auth" });
  };

  if (!session) {
    return (
      <div className="mx-auto max-w-md px-4 pt-16 text-center">
        <User className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
        <h1 className="text-2xl font-bold">{tr("Ton profil")}</h1>
        <p className="mt-2 text-muted-foreground">{tr("Crée un compte client ou organisateur.")}</p>
        <Link
          to="/auth"
          className="btn-glow mt-6 inline-flex rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground"
        >
          {tr("Se connecter ou s'inscrire")}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pt-8 md:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase text-primary">
            {profile.account_type === "organizer" ? tr("Compte organisateur") : tr("Compte client")}
          </p>
          <h1 className="text-3xl font-black">{tr("Profil et préférences")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{session.email}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {roles.map((role) => (
            <span
              key={role}
              className="rounded-full border border-primary/40 px-3 py-1 text-xs text-primary"
            >
              {role}
            </span>
          ))}
        </div>
      </div>

      <section className="glass mb-4 space-y-4 rounded-3xl p-5 md:p-6">
        <h2 className="text-lg font-semibold">{tr("Informations personnelles")}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-xs font-medium">
            <span className="mb-1.5 block">{tr("Nom affiché")}</span>
            <input
              value={profile.display_name}
              maxLength={100}
              onChange={(event) =>
                setProfile((current) => ({ ...current, display_name: event.target.value }))
              }
              className="field-control"
            />
          </label>
          <label className="text-xs font-medium">
            <span className="mb-1.5 block">{tr("Ville principale")}</span>
            <CitySearchInput
              value={profile.home_city_id}
              initialLabel={homeCityLabel}
              onChange={(homeCityId) =>
                setProfile((current) => ({ ...current, home_city_id: homeCityId }))
              }
            />
          </label>
          {profile.account_type === "client" && (
            <label className="text-xs font-medium">
              <span className="mb-1.5 block">{tr("Année de naissance")}</span>
              <input
                type="number"
                min={1900}
                max={new Date().getFullYear()}
                value={profile.birth_year}
                onChange={(event) =>
                  setProfile((current) => ({ ...current, birth_year: event.target.value }))
                }
                className="field-control"
              />
            </label>
          )}
        </div>
      </section>

      {profile.account_type === "client" && (
        <>
          <section className="glass mb-4 rounded-3xl p-5 md:p-6">
            <h2 className="text-lg font-semibold">{tr("Goûts musicaux")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {tr("Ils servent aux recommandations et, avec ton accord, au ciblage publicitaire.")}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {MUSIC_GENRES.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={profile.music_preferences.includes(value)}
                  onClick={() => toggleGenre(value)}
                  className="rounded-full border px-3 py-1.5 text-xs"
                  style={
                    profile.music_preferences.includes(value)
                      ? { borderColor: "var(--color-primary)", color: "var(--color-primary)" }
                      : undefined
                  }
                >
                  {genreLabel(value, label)}
                </button>
              ))}
            </div>
          </section>

          <section className="glass mb-4 rounded-3xl p-5 md:p-6">
            <div className="flex items-start gap-3">
              <ShieldCheck className="h-6 w-6 shrink-0 text-primary" />
              <div>
                <h2 className="text-lg font-semibold">{tr("Données et confidentialité")}</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {tr(
                    "Les parcours individuels ne sont jamais visibles par les organisateurs. Ils reçoivent uniquement des statistiques agrégées.",
                  )}
                </p>
              </div>
            </div>
            <div className="mt-5 space-y-3">
              <PrivacyToggle
                checked={profile.analytics_consent}
                onChange={(checked) =>
                  setProfile((current) => ({ ...current, analytics_consent: checked }))
                }
                title={tr("Analyse du parcours")}
                description={tr(
                  "Pages vues et interactions pour améliorer l'expérience et les recommandations.",
                )}
              />
              <PrivacyToggle
                checked={profile.personalized_ads_consent}
                onChange={(checked) =>
                  setProfile((current) => ({ ...current, personalized_ads_consent: checked }))
                }
                title={tr("Publicités personnalisées")}
                description={tr("Ciblage selon ta ville, ta tranche d'âge et tes styles musicaux.")}
              />
            </div>
            <button
              type="button"
              onClick={() => void deleteJourney()}
              className="mt-5 inline-flex items-center gap-2 rounded-full border px-4 py-2 text-xs text-muted-foreground hover:bg-accent"
            >
              <Trash2 className="h-4 w-4" /> {tr("Supprimer mon historique de parcours")}
            </button>
          </section>
        </>
      )}

      <button
        type="button"
        onClick={() => void saveProfile()}
        disabled={saving}
        className="btn-glow mb-4 w-full rounded-full bg-primary py-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"
      >
        {saving ? tr("Enregistrement…") : tr("Enregistrer toutes les modifications")}
      </button>

      <div className="glass mb-4 space-y-2 rounded-3xl p-4">
        <Link to="/favorites" className="flex items-center gap-3 rounded-xl p-3 hover:bg-accent">
          <Heart className="h-5 w-5" /> {tr("Mes favoris")}
        </Link>
        <Link to="/organizer" className="flex items-center gap-3 rounded-xl p-3 hover:bg-accent">
          <Settings className="h-5 w-5" /> {tr("Portail organisateur")}
        </Link>
        {roles.includes("organizer") && (
          <Link
            to="/organizer/ads"
            className="flex items-center gap-3 rounded-xl p-3 hover:bg-accent"
          >
            <Megaphone className="h-5 w-5" /> {tr("Campagnes publicitaires")}
          </Link>
        )}
        {(roles.includes("admin") || roles.includes("moderator")) && (
          <Link to="/admin" className="flex items-center gap-3 rounded-xl p-3 hover:bg-accent">
            <Shield className="h-5 w-5" /> {tr("Administration")}
          </Link>
        )}
      </div>
      <button
        type="button"
        onClick={() => void signOut()}
        className="flex w-full items-center justify-center gap-2 rounded-full border py-3 text-sm font-medium hover:bg-accent"
      >
        <LogOut className="h-4 w-4" /> {tr("Se déconnecter")}
      </button>
    </div>
  );
}

function PrivacyToggle({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  description: string;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-2xl border p-4">
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{description}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-5 w-5 shrink-0 accent-[var(--color-primary)]"
      />
    </label>
  );
}
