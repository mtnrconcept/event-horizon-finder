import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { BadgeCheck, Heart, MessageCircle, Share2 } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { SocialComments } from "@/components/social/social-comments";
import { SocialEventAttachment } from "@/components/social/social-event-attachment";
import { SocialMediaGrid } from "@/components/social/social-media-grid";
import { useToggleSocialLike } from "@/hooks/use-social-feed";
import { shareSocialPost, type SocialPost } from "@/lib/social-queries";

function relativeDate(value: string) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 8) return formatter.format(days, "day");
  return new Intl.DateTimeFormat("fr-CH", {
    day: "numeric",
    month: "short",
    year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  }).format(new Date(value));
}

function compactCount(value: number) {
  return new Intl.NumberFormat("fr", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function SocialPostCard({
  post,
  currentUserId,
  standalone = false,
}: {
  post: SocialPost;
  currentUserId: string | null;
  standalone?: boolean;
}) {
  const toggleLike = useToggleSocialLike();
  const [commentsExpanded, setCommentsExpanded] = useState(standalone);
  const [authPrompt, setAuthPrompt] = useState(false);
  const [bodyExpanded, setBodyExpanded] = useState(standalone);

  const like = () => {
    if (!currentUserId) {
      setAuthPrompt(true);
      return;
    }
    toggleLike.mutate({ postId: post.id, currentlyLiked: post.liked_by_viewer });
  };

  const share = async () => {
    try {
      const result = await shareSocialPost(post);
      if (result === "copied") toast.success("Lien copié");
    } catch {
      toast.error("Impossible de partager cette publication");
    }
  };

  const showMore = Boolean(post.body && post.body.length > 480 && !bodyExpanded);

  return (
    <article className="glass overflow-hidden rounded-3xl shadow-[var(--shadow-card)]">
      <header className="flex items-start gap-3 px-4 py-4 sm:px-5">
        <Avatar className="h-11 w-11 border bg-surface-2">
          {post.organizer.logo_url && (
            <AvatarImage src={post.organizer.logo_url} alt="" className="object-cover" />
          )}
          <AvatarFallback className="bg-primary/15 text-xs font-bold text-primary">
            {post.organizer.name.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-semibold sm:text-base">{post.organizer.name}</p>
            {post.organizer.is_verified && (
              <BadgeCheck
                className="h-4 w-4 shrink-0 text-primary"
                aria-label="Organisateur vérifié"
              />
            )}
          </div>
          {standalone ? (
            <time className="text-xs text-muted-foreground">{relativeDate(post.published_at)}</time>
          ) : (
            <Link
              to="/post/$id"
              params={{ id: post.id }}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              {relativeDate(post.published_at)}
            </Link>
          )}
        </div>
      </header>

      {post.body && (
        <div className="px-4 pb-4 sm:px-5">
          <p
            className={
              !bodyExpanded && post.body.length > 480
                ? "line-clamp-6 whitespace-pre-wrap break-words text-[15px] leading-relaxed"
                : "whitespace-pre-wrap break-words text-[15px] leading-relaxed"
            }
          >
            {post.body}
          </p>
          {showMore && (
            <button
              type="button"
              onClick={() => setBodyExpanded(true)}
              className="mt-1 text-sm font-medium text-primary hover:underline"
            >
              Voir plus
            </button>
          )}
        </div>
      )}

      <SocialMediaGrid media={post.media} />
      {post.event && (
        <div className={post.media.length ? "pt-4" : ""}>
          <SocialEventAttachment event={post.event} />
        </div>
      )}

      <div className="grid grid-cols-3 border-t px-2 py-1.5 sm:px-3">
        <Button
          type="button"
          variant="ghost"
          onClick={like}
          disabled={toggleLike.isPending}
          aria-pressed={post.liked_by_viewer}
          className={
            post.liked_by_viewer ? "rounded-xl text-primary" : "rounded-xl text-muted-foreground"
          }
        >
          <Heart className="h-4 w-4" fill={post.liked_by_viewer ? "currentColor" : "none"} />
          <span className="hidden sm:inline">J'aime</span>
          {post.like_count > 0 && <span>{compactCount(post.like_count)}</span>}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setCommentsExpanded((value) => !value)}
          className="rounded-xl text-muted-foreground"
        >
          <MessageCircle className="h-4 w-4" />
          <span className="hidden sm:inline">Commenter</span>
          {post.comment_count > 0 && <span>{compactCount(post.comment_count)}</span>}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={share}
          className="rounded-xl text-muted-foreground"
        >
          <Share2 className="h-4 w-4" />
          <span className="hidden sm:inline">Partager</span>
        </Button>
      </div>

      {authPrompt && !currentUserId && (
        <div className="flex items-center justify-between gap-3 border-t bg-primary/5 px-4 py-3">
          <p className="text-xs text-muted-foreground">Connecte-toi pour aimer et commenter.</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAuthPrompt(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Plus tard
            </button>
            <Button asChild size="sm" className="rounded-full">
              <a href={`/auth?redirect=${encodeURIComponent(`/post/${post.id}`)}`}>Se connecter</a>
            </Button>
          </div>
        </div>
      )}

      <SocialComments
        postId={post.id}
        currentUserId={currentUserId}
        expanded={commentsExpanded}
        commentsEnabled={post.comments_enabled}
      />
    </article>
  );
}
