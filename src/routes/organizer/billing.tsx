import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  BadgeCheck,
  Building2,
  Check,
  ChevronLeft,
  CircleDollarSign,
  CreditCard,
  Megaphone,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  createOrganizerBillingPortal,
  createOrganizerSubscriptionCheckout,
  fetchOrganizerBillingContext,
  formatPlanAmount,
  type BillingPeriod,
  type MonetizationPlan,
  type OrganizerBillingOption,
  type OrganizerSubscription,
} from "@/lib/monetization";
import { useTranslation } from "@/lib/i18n";

export const Route = createFileRoute("/organizer/billing")({
  head: () => ({ meta: [{ title: "Abonnements organisateur — Global Party" }] }),
  component: OrganizerBilling,
});

function OrganizerBilling() {
  const { tr, t, localeTag } = useTranslation();
  const navigate = useNavigate();
  const [organizers, setOrganizers] = useState<OrganizerBillingOption[]>([]);
  const [plans, setPlans] = useState<MonetizationPlan[]>([]);
  const [subscriptions, setSubscriptions] = useState<OrganizerSubscription[]>([]);
  const [organizerId, setOrganizerId] = useState("");
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) {
        navigate({ to: "/auth", search: { redirect: "/organizer/billing" } });
        return;
      }
      const context = await fetchOrganizerBillingContext(data.user.id);
      if (!active) return;
      setOrganizers(context.organizers);
      setPlans(context.plans);
      setSubscriptions(context.subscriptions);
      setOrganizerId(context.organizers[0]?.id ?? "");
      setLoading(false);
    })().catch((error) => {
      if (!active) return;
      setLoading(false);
      toast.error(error instanceof Error ? error.message : "Facturation indisponible");
    });
    return () => {
      active = false;
    };
  }, [navigate]);

  const subscription = subscriptions.find((item) => item.organizer_id === organizerId) ?? null;
  const activePlanCode = subscription?.plan_code ?? "starter";

  const startCheckout = async (plan: MonetizationPlan) => {
    if (!organizerId || pendingAction) return;
    if (plan.is_contact_sales) {
      window.location.assign("/help");
      return;
    }
    if (plan.code === "starter") return;
    setPendingAction(plan.code);
    try {
      window.location.assign(
        await createOrganizerSubscriptionCheckout(organizerId, plan.code, period),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr("Paiement indisponible"));
      setPendingAction("");
    }
  };

  const openPortal = async () => {
    if (!organizerId || pendingAction) return;
    setPendingAction("portal");
    try {
      window.location.assign(await createOrganizerBillingPortal(organizerId));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr("Portail indisponible"));
      setPendingAction("");
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-12 text-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  if (!organizers.length) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <Building2 className="mx-auto h-12 w-12 text-muted-foreground" />
        <h1 className="mt-4 text-2xl font-bold">{tr("Aucune organisation facturable")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {tr("Crée une organisation ou demande un rôle propriétaire pour gérer son abonnement.")}
        </p>
        <Link
          to="/organizer"
          className="mt-5 inline-flex rounded-full bg-primary px-5 py-2 text-sm text-primary-foreground"
        >
          {tr("Portail organisateur")}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 md:px-6">
      <Link
        to="/organizer"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> {tr("Dashboard organisateur")}
      </Link>

      <section className="relative overflow-hidden rounded-[2rem] border p-6 md:p-8">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_15%_15%,oklch(0.68_0.22_295_/_0.34),transparent_35%),radial-gradient(circle_at_88%_18%,oklch(0.72_0.18_35_/_0.18),transparent_30%),linear-gradient(135deg,oklch(0.19_0.03_265_/_0.96),oklch(0.12_0.03_265_/_0.92))]" />
        <p className="text-xs font-semibold uppercase text-primary">{tr("Monétisation")}</p>
        <h1 className="mt-2 text-3xl font-black md:text-5xl">
          {tr("Développe ton audience avec Global Party")}
        </h1>
        <p className="mt-3 max-w-3xl text-sm text-muted-foreground md:text-base">
          {tr(
            "Choisis les outils adaptés à ton rythme : publication gratuite, statistiques avancées, collaboration, promotion et solutions sur mesure.",
          )}
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <label className="text-sm font-semibold" htmlFor="billing-organization">
            {tr("Organisation")}
          </label>
          <select
            id="billing-organization"
            value={organizerId}
            onChange={(event) => setOrganizerId(event.target.value)}
            className="field-control max-w-sm"
          >
            {organizers.map((organizer) => (
              <option key={organizer.id} value={organizer.id}>
                {organizer.name}
              </option>
            ))}
          </select>
          {subscription?.stripe_customer_id && (
            <button
              type="button"
              onClick={() => void openPortal()}
              disabled={Boolean(pendingAction)}
              className="inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold hover:bg-accent disabled:opacity-50"
            >
              <CreditCard className="h-4 w-4" />
              {pendingAction === "portal" ? tr("Ouverture…") : tr("Gérer la facturation")}
            </button>
          )}
        </div>
      </section>

      <div className="my-6 flex justify-center">
        <div className="inline-flex rounded-full border bg-card p-1">
          <button
            type="button"
            onClick={() => setPeriod("monthly")}
            className={`rounded-full px-5 py-2 text-sm font-semibold ${
              period === "monthly" ? "bg-primary text-primary-foreground" : ""
            }`}
          >
            {tr("Mensuel")}
          </button>
          <button
            type="button"
            onClick={() => setPeriod("annual")}
            className={`rounded-full px-5 py-2 text-sm font-semibold ${
              period === "annual" ? "bg-primary text-primary-foreground" : ""
            }`}
          >
            {tr("Annuel · 2 mois offerts")}
          </button>
        </div>
      </div>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {plans.map((plan) => {
          const isCurrent = activePlanCode === plan.code;
          const isRecommended = plan.code === "pro";
          const amount = formatPlanAmount(plan, period, localeTag);
          return (
            <article
              key={plan.code}
              className={`relative flex min-h-[32rem] flex-col rounded-[2rem] border p-6 ${
                isRecommended ? "border-primary/60 bg-primary/[0.04]" : "glass"
              }`}
            >
              {isRecommended && (
                <span className="absolute right-5 top-5 rounded-full bg-primary px-3 py-1 text-[10px] font-bold uppercase text-primary-foreground">
                  {tr("Recommandé")}
                </span>
              )}
              <div className="grid h-11 w-11 place-items-center rounded-2xl bg-primary/10 text-primary">
                {plan.code === "business" || plan.code === "enterprise" ? (
                  <Building2 className="h-5 w-5" />
                ) : plan.code === "pro" ? (
                  <Sparkles className="h-5 w-5" />
                ) : (
                  <CircleDollarSign className="h-5 w-5" />
                )}
              </div>
              <h2 className="mt-5 text-2xl font-black">{plan.name}</h2>
              <p className="mt-2 min-h-16 text-sm text-muted-foreground">{plan.description}</p>
              <div className="mt-5">
                {plan.is_contact_sales ? (
                  <p className="text-2xl font-black">{tr("Sur mesure")}</p>
                ) : plan.code === "starter" ? (
                  <p className="text-3xl font-black">{tr("Gratuit")}</p>
                ) : (
                  <>
                    <p className="text-3xl font-black">{amount}</p>
                    <p className="text-xs text-muted-foreground">
                      {period === "annual" ? tr("par an") : tr("par mois")}
                    </p>
                  </>
                )}
              </div>
              <ul className="mt-6 flex-1 space-y-3 text-sm">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => void startCheckout(plan)}
                disabled={isCurrent || Boolean(pendingAction)}
                className={`mt-6 inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60 ${
                  isRecommended ? "bg-primary text-primary-foreground" : "border hover:bg-accent"
                }`}
              >
                {isCurrent ? (
                  <>
                    <BadgeCheck className="h-4 w-4" /> {tr("Plan actuel")}
                  </>
                ) : pendingAction === plan.code ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" /> {tr("Préparation…")}
                  </>
                ) : plan.is_contact_sales ? (
                  tr("Parler à l’équipe")
                ) : (
                  tr("Choisir ce plan")
                )}
              </button>
            </article>
          );
        })}
      </section>

      <section className="mt-7 grid gap-4 md:grid-cols-3">
        <RevenueCard
          icon={Megaphone}
          title={tr("Promotion à la carte")}
          body={tr("Achète une campagne ciblée sans abonnement et suis ses impressions et clics.")}
          link="/organizer/ads"
          linkLabel={tr("Créer une campagne")}
        />
        <RevenueCard
          icon={CircleDollarSign}
          title={tr("Billetterie et affiliation")}
          body={tr(
            "Les futurs partenariats billetterie attribueront les ventes générées par Global Party.",
          )}
        />
        <RevenueCard
          icon={Building2}
          title={tr("Sponsoring et API")}
          body={tr(
            "Les villes, marques et grands réseaux peuvent obtenir des espaces sponsorisés, widgets et accès API.",
          )}
        />
      </section>
    </div>
  );
}

function RevenueCard({
  icon: Icon,
  title,
  body,
  link,
  linkLabel,
}: {
  icon: typeof Megaphone;
  title: string;
  body: string;
  link?: "/organizer/ads";
  linkLabel?: string;
}) {
  return (
    <article className="glass rounded-3xl p-5">
      <Icon className="h-5 w-5 text-primary" />
      <h2 className="mt-3 font-bold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      {link && linkLabel && (
        <Link to={link} className="mt-4 inline-flex text-sm font-semibold text-primary">
          {linkLabel}
        </Link>
      )}
    </article>
  );
}
