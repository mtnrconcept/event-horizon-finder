/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { notifyPrivacyUpdated } from "@/lib/client-analytics";

const clientDb = supabase as unknown as SupabaseClient<any>;

export function ClientConsentBanner() {
  const [userId, setUserId] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const { data } = await clientDb.auth.getUser();
      if (!active || !data.user) {
        if (active) setVisible(false);
        return;
      }
      const { data: profile } = await clientDb
        .from("profiles")
        .select("account_type,consent_updated_at")
        .eq("id", data.user.id)
        .maybeSingle();
      if (!active) return;
      setUserId(data.user.id);
      setVisible(profile?.account_type === "client" && !profile.consent_updated_at);
    };
    void load();
    const { data: listener } = clientDb.auth.onAuthStateChange(() => void load());
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const decide = async (accepted: boolean) => {
    if (!userId || saving) return;
    setSaving(true);
    const { error } = await clientDb
      .from("profiles")
      .update({
        analytics_consent: accepted,
        personalized_ads_consent: accepted,
        consent_updated_at: new Date().toISOString(),
      })
      .eq("id", userId);
    setSaving(false);
    if (error) return;
    setVisible(false);
    notifyPrivacyUpdated();
  };

  if (!visible) return null;
  return (
    <aside className="glass fixed bottom-20 left-3 right-3 z-50 mx-auto max-w-2xl rounded-3xl p-4 shadow-2xl md:bottom-5 md:p-5">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-6 w-6 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Une expérience adaptée à tes sorties</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground sm:text-sm">
            Avec ton accord, EVENTA enregistre ton parcours dans l'application et utilise ta ville,
            ta tranche d'âge et tes goûts musicaux pour personnaliser les recommandations et
            publicités. Les organisateurs ne voient que des statistiques agrégées.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" disabled={saving} onClick={() => void decide(true)}>
              Accepter
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => void decide(false)}
            >
              Continuer sans personnalisation
            </Button>
          </div>
        </div>
      </div>
    </aside>
  );
}
