import { useState } from "react";
import { MessageCircle, Send } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAddSocialComment, useSocialComments } from "@/hooks/use-social-feed";
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
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(
    new Date(value),
  );
}

export function SocialComments({
  postId,
  currentUserId,
  expanded,
  commentsEnabled,
}: {
  postId: string;
  currentUserId: string | null;
  expanded: boolean;
  commentsEnabled: boolean;
}) {
  const { tr, localeTag } = useTranslation();
  const comments = useSocialComments(postId, expanded);
  const addComment = useAddSocialComment(postId);
  const [body, setBody] = useState("");

  if (!expanded) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!body.trim() || addComment.isPending) return;
    try {
      await addComment.mutateAsync(body);
      setBody("");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : tr("Impossible d'ajouter le commentaire"),
      );
    }
  };

  return (
    <div className="border-t px-4 py-4">
      {!commentsEnabled ? (
        <p className="text-sm text-muted-foreground">{tr("Les commentaires sont fermés.")}</p>
      ) : currentUserId ? (
        <form onSubmit={submit} className="mb-4 flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={1000}
              rows={2}
              placeholder={tr("Ajouter un commentaire…")}
              aria-label={tr("Ajouter un commentaire…")}
              className="min-h-16 resize-none rounded-xl bg-surface/50"
            />
            {body.length > 850 && (
              <p className="mt-1 text-right text-[10px] text-muted-foreground">
                {body.length}/1 000
              </p>
            )}
          </div>
          <Button
            type="submit"
            size="icon"
            disabled={!body.trim() || addComment.isPending}
            aria-label={tr("Publier le commentaire")}
            className="rounded-full"
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>
      ) : (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border bg-primary/5 px-3 py-2.5">
          <p className="text-xs text-muted-foreground">
            {tr("Connecte-toi pour participer à la discussion.")}
          </p>
          <Button asChild size="sm" className="rounded-full">
            <a href={`/auth?redirect=${encodeURIComponent(`/post/${postId}`)}`}>
              {tr("Se connecter")}
            </a>
          </Button>
        </div>
      )}

      {comments.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, index) => (
            <div key={index} className="flex gap-2">
              <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-8 w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : comments.isError ? (
        <button
          type="button"
          onClick={() => comments.refetch()}
          className="text-xs text-destructive underline-offset-4 hover:underline"
        >
          {tr("Impossible de charger les commentaires. Réessayer")}
        </button>
      ) : comments.data?.length ? (
        <ul className="space-y-3">
          {comments.data.map((comment) => (
            <li key={comment.id} className="flex items-start gap-2.5">
              <Avatar className="h-8 w-8 border">
                {comment.author_avatar_url && (
                  <AvatarImage src={comment.author_avatar_url} alt="" className="object-cover" />
                )}
                <AvatarFallback className="text-[10px] font-semibold">
                  {comment.author_display_name.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1 rounded-2xl bg-muted/55 px-3 py-2">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="truncate text-xs font-semibold">{comment.author_display_name}</p>
                  <time className="shrink-0 text-[10px] text-muted-foreground">
                    {relativeDate(comment.created_at, localeTag)}
                  </time>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {comment.body}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <MessageCircle className="h-4 w-4" /> {tr("Sois la première personne à commenter.")}
        </div>
      )}
    </div>
  );
}
