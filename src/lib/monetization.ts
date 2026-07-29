/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

const billingDb = supabase as unknown as SupabaseClient<any>;

export type BillingPeriod = "monthly" | "annual";

export type MonetizationPlan = {
  code: string;
  name: string;
  description: string;
  monthly_amount_minor: number;
  annual_amount_minor: number;
  currency: string;
  features: string[];
  limits: Record<string, number>;
  is_contact_sales: boolean;
  sort_order: number;
};

export type OrganizerBillingOption = {
  id: string;
  name: string;
  role: string;
};

export type OrganizerSubscription = {
  organizer_id: string;
  plan_code: string;
  status: string;
  billing_period: BillingPeriod;
  stripe_customer_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
};

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export async function fetchOrganizerBillingContext(userId: string) {
  const [{ data: memberships, error: membershipError }, { data: plans, error: planError }] =
    await Promise.all([
      billingDb
        .from("organizer_members")
        .select("role,organizer:organizers(id,name)")
        .eq("user_id", userId)
        .in("role", ["owner", "admin"]),
      billingDb
        .from("monetization_plans")
        .select(
          "code,name,description,monthly_amount_minor,annual_amount_minor,currency,features,limits,is_contact_sales,sort_order",
        )
        .eq("audience", "organizer")
        .eq("is_active", true)
        .order("sort_order"),
    ]);
  if (membershipError) throw membershipError;
  if (planError) throw planError;

  const organizers: OrganizerBillingOption[] = (memberships ?? []).flatMap((row: any) => {
    const organizer = firstRelation<{ id: string; name: string }>(row.organizer);
    return organizer ? [{ ...organizer, role: String(row.role) }] : [];
  });
  const organizerIds = organizers.map((organizer) => organizer.id);

  let subscriptions: OrganizerSubscription[] = [];
  if (organizerIds.length) {
    const { data, error } = await billingDb
      .from("organizer_subscriptions")
      .select(
        "organizer_id,plan_code,status,billing_period,stripe_customer_id,current_period_end,cancel_at_period_end",
      )
      .in("organizer_id", organizerIds);
    if (error) throw error;
    subscriptions = (data ?? []) as OrganizerSubscription[];
  }

  return {
    organizers,
    plans: (plans ?? []).map((plan: any) => ({
      ...plan,
      monthly_amount_minor: Number(plan.monthly_amount_minor),
      annual_amount_minor: Number(plan.annual_amount_minor),
      features: Array.isArray(plan.features) ? plan.features.map(String) : [],
      limits:
        plan.limits && typeof plan.limits === "object"
          ? (plan.limits as Record<string, number>)
          : {},
      sort_order: Number(plan.sort_order),
    })) as MonetizationPlan[],
    subscriptions,
  };
}

export async function createOrganizerSubscriptionCheckout(
  organizerId: string,
  planCode: string,
  billingPeriod: BillingPeriod,
) {
  const returnUrl = `${window.location.origin}/organizer/billing`;
  const { data, error } = await supabase.functions.invoke(
    "create-organizer-subscription-checkout",
    {
      body: { organizerId, planCode, billingPeriod, returnUrl },
    },
  );
  if (error) throw error;
  if (!data?.url) throw new Error(data?.error || "Paiement d’abonnement indisponible");
  return String(data.url);
}

export async function createOrganizerBillingPortal(organizerId: string) {
  const returnUrl = `${window.location.origin}/organizer/billing`;
  const { data, error } = await supabase.functions.invoke("create-billing-portal", {
    body: { organizerId, returnUrl },
  });
  if (error) throw error;
  if (!data?.url) throw new Error(data?.error || "Portail de facturation indisponible");
  return String(data.url);
}

export function formatPlanAmount(plan: MonetizationPlan, period: BillingPeriod, locale: string) {
  const amount = period === "annual" ? plan.annual_amount_minor : plan.monthly_amount_minor;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: plan.currency,
    maximumFractionDigits: 0,
  }).format(amount / 100);
}
