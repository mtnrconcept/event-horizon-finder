import { useEffect, useMemo, useRef } from "react";
import { CalendarDays, Clock3, MessageCircle, RefreshCw, Sparkles, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SocialPostCard } from "@/components/social/social-post-card";
import { useSocialFeed } from "@/hooks/use-social-feed";
import type { SocialFeedFilter } from "@/lib/social-queries";
import { useTranslation } from "@/lib/i18n";

const filters: Array<{
  value: SocialFeedFilter;
  label: string;
  icon: typeof Users;
  requiresAuth?: boolean;
}> = [
  { value: "all", label: "Pour toi", icon: Sparkles },
  { value: "following", label: "Abonnements", icon: Users, requiresAuth: true },
  { value: "events", label: "Événements", icon: CalendarDays },
  { value: "recent", label: "Récent", icon: Clock3 },
];

function PostSkeleton() {
  return (
    <div className="glass overflow-hidden rounded-3xl">
      <div className="flex items-center gap-3 p-4">
        <Skeleton className="h-11 w-11 rounded-full" />
        <div className="space-y-2"><Skeleton className="h-3.5 w-36" /><Skeleton className="h-3 w-20" /></div>
      </div>
      <div className="space-y-2 px-4 pb-4"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-4/5" /></div>
      <Skeleton className="aspect-video w-full rounded-none" />
      <div className="grid grid-cols-4 gap-3 p-3"><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
    </div>
  );
}

export function SocialFeed({
  filter,
  onFilterChange,
  currentUserId,
}: {
  filter: SocialFeedFilter;
  onFilterChange: (filter: SocialFeedFilter) => void;
  currentUserId: string | null;
}) {
  const { tr, t } = useTranslation();
  const feed = useSocialFeed(filter, currentUserId);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = feed;
  const posts = useMemo(() => feed.data?.pages.flatMap((page) => page.posts) ?? [], [feed.data]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) fetchNextPage();
      },
      { rootMargin: "500px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  return (
    <section aria-label={tr("Fil social Global Party")}>
      <div className="no-scrollbar sticky top-0 z-20 mb-4 flex gap-1 overflow-x-auto rounded-2xl border bg-background/90 p-1.5 shadow-lg backdrop-blur-xl md:top-[4.25rem]">
        {filters.map(({ value, label, icon: Icon, requiresAuth }) => (
          <button
            key={value}
            type="button"
            onClick={() => onFilterChange(value)}
            disabled={Boolean(requiresAuth && !currentUserId)}
            title={requiresAuth && !currentUserId ? tr("Connecte-toi pour voir tes abonnements") : undefined}
            className={`flex min-h-10 min-w-fit flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-3 text-xs font-semibold transition-colors sm:text-sm ${filter === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            <Icon className="h-4 w-4" /> {tr(label)}
          </button>
        ))}
      </div>

      {feed.isLoading ? (
        <div className="space-y-4">{Array.from({ length: 3 }).map((_, index) => <PostSkeleton key={index} />)}</div>
      ) : feed.isError ? (
        <div className="glass rounded-3xl p-8 text-center">
          <RefreshCw className="mx-auto h-9 w-9 text-muted-foreground" />
          <p className="mt-3 font-semibold">{tr("Le fil n’a pas pu être chargé")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{tr("Vérifie ta connexion puis réessaie.")}</p>
          <Button variant="outline" onClick={() => feed.refetch()} className="mt-4 rounded-full">{t("common.retry")}</Button>
        </div>
      ) : posts.length === 0 ? (
        <div className="glass rounded-3xl p-8 text-center">
          <MessageCircle className="mx-auto h-10 w-10 text-muted-foreground" />
          <h2 className="mt-3 text-lg font-semibold">
            {filter === "following"
              ? tr("Ton fil d’abonnements est encore vide")
              : filter === "events"
                ? tr("Aucune publication liée à un événement pour l’instant")
                : tr("Le fil est encore calme")}
          </h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            {filter === "following"
              ? tr("Suis des membres et des organisateurs pour composer un fil qui te ressemble.")
              : tr("Les prochaines publications de la communauté apparaîtront ici.")}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {posts.map((post) => <SocialPostCard key={post.id} post={post} currentUserId={currentUserId} />)}
          <div ref={loadMoreRef} className="flex min-h-16 items-center justify-center">
            {feed.isFetchingNextPage ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><RefreshCw className="h-4 w-4 animate-spin" /> {t("common.loading")}</div>
            ) : feed.hasNextPage ? (
              <Button variant="ghost" size="sm" onClick={() => feed.fetchNextPage()}>{tr("Voir plus")}</Button>
            ) : (
              <p className="text-xs text-muted-foreground">{tr("Tu es à jour.")}</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
