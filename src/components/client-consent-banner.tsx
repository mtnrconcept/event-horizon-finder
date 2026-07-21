/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from "@supabase/supabase-js";
import { Link } from "@tanstack/react-router";
import { BarChart3, Cookie, LoaderCircle, Megaphone, ShieldCheck, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { notifyPrivacyUpdated } from "@/lib/client-analytics";
import { useTranslation } from "@/lib/i18n";

const clientDb = supabase as unknown as SupabaseClient<any>;
const CONSENT_VERSION = "2026-07-21";
const LOCAL_CONSENT_KEY = "global-party:cookie-consent";
const ANONYMOUS_ID_KEY = "global-party:anonymous-id";

type ConsentChoices = {
  necessary: true;
  analytics: boolean;
  personalization: boolean;
  advertising: boolean;
  policyVersion: string;
  updatedAt: string;
};

const DEFAULT_CHOICES: ConsentChoices = {
  necessary: true,
  analytics: false,
  personalization: false,
  advertising: false,
  policyVersion: CONSENT_VERSION,
  updatedAt: "",
};

export function ClientConsentBanner() {
  const { tr } = useTranslation();
  const [userId, setUserId] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [choices, setChoices] = useState<ConsentChoices>(DEFAULT_CHOICES);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const local = readLocalConsent();
      const { data } = await clientDb.auth.getUser();
      if (!active) return;
      const currentUserId = data.user?.id ?? null;
      setUserId(currentUserId);

      if (!currentUserId) {
        const current = local?.policyVersion === CONSENT_VERSION ? local : DEFAULT_CHOICES;
        setChoices(current);
        setVisible(local?.policyVersion !== CONSENT_VERSION);
        return;
      }

      const [{ data: stored }, { data: profile }] = await Promise.all([
        clientDb
          .from("cookie_consents")
          .select("analytics,personalization,advertising,policy_version,updated_at")
          .eq("user_id", currentUserId)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        clientDb
          .from("profiles")
          .select("analytics_consent,personalized_ads_consent,consent_updated_at")
          .eq("id", currentUserId)
          .maybeSingle(),
      ]);
      if (!active) return;

      const databaseChoices: ConsentChoices | null = stored
        ? {
            necessary: true,
            analytics: Boolean(stored.analytics),
            personalization: Boolean(stored.personalization),
            advertising: Boolean(stored.advertising),
            policyVersion: String(stored.policy_version ?? ""),
            updatedAt: String(stored.updated_at ?? ""),
          }
        : profile?.consent_updated_at
          ? {
              necessary: true,
              analytics: Boolean(profile.analytics_consent),
              personalization: false,
              advertising: Boolean(profile.personalized_ads_consent),
              policyVersion: "legacy",
              updatedAt: String(profile.consent_updated_at),
            }
          : null;
      const current =
        databaseChoices?.policyVersion === CONSENT_VERSION
          ? databaseChoices
          : local?.policyVersion === CONSENT_VERSION
            ? local
            : databaseChoices ?? DEFAULT_CHOICES;
      setChoices(current);
      setVisible(databaseChoices?.policyVersion !== CONSENT_VERSION && local?.policyVersion !== CONSENT_VERSION);
    };

    void load();
    const { data: listener } = clientDb.auth.onAuthStateChange(() => void load());
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const persist = async (nextValues: Pick<ConsentChoices, "analytics" | "personalization" | "advertising">) => {
    if (saving) return;
    setSaving(true);
    const now = new Date().toISOString();
    const next: ConsentChoices = {
      necessary: true,
      ...nextValues,
      policyVersion: CONSENT_VERSION,
      updatedAt: now,
    };

    try {
      writeLocalConsent(next);
      if (userId) {
        const operations = await Promise.allSettled([
          clientDb.from("cookie_consents").insert({
            user_id: userId,
            necessary: true,
            analytics: next.analytics,
            personalization: next.personalization,
            advertising: next.advertising,
            policy_version: CONSENT_VERSION,
            source: "web",
            updated_at: now,
          }),
          clientDb
            .from("profiles")
            .update({
              analytics_consent: next.analytics,
              personalized_ads_consent: next.advertising,
              consent_updated_at: now,
            })
            .eq("id", userId),
          clientDb
            .from("user_settings")
            .upsert(
              {
                user_id: userId,
                analytics_enabled: next.analytics,
                personalized_recommendations: next.personalization,
                personalized_ads: next.advertising,
                updated_at: now,
              },
              { onConflict: "user_id" },
            ),
        ]);
        const profileWriteFailed = operations[1].status === "rejected" ||
          (operations[1].status === "fulfilled" && Boolean((operations[1].value as any).error));
        if (profileWriteFailed) {
          throw new Error("profile-consent-write-failed");
        }
      }
      setChoices(next);
      setVisible(false);
      setCustomizing(false);
      notifyPrivacyUpdated();
      window.dispatchEvent(new CustomEvent("global-party:consent-updated", { detail: next }));
    } catch (error) {
      console.error("[privacy] consent persistence failed", error);
      // Local storage already records the user's choice. Keep the banner visible
      // for authenticated users when the authoritative profile write failed.
      if (!userId) {
        setChoices(next);
        setVisible(false);
        setCustomizing(false);
      }
    } finally {
      setSaving(false);
    }
  };

  if (!visible) return null;

  return (
    <aside className="glass fixed bottom-20 left-3 right-3 z-[60] mx-auto max-w-3xl overflow-hidden rounded-3xl border border-primary/20 shadow-2xl md:bottom-5">
      <div className="flex items-start gap-3 p-4 sm:p-5">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-primary/12 text-primary">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-black">{tr("Tes choix de confidentialité")}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground sm:text-sm">
            {tr("Les fonctions indispensables restent actives. L’analyse, la personnalisation et la publicité sont facultatives et désactivées tant que tu ne les acceptes pas.")}
          </p>
          {!customizing ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" disabled={saving} onClick={() => void persist({ analytics: true, personalization: true, advertising: true })}>
                {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                {tr("Tout accepter")}
              </Button>
              <Button size="sm" variant="outline" disabled={saving} onClick={() => void persist({ analytics: false, personalization: false, advertising: false })}>
                {tr("Tout refuser")}
              </Button>
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => setCustomizing(true)}>
                {tr("Personnaliser")}
              </Button>
            </div>
          ) : (
            <div className="mt-4 space-y-2">
              <ConsentChoice icon={Cookie} title={tr("Nécessaires")} description={tr("Connexion, sécurité, langue et préférences essentielles.")} checked locked onChange={() => undefined} />
              <ConsentChoice icon={BarChart3} title={tr("Analyse") } description={tr("Comprendre les parcours et améliorer les performances.")} checked={choices.analytics} onChange={(analytics) => setChoices((current) => ({ ...current, analytics }))} />
              <ConsentChoice icon={Sparkles} title={tr("Personnalisation")} description={tr("Adapter les recommandations à tes intérêts et interactions.")} checked={choices.personalization} onChange={(personalization) => setChoices((current) => ({ ...current, personalization }))} />
              <ConsentChoice icon={Megaphone} title={tr("Publicité personnalisée")} description={tr("Adapter les contenus sponsorisés lorsque tu l’autorises.")} checked={choices.advertising} onChange={(advertising) => setChoices((current) => ({ ...current, advertising }))} />
              <div className="flex flex-wrap gap-2 pt-2">
                <Button size="sm" disabled={saving} onClick={() => void persist(choices)}>
                  {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                  {tr("Enregistrer mes choix")}
                </Button>
                <Button size="sm" variant="ghost" disabled={saving} onClick={() => setCustomizing(false)}>{tr("Retour")}</Button>
              </div>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <Link to="/cookies" className="underline-offset-2 hover:text-foreground hover:underline">{tr("Politique de cookies")}</Link>
            <Link to="/privacy" className="underline-offset-2 hover:text-foreground hover:underline">{tr("Politique de confidentialité")}</Link>
            <Link to="/settings" search={{ section: "cookies" }} className="underline-offset-2 hover:text-foreground hover:underline">{tr("Modifier plus tard dans les paramètres")}</Link>
          </div>
        </div>
        {customizing && (
          <button type="button" onClick={() => setCustomizing(false)} disabled={saving} aria-label={tr("Fermer la personnalisation")} className="grid h-9 w-9 shrink-0 place-items-center rounded-full hover:bg-accent disabled:opacity-50">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </aside>
  );
}

function ConsentChoice({ icon: Icon, title, description, checked, locked = false, onChange }: { icon: typeof Cookie; title: string; description: string; checked: boolean; locked?: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className={`flex items-center gap-3 rounded-2xl border px-3 py-3 ${locked ? "cursor-default opacity-75" : "cursor-pointer"}`}>
      <Icon className="h-4 w-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1"><span className="block text-xs font-bold">{title}</span><span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{description}</span></span>
      <input type="checkbox" checked={checked} disabled={locked} onChange={(event) => onChange(event.target.checked)} className="peer sr-only" />
      <span className="relative h-6 w-11 shrink-0 rounded-full bg-muted transition peer-checked:bg-primary peer-disabled:opacity-80 after:absolute after:left-1 after:top-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow after:transition peer-checked:after:translate-x-5" />
    </label>
  );
}

function readLocalConsent(): ConsentChoices | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LOCAL_CONSENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ConsentChoices>;
    if (typeof parsed.policyVersion !== "string") return null;
    return {
      necessary: true,
      analytics: parsed.analytics === true,
      personalization: parsed.personalization === true,
      advertising: parsed.advertising === true,
      policyVersion: parsed.policyVersion,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}

function writeLocalConsent(value: ConsentChoices) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCAL_CONSENT_KEY, JSON.stringify(value));
    if (!window.localStorage.getItem(ANONYMOUS_ID_KEY)) {
      window.localStorage.setItem(ANONYMOUS_ID_KEY, crypto.randomUUID());
    }
  } catch {
    // Browser storage can be blocked. The in-memory choice still applies for
    // the current page, and the banner will ask again on a later visit.
  }
}
