import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BadgeCheck, Heart, MessageCircle, Radio, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SocialFeed } from "@/components/social/social-feed";
import { SocialPostComposer } from "@/components/social/social-post-composer";
import { useCurrentSocialUser } from "@/hooks/use-social-feed";
import type { SocialFeedFilter } from "@/lib/social-queries";
import { TargetedCampaigns } from "@/components/targeted-campaigns";

export const Route = createFileRoute("/social")({
  head: () => ({
    meta: [
      { title: "Communauté — EVENTA" },
      {
        name: "description",
        content: "Découvre les annonces des organisateurs et échange autour des événements.",
      },
      { property: "og:title", content: "Communauté EVENTA" },
      {
        property: "og:description",
        content: "Le fil des organisateurs et de la communauté événementielle.",
      },
    ],
  }),
  component: SocialPage,
});

function SocialPage() {
  const currentUser = useCurrentSocialUser();
  const [filter, setFilter] = useState<SocialFeedFilter>("all");
  const userId = currentUser.data?.id ?? null;

  return (
    <div className="mx-auto max-w-6xl px-4 pt-6 md:px-6 md:pt-9">
      <section className="relative mb-6 overflow-hidden rounded-[2rem] border p-5 sm:p-7">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_15%_15%,oklch(0.68_0.22_295_/_0.32),transparent_35%),radial-gradient(circle_at_90%_20%,oklch(0.72_0.18_35_/_0.20),transparent_30%),linear-gradient(135deg,oklch(0.19_0.03_265_/_0.95),oklch(0.12_0.03_265_/_0.9))]" />
        <Badge className="mb-4 border-transparent bg-primary/15 text-primary">
          <Radio className="mr-1.5 h-3.5 w-3.5" /> Le réseau EVENTA
        </Badge>
        <h1 className="max-w-3xl text-3xl font-black leading-tight sm:text-5xl">
          Les événements commencent bien avant l'ouverture des portes.
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground sm:text-base">
          Annonces, coulisses, photos et rendez-vous : retrouve ici les organisateurs qui font vivre
          ta ville.
        </p>
      </section>

      <TargetedCampaigns placement="social" />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,680px)_minmax(250px,1fr)]">
        <div className="min-w-0">
          {userId && <SocialPostComposer userId={userId} />}
          <SocialFeed filter={filter} onFilterChange={setFilter} currentUserId={userId} />
        </div>

        <aside className="hidden space-y-4 lg:sticky lg:top-24 lg:block">
          {!userId && !currentUser.isLoading && (
            <div className="glass rounded-3xl p-5">
              <Users className="h-8 w-8 text-primary" />
              <h2 className="mt-3 text-lg font-semibold">Rejoins la conversation</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Connecte-toi pour aimer, commenter et échanger avec la communauté.
              </p>
              <Button asChild className="mt-4 w-full rounded-full">
                <a href="/auth?redirect=%2Fsocial">Se connecter</a>
              </Button>
            </div>
          )}

          <div className="glass rounded-3xl p-5">
            <h2 className="font-semibold">Ici, tu peux</h2>
            <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
              <li className="flex gap-2.5">
                <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> Voir les annonces
                officielles
              </li>
              <li className="flex gap-2.5">
                <Heart className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> Soutenir les publications
              </li>
              <li className="flex gap-2.5">
                <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> Échanger avec la
                communauté
              </li>
            </ul>
          </div>

          {userId && (
            <div className="rounded-3xl border border-primary/20 bg-primary/5 p-5">
              <p className="text-sm font-semibold">Tu organises des événements ?</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Crée ou rejoins une organisation pour publier dans le fil.
              </p>
              <Button asChild variant="outline" size="sm" className="mt-3 rounded-full">
                <Link to="/organizer">Portail organisateur</Link>
              </Button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
