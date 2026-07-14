/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from "@supabase/supabase-js";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { setClientAnalyticsEnabled, trackClientEvent } from "@/lib/client-analytics";

const clientDb = supabase as unknown as SupabaseClient<any>;

type TrackingProfile = {
  account_type: "client" | "organizer";
  analytics_consent: boolean;
  home_city_id: string | null;
};

export function ClientJourneyTracker() {
  const path = useRouterState({
    select: (state) => `${state.location.pathname}${state.location.searchStr || ""}`,
  });
  const [profile, setProfile] = useState<TrackingProfile | null>(null);
  const previousPath = useRef<string | null>(null);
  const lastTrackedPath = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const { data } = await clientDb.auth.getUser();
      if (!data.user) {
        if (active) setProfile(null);
        setClientAnalyticsEnabled(false);
        return;
      }
      const { data: row } = await clientDb
        .from("profiles")
        .select("account_type,analytics_consent,home_city_id")
        .eq("id", data.user.id)
        .maybeSingle();
      if (!active) return;
      const nextProfile = (row ?? null) as TrackingProfile | null;
      setProfile(nextProfile);
      setClientAnalyticsEnabled(
        nextProfile?.account_type === "client" && nextProfile.analytics_consent,
      );
    };

    void load();
    const { data: authListener } = clientDb.auth.onAuthStateChange(() => void load());
    window.addEventListener("eventa:privacy-updated", load);
    return () => {
      active = false;
      authListener.subscription.unsubscribe();
      window.removeEventListener("eventa:privacy-updated", load);
    };
  }, []);

  useEffect(() => {
    if (
      profile?.account_type !== "client" ||
      !profile.analytics_consent ||
      lastTrackedPath.current === path
    ) {
      return;
    }
    const referrerPath = previousPath.current;
    previousPath.current = path;
    lastTrackedPath.current = path;
    void trackClientEvent("page_view", {
      path,
      referrerPath,
      cityId: profile.home_city_id,
    });
  }, [path, profile]);

  return null;
}
