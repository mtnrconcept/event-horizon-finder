import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft, MessageCircle } from "lucide-react";
import { SocialPostCard } from "@/components/social/social-post-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentSocialUser, useSocialPost } from "@/hooks/use-social-feed";
import { getEventArtworkUrl } from "@/lib/event-artwork";
import { fetchSocialPost } from "@/lib/social-queries";
import { useTranslation } from "@/lib/i18n";

export const Route = createFileRoute("/post/$id")({
  loader: async ({ params }) => {
    const post = await fetchSocialPost(params.id, null);
    if (!post) throw notFound();
    return post;
  },
  head: ({ loaderData }) => {
    if (!loaderData) {
      return {
        meta: [
          { title: "Publication introuvable — Global Party" },
          { name: "robots", content: "noindex" },
        ],
      };
    }
    const image =
      loaderData.media.find((item) => item.kind === "image")?.public_url ??
      (loaderData.event
        ? getEventArtworkUrl(loaderData.event.id, loaderData.event.cover_image_url)
        : null);
    const description =
      loaderData.body?.slice(0, 180) ??
      loaderData.event?.short_description ??
      `Une publication de ${loaderData.organizer.name} sur Global Party.`;
    return {
      meta: [
        { title: `${loaderData.organizer.name} — Global Party` },
        { name: "description", content: description },
        { property: "og:title", content: `${loaderData.organizer.name} sur Global Party` },
        { property: "og:description", content: description },
        { property: "og:type", content: "article" },
        ...(image ? [{ property: "og:image", content: image }] : []),
      ],
    };
  },
  errorComponent: PostError,
  notFoundComponent: PostNotFound,
  component: SocialPostPage,
});

function PostError({ error }: { error: Error }) {
  const { tr } = useTranslation();
  return (
    <div className="mx-auto max-w-xl px-4 py-16 text-center">
      <MessageCircle className="mx-auto h-10 w-10 text-muted-foreground" />
      <h1 className="mt-4 text-xl font-semibold">{tr("Impossible de charger la publication")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
      <Button asChild variant="outline" className="mt-5 rounded-full">
        <Link to="/social">{tr("Retour au fil")}</Link>
      </Button>
    </div>
  );
}

function PostNotFound() {
  const { tr } = useTranslation();
  return (
    <div className="mx-auto max-w-xl px-4 py-16 text-center">
      <MessageCircle className="mx-auto h-10 w-10 text-muted-foreground" />
      <h1 className="mt-4 text-xl font-semibold">{tr("Publication introuvable")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {tr("Elle a peut-être été retirée ou masquée.")}
      </p>
      <Button asChild variant="outline" className="mt-5 rounded-full">
        <Link to="/social">{tr("Retour au fil")}</Link>
      </Button>
    </div>
  );
}

function SocialPostPage() {
  const { tr } = useTranslation();
  const initialPost = Route.useLoaderData();
  const currentUser = useCurrentSocialUser();
  const userId = currentUser.data?.id ?? null;
  const post = useSocialPost(initialPost.id, userId, initialPost);

  return (
    <div className="mx-auto max-w-2xl px-4 pt-6 md:px-6 md:pt-9">
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="mb-3 -ml-2 rounded-full text-muted-foreground"
      >
        <Link to="/social">
          <ArrowLeft className="h-4 w-4" /> {tr("Retour au fil")}
        </Link>
      </Button>
      {post.isLoading ? (
        <div className="glass rounded-3xl p-5">
          <div className="flex gap-3">
            <Skeleton className="h-11 w-11 rounded-full" />
            <Skeleton className="h-8 flex-1" />
          </div>
          <Skeleton className="mt-5 h-32 w-full" />
        </div>
      ) : post.data ? (
        <SocialPostCard post={post.data} currentUserId={userId} standalone />
      ) : (
        <div className="glass rounded-3xl p-8 text-center text-sm text-muted-foreground">
          {tr("Cette publication n'est plus disponible.")}
        </div>
      )}
    </div>
  );
}
