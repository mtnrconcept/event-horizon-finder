import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  BadgeCheck,
  Bookmark,
  EyeOff,
  Flag,
  Globe2,
  Heart,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Share2,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { SocialComments } from "@/components/social/social-comments";
import { SocialEventAttachment } from "@/components/social/social-event-attachment";
import { SocialMediaGrid } from "@/components/social/social-media-grid";
import {
  useDeleteSocialPost,
  useHideSocialAuthor,
  useReportSocialPost,
  useToggleSocialFollow,
  useToggleSocialLike,
  useToggleSocialSave,
} from "@/hooks/use-social-feed";
import { shareSocialPost, type SocialPost } from "@/lib/social-queries";
import { useTranslation } from "@/lib/i18n";

function relativeDate(value: string, locale: string) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 8) return formatter.format(days, "day");
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  }).format(new Date(value));
}

function compactCount(value: number, locale: string) {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(
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
  const { tr, localeTag } = useTranslation();
  const toggleLike = useToggleSocialLike();
  const toggleSave = useToggleSocialSave();
  const toggleFollow = useToggleSocialFollow();
  const reportPost = useReportSocialPost();
  const hideAuthor = useHideSocialAuthor();
  const deletePost = useDeleteSocialPost();
  const [commentsExpanded, setCommentsExpanded] = useState(standalone);
  const [authPrompt, setAuthPrompt] = useState(false);
  const [bodyExpanded, setBodyExpanded] = useState(standalone);
  const [menuOpen, setMenuOpen] = useState(false);
  const isOwn = Boolean(
    currentUserId && (post.author_user_id === currentUserId || post.created_by === currentUserId),
  );

  const requireAuth = () => {
    if (currentUserId) return true;
    setAuthPrompt(true);
    return false;
  };

  const like = () => {
    if (!requireAuth()) return;
    toggleLike.mutate({ postId: post.id, currentlyLiked: post.liked_by_viewer });
  };

  const save = () => {
    if (!requireAuth()) return;
    toggleSave.mutate({ postId: post.id, currentlySaved: post.saved_by_viewer });
  };

  const follow = () => {
    if (!requireAuth() || isOwn) return;
    toggleFollow.mutate(post, {
      onSuccess: () =>
        toast.success(
          post.followed_by_viewer ? tr("Abonnement retiré") : tr("Abonnement mis à jour"),
        ),
    });
  };

  const share = async () => {
    if (!post.allow_sharing) return;
    try {
      const result = await shareSocialPost(post);
      if (result === "copied") toast.success(tr("Lien copié"));
    } catch {
      toast.error(tr("Impossible de partager cette publication"));
    }
  };

  const report = () => {
    if (!requireAuth()) return;
    const details = window.prompt(
      tr("Décris brièvement le problème. Le signalement restera confidentiel."),
    );
    if (details === null) return;
    reportPost.mutate(
      { postId: post.id, details },
      {
        onSuccess: () => toast.success(tr("Signalement transmis à la modération")),
        onError: () => toast.error(tr("Le signalement n’a pas pu être envoyé")),
      },
    );
    setMenuOpen(false);
  };

  const mute = () => {
    if (!requireAuth()) return;
    if (!window.confirm(tr(`Masquer les publications de ${post.organizer.name} ?`))) return;
    hideAuthor.mutate(post, {
      onSuccess: () => toast.success(tr("Compte masqué de ton fil")),
      onError: () => toast.error(tr("Le compte n’a pas pu être masqué")),
    });
    setMenuOpen(false);
  };

  const remove = () => {
    if (!isOwn || !window.confirm(tr("Supprimer définitivement cette publication ?"))) return;
    deletePost.mutate(post, {
      onSuccess: () => toast.success(tr("Publication supprimée")),
      onError: () => toast.error(tr("La publication n’a pas pu être supprimée")),
    });
    setMenuOpen(false);
  };

  const showMore = Boolean(post.body && post.body.length > 480 && !bodyExpanded);
  const isBusy =
    toggleLike.isPending ||
    toggleSave.isPending ||
    toggleFollow.isPending ||
    reportPost.isPending ||
    hideAuthor.isPending ||
    deletePost.isPending;

  return (
    <article className="glass overflow-visible rounded-3xl shadow-[var(--shadow-card)]">
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
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="truncate text-sm font-semibold sm:text-base">{post.organizer.name}</p>
            {post.organizer.is_verified && (
              <BadgeCheck
                className="h-4 w-4 shrink-0 text-primary"
                aria-label={tr("Compte vérifié")}
              />
            )}
            {!isOwn && currentUserId && (
              <button
                type="button"
                onClick={follow}
                disabled={toggleFollow.isPending}
                className={`ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${post.followed_by_viewer ? "bg-accent text-foreground" : "bg-primary/10 text-primary"}`}
              >
                {post.followed_by_viewer ? (
                  <UserCheck className="h-3 w-3" />
                ) : (
                  <UserPlus className="h-3 w-3" />
                )}
                {post.followed_by_viewer ? tr("Suivi") : tr("Suivre")}
              </button>
            )}
            {post.visibility !== "public" && (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10px] text-muted-foreground">
                {post.visibility === "followers" ? (
                  <Users className="h-3 w-3" />
                ) : (
                  <EyeOff className="h-3 w-3" />
                )}
                {post.visibility === "followers" ? tr("Abonnés") : tr("Privé")}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            {standalone ? (
              <time>{relativeDate(post.published_at, localeTag)}</time>
            ) : (
              <Link
                to="/post/$id"
                params={{ id: post.id }}
                className="hover:text-foreground hover:underline"
              >
                {relativeDate(post.published_at, localeTag)}
              </Link>
            )}
            {post.edited_at && <span>· {tr("modifié")}</span>}
            {post.location_name && (
              <span className="inline-flex items-center gap-1">
                · <MapPin className="h-3 w-3" /> {post.location_name}
              </span>
            )}
          </div>
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((value) => !value)}
            disabled={isBusy}
            aria-label={tr("Options de publication")}
            className="grid h-10 w-10 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <MoreHorizontal className="h-5 w-5" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-11 z-30 w-56 rounded-2xl border bg-background p-1.5 shadow-2xl">
              {!isOwn && (
                <MenuAction icon={EyeOff} onClick={mute}>
                  {tr("Masquer ce compte")}
                </MenuAction>
              )}
              {!isOwn && (
                <MenuAction icon={Flag} onClick={report}>
                  {tr("Signaler la publication")}
                </MenuAction>
              )}
              {isOwn && (
                <MenuAction icon={Trash2} danger onClick={remove}>
                  {tr("Supprimer")}
                </MenuAction>
              )}
            </div>
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
              {tr("Voir plus")}
            </button>
          )}
          {!!post.tags.length && (
            <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1 text-sm font-semibold text-primary">
              {post.tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </div>
          )}
        </div>
      )}

      <SocialMediaGrid media={post.media} />
      {post.event && (
        <div className={post.media.length ? "pt-4" : ""}>
          <SocialEventAttachment event={post.event} />
        </div>
      )}

      <div className="grid grid-cols-4 border-t px-2 py-1.5 sm:px-3">
        <ActionButton
          active={post.liked_by_viewer}
          disabled={toggleLike.isPending}
          onClick={like}
          icon={<Heart className="h-4 w-4" fill={post.liked_by_viewer ? "currentColor" : "none"} />}
          label={tr("J’aime")}
          count={post.like_count}
          locale={localeTag}
        />
        <ActionButton
          active={commentsExpanded}
          onClick={() => setCommentsExpanded((value) => !value)}
          icon={<MessageCircle className="h-4 w-4" />}
          label={tr("Commenter")}
          count={post.comment_count}
          locale={localeTag}
        />
        <ActionButton
          disabled={!post.allow_sharing}
          onClick={() => void share()}
          icon={<Share2 className="h-4 w-4" />}
          label={tr("Partager")}
          count={post.share_count}
          locale={localeTag}
        />
        <ActionButton
          active={post.saved_by_viewer}
          disabled={toggleSave.isPending}
          onClick={save}
          icon={
            <Bookmark className="h-4 w-4" fill={post.saved_by_viewer ? "currentColor" : "none"} />
          }
          label={tr("Enregistrer")}
          count={post.save_count}
          locale={localeTag}
        />
      </div>

      {authPrompt && !currentUserId && (
        <div className="flex items-center justify-between gap-3 border-t bg-primary/5 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {tr("Connecte-toi pour participer à la communauté.")}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAuthPrompt(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {tr("Plus tard")}
            </button>
            <Button asChild size="sm" className="rounded-full">
              <a href={`/auth?redirect=${encodeURIComponent(`/post/${post.id}`)}`}>
                {tr("Se connecter")}
              </a>
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

function ActionButton({
  active = false,
  disabled = false,
  onClick,
  icon,
  label,
  count,
  locale,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
  locale: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={label}
      className={`min-w-0 rounded-xl px-1 sm:px-3 ${active ? "text-primary" : "text-muted-foreground"}`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="hidden lg:inline">{label}</span>
      {count > 0 && <span className="text-xs">{compactCount(count, locale)}</span>}
    </Button>
  );
}

function MenuAction({
  icon: Icon,
  danger = false,
  onClick,
  children,
}: {
  icon: typeof Flag;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-accent ${danger ? "text-destructive" : ""}`}
    >
      <Icon className="h-4 w-4" />
      {children}
    </button>
  );
}
