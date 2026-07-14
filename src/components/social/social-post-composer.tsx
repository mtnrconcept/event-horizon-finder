import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CalendarPlus, ImagePlus, Send, X } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useCreateSocialPost, useSocialPostingContext } from "@/hooks/use-social-feed";
import {
  SOCIAL_ALLOWED_MIME_TYPES,
  SOCIAL_MAX_FILE_BYTES,
  SOCIAL_MAX_MEDIA,
  validateSocialFiles,
} from "@/lib/social-queries";

export function SocialPostComposer({ userId }: { userId: string }) {
  const context = useSocialPostingContext(userId);
  const createPost = useCreateSocialPost();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [organizerId, setOrganizerId] = useState("");
  const [body, setBody] = useState("");
  const [eventId, setEventId] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [eventPickerOpen, setEventPickerOpen] = useState(false);

  useEffect(() => {
    if (!organizerId && context.data?.organizers[0]) {
      setOrganizerId(context.data.organizers[0].id);
    }
  }, [context.data?.organizers, organizerId]);

  useEffect(() => {
    setEventId("");
  }, [organizerId]);

  const previews = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files],
  );
  useEffect(
    () => () => previews.forEach((preview) => URL.revokeObjectURL(preview.url)),
    [previews],
  );

  if (context.isLoading) {
    return (
      <div className="glass mb-5 rounded-3xl p-4 sm:p-5">
        <div className="flex gap-3">
          <Skeleton className="h-10 w-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-20 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (context.isError) return null;
  if (!context.data?.organizers.length) {
    return (
      <div className="glass mb-5 rounded-3xl p-5 lg:hidden">
        <p className="font-semibold">Tu organises des événements ?</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Crée ou rejoins une organisation pour publier messages, médias et événements dans le fil.
        </p>
        <Button asChild variant="outline" size="sm" className="mt-3 rounded-full">
          <Link to="/organizer">Ouvrir le portail organisateur</Link>
        </Button>
      </div>
    );
  }

  const organizer =
    context.data.organizers.find((item) => item.id === organizerId) ?? context.data.organizers[0];
  const availableEvents = context.data.events.filter(
    (event) => event.organizer_id === organizer.id,
  );
  const selectedEvent = availableEvents.find((event) => event.id === eventId) ?? null;
  const canSubmit = Boolean(body.trim() || files.length || eventId) && !createPost.isPending;

  const chooseFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    try {
      const next = [...files, ...selected];
      validateSocialFiles(next);
      setFiles(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Média non pris en charge");
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    try {
      await createPost.mutateAsync({
        organizerId: organizer.id,
        body,
        eventId: eventId || null,
        files,
      });
      setBody("");
      setEventId("");
      setFiles([]);
      setEventPickerOpen(false);
      toast.success("Publication en ligne");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Impossible de publier");
    }
  };

  return (
    <form
      onSubmit={submit}
      className="glass mb-5 overflow-hidden rounded-3xl shadow-[var(--shadow-card)]"
    >
      <div className="flex items-start gap-3 p-4 sm:p-5">
        <Avatar className="h-11 w-11 border bg-surface-2">
          {organizer.logo_url && (
            <AvatarImage src={organizer.logo_url} alt="" className="object-cover" />
          )}
          <AvatarFallback className="bg-primary/15 text-xs font-bold text-primary">
            {organizer.name.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Publier en tant que</span>
            {context.data.organizers.length > 1 ? (
              <select
                value={organizer.id}
                onChange={(event) => setOrganizerId(event.target.value)}
                className="rounded-lg border bg-surface px-2 py-1 text-xs font-semibold outline-none focus:border-primary"
                aria-label="Organisation qui publie"
              >
                {context.data.organizers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-xs font-semibold">{organizer.name}</span>
            )}
          </div>
          <Textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={5000}
            rows={3}
            placeholder="Partage une annonce, une nouveauté ou les coulisses de ton événement…"
            className="min-h-24 resize-none border-0 bg-transparent p-0 text-base shadow-none focus-visible:ring-0"
          />
          {body.length > 4400 && (
            <p className="text-right text-[10px] text-muted-foreground">{body.length}/5 000</p>
          )}
        </div>
      </div>

      {previews.length > 0 && (
        <div className="grid grid-cols-2 gap-2 px-4 pb-4 sm:px-5">
          {previews.map(({ file, url }, index) => (
            <div
              key={`${file.name}-${file.lastModified}`}
              className="relative aspect-video overflow-hidden rounded-xl bg-muted"
            >
              {file.type.startsWith("video/") ? (
                <video src={url} muted playsInline className="h-full w-full object-cover" />
              ) : (
                <img src={url} alt="Aperçu du média" className="h-full w-full object-cover" />
              )}
              <button
                type="button"
                onClick={() =>
                  setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))
                }
                aria-label={`Retirer ${file.name}`}
                className="absolute right-2 top-2 rounded-full bg-black/65 p-1.5 text-white hover:bg-black/80"
              >
                <X className="h-3.5 w-3.5" />
              </button>
              <span className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white">
                {(file.size / 1024 / 1024).toFixed(1)} Mio
              </span>
            </div>
          ))}
        </div>
      )}

      {eventPickerOpen && (
        <div className="mx-4 mb-4 rounded-2xl border bg-surface/50 p-3 sm:mx-5">
          <label htmlFor="social-event" className="text-xs font-medium">
            Événement associé
          </label>
          {availableEvents.length ? (
            <select
              id="social-event"
              value={eventId}
              onChange={(event) => setEventId(event.target.value)}
              className="mt-2 w-full rounded-xl border bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
            >
              <option value="">Aucun événement</option>
              {availableEvents.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.title}
                </option>
              ))}
            </select>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              Cette organisation n'a pas encore d'événement publié.
            </p>
          )}
          {selectedEvent && (
            <div className="mt-3 flex items-center gap-3 rounded-xl border p-2">
              {selectedEvent.cover_image_url && (
                <img
                  src={selectedEvent.cover_image_url}
                  alt=""
                  className="h-12 w-12 rounded-lg object-cover"
                />
              )}
              <p className="line-clamp-2 text-xs font-medium">{selectedEvent.title}</p>
            </div>
          )}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={SOCIAL_ALLOWED_MIME_TYPES.join(",")}
        multiple
        className="sr-only"
        onChange={chooseFiles}
      />
      <div className="flex flex-wrap items-center gap-1 border-t px-3 py-2 sm:px-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={files.length >= SOCIAL_MAX_MEDIA || createPost.isPending}
          className="rounded-full text-muted-foreground"
        >
          <ImagePlus className="h-4 w-4" /> Média
          <span className="text-[10px]">
            {files.length}/{SOCIAL_MAX_MEDIA}
          </span>
        </Button>
        <Button
          type="button"
          variant={eventId ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setEventPickerOpen((value) => !value)}
          disabled={createPost.isPending}
          className="rounded-full text-muted-foreground"
        >
          <CalendarPlus className="h-4 w-4" /> Événement
        </Button>
        <span className="ml-1 hidden text-[10px] text-muted-foreground sm:inline">
          Images ou vidéos · {(SOCIAL_MAX_FILE_BYTES / 1024 / 1024).toFixed(0)} Mio max.
        </span>
        <Button type="submit" size="sm" disabled={!canSubmit} className="ml-auto rounded-full px-4">
          <Send className="h-4 w-4" /> {createPost.isPending ? "Publication…" : "Publier"}
        </Button>
      </div>
    </form>
  );
}
