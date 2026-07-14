/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

const analyticsDb = supabase as unknown as SupabaseClient<any>;
const SESSION_KEY = "eventa.client-session-id";
let analyticsEnabled = false;

export function setClientAnalyticsEnabled(enabled: boolean) {
  analyticsEnabled = enabled;
}

export function getClientSessionId(): string {
  if (typeof window === "undefined") return crypto.randomUUID();
  const existing = window.sessionStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const sessionId = crypto.randomUUID();
  window.sessionStorage.setItem(SESSION_KEY, sessionId);
  return sessionId;
}

export async function trackClientEvent(
  eventName: string,
  options: {
    path?: string;
    referrerPath?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    cityId?: string | null;
    metadata?: Record<string, string | number | boolean | null>;
  } = {},
): Promise<void> {
  if (!analyticsEnabled || typeof window === "undefined") return;
  const { data } = await analyticsDb.auth.getUser();
  if (!data.user) return;

  const { error } = await analyticsDb.from("client_journey_events").insert({
    user_id: data.user.id,
    session_id: getClientSessionId(),
    event_name: eventName,
    path: options.path ?? `${window.location.pathname}${window.location.search}`,
    referrer_path: options.referrerPath ?? null,
    entity_type: options.entityType ?? null,
    entity_id: options.entityId ?? null,
    city_id: options.cityId ?? null,
    metadata: options.metadata ?? {},
  });

  // Consent and authorization are enforced again by RLS. Tracking must never
  // interrupt the user's navigation if the request is rejected or offline.
  if (error && import.meta.env.DEV) console.debug("[analytics] event ignored", error.message);
}

export function notifyPrivacyUpdated() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("eventa:privacy-updated"));
}
