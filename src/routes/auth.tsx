import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Building2, Check, Music2, UserRound } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { MUSIC_GENRES } from "@/lib/event-filters";
import { CitySearchInput } from "@/components/city-search-input";
import { toast } from "sonner";
import { useTranslation } from "@/lib/i18n";

type AuthSearch = { redirect?: string };
type AccountType = "client" | "organizer";

// A fixed invalid origin is only used to validate relative redirects. The
// actual post-authentication destination always uses window.location.origin.
const redirectValidationOrigin = "https://eventa.invalid";

function safeInternalRedirect(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return undefined;
  }
  try {
    const base = new URL(redirectValidationOrigin);
    const target = new URL(value, base);
    if (target.origin !== base.origin || target.pathname === "/auth") return undefined;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return undefined;
  }
}

export const Route = createFileRoute("/auth")({
  validateSearch: (search: Record<string, unknown>): AuthSearch => ({
    redirect: safeInternalRedirect(search.redirect),
  }),
  head: () => ({ meta: [{ title: "Connexion ou inscription — Global Party" }] }),
  component: Auth,
});

function Auth() {
  const { tr, genreLabel } = useTranslation();
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const [mode, setMode] = useState<"signin" | "signup" | "reset">("signin");
  const [accountType, setAccountType] = useState<AccountType>("client");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [organizerName, setOrganizerName] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [homeCityId, setHomeCityId] = useState("");
  const [musicPreferences, setMusicPreferences] = useState<string[]>([]);
  const [analyticsConsent, setAnalyticsConsent] = useState(false);
  const [adsConsent, setAdsConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const destination = redirect ?? "/";

  const navigateTo = (target: string) => {
    if (target === "/") navigate({ to: "/" });
    else window.location.assign(target);
  };

  const destinationAfterLogin = async () => {
    if (redirect) return destination;
    const { data } = await supabase.auth.getUser();
    if (!data.user) return "/";
    const { data: organizerRole } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", data.user.id)
      .eq("role", "organizer")
      .maybeSingle();
    return organizerRole ? "/organizer" : "/";
  };

  const toggleGenre = (genre: string) => {
    setMusicPreferences((current) =>
      current.includes(genre)
        ? current.filter((item) => item !== genre)
        : current.length < 12
          ? [...current, genre]
          : current,
    );
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      if (mode === "signup") {
        if (accountType === "organizer" && organizerName.trim().length < 2) {
          throw new Error(tr("Indique le nom de ton organisation."));
        }
        const parsedBirthYear = birthYear ? Number(birthYear) : null;
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: new URL(
              accountType === "organizer" ? "/organizer" : destination,
              window.location.origin,
            ).toString(),
            data: {
              display_name: displayName.trim(),
              account_type: accountType,
              organizer_name: accountType === "organizer" ? organizerName.trim() : null,
              birth_year: parsedBirthYear,
              home_city_id: homeCityId || null,
              music_preferences: musicPreferences,
              analytics_consent: analyticsConsent,
              personalized_ads_consent: adsConsent,
            },
          },
        });
        if (error) throw error;
        if (!data.session) {
          toast.success(tr("Compte créé. Confirme ton adresse e-mail pour te connecter."));
          setMode("signin");
          return;
        }
        toast.success(
          accountType === "organizer" ? tr("Espace organisateur créé") : tr("Compte client créé"),
        );
        navigateTo(accountType === "organizer" ? "/organizer" : destination);
      } else if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigateTo(await destinationAfterLogin());
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        if (error) throw error;
        toast.success(tr("E-mail de réinitialisation envoyé."));
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : tr("Une erreur est survenue"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-[calc(100vh-8rem)] max-w-3xl items-center px-4 py-8">
      <div className="glass w-full rounded-[2rem] p-5 md:p-8">
        <h1 className="text-3xl font-black">
          {mode === "signin"
            ? tr("Bienvenue sur Global Party")
            : mode === "signup"
              ? tr("Crée ton espace")
              : tr("Mot de passe oublié")}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {mode === "signin"
            ? tr("Connecte-toi pour retrouver tes favoris ou gérer tes événements.")
            : mode === "signup"
              ? tr("Choisis le compte correspondant à ton utilisation.")
              : tr("Reçois un lien sécurisé pour choisir un nouveau mot de passe.")}
        </p>

        {mode === "signup" && (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <AccountChoice
              active={accountType === "client"}
              title={tr("Compte client")}
              description={tr("Découvrir, aimer, commenter et personnaliser tes sorties.")}
              icon={UserRound}
              onClick={() => setAccountType("client")}
            />
            <AccountChoice
              active={accountType === "organizer"}
              title={tr("Compte organisateur")}
              description={tr("Créer des événements, publier et lancer des campagnes.")}
              icon={Building2}
              onClick={() => setAccountType("organizer")}
            />
          </div>
        )}

        <form onSubmit={submit} className="mt-6 space-y-4">
          {mode === "signup" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={tr("Nom affiché")}>
                <input
                  required
                  maxLength={100}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder={tr("Ton nom")}
                  className="field-control"
                />
              </Field>
              {accountType === "organizer" ? (
                <Field label={tr("Organisation")}>
                  <input
                    required
                    maxLength={120}
                    value={organizerName}
                    onChange={(event) => setOrganizerName(event.target.value)}
                    placeholder={tr("Nom de l'organisation")}
                    className="field-control"
                  />
                </Field>
              ) : (
                <Field label={tr("Année de naissance (facultatif)")}>
                  <input
                    type="number"
                    min={1900}
                    max={new Date().getFullYear()}
                    value={birthYear}
                    onChange={(event) => setBirthYear(event.target.value)}
                    placeholder="1995"
                    className="field-control"
                  />
                </Field>
              )}
              <Field label={tr("Ville principale")}>
                <CitySearchInput value={homeCityId} onChange={setHomeCityId} />
              </Field>
            </div>
          )}

          <Field label={tr("E-mail")}>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={tr("nom@exemple.ch")}
              className="field-control"
            />
          </Field>
          {mode !== "reset" && (
            <Field label={tr("Mot de passe")}>
              <input
                type="password"
                required
                minLength={8}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={tr("8 caractères minimum")}
                className="field-control"
              />
            </Field>
          )}

          {mode === "signup" && accountType === "client" && (
            <div className="rounded-2xl border p-4">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <Music2 className="h-4 w-4 text-primary" /> {tr("Préférences musicales")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {tr("Facultatif · sélectionne jusqu'à 12 styles.")}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {MUSIC_GENRES.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={musicPreferences.includes(value)}
                    onClick={() => toggleGenre(value)}
                    className="rounded-full border px-2.5 py-1 text-xs"
                    style={
                      musicPreferences.includes(value)
                        ? { borderColor: "var(--color-primary)", color: "var(--color-primary)" }
                        : undefined
                    }
                  >
                    {musicPreferences.includes(value) && <Check className="mr-1 inline h-3 w-3" />}
                    {genreLabel(value, label)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {mode === "signup" && accountType === "client" && (
            <div className="space-y-3 rounded-2xl bg-primary/5 p-4 text-xs">
              <ConsentToggle
                checked={analyticsConsent}
                onChange={setAnalyticsConsent}
                label={tr(
                  "J'accepte l'analyse de mon parcours dans l'application pour améliorer mes recommandations.",
                )}
              />
              <ConsentToggle
                checked={adsConsent}
                onChange={setAdsConsent}
                label={tr(
                  "J'accepte les publicités personnalisées selon ma ville, mon âge et mes goûts musicaux.",
                )}
              />
              <p className="text-muted-foreground">
                {tr("Ces choix sont facultatifs et modifiables à tout moment depuis ton profil.")}
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn-glow w-full rounded-full bg-primary py-3 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {loading
              ? tr("Traitement…")
              : mode === "signin"
                ? tr("Se connecter")
                : mode === "signup"
                  ? accountType === "organizer"
                    ? tr("Créer mon espace organisateur")
                    : tr("Créer mon compte client")
                  : tr("Envoyer le lien")}
          </button>
        </form>

        <div className="mt-5 flex flex-wrap justify-between gap-3 text-xs">
          <button
            type="button"
            onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            className="text-muted-foreground hover:text-foreground"
          >
            {mode === "signin" ? tr("Créer un compte") : tr("J'ai déjà un compte")}
          </button>
          {mode !== "reset" && (
            <button
              type="button"
              onClick={() => setMode("reset")}
              className="text-muted-foreground hover:text-foreground"
            >
              {tr("Mot de passe oublié")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AccountChoice({
  active,
  title,
  description,
  icon: Icon,
  onClick,
}: {
  active: boolean;
  title: string;
  description: string;
  icon: typeof UserRound;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="rounded-2xl border p-4 text-left transition-colors hover:bg-accent"
      style={
        active
          ? { borderColor: "var(--color-primary)", background: "var(--color-accent)" }
          : undefined
      }
    >
      <Icon className="mb-3 h-6 w-6 text-primary" />
      <span className="block font-semibold">{title}</span>
      <span className="mt-1 block text-xs text-muted-foreground">{description}</span>
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium">
      <span className="mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}

function ConsentToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]"
      />
      <span>{label}</span>
    </label>
  );
}
