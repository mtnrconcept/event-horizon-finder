import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Megaphone } from "lucide-react";
import {
  fetchEligibleCampaigns,
  recordAdDelivery,
  type AdPlacement,
  type EligibleCampaign,
} from "@/lib/ad-queries";
import { useTranslation } from "@/lib/i18n";

export function TargetedCampaigns({ placement }: { placement: AdPlacement }) {
  const { tr } = useTranslation();
  const campaigns = useQuery({
    queryKey: ["eligible-ad-campaigns", placement],
    queryFn: () => fetchEligibleCampaigns(placement),
    staleTime: 5 * 60_000,
    retry: false,
  });

  useEffect(() => {
    campaigns.data?.forEach((campaign) => {
      void recordAdDelivery(campaign.campaign_id, "impression", placement);
    });
  }, [campaigns.data, placement]);

  if (!campaigns.data?.length) return null;
  return (
    <section aria-label={tr("Événements sponsorisés")} className="mb-6">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
        <Megaphone className="h-3.5 w-3.5" />{" "}
        {tr("Sélection sponsorisée · personnalisée avec ton accord")}
      </div>
      <div className="no-scrollbar flex gap-3 overflow-x-auto pb-2">
        {campaigns.data.map((campaign) => (
          <CampaignCard key={campaign.campaign_id} campaign={campaign} placement={placement} />
        ))}
      </div>
    </section>
  );
}

function CampaignCard({
  campaign,
  placement,
}: {
  campaign: EligibleCampaign;
  placement: AdPlacement;
}) {
  const href =
    campaign.cta_url ??
    (campaign.promoted_event_slug
      ? `/event/${campaign.promoted_event_slug}`
      : campaign.promoted_post_id
        ? `/post/${campaign.promoted_post_id}`
        : "/social");
  const external = /^https?:\/\//.test(href);
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer sponsored" : "sponsored"}
      onClick={() => void recordAdDelivery(campaign.campaign_id, "click", placement)}
      className="group grid min-w-[19rem] max-w-md flex-1 grid-cols-[5.5rem_1fr] overflow-hidden rounded-2xl border bg-surface/70 transition-colors hover:border-primary/50 sm:min-w-[23rem]"
    >
      <div className="bg-[radial-gradient(circle_at_30%_20%,oklch(0.68_0.22_295_/_0.65),transparent_55%),linear-gradient(145deg,oklch(0.25_0.08_295),oklch(0.18_0.04_265))]">
        {campaign.image_url && (
          <img src={campaign.image_url} alt="" className="h-full w-full object-cover" />
        )}
      </div>
      <div className="min-w-0 p-3">
        <p className="text-[10px] font-semibold uppercase text-primary">
          {campaign.organizer_name}
        </p>
        <h2 className="mt-1 line-clamp-1 text-sm font-bold">{campaign.headline}</h2>
        {campaign.body && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{campaign.body}</p>
        )}
        <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary">
          {campaign.cta_label} <ArrowUpRight className="h-3.5 w-3.5" />
        </span>
      </div>
    </a>
  );
}
