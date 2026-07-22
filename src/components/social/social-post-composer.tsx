import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarPlus,
  ChevronDown,
  Globe2,
  ImagePlus,
  MapPin,
  Send,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EventArtworkImage } from "@/components/event-artwork-image";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useCreateSocialPost, useSocialPostingContext } from "@/hooks/use-social-feed";
import {
  SOCIAL_ALLOWED_MIME_TYPES,
  SOCIAL_MAX_FILE_BYTES,
  SOCIAL_MAX_MEDIA,
  type SocialVisibility,
  validateSocialFiles,
} from "@/lib/social-queries";
import { useTranslation } from "@/lib/i18n";
import { improveSocialDraft } from "@/lib/feed-intelligence";
import {
  applyTranslationToEventRecord,
  useEventContentTranslations,
} from "@/lib/event-content-translations";

export function SocialPostComposer({ userId }: { userId: string }) {
  const { tr, locale } = useTranslation();
  const context = useSocialPostingContext(userId);
  const createPost = useCreateSocialPost();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [authorKey, setAuthorKey] = useState("personal");
  const [body, setBody] = useState("");
  const [eventId, setEventId] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [eventPickerOpen, setEventPickerOpen] = useState(false);
  const [visibility, setVisibility] = useState<SocialVisibility>("public");
  const [locationName, setLocationName] = useState("");
  const [commentsEnabled, setCommentsEnabled] = useState(true);
  const [clientRequestId, setClientRequestId] = useState(() => crypto.randomUUID());
  const eventTranslations = useEventContentTranslations(
    context.data?.events.map((event) => event.id) ?? [],
    locale,
    "summary",
  );

  const previews = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files],
  );
  useEffect(
    () => () => previews.forEach((preview) => URL.revokeObjectURL(preview.url)),
    [previews],
  );

  useEffect(() => {
    setEventId("");
    if (authorKey !== "personal") setVisibility("public");
  }, [authorKey]);

  if (context.isLoading) {
    return (
      <div className="glass mb-5 rounded-3xl p-4 sm:p-5">
        <div className="flex gap-3">
          <Skeleton className="h-11 w-11 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-20 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (context.isError || !context.data) return null;

  const organizer = context.data.organizers.find((item) => item.id === authorKey) ?? null;
  const author = organizer
    ? { name: organizer.name, avatar_url: organizer.logo_url }
    : context.data.personal;
  const availableEvents = organizer
    ? context.data.events
        .filter((event) => event.organizer_id === organizer.id)
        .map((event) => applyTranslationToEventRecord(event, eventTranslations.get(event.id)))
    : [];
  const selectedEvent = availableEvents.find((event) => event.id === eventId) ?? null;
  const canSubmit = Boolean(body.trim() || files.length || eventId) && !createPost.isPending;

  const improveDraft = () => {
    setBody(improveSocialDraft(body, selectedEvent?.title));
    setExpanded(true);
    toast.success(tr("Proposition IA ajoutée — tu gardes le contrôle"));
  };

  const chooseFiles = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    try {
      const next = [...files, ...selected];
      validateSocialFiles(next);
      setFiles(next);
      setExpanded(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr("Média non pris en charge"));
    }
  };

  const reset = () => {
    setBody("");
    setEventId("");
    setFiles([]);
    setLocationName("");
    setEventPickerOpen(false);
    setVisibility("public");
    setCommentsEnabled(true);
    setClientRequestId(crypto.randomUUID());
    setExpanded(false);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    try {
      await createPost.mutateAsync({
        organizerId: organizer?.id ?? null,
        body,
        eventId: eventId || null,
        files,
        visibility,
        locationName: locationName.trim() || null,
        commentsEnabled,
        clientRequestId,
      });
      reset();
      toast.success(tr("Publication en ligne"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr("Impossible de publier"));
    }
  };

  return (
    <form
      onSubmit={submit}
      className="glass mb-5 overflow-hidden rounded-3xl shadow-[var(--shadow-card)]"
    >
      <div className="flex items-start gap-3 p-4 sm:p-5">
        <Avatar className="h-11 w-11 border bg-surface-2">
          {author.avatar_url && (
            <AvatarImage src={author.avatar_url} alt="" className="object-cover" />
          )}
          <AvatarFallback className="bg-primary/15 text-xs font-bold text-primary">
            {author.name.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">{tr("Publier en tant que")}</span>
            <label className="relative">
              <select
                value={authorKey}
                onChange={(event) => setAuthorKey(event.target.value)}
                className="appearance-none rounded-lg border bg-surface py-1 pl-2 pr-7 text-xs font-semibold outline-none focus:border-primary"
                aria-label={tr("Identité qui publie")}
              >
                <option value="personal">{context.data.personal.name}</option>
                {context.data.organizers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
            </label>
            {authorKey === "personal" && (
              <label className="relative ml-auto">
                <select
                  value={visibility}
                  onChange={(event) => setVisibility(event.target.value as SocialVisibility)}
                  className="appearance-none rounded-full border bg-surface py-1 pl-7 pr-7 text-[11px] font-semibold outline-none focus:border-primary"
                  aria-label={tr("Audience")}
                >
                  <option value="public">{tr("Public")}</option>
                  <option value="followers">{tr("Abonnés")}</option>
                  <option value="private">{tr("Privé")}</option>
                </select>
                {visibility === "public" ? (
                  <Globe2 className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
                ) : (
                  <Users className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
                )}
                <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
              </label>
            )}
          </div>
          <Textarea
            value={body}
            onFocus={() => setExpanded(true)}
            onChange={(event) => setBody(event.target.value)}
            maxLength={5000}
            rows={expanded ? 4 : 2}
            placeholder={tr(
              "Partage une découverte, une ambiance ou les coulisses d’un événement…",
            )}
            className="min-h-20 resize-none border-0 bg-transparent p-0 text-base shadow-none focus-visible:ring-0"
          />
          {body.length > 4400 && (
            <p className="text-right text-[10px] text-muted-foreground">{body.length}/5 000</p>
          )}
        </div>
      </div>

      {previews.length > 0 && (
        <div className="grid grid-cols-2 gap-2 px-4 pb-4 sm:grid-cols-3 sm:px-5">
          {previews.map(({ file, url }, index) => (
            <div
              key={`${file.name}-${file.lastModified}`}
              className="relative aspect-square overflow-hidden rounded-xl bg-muted"
            >
              {file.type.startsWith("video/") ? (
                <video src={url} muted playsInline className="h-full w-full object-cover" />
              ) : (
                <img src={url} alt={tr("Aperçu du média")} className="h-full w-full object-cover" />
              )}
              <button
                type="button"
                onClick={() =>
                  setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))
                }
                aria-label={`${tr("Retirer")} ${file.name}`}
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

      {eventPickerOpen && organizer && (
        <div className="mx-4 mb-4 rounded-2xl border bg-surface/50 p-3 sm:mx-5">
          <label htmlFor="social-event" className="text-xs font-medium">
            {tr("Événement associé")}
          </label>
          {availableEvents.length ? (
            <select
              id="social-event"
              value={eventId}
              onChange={(event) => setEventId(event.target.value)}
              className="mt-2 w-full rounded-xl border bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
            >
              <option value="">{tr("Aucun événement")}</option>
              {availableEvents.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.title}
                </option>
              ))}
            </select>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              {tr("Cette organisation n’a pas encore d’événement publié.")}
            </p>
          )}
          {selectedEvent && (
            <div className="mt-3 flex items-center gap-3 rounded-xl border p-2">
              <EventArtworkImage
                eventId={selectedEvent.id}
                sourceUrl={selectedEvent.cover_image_url}
                alt=""
                className="h-12 w-12 rounded-lg object-cover"
              />
              <p className="line-clamp-2 text-xs font-medium">{selectedEvent.title}</p>
            </div>
          )}
        </div>
      )}

      {expanded && (
        <div className="mx-4 mb-4 grid gap-3 rounded-2xl border bg-accent/20 p-3 sm:mx-5 sm:grid-cols-[1fr_auto]">
          <label className="relative flex min-h-10 items-center">
            <MapPin className="pointer-events-none absolute left-3 h-4 w-4 text-muted-foreground" />
            <input
              value={locationName}
              onChange={(event) => setLocationName(event.target.value.slice(0, 160))}
              placeholder={tr("Ajouter un lieu")}
              className="field-control h-full w-full pl-9"
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border bg-background px-3 py-2 text-xs font-semibold">
            {tr("Commentaires")}
            <input
              type="checkbox"
              checked={commentsEnabled}
              onChange={(event) => setCommentsEnabled(event.target.checked)}
              className="h-4 w-4 accent-[var(--color-primary)]"
            />
          </label>
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
          onClick={improveDraft}
          disabled={createPost.isPending}
          className="rounded-full bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary"
        >
          <Sparkles className="h-4 w-4" /> {tr("Améliorer avec l’IA")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={files.length >= SOCIAL_MAX_MEDIA || createPost.isPending}
          className="rounded-full text-muted-foreground"
        >
          <ImagePlus className="h-4 w-4" /> {tr("Média")}{" "}
          <span className="text-[10px]">
            {files.length}/{SOCIAL_MAX_MEDIA}
          </span>
        </Button>
        {organizer && (
          <Button
            type="button"
            variant={eventId ? "secondary" : "ghost"}
            size="sm"
            onClick={() => {
              setEventPickerOpen((value) => !value);
              setExpanded(true);
            }}
            disabled={createPost.isPending}
            className="rounded-full text-muted-foreground"
          >
            <CalendarPlus className="h-4 w-4" /> {tr("Événement")}
          </Button>
        )}
        <span className="ml-1 hidden text-[10px] text-muted-foreground lg:inline">
          {tr("Images 12 Mio · vidéos {size} Mio max.", {
            size: (SOCIAL_MAX_FILE_BYTES / 1024 / 1024).toFixed(0),
          })}
        </span>
        <Button type="submit" size="sm" disabled={!canSubmit} className="ml-auto rounded-full px-4">
          <Send className="h-4 w-4" /> {createPost.isPending ? tr("Publication…") : tr("Publier")}
        </Button>
      </div>
    </form>
  );
}
