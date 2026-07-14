/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { getClientSessionId } from "@/lib/client-analytics";

const adDb = supabase as unknown as SupabaseClient<any>;

export type AdPlacement = "discover" | "social" | "event";
export type CampaignStatus = "draft" | "active" | "paused" | "completed" | "rejected";

export type OrganizerOption = {
  id: string;
  name: string;
  role: string;
};

export type PromotableEvent = { id: string; organizer_id: string; title: string; slug: string };
export type PromotablePost = { id: string; organizer_id: string; body: string | null };

export type AdCampaign = {
  id: string;
  organizer_id: string;
  name: string;
  status: CampaignStatus;
  objective: string;
  headline: string;
  body: string | null;
  promoted_event_id: string | null;
  promoted_post_id: string | null;
  placements: AdPlacement[];
  target_city_ids: string[];
  target_age_min: number | null;
  target_age_max: number | null;
  target_music_genres: string[];
  starts_at: string;
  ends_at: string;
  daily_budget: number;
  total_budget: number;
  currency: string;
  created_at: string;
  impression_count: number;
  click_count: number;
  unique_reach: number;
  click_through_rate: number;
};

export type EligibleCampaign = {
  campaign_id: string;
  organizer_name: string;
  headline: string;
  body: string | null;
  image_url: string | null;
  cta_label: string;
  cta_url: string | null;
  promoted_event_slug: string | null;
  promoted_post_id: string | null;
};

export type CreateCampaignInput = {
  organizer_id: string;
  name: string;
  status: "draft" | "active";
  objective: string;
  promoted_event_id: string | null;
  promoted_post_id: string | null;
  headline: string;
  body: string | null;
  image_url: string | null;
  cta_label: string;
  cta_url: string | null;
  placements: AdPlacement[];
  target_city_ids: string[];
  target_age_min: number | null;
  target_age_max: number | null;
  target_music_genres: string[];
  starts_at: string;
  ends_at: string;
  daily_budget: number;
  total_budget: number;
  currency: string;
};

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export async function fetchOrganizerAdContext(userId: string) {
  const { data: membershipRows, error: membershipError } = await adDb
    .from("organizer_members")
    .select("role,organizer:organizers(id,name)")
    .eq("user_id", userId)
    .in("role", ["owner", "admin", "editor"]);
  if (membershipError) throw membershipError;

  const organizers: OrganizerOption[] = (membershipRows ?? []).flatMap((row: any) => {
    const organizer = firstRelation<{ id: string; name: string }>(row.organizer);
    return organizer ? [{ ...organizer, role: String(row.role) }] : [];
  });
  if (!organizers.length) return { organizers, events: [], posts: [] };
  const organizerIds = organizers.map((organizer) => organizer.id);

  const [{ data: events, error: eventError }, { data: posts, error: postError }] =
    await Promise.all([
      adDb
        .from("events")
        .select("id,organizer_id,title,slug")
        .in("organizer_id", organizerIds)
        .eq("status", "published")
        .order("updated_at", { ascending: false }),
      adDb
        .from("social_posts")
        .select("id,organizer_id,body")
        .in("organizer_id", organizerIds)
        .eq("status", "published")
        .order("published_at", { ascending: false }),
    ]);
  if (eventError) throw eventError;
  if (postError) throw postError;
  return {
    organizers,
    events: (events ?? []) as PromotableEvent[],
    posts: (posts ?? []) as PromotablePost[],
  };
}

export async function fetchAdCampaigns(organizerIds: string[]): Promise<AdCampaign[]> {
  if (!organizerIds.length) return [];
  const { data: rows, error } = await adDb
    .from("ad_campaigns")
    .select("*")
    .in("organizer_id", organizerIds)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const performanceRows = (
    await Promise.all(
      organizerIds.map(async (organizerId) => {
        const { data, error: performanceError } = await adDb.rpc("get_ad_campaign_performance", {
          _organizer_id: organizerId,
        });
        if (performanceError) throw performanceError;
        return data ?? [];
      }),
    )
  ).flat();
  const performance = new Map(performanceRows.map((row: any) => [String(row.campaign_id), row]));

  return (rows ?? []).map((row: any) => {
    const stats = performance.get(String(row.id));
    return {
      ...row,
      daily_budget: Number(row.daily_budget),
      total_budget: Number(row.total_budget),
      impression_count: Number(stats?.impression_count ?? 0),
      click_count: Number(stats?.click_count ?? 0),
      unique_reach: Number(stats?.unique_reach ?? 0),
      click_through_rate: Number(stats?.click_through_rate ?? 0),
    } as AdCampaign;
  });
}

export async function createAdCampaign(input: CreateCampaignInput): Promise<string> {
  const { data: authData, error: authError } = await adDb.auth.getUser();
  if (authError || !authData.user) throw new Error("Connecte-toi pour créer une campagne.");
  const { data, error } = await adDb
    .from("ad_campaigns")
    .insert({ ...input, created_by: authData.user.id })
    .select("id")
    .single();
  if (error) throw error;
  return String(data.id);
}

export async function updateAdCampaignStatus(campaignId: string, status: CampaignStatus) {
  const { error } = await adDb.from("ad_campaigns").update({ status }).eq("id", campaignId);
  if (error) throw error;
}

export async function estimateAdAudience(args: {
  cityIds: string[];
  ageMin: number | null;
  ageMax: number | null;
  genres: string[];
}): Promise<number> {
  const { data, error } = await adDb.rpc("estimate_ad_campaign_audience", {
    _city_ids: args.cityIds,
    _age_min: args.ageMin,
    _age_max: args.ageMax,
    _genres: args.genres,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

export async function fetchEligibleCampaigns(placement: AdPlacement): Promise<EligibleCampaign[]> {
  const { data, error } = await adDb.rpc("eligible_ad_campaigns", {
    _placement: placement,
    _limit: 3,
  });
  if (error) {
    // Anonymous visitors and non-consenting clients simply receive no personalized campaign.
    if (error.code === "42501") return [];
    throw error;
  }
  return (data ?? []) as EligibleCampaign[];
}

export async function recordAdDelivery(
  campaignId: string,
  eventType: "impression" | "click",
  placement: AdPlacement,
) {
  if (typeof window === "undefined") return;
  await adDb.rpc("record_ad_campaign_delivery", {
    _campaign_id: campaignId,
    _event_type: eventType,
    _placement: placement,
    _session_id: getClientSessionId(),
    _path: `${window.location.pathname}${window.location.search}`,
  });
}
