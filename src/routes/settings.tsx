/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Provider, SupabaseClient, UserIdentity } from "@supabase/supabase-js";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  Accessibility,
  Bell,
  Bookmark,
  ChevronRight,
  CircleUserRound,
  Cookie,
  Database,
  Eye,
  EyeOff,
  Globe2,
  HardDriveDownload,
  KeyRound,
  Languages,
  Link2,
  LoaderCircle,
  LockKeyhole,
  MapPin,
  Megaphone,
  MonitorSmartphone,
  Moon,
  Palette,
  RefreshCw,
  Save,
  Search,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Trash2,
  UserRoundCog,
  Users,
  Volume2,
  Wifi,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useTranslation } from "@/lib/i18n";

const settingsDb = supabase as unknown as SupabaseClient<any>;

type SettingsSection =
  | "account"
  | "privacy"
  | "feed"
  | "notifications"
  | "appearance"
  | "location"
  | "security"
  | "connections"
  | "cookies"
  | "data";

type UserSettings = {
  profile_visibility: "public" | "followers" | "private";
  show_online_status: boolean;
  show_activity_status: boolean;
  show_followers_count: boolean;
  show_following_count: boolean;
  allow_follow_requests: boolean;
  allow_messages_from: "everyone" | "following" | "none";
  allow_mentions_from: "everyone" | "following" | "none";
  allow_tagging_from: "everyone" | "following" | "none";
  discoverable_by_email: boolean;
  discoverable_by_phone: boolean;
  search_engine_indexing: boolean;
  feed_ranking: "recommended" | "balanced" | "chronological";
  show_suggested_posts: boolean;
  show_sponsored_posts: boolean;
  sensitive_content_level: "less" | "standard" | "more";
  autoplay_videos: boolean;
  autoplay_muted: boolean;
  preferred_categories: string[];
  muted_keywords: string[];
  notification_push_enabled: boolean;
  notification_email_enabled: boolean;
  notification_in_app_enabled: boolean;
  notify_new_follower: boolean;
  notify_follow_request: boolean;
  notify_post_like: boolean;
  notify_post_comment: boolean;
  notify_post_share: boolean;
  notify_mentions: boolean;
  notify_event_reminders: boolean;
  notify_event_changes: boolean;
  notify_nearby_events: boolean;
  notify_recommendations: boolean;
  notify_marketing: boolean;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  theme: "system" | "light" | "dark";
  high_contrast: boolean;
  reduced_motion: boolean;
  compact_mode: boolean;
  font_scale: number;
  locale: string;
  timezone: string;
  week_starts_on: number;
  precise_location: boolean;
  nearby_recommendations: boolean;
  background_location: boolean;
  location_history: boolean;
  data_saver: boolean;
  media_quality: "auto" | "standard" | "high";
  download_on_wifi_only: boolean;
  login_alerts: boolean;
  remember_devices: boolean;
  personalized_recommendations: boolean;
  personalized_ads: boolean;
  analytics_enabled: boolean;
  crash_reports_enabled: boolean;
};

type ProfileSettings = {
  display_name: string;
  username: string;
  bio: string;
  website_url: string;
  pronouns: string;
};

const DEFAULT_SETTINGS: UserSettings = {
  profile_visibility: "public",
  show_online_status: true,
  show_activity_status: true,
  show_followers_count: true,
  show_following_count: true,
  allow_follow_requests: true,
  allow_messages_from: "following",
  allow_mentions_from: "everyone",
  allow_tagging_from: "following",
  discoverable_by_email: false,
  discoverable_by_phone: false,
  search_engine_indexing: false,
  feed_ranking: "balanced",
  show_suggested_posts: true,
  show_sponsored_posts: true,
  sensitive_content_level: "standard",
  autoplay_videos: true,
  autoplay_muted: true,
  preferred_categories: [],
  muted_keywords: [],
  notification_push_enabled: true,
  notification_email_enabled: true,
  notification_in_app_enabled: true,
  notify_new_follower: true,
  notify_follow_request: true,
  notify_post_like: true,
  notify_post_comment: true,
  notify_post_share: true,
  notify_mentions: true,
  notify_event_reminders: true,
  notify_event_changes: true,
  notify_nearby_events: false,
  notify_recommendations: true,
  notify_marketing: false,
  quiet_hours_enabled: false,
  quiet_hours_start: "22:00",
  quiet_hours_end: "08:00",
  theme: "system",
  high_contrast: false,
  reduced_motion: false,
  compact_mode: false,
  font_scale: 1,
  locale: "fr",
  timezone: "Europe/Zurich",
  week_starts_on: 1,
  precise_location: false,
  nearby_recommendations: true,
  background_location: false,
  location_history: false,
  data_saver: false,
  media_quality: "auto",
  download_on_wifi_only: true,
  login_alerts: true,
  remember_devices: true,
  personalized_recommendations: true,
  personalized_ads: false,
  analytics_enabled: false,
  crash_reports_enabled: true,
};

const EMPTY_PROFILE: ProfileSettings = {
  display_name: "",
  username: "",
  bio: "",
  website_url: "",
  pronouns: "",
};

const sections: Array<{
  id: SettingsSection;
  label: string;
  description: string;
  icon: typeof Shield;
}> = [
  { id: "account", label: "Compte et profil", description: "Identité publique et informations du compte", icon: CircleUserRound },
  { id: "privacy", label: "Confidentialité", description: "Visibilité, interactions et découvrabilité", icon: Shield },
  { id: "feed", label: "Fil et contenu", description: "Classement, suggestions et médias", icon: SlidersHorizontal },
  { id: "notifications", label: "Notifications", description: "Alertes, rappels et heures silencieuses", icon: Bell },
  { id: "appearance", label: "Apparence et accessibilité", description: "Thème, taille et confort visuel", icon: Accessibility },
  { id: "location", label: "Localisation et réseau", description: "Proximité, données mobiles et qualité", icon: MapPin },
  { id: "security", label: "Sécurité", description: "Sessions, alertes et appareils", icon: LockKeyhole },
  { id: "connections", label: "Applications connectées", description: "Google, Facebook, Spotify et autres", icon: Link2 },
  { id: "cookies", label: "Cookies et personnalisation", description: "Analyse, publicité et recommandations", icon: Cookie },
  { id: "data", label: "Données et compte", description: "Export, assistance et suppression", icon: Database },
];

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Paramètres — Global Party" },
      {
        name: "description",
        content: "Contrôle ton compte, ta confidentialité, tes notifications et tes préférences Global Party.",
      },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const { tr } = useTranslation();
  const navigate = useNavigate();
  const search = Route.useSearch() as { section?: string };
  const initialSection = sections.some((item) => item.id === search.section)
    ? (search.section as SettingsSection)
    : "account";
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection);
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [identities, setIdentities] = useState<UserIdentity[]>([]);
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [profile, setProfile] = useState<ProfileSettings>(EMPTY_PROFILE);
  const [connectedAccounts, setConnectedAccounts] = useState<any[]>([]);
  const [mutedKeywordInput, setMutedKeywordInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [requesting, setRequesting] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const { data: authData, error: authError } = await settingsDb.auth.getUser();
      if (authError && authError.name !== "AuthSessionMissingError") throw authError;
      if (!authData.user) {
        setUserId(null);
        return;
      }
      const currentUser = authData.user;
      setUserId(currentUser.id);
      setEmail(currentUser.email ?? "");
      setIdentities(currentUser.identities ?? []);

      const [{ data: profileRow, error: profileError }, { data: settingsRow, error: settingsError }, { data: connectionRows }] =
        await Promise.all([
          settingsDb
            .from("profiles")
            .select("display_name,username,bio,website_url,pronouns,locale,is_private,analytics_consent,personalized_ads_consent")
            .eq("id", currentUser.id)
            .maybeSingle(),
          settingsDb.from("user_settings").select("*").eq("user_id", currentUser.id).maybeSingle(),
          settingsDb
            .from("connected_accounts")
            .select("id,provider,provider_account_id,display_name,avatar_url,status,connected_at,refreshed_at")
            .eq("user_id", currentUser.id)
            .order("connected_at", { ascending: false }),
        ]);
      if (profileError) throw profileError;
      if (settingsError && settingsError.code !== "PGRST116") throw settingsError;

      setProfile({
        display_name: profileRow?.display_name ?? "",
        username: profileRow?.username ?? "",
        bio: profileRow?.bio ?? "",
        website_url: profileRow?.website_url ?? "",
        pronouns: profileRow?.pronouns ?? "",
      });
      setSettings({
        ...DEFAULT_SETTINGS,
        ...(settingsRow ?? {}),
        locale: settingsRow?.locale ?? profileRow?.locale ?? "fr",
        profile_visibility:
          settingsRow?.profile_visibility ?? (profileRow?.is_private ? "private" : "public"),
        analytics_enabled: settingsRow?.analytics_enabled ?? Boolean(profileRow?.analytics_consent),
        personalized_ads:
          settingsRow?.personalized_ads ?? Boolean(profileRow?.personalized_ads_consent),
      });
      setConnectedAccounts(connectionRows ?? []);
      setDirty(false);
    } catch (error) {
      console.error("[settings] load failed", error);
      toast.error(tr("Les paramètres n’ont pas pu être chargés."));
    } finally {
      setLoading(false);
    }
  }, [tr]);

  useEffect(() => {
    void loadSettings();
    const { data } = settingsDb.auth.onAuthStateChange(() => void loadSettings());
    return () => data.subscription.unsubscribe();
  }, [loadSettings]);

  useEffect(() => {
    const next = sections.some((item) => item.id === search.section)
      ? (search.section as SettingsSection)
      : undefined;
    if (next) setActiveSection(next);
  }, [search.section]);

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  const updateSetting = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };

  const updateProfile = <K extends keyof ProfileSettings>(key: K, value: ProfileSettings[K]) => {
    setProfile((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };

  const chooseSection = (section: SettingsSection) => {
    setActiveSection(section);
    setMobileMenuOpen(false);
    navigate({ to: "/settings", search: { section }, replace: true });
    window.scrollTo({ top: 0, behavior: settings.reduced_motion ? "auto" : "smooth" });
  };

  const save = async () => {
    if (!userId || saving) return;
    const username = profile.username.trim().replace(/^@/, "").toLocaleLowerCase();
    if (username && !/^[a-z0-9._-]{3,30}$/.test(username)) {
      toast.error(tr("Le nom d’utilisateur doit contenir 3 à 30 lettres, chiffres, points, tirets ou underscores."));
      return;
    }
    const website = profile.website_url.trim();
    if (website && !isSafeWebsite(website)) {
      toast.error(tr("L’adresse du site doit commencer par https:// ou http://."));
      return;
    }

    setSaving(true);
    try {
      const now = new Date().toISOString();
      const [{ error: settingsError }, { error: profileError }] = await Promise.all([
        settingsDb.from("user_settings").upsert(
          {
            user_id: userId,
            ...settings,
            preferred_categories: settings.preferred_categories.slice(0, 30),
            muted_keywords: settings.muted_keywords.slice(0, 100),
            updated_at: now,
          },
          { onConflict: "user_id" },
        ),
        settingsDb
          .from("profiles")
          .update({
            display_name: profile.display_name.trim().slice(0, 100),
            username: username || null,
            bio: profile.bio.trim().slice(0, 500) || null,
            website_url: website || null,
            pronouns: profile.pronouns.trim().slice(0, 60) || null,
            locale: settings.locale,
            is_private: settings.profile_visibility === "private",
            analytics_consent: settings.analytics_enabled,
            personalized_ads_consent: settings.personalized_ads,
            consent_updated_at: now,
          })
          .eq("id", userId),
      ]);
      if (settingsError) throw settingsError;
      if (profileError) throw profileError;
      applyLocalAppearance(settings);
      setDirty(false);
      toast.success(tr("Paramètres enregistrés."));
    } catch (error: any) {
      console.error("[settings] save failed", error);
      if (error?.code === "23505") {
        toast.error(tr("Ce nom d’utilisateur est déjà utilisé."));
      } else {
        toast.error(tr("L’enregistrement n’a pas abouti."));
      }
    } finally {
      setSaving(false);
    }
  };

  const addMutedKeyword = () => {
    const value = mutedKeywordInput.trim().toLocaleLowerCase().slice(0, 80);
    if (!value || settings.muted_keywords.includes(value)) return;
    updateSetting("muted_keywords", [...settings.muted_keywords, value].slice(0, 100));
    setMutedKeywordInput("");
  };

  const connectProvider = async (provider: Provider) => {
    if (!userId) return;
    try {
      const { error } = await settingsDb.auth.linkIdentity({
        provider,
        options: { redirectTo: `${window.location.origin}/settings?section=connections` },
      });
      if (error) throw error;
    } catch (error) {
      console.error("[settings] identity linking failed", error);
      toast.error(tr("La connexion au service n’a pas abouti."));
    }
  };

  const disconnectIdentity = async (identity: UserIdentity) => {
    if (identities.length <= 1) {
      toast.error(tr("Ajoute d’abord une autre méthode de connexion pour ne pas perdre l’accès au compte."));
      return;
    }
    if (!window.confirm(tr("Déconnecter ce service de ton compte ?"))) return;
    const { error } = await settingsDb.auth.unlinkIdentity(identity);
    if (error) {
      toast.error(tr("Le service n’a pas pu être déconnecté."));
      return;
    }
    setIdentities((current) => current.filter((item) => item.id !== identity.id));
    toast.success(tr("Service déconnecté."));
  };

  const createAccountRequest = async (kind: "export" | "delete") => {
    if (!userId || requesting) return;
    const message =
      kind === "export"
        ? "Je demande une copie exportable des données associées à mon compte."
        : "Je demande la suppression de mon compte et de mes données, sous réserve des obligations légales de conservation.";
    if (kind === "delete" && !window.confirm(tr("Envoyer une demande de suppression du compte ? Cette demande devra être vérifiée avant exécution."))) return;
    setRequesting(kind);
    const { error } = await settingsDb.from("support_tickets").insert({
      user_id: userId,
      category: kind === "export" ? "data_export" : "account_deletion",
      priority: kind === "delete" ? "high" : "normal",
      subject: kind === "export" ? "Export de mes données" : "Suppression de mon compte",
      message,
    });
    setRequesting(null);
    if (error) {
      toast.error(tr("La demande n’a pas pu être créée."));
      return;
    }
    toast.success(tr("Demande transmise au centre d’aide."));
  };

  const activeMeta = sections.find((item) => item.id === activeSection) ?? sections[0];

  if (loading) {
    return (
      <div className="mx-auto flex min-h-[65vh] max-w-6xl items-center justify-center px-4">
        <div className="text-center"><LoaderCircle className="mx-auto h-9 w-9 animate-spin text-primary" /><p className="mt-3 text-sm text-muted-foreground">{tr("Chargement des paramètres…")}</p></div>
      </div>
    );
  }

  if (!userId) {
    return (
      <div className="mx-auto max-w-lg px-4 py-20 text-center">
        <UserRoundCog className="mx-auto h-14 w-14 text-primary" />
        <h1 className="mt-4 text-3xl font-black">{tr("Tes paramètres personnels")}</h1>
        <p className="mt-3 text-muted-foreground">{tr("Connecte-toi pour contrôler ta confidentialité, tes notifications et ton expérience.")}</p>
        <Link to="/auth" className="btn-glow mt-6 inline-flex min-h-11 items-center rounded-full bg-primary px-6 font-semibold text-primary-foreground">{tr("Se connecter")}</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-3 pb-24 pt-5 sm:px-4 md:px-6 md:pb-10 md:pt-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-bold text-primary"><ShieldCheck className="h-3.5 w-3.5" /> {tr("Centre de contrôle")}</div>
          <h1 className="mt-3 text-3xl font-black sm:text-4xl">{tr("Paramètres")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{tr("Chaque choix sensible reste désactivé tant que tu ne l’actives pas explicitement.")}</p>
        </div>
        <button type="button" onClick={() => void save()} disabled={!dirty || saving} className="btn-glow hidden min-h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-bold text-primary-foreground disabled:opacity-40 md:inline-flex">
          {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{saving ? tr("Enregistrement…") : tr("Enregistrer")}
        </button>
      </header>

      <button type="button" onClick={() => setMobileMenuOpen(true)} className="glass mb-4 flex min-h-12 w-full items-center gap-3 rounded-2xl px-4 text-left md:hidden">
        <activeMeta.icon className="h-5 w-5 text-primary" />
        <span className="min-w-0 flex-1"><span className="block font-bold">{tr(activeMeta.label)}</span><span className="block truncate text-xs text-muted-foreground">{tr(activeMeta.description)}</span></span>
        <ChevronRight className="h-5 w-5" />
      </button>

      <div className="grid items-start gap-5 md:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="glass sticky top-24 hidden max-h-[calc(100vh-7rem)] overflow-y-auto rounded-3xl p-2 md:block">
          {sections.map((section) => <SectionButton key={section.id} section={section} active={activeSection === section.id} onClick={() => chooseSection(section.id)} tr={tr} />)}
        </aside>

        <main className="min-w-0">
          <section className="glass rounded-3xl p-4 sm:p-6">
            <div className="mb-6 flex items-start gap-3 border-b pb-5">
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-primary/12 text-primary"><activeMeta.icon className="h-5 w-5" /></div>
              <div><h2 className="text-xl font-black sm:text-2xl">{tr(activeMeta.label)}</h2><p className="mt-1 text-sm text-muted-foreground">{tr(activeMeta.description)}</p></div>
            </div>

            {activeSection === "account" && <AccountSection profile={profile} email={email} update={updateProfile} tr={tr} />}
            {activeSection === "privacy" && <PrivacySection settings={settings} update={updateSetting} tr={tr} />}
            {activeSection === "feed" && <FeedSection settings={settings} update={updateSetting} mutedKeywordInput={mutedKeywordInput} setMutedKeywordInput={setMutedKeywordInput} addMutedKeyword={addMutedKeyword} tr={tr} />}
            {activeSection === "notifications" && <NotificationsSection settings={settings} update={updateSetting} tr={tr} />}
            {activeSection === "appearance" && <AppearanceSection settings={settings} update={updateSetting} tr={tr} />}
            {activeSection === "location" && <LocationSection settings={settings} update={updateSetting} tr={tr} />}
            {activeSection === "security" && <SecuritySection settings={settings} update={updateSetting} tr={tr} />}
            {activeSection === "connections" && <ConnectionsSection identities={identities} connectedAccounts={connectedAccounts} connect={connectProvider} disconnect={disconnectIdentity} tr={tr} />}
            {activeSection === "cookies" && <CookiesSection settings={settings} update={updateSetting} tr={tr} />}
            {activeSection === "data" && <DataSection requesting={requesting} request={createAccountRequest} tr={tr} />}
          </section>
        </main>
      </div>

      <div className="fixed bottom-[calc(4.4rem+env(safe-area-inset-bottom))] left-3 right-3 z-30 md:hidden">
        <button type="button" onClick={() => void save()} disabled={!dirty || saving} className="btn-glow flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-primary px-5 font-bold text-primary-foreground shadow-2xl disabled:opacity-40">
          {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{saving ? tr("Enregistrement…") : tr("Enregistrer les modifications")}
        </button>
      </div>

      {mobileMenuOpen && (
        <div className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-sm md:hidden" role="dialog" aria-modal="true">
          <div className="absolute bottom-0 left-0 right-0 max-h-[88dvh] overflow-y-auto rounded-t-3xl border bg-background p-3 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <div className="mb-2 flex items-center justify-between px-2 py-2"><h2 className="text-lg font-black">{tr("Tous les paramètres")}</h2><button type="button" onClick={() => setMobileMenuOpen(false)} className="grid h-10 w-10 place-items-center rounded-full hover:bg-accent"><X className="h-5 w-5" /></button></div>
            {sections.map((section) => <SectionButton key={section.id} section={section} active={activeSection === section.id} onClick={() => chooseSection(section.id)} tr={tr} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionButton({ section, active, onClick, tr }: { section: (typeof sections)[number]; active: boolean; onClick: () => void; tr: (value: string) => string }) {
  const Icon = section.icon;
  return <button type="button" onClick={onClick} className={`mb-1 flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition ${active ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}><Icon className="h-5 w-5 shrink-0" /><span className="min-w-0 flex-1"><span className="block text-sm font-bold">{tr(section.label)}</span><span className={`block truncate text-[11px] ${active ? "text-primary-foreground/75" : "text-muted-foreground"}`}>{tr(section.description)}</span></span><ChevronRight className="h-4 w-4 shrink-0 opacity-70" /></button>;
}

type UpdateSettings = <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => void;

function AccountSection({ profile, email, update, tr }: { profile: ProfileSettings; email: string; update: <K extends keyof ProfileSettings>(key: K, value: ProfileSettings[K]) => void; tr: (value: string) => string }) {
  return <div className="space-y-6"><div className="grid gap-4 sm:grid-cols-2"><TextField label={tr("Nom affiché")} value={profile.display_name} maxLength={100} onChange={(value) => update("display_name", value)} /><TextField label={tr("Nom d’utilisateur")} helper={tr("3 à 30 caractères, sans espace")} prefix="@" value={profile.username} maxLength={30} onChange={(value) => update("username", value)} /><TextField label={tr("Adresse e-mail")} value={email} disabled /><TextField label={tr("Pronoms")} value={profile.pronouns} maxLength={60} onChange={(value) => update("pronouns", value)} /><TextField label={tr("Site web")} value={profile.website_url} maxLength={300} placeholder="https://" onChange={(value) => update("website_url", value)} /></div><label className="block text-sm font-semibold"><span className="mb-2 block">{tr("Biographie")}</span><textarea value={profile.bio} onChange={(event) => update("bio", event.target.value.slice(0, 500))} rows={5} className="field-control w-full resize-y" placeholder={tr("Présente-toi à la communauté…")} /><span className="mt-1 block text-right text-[11px] text-muted-foreground">{profile.bio.length}/500</span></label></div>;
}

function PrivacySection({ settings, update, tr }: { settings: UserSettings; update: UpdateSettings; tr: (value: string) => string }) {
  return <div className="space-y-6"><SelectSetting icon={Eye} title={tr("Visibilité du profil")} description={tr("Détermine qui peut consulter ton profil et tes publications.")} value={settings.profile_visibility} onChange={(value) => update("profile_visibility", value as UserSettings["profile_visibility"])} options={[["public", tr("Public")],["followers", tr("Abonnés")],["private", tr("Privé")]]} /><SettingGroup title={tr("Présence et activité")}><ToggleSetting title={tr("Afficher mon statut en ligne")} description={tr("Permet aux personnes autorisées de savoir quand tu es actif.")} checked={settings.show_online_status} onChange={(value) => update("show_online_status", value)} /><ToggleSetting title={tr("Afficher mon activité récente")} description={tr("Indique tes interactions récentes selon tes autres règles de confidentialité.")} checked={settings.show_activity_status} onChange={(value) => update("show_activity_status", value)} /><ToggleSetting title={tr("Afficher le nombre d’abonnés")} checked={settings.show_followers_count} onChange={(value) => update("show_followers_count", value)} /><ToggleSetting title={tr("Afficher le nombre d’abonnements")} checked={settings.show_following_count} onChange={(value) => update("show_following_count", value)} /></SettingGroup><SettingGroup title={tr("Interactions")}><ToggleSetting title={tr("Autoriser les demandes d’abonnement")} checked={settings.allow_follow_requests} onChange={(value) => update("allow_follow_requests", value)} /><ChoiceRow label={tr("Messages privés")} value={settings.allow_messages_from} onChange={(value) => update("allow_messages_from", value as UserSettings["allow_messages_from"])} tr={tr} /><ChoiceRow label={tr("Mentions")} value={settings.allow_mentions_from} onChange={(value) => update("allow_mentions_from", value as UserSettings["allow_mentions_from"])} tr={tr} /><ChoiceRow label={tr("Identification sur les publications")} value={settings.allow_tagging_from} onChange={(value) => update("allow_tagging_from", value as UserSettings["allow_tagging_from"])} tr={tr} /></SettingGroup><SettingGroup title={tr("Découvrabilité")}><ToggleSetting title={tr("Être trouvé grâce à mon e-mail")} checked={settings.discoverable_by_email} onChange={(value) => update("discoverable_by_email", value)} /><ToggleSetting title={tr("Être trouvé grâce à mon téléphone")} checked={settings.discoverable_by_phone} onChange={(value) => update("discoverable_by_phone", value)} /><ToggleSetting title={tr("Autoriser l’indexation par les moteurs de recherche")} description={tr("Désactivé par défaut. Ne concerne que les informations publiques.")} checked={settings.search_engine_indexing} onChange={(value) => update("search_engine_indexing", value)} /></SettingGroup></div>;
}

function FeedSection({ settings, update, mutedKeywordInput, setMutedKeywordInput, addMutedKeyword, tr }: { settings: UserSettings; update: UpdateSettings; mutedKeywordInput: string; setMutedKeywordInput: (value: string) => void; addMutedKeyword: () => void; tr: (value: string) => string }) {
  return <div className="space-y-6"><SelectSetting icon={Sparkles} title={tr("Classement du fil")} description={tr("Choisis la manière dont les publications sont ordonnées.")} value={settings.feed_ranking} onChange={(value) => update("feed_ranking", value as UserSettings["feed_ranking"])} options={[["recommended", tr("Recommandé")],["balanced", tr("Équilibré")],["chronological", tr("Chronologique")]]} /><SelectSetting icon={Shield} title={tr("Contenu sensible")} description={tr("Ajuste le niveau de filtrage sans désactiver la modération.")} value={settings.sensitive_content_level} onChange={(value) => update("sensitive_content_level", value as UserSettings["sensitive_content_level"])} options={[["less", tr("Afficher moins")],["standard", tr("Standard")],["more", tr("Afficher davantage")]]} /><SettingGroup title={tr("Contenu proposé")}><ToggleSetting title={tr("Afficher les publications suggérées")} checked={settings.show_suggested_posts} onChange={(value) => update("show_suggested_posts", value)} /><ToggleSetting title={tr("Afficher les publications sponsorisées")} description={tr("Les contenus sponsorisés restent clairement identifiés.")} checked={settings.show_sponsored_posts} onChange={(value) => update("show_sponsored_posts", value)} /><ToggleSetting title={tr("Recommandations personnalisées")} checked={settings.personalized_recommendations} onChange={(value) => update("personalized_recommendations", value)} /></SettingGroup><SettingGroup title={tr("Lecture des médias")}><ToggleSetting title={tr("Lire automatiquement les vidéos")} checked={settings.autoplay_videos} onChange={(value) => update("autoplay_videos", value)} /><ToggleSetting title={tr("Démarrer les vidéos sans son")} checked={settings.autoplay_muted} onChange={(value) => update("autoplay_muted", value)} /></SettingGroup><div><h3 className="font-bold">{tr("Mots et expressions masqués")}</h3><p className="mt-1 text-sm text-muted-foreground">{tr("Les publications contenant ces termes seront retirées de ton fil lorsque cela est possible.")}</p><div className="mt-3 flex gap-2"><input value={mutedKeywordInput} onChange={(event) => setMutedKeywordInput(event.target.value.slice(0,80))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addMutedKeyword(); } }} className="field-control min-h-11 flex-1" placeholder={tr("Ajouter un mot ou une expression")} /><button type="button" onClick={addMutedKeyword} className="rounded-full border px-4 text-sm font-semibold hover:bg-accent">{tr("Ajouter")}</button></div><div className="mt-3 flex flex-wrap gap-2">{settings.muted_keywords.map((keyword) => <button type="button" key={keyword} onClick={() => update("muted_keywords", settings.muted_keywords.filter((item) => item !== keyword))} className="inline-flex items-center gap-1 rounded-full bg-accent px-3 py-1.5 text-xs">{keyword}<X className="h-3 w-3" /></button>)}</div></div></div>;
}

function NotificationsSection({ settings, update, tr }: { settings: UserSettings; update: UpdateSettings; tr: (value: string) => string }) {
  return <div className="space-y-6"><SettingGroup title={tr("Canaux")}><ToggleSetting title={tr("Notifications dans l’application")} checked={settings.notification_in_app_enabled} onChange={(value) => update("notification_in_app_enabled", value)} /><ToggleSetting title={tr("Notifications push")} checked={settings.notification_push_enabled} onChange={(value) => update("notification_push_enabled", value)} /><ToggleSetting title={tr("Notifications par e-mail")} checked={settings.notification_email_enabled} onChange={(value) => update("notification_email_enabled", value)} /></SettingGroup><SettingGroup title={tr("Réseau social")}><ToggleSetting title={tr("Nouvel abonné")} checked={settings.notify_new_follower} onChange={(value) => update("notify_new_follower", value)} /><ToggleSetting title={tr("Demande d’abonnement")} checked={settings.notify_follow_request} onChange={(value) => update("notify_follow_request", value)} /><ToggleSetting title={tr("J’aime sur mes publications")} checked={settings.notify_post_like} onChange={(value) => update("notify_post_like", value)} /><ToggleSetting title={tr("Commentaires")} checked={settings.notify_post_comment} onChange={(value) => update("notify_post_comment", value)} /><ToggleSetting title={tr("Partages")} checked={settings.notify_post_share} onChange={(value) => update("notify_post_share", value)} /><ToggleSetting title={tr("Mentions et identifications")} checked={settings.notify_mentions} onChange={(value) => update("notify_mentions", value)} /></SettingGroup><SettingGroup title={tr("Événements")}><ToggleSetting title={tr("Rappels avant un événement")} checked={settings.notify_event_reminders} onChange={(value) => update("notify_event_reminders", value)} /><ToggleSetting title={tr("Changements d’horaire ou annulations")} checked={settings.notify_event_changes} onChange={(value) => update("notify_event_changes", value)} /><ToggleSetting title={tr("Événements intéressants à proximité")} checked={settings.notify_nearby_events} onChange={(value) => update("notify_nearby_events", value)} /><ToggleSetting title={tr("Recommandations périodiques")} checked={settings.notify_recommendations} onChange={(value) => update("notify_recommendations", value)} /><ToggleSetting title={tr("Actualités et offres Global Party")} checked={settings.notify_marketing} onChange={(value) => update("notify_marketing", value)} /></SettingGroup><SettingGroup title={tr("Heures silencieuses")}><ToggleSetting title={tr("Activer les heures silencieuses")} description={tr("Les alertes non urgentes sont regroupées jusqu’à la fin de la plage.")} checked={settings.quiet_hours_enabled} onChange={(value) => update("quiet_hours_enabled", value)} /><div className="grid gap-3 sm:grid-cols-2"><TextField type="time" label={tr("Début")} value={settings.quiet_hours_start} disabled={!settings.quiet_hours_enabled} onChange={(value) => update("quiet_hours_start", value)} /><TextField type="time" label={tr("Fin")} value={settings.quiet_hours_end} disabled={!settings.quiet_hours_enabled} onChange={(value) => update("quiet_hours_end", value)} /></div></SettingGroup></div>;
}

function AppearanceSection({ settings, update, tr }: { settings: UserSettings; update: UpdateSettings; tr: (value: string) => string }) {
  return <div className="space-y-6"><SelectSetting icon={Palette} title={tr("Thème")} description={tr("Suit le système ou impose un thème clair ou sombre.")} value={settings.theme} onChange={(value) => update("theme", value as UserSettings["theme"])} options={[["system", tr("Système")],["light", tr("Clair")],["dark", tr("Sombre")]]} /><SelectSetting icon={Languages} title={tr("Langue de l’interface")} value={settings.locale} onChange={(value) => update("locale", value)} options={[["fr", "Français"],["en", "English"],["de", "Deutsch"],["it", "Italiano"],["es", "Español"],["pl", "Polski"]]} /><SettingGroup title={tr("Accessibilité")}><ToggleSetting title={tr("Contraste renforcé")} checked={settings.high_contrast} onChange={(value) => update("high_contrast", value)} /><ToggleSetting title={tr("Réduire les animations")} description={tr("Réduit les transitions, effets de profondeur et lectures automatiques.")} checked={settings.reduced_motion} onChange={(value) => update("reduced_motion", value)} /><ToggleSetting title={tr("Mode compact")} checked={settings.compact_mode} onChange={(value) => update("compact_mode", value)} /><label className="block rounded-2xl border p-4"><span className="font-semibold">{tr("Taille du texte")}</span><div className="mt-3 flex items-center gap-3"><span className="text-xs" aria-hidden="true">{"A"}</span><input type="range" min="0.8" max="1.5" step="0.05" value={settings.font_scale} onChange={(event) => update("font_scale", Number(event.target.value))} className="w-full accent-[var(--color-primary)]" /><span className="text-xl" aria-hidden="true">{"A"}</span><span className="w-12 text-right text-xs text-muted-foreground">{Math.round(settings.font_scale*100)}%</span></div></label></SettingGroup><SelectSetting icon={Globe2} title={tr("Fuseau horaire")} value={settings.timezone} onChange={(value) => update("timezone", value)} options={[["Europe/Zurich","Europe/Zurich"],["Europe/Paris","Europe/Paris"],["Europe/London","Europe/London"],["America/New_York","America/New_York"],["America/Los_Angeles","America/Los_Angeles"],["Asia/Dubai","Asia/Dubai"],["Asia/Tokyo","Asia/Tokyo"]]} /></div>;
}

function LocationSection({ settings, update, tr }: { settings: UserSettings; update: UpdateSettings; tr: (value: string) => string }) {
  return <div className="space-y-6"><SettingGroup title={tr("Localisation")}><ToggleSetting title={tr("Utiliser ma position précise")} description={tr("Utile pour les distances exactes. Tu peux continuer avec une ville seulement.")} checked={settings.precise_location} onChange={(value) => update("precise_location", value)} /><ToggleSetting title={tr("Recommandations à proximité")} checked={settings.nearby_recommendations} onChange={(value) => update("nearby_recommendations", value)} /><ToggleSetting title={tr("Localisation en arrière-plan")} description={tr("Désactivée par défaut. Nécessite également l’autorisation du système.")} checked={settings.background_location} onChange={(value) => update("background_location", value)} /><ToggleSetting title={tr("Historique des lieux utilisés")} checked={settings.location_history} onChange={(value) => update("location_history", value)} /></SettingGroup><SettingGroup title={tr("Données et médias")}><ToggleSetting title={tr("Économiseur de données")} checked={settings.data_saver} onChange={(value) => update("data_saver", value)} /><SelectSetting icon={MonitorSmartphone} title={tr("Qualité des médias")} value={settings.media_quality} onChange={(value) => update("media_quality", value as UserSettings["media_quality"])} options={[["auto", tr("Automatique")],["standard", tr("Standard")],["high", tr("Haute")]]} /><ToggleSetting title={tr("Téléchargements uniquement en Wi-Fi")} checked={settings.download_on_wifi_only} onChange={(value) => update("download_on_wifi_only", value)} /></SettingGroup></div>;
}

function SecuritySection({ settings, update, tr }: { settings: UserSettings; update: UpdateSettings; tr: (value: string) => string }) {
  return <div className="space-y-6"><SettingGroup title={tr("Protection du compte")}><ToggleSetting title={tr("Alertes de nouvelle connexion")} description={tr("Reçois une alerte lorsqu’un appareil inhabituel accède au compte.")} checked={settings.login_alerts} onChange={(value) => update("login_alerts", value)} /><ToggleSetting title={tr("Mémoriser les appareils approuvés")} checked={settings.remember_devices} onChange={(value) => update("remember_devices", value)} /></SettingGroup><div className="grid gap-3 sm:grid-cols-2"><SecurityLink icon={KeyRound} title={tr("Changer le mot de passe")} description={tr("Envoie un lien sécurisé à ton e-mail.")} onClick={async () => { const { error } = await settingsDb.auth.resetPasswordForEmail((await settingsDb.auth.getUser()).data.user?.email ?? "", { redirectTo: `${window.location.origin}/auth?mode=reset` }); if (error) toast.error(tr("Le lien n’a pas pu être envoyé.")); else toast.success(tr("Lien de réinitialisation envoyé.")); }} /><SecurityLink icon={Smartphone} title={tr("Authentification renforcée")} description={tr("Gère les facteurs d’authentification disponibles.")} href="/help?article=security" /><SecurityLink icon={MonitorSmartphone} title={tr("Sessions et appareils")} description={tr("Déconnecte les autres sessions en cas de doute.")} onClick={async () => { if (!window.confirm(tr("Déconnecter toutes les autres sessions ?"))) return; const { error } = await settingsDb.auth.signOut({ scope: "others" }); if (error) toast.error(tr("Les sessions n’ont pas pu être fermées.")); else toast.success(tr("Autres sessions déconnectées.")); }} /><SecurityLink icon={ShieldCheck} title={tr("Guide de sécurité")} description={tr("Conseils pour protéger ton compte et reconnaître les fraudes.")} href="/help" /></div></div>;
}

function ConnectionsSection({ identities, connectedAccounts, connect, disconnect, tr }: { identities: UserIdentity[]; connectedAccounts: any[]; connect: (provider: Provider) => Promise<void>; disconnect: (identity: UserIdentity) => Promise<void>; tr: (value: string) => string }) {
  const providers: Array<{ provider: Provider | null; key: string; name: string; description: string; available: boolean }> = [
    { provider: "google", key: "google", name: "Google", description: "Connexion rapide et calendrier", available: true },
    { provider: "facebook", key: "facebook", name: "Facebook", description: "Connexion et identité", available: true },
    { provider: "spotify", key: "spotify", name: "Spotify", description: "Préférences musicales", available: true },
    { provider: "apple", key: "apple", name: "Apple", description: "Connexion avec Apple", available: true },
    { provider: "twitter", key: "twitter", name: "X", description: "Connexion via X", available: true },
    { provider: "linkedin_oidc", key: "linkedin", name: "LinkedIn", description: "Identité professionnelle", available: true },
    { provider: null, key: "instagram", name: "Instagram", description: "Publication organisateur et statistiques", available: false },
    { provider: null, key: "tiktok", name: "TikTok", description: "Publication et statistiques", available: false },
  ];
  return <div className="space-y-4"><div className="rounded-2xl border border-primary/20 bg-primary/5 p-4 text-sm text-muted-foreground"><p className="font-semibold text-foreground">{tr("Aucun jeton de réseau social n’est stocké dans le navigateur.")}</p><p className="mt-1">{tr("Les connexions OAuth utilisent les fournisseurs configurés côté serveur. Instagram et TikTok restent inactifs tant que leurs applications officielles ne sont pas validées.")}</p></div>{providers.map((item) => { const identity = identities.find((value) => normalizeProvider(value.provider) === item.key); const metadataConnection = connectedAccounts.find((value) => value.provider === item.key); const connected = Boolean(identity || metadataConnection); return <div key={item.key} className="flex flex-wrap items-center gap-3 rounded-2xl border p-4"><div className="grid h-11 w-11 place-items-center rounded-xl bg-accent font-black">{item.name.slice(0,1)}</div><div className="min-w-0 flex-1"><p className="font-bold">{item.name}</p><p className="text-xs text-muted-foreground">{tr(item.description)}</p>{connected && <p className="mt-1 text-[11px] font-semibold text-emerald-500">{tr("Connecté")}{metadataConnection?.display_name ? ` · ${metadataConnection.display_name}` : ""}</p>}</div>{connected && identity ? <button type="button" onClick={() => void disconnect(identity)} className="rounded-full border px-4 py-2 text-xs font-semibold hover:bg-accent">{tr("Déconnecter")}</button> : item.available && item.provider ? <button type="button" onClick={() => void connect(item.provider!)} className="rounded-full bg-primary px-4 py-2 text-xs font-bold text-primary-foreground">{tr("Connecter")}</button> : <span className="rounded-full bg-accent px-3 py-1.5 text-[11px] text-muted-foreground">{tr("Configuration serveur requise")}</span>}</div>; })}</div>;
}

function CookiesSection({ settings, update, tr }: { settings: UserSettings; update: UpdateSettings; tr: (value: string) => string }) {
  return <div className="space-y-6"><div className="rounded-2xl border p-4"><div className="flex items-center gap-3"><ShieldCheck className="h-6 w-6 text-primary" /><div><p className="font-bold">{tr("Cookies strictement nécessaires")}</p><p className="text-xs text-muted-foreground">{tr("Toujours actifs pour la connexion, la sécurité et les préférences essentielles.")}</p></div><span className="ml-auto rounded-full bg-primary/10 px-3 py-1 text-xs font-bold text-primary">{tr("Toujours actifs")}</span></div></div><SettingGroup title={tr("Choix facultatifs")}><ToggleSetting title={tr("Analyse d’utilisation")} description={tr("Mesures agrégées pour améliorer les écrans et corriger les parcours difficiles.")} checked={settings.analytics_enabled} onChange={(value) => update("analytics_enabled", value)} /><ToggleSetting title={tr("Personnalisation des recommandations")} description={tr("Adapte les suggestions à tes préférences et interactions.")} checked={settings.personalized_recommendations} onChange={(value) => update("personalized_recommendations", value)} /><ToggleSetting title={tr("Publicités personnalisées")} description={tr("Adapte les publicités lorsque tu l’autorises. Les publicités restent identifiées.")} checked={settings.personalized_ads} onChange={(value) => update("personalized_ads", value)} /><ToggleSetting title={tr("Rapports de panne anonymisés")} checked={settings.crash_reports_enabled} onChange={(value) => update("crash_reports_enabled", value)} /></SettingGroup><div className="flex flex-wrap gap-2"><Link to="/cookies" className="rounded-full border px-4 py-2 text-sm font-semibold hover:bg-accent">{tr("Lire la politique de cookies")}</Link><Link to="/privacy" className="rounded-full border px-4 py-2 text-sm font-semibold hover:bg-accent">{tr("Politique de confidentialité")}</Link></div></div>;
}

function DataSection({ requesting, request, tr }: { requesting: string | null; request: (kind: "export" | "delete") => Promise<void>; tr: (value: string) => string }) {
  return <div className="space-y-5"><div className="grid gap-3 sm:grid-cols-2"><DataAction icon={HardDriveDownload} title={tr("Exporter mes données")} description={tr("Demande une copie structurée des données de ton compte.")} action={tr("Demander l’export")} loading={requesting === "export"} onClick={() => void request("export")} /><DataAction icon={Trash2} danger title={tr("Supprimer mon compte")} description={tr("Crée une demande vérifiée. Aucune suppression automatique irréversible n’est lancée depuis cet écran.")} action={tr("Demander la suppression")} loading={requesting === "delete"} onClick={() => void request("delete")} /></div><div className="rounded-2xl border p-4"><h3 className="font-bold">{tr("Besoin d’aide avant de décider ?")}</h3><p className="mt-1 text-sm text-muted-foreground">{tr("Le centre d’aide explique les conséquences d’un export, d’une désactivation ou d’une suppression.")}</p><div className="mt-4 flex flex-wrap gap-2"><Link to="/help" className="rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-foreground">{tr("Ouvrir le centre d’aide")}</Link><Link to="/faq" className="rounded-full border px-4 py-2 text-sm font-semibold hover:bg-accent">{tr("Consulter la FAQ")}</Link></div></div></div>;
}

function SettingGroup({ title, children }: { title: string; children: React.ReactNode }) { return <div><h3 className="mb-3 font-black">{title}</h3><div className="divide-y rounded-2xl border px-4">{children}</div></div>; }
function ToggleSetting({ title, description, checked, onChange }: { title: string; description?: string; checked: boolean; onChange: (value: boolean) => void }) { return <label className="flex cursor-pointer items-center gap-4 py-4"><span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{title}</span>{description && <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{description}</span>}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="peer sr-only" /><span className="relative h-7 w-12 shrink-0 rounded-full bg-muted transition peer-checked:bg-primary after:absolute after:left-1 after:top-1 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition peer-checked:after:translate-x-5" /></label>; }
function SelectSetting({ icon: Icon, title, description, value, onChange, options }: { icon: typeof Eye; title: string; description?: string; value: string; onChange: (value: string) => void; options: Array<[string,string]> }) { return <label className="flex flex-col gap-3 rounded-2xl border p-4 sm:flex-row sm:items-center"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent"><Icon className="h-5 w-5 text-primary" /></div><span className="min-w-0 flex-1"><span className="block font-bold">{title}</span>{description && <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="field-control min-h-11 min-w-44">{options.map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>; }
function ChoiceRow({ label, value, onChange, tr }: { label: string; value: string; onChange: (value: string) => void; tr: (value:string)=>string }) { return <div className="flex flex-wrap items-center gap-3 py-4"><span className="min-w-44 flex-1 text-sm font-semibold">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="field-control min-h-10 min-w-40"><option value="everyone">{tr("Tout le monde")}</option><option value="following">{tr("Comptes suivis")}</option><option value="none">{tr("Personne")}</option></select></div>; }
function TextField({ label, helper, prefix, value, onChange, disabled=false, maxLength, placeholder, type="text" }: { label: string; helper?: string; prefix?: string; value: string; onChange?: (value:string)=>void; disabled?: boolean; maxLength?: number; placeholder?: string; type?: string }) { return <label className="block text-sm font-semibold"><span className="mb-1.5 block">{label}</span><div className="relative">{prefix && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">{prefix}</span>}<input type={type} value={value} onChange={(event) => onChange?.(event.target.value)} disabled={disabled} maxLength={maxLength} placeholder={placeholder} className={`field-control min-h-11 w-full ${prefix ? "pl-8" : ""} disabled:opacity-60`} /></div>{helper && <span className="mt-1 block text-[11px] text-muted-foreground">{helper}</span>}</label>; }
function SecurityLink({ icon: Icon, title, description, onClick, href }: { icon: typeof KeyRound; title: string; description: string; onClick?: () => void | Promise<void>; href?: string }) { const content = <><Icon className="h-5 w-5 text-primary" /><span className="min-w-0 flex-1"><span className="block font-bold">{title}</span><span className="mt-1 block text-xs text-muted-foreground">{description}</span></span><ChevronRight className="h-4 w-4" /></>; return href ? <a href={href} className="flex items-start gap-3 rounded-2xl border p-4 hover:border-primary/50">{content}</a> : <button type="button" onClick={() => void onClick?.()} className="flex items-start gap-3 rounded-2xl border p-4 text-left hover:border-primary/50">{content}</button>; }
function DataAction({ icon: Icon, title, description, action, loading, danger=false, onClick }: { icon: typeof Database; title:string; description:string; action:string; loading:boolean; danger?:boolean; onClick:()=>void }) { return <div className={`rounded-2xl border p-5 ${danger ? "border-destructive/30" : ""}`}><Icon className={`h-7 w-7 ${danger ? "text-destructive" : "text-primary"}`} /><h3 className="mt-3 font-black">{title}</h3><p className="mt-1 text-sm text-muted-foreground">{description}</p><button type="button" onClick={onClick} disabled={loading} className={`mt-4 inline-flex min-h-10 items-center gap-2 rounded-full px-4 text-sm font-bold disabled:opacity-50 ${danger ? "border border-destructive/40 text-destructive hover:bg-destructive/10" : "bg-primary text-primary-foreground"}`}>{loading && <LoaderCircle className="h-4 w-4 animate-spin" />}{action}</button></div>; }

function normalizeProvider(value: string) { if (value === "linkedin_oidc") return "linkedin"; if (value === "twitter") return "twitter"; return value; }
function isSafeWebsite(value: string) { try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:"; } catch { return false; } }
function applyLocalAppearance(settings: UserSettings) { if (typeof document === "undefined") return; document.documentElement.dataset.theme = settings.theme; document.documentElement.dataset.contrast = settings.high_contrast ? "high" : "normal"; document.documentElement.dataset.compact = settings.compact_mode ? "true" : "false"; document.documentElement.style.fontSize = `${settings.font_scale * 100}%`; document.documentElement.classList.toggle("reduce-motion", settings.reduced_motion); }
