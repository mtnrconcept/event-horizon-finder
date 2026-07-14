/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export const SOCIAL_MEDIA_BUCKET = "social-media";
export const SOCIAL_PAGE_SIZE = 12;
export const SOCIAL_MAX_MEDIA = 4;
export const SOCIAL_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const SOCIAL_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
] as const;

export type SocialFeedFilter = "all" | "events";

export type SocialOrganizer = {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
  is_verified: boolean;
};

export type SocialMedia = {
  id: string;
  storage_path: string;
  public_url: string;
  kind: "image" | "video";
  mime_type: string;
  alt_text: string | null;
  sort_order: number;
};

export type SocialEvent = {
  id: string;
  organizer_id: string | null;
  slug: string;
  title: string;
  short_description: string | null;
  cover_image_url: string | null;
  is_free: boolean;
  starts_at: string | null;
  timezone: string;
  venue_name: string | null;
  city_name: string | null;
};

export type SocialComment = {
  id: string;
  post_id: string;
  body: string;
  status: string;
  author_display_name: string;
  author_avatar_url: string | null;
  created_at: string;
  updated_at: string;
};

export type SocialPost = {
  id: string;
  organizer_id: string;
  event_id: string | null;
  body: string | null;
  status: "draft" | "published" | "hidden";
  comments_enabled: boolean;
  like_count: number;
  comment_count: number;
  liked_by_viewer: boolean;
  published_at: string;
  created_at: string;
  updated_at: string;
  organizer: SocialOrganizer;
  media: SocialMedia[];
  event: SocialEvent | null;
};

export type SocialFeedPage = {
  posts: SocialPost[];
  nextCursor: string | null;
};

export type OrganizerPostingOption = SocialOrganizer & {
  role: "owner" | "admin" | "editor";
};

export type SocialPostingContext = {
  organizers: OrganizerPostingOption[];
  events: SocialEvent[];
};

export type CreateSocialPostInput = {
  organizerId: string;
  body: string;
  eventId: string | null;
  files: File[];
};

type RawOccurrence = {
  starts_at?: string | null;
  timezone?: string | null;
};

type RawEvent = {
  id?: string;
  organizer_id?: string | null;
  slug?: string;
  title?: string;
  short_description?: string | null;
  cover_image_url?: string | null;
  is_free?: boolean;
  occurrences?: RawOccurrence[] | RawOccurrence | null;
  venue?: {
    name?: string | null;
    city?: { name?: string | null } | { name?: string | null }[] | null;
  } | null;
};

// The social migration and generated Database type can land independently. Keep
// the boundary untyped while exposing a fully typed API to the rest of the app.
const socialDb = supabase as unknown as SupabaseClient<any>;

const POST_SELECT = `
  id,
  organizer_id,
  event_id,
  body,
  status,
  comments_enabled,
  like_count,
  comment_count,
  published_at,
  created_at,
  updated_at,
  organizer:organizers(id,slug,name,logo_url,is_verified),
  media:social_post_media(id,post_id,storage_path,kind,mime_type,alt_text,sort_order,created_at),
  event:events(
    id,
    organizer_id,
    slug,
    title,
    short_description,
    cover_image_url,
    is_free,
    occurrences:event_occurrences(starts_at,timezone),
    venue:venues(name,city:cities(name))
  )
`;

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function publicMediaUrl(storagePath: string): string {
  return socialDb.storage.from(SOCIAL_MEDIA_BUCKET).getPublicUrl(storagePath).data.publicUrl;
}

function normalizeEvent(raw: RawEvent | RawEvent[] | null | undefined): SocialEvent | null {
  const event = firstRelation(raw);
  if (!event?.id || !event.slug || !event.title) return null;
  const occurrences = Array.isArray(event.occurrences)
    ? event.occurrences
    : event.occurrences
      ? [event.occurrences]
      : [];
  const firstOccurrence = [...occurrences]
    .filter((occ) => occ.starts_at)
    .sort((a, b) => (a.starts_at ?? "").localeCompare(b.starts_at ?? ""))[0];
  const venue = firstRelation(event.venue);
  const city = firstRelation(venue?.city);

  return {
    id: event.id,
    organizer_id: event.organizer_id ?? null,
    slug: event.slug,
    title: event.title,
    short_description: event.short_description ?? null,
    cover_image_url: event.cover_image_url ?? null,
    is_free: event.is_free ?? false,
    starts_at: firstOccurrence?.starts_at ?? null,
    timezone: firstOccurrence?.timezone ?? "Europe/Zurich",
    venue_name: venue?.name ?? null,
    city_name: city?.name ?? null,
  };
}

function normalizePost(raw: any, likedPostIds: Set<string>): SocialPost {
  const organizer = firstRelation<SocialOrganizer>(raw.organizer);
  if (!organizer) throw new Error("Publication sans organisateur");

  const media: SocialMedia[] = (Array.isArray(raw.media) ? raw.media : [])
    .map((item: any) => ({
      id: String(item.id),
      storage_path: String(item.storage_path),
      public_url: publicMediaUrl(String(item.storage_path)),
      kind: item.kind === "video" ? "video" : "image",
      mime_type: String(item.mime_type ?? "application/octet-stream"),
      alt_text: item.alt_text ? String(item.alt_text) : null,
      sort_order: Number(item.sort_order ?? 0),
    }))
    .sort((a: SocialMedia, b: SocialMedia) => a.sort_order - b.sort_order)
    .slice(0, SOCIAL_MAX_MEDIA);

  return {
    id: String(raw.id),
    organizer_id: String(raw.organizer_id),
    event_id: raw.event_id ? String(raw.event_id) : null,
    body: raw.body ? String(raw.body) : null,
    status: raw.status as SocialPost["status"],
    comments_enabled: raw.comments_enabled !== false,
    like_count: Number(raw.like_count ?? 0),
    comment_count: Number(raw.comment_count ?? 0),
    liked_by_viewer: likedPostIds.has(String(raw.id)),
    published_at: String(raw.published_at ?? raw.created_at),
    created_at: String(raw.created_at),
    updated_at: String(raw.updated_at),
    organizer,
    media,
    event: normalizeEvent(raw.event),
  };
}

async function fetchViewerLikes(postIds: string[], userId: string | null): Promise<Set<string>> {
  if (!userId || postIds.length === 0) return new Set();
  const { data, error } = await socialDb
    .from("social_post_likes")
    .select("post_id")
    .eq("user_id", userId)
    .in("post_id", postIds);
  if (error) throw error;
  return new Set((data ?? []).map((row: any) => String(row.post_id)));
}

export async function fetchSocialFeed(args: {
  filter: SocialFeedFilter;
  cursor: string | null;
  userId: string | null;
}): Promise<SocialFeedPage> {
  let query = socialDb
    .from("social_posts")
    .select(POST_SELECT)
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(SOCIAL_PAGE_SIZE + 1);

  if (args.cursor) query = query.lt("published_at", args.cursor);
  if (args.filter === "events") query = query.not("event_id", "is", null);

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []) as any[];
  const hasMore = rows.length > SOCIAL_PAGE_SIZE;
  const visibleRows = rows.slice(0, SOCIAL_PAGE_SIZE);
  const likedPostIds = await fetchViewerLikes(
    visibleRows.map((row) => String(row.id)),
    args.userId,
  );
  const posts = visibleRows.map((row) => normalizePost(row, likedPostIds));

  return {
    posts,
    nextCursor: hasMore ? (posts.at(-1)?.published_at ?? null) : null,
  };
}

export async function fetchSocialPost(
  postId: string,
  userId: string | null,
): Promise<SocialPost | null> {
  const { data, error } = await socialDb
    .from("social_posts")
    .select(POST_SELECT)
    .eq("id", postId)
    .eq("status", "published")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const likes = await fetchViewerLikes([postId], userId);
  return normalizePost(data, likes);
}

export async function fetchSocialComments(postId: string): Promise<SocialComment[]> {
  const { data, error } = await socialDb
    .from("social_comments")
    .select("id,post_id,body,status,author_display_name,author_avatar_url,created_at,updated_at")
    .eq("post_id", postId)
    .eq("status", "published")
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: String(row.id),
    post_id: String(row.post_id),
    body: String(row.body),
    status: String(row.status),
    author_display_name: String(row.author_display_name || "Membre EVENTA"),
    author_avatar_url: row.author_avatar_url ? String(row.author_avatar_url) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }));
}

export async function fetchSocialPostingContext(userId: string): Promise<SocialPostingContext> {
  const { data: membershipRows, error: membershipError } = await supabase
    .from("organizer_members")
    .select("organizer_id,role,organizer:organizers(id,slug,name,logo_url,is_verified)")
    .eq("user_id", userId)
    .in("role", ["owner", "admin", "editor"]);
  if (membershipError) throw membershipError;

  const organizers: OrganizerPostingOption[] = (membershipRows ?? []).flatMap((row) => {
    const organizer = firstRelation(row.organizer);
    if (!organizer || !["owner", "admin", "editor"].includes(row.role)) return [];
    return [
      {
        id: organizer.id,
        slug: organizer.slug,
        name: organizer.name,
        logo_url: organizer.logo_url,
        is_verified: organizer.is_verified,
        role: row.role as OrganizerPostingOption["role"],
      },
    ];
  });

  if (organizers.length === 0) return { organizers: [], events: [] };
  const { data: eventRows, error: eventError } = await supabase
    .from("events")
    .select(
      "id,organizer_id,slug,title,short_description,cover_image_url,is_free,occurrences:event_occurrences(starts_at,timezone),venue:venues(name,city:cities(name))",
    )
    .in(
      "organizer_id",
      organizers.map((organizer) => organizer.id),
    )
    .eq("status", "published")
    .order("updated_at", { ascending: false })
    .limit(100);
  if (eventError) throw eventError;

  return {
    organizers,
    events: (eventRows ?? []).flatMap((event) => {
      const normalized = normalizeEvent(event as unknown as RawEvent);
      return normalized ? [normalized] : [];
    }),
  };
}

function extensionFor(file: File): string {
  const known: Record<(typeof SOCIAL_ALLOWED_MIME_TYPES)[number], string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  };
  return known[file.type as (typeof SOCIAL_ALLOWED_MIME_TYPES)[number]];
}

export function validateSocialFiles(files: File[]): void {
  if (files.length > SOCIAL_MAX_MEDIA) {
    throw new Error(`Tu peux ajouter au maximum ${SOCIAL_MAX_MEDIA} médias.`);
  }
  for (const file of files) {
    if (!(SOCIAL_ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
      throw new Error(
        `${file.name} n'est pas pris en charge. Formats acceptés : JPEG, PNG, WebP, GIF, MP4, WebM et MOV.`,
      );
    }
    if (file.size > SOCIAL_MAX_FILE_BYTES) {
      throw new Error(`${file.name} dépasse la limite de 50 Mio.`);
    }
  }
}

export async function createSocialPost(input: CreateSocialPostInput): Promise<string> {
  const body = input.body.trim();
  validateSocialFiles(input.files);
  if (!body && !input.eventId && input.files.length === 0) {
    throw new Error("Ajoute un message, un média ou un événement.");
  }

  const { data: authData, error: authError } = await socialDb.auth.getUser();
  if (authError || !authData.user) throw new Error("Connecte-toi pour publier.");

  const postId = crypto.randomUUID();
  const uploadedPaths: string[] = [];
  let postCreated = false;

  try {
    const { error: postError } = await socialDb.from("social_posts").insert({
      id: postId,
      organizer_id: input.organizerId,
      created_by: authData.user.id,
      event_id: input.eventId,
      body: body || null,
      status: "draft",
      comments_enabled: true,
    });
    if (postError) throw postError;
    postCreated = true;

    const mediaRows: Array<Record<string, unknown>> = [];
    for (const [index, file] of input.files.entries()) {
      const storagePath = `${input.organizerId}/${postId}/${crypto.randomUUID()}.${extensionFor(file)}`;
      const { error: uploadError } = await socialDb.storage
        .from(SOCIAL_MEDIA_BUCKET)
        .upload(storagePath, file, {
          cacheControl: "31536000",
          contentType: file.type,
          upsert: false,
        });
      if (uploadError) throw uploadError;
      uploadedPaths.push(storagePath);
      mediaRows.push({
        post_id: postId,
        storage_path: storagePath,
        kind: file.type.startsWith("video/") ? "video" : "image",
        mime_type: file.type,
        alt_text: null,
        sort_order: index,
      });
    }

    if (mediaRows.length > 0) {
      const { error: mediaError } = await socialDb.from("social_post_media").insert(mediaRows);
      if (mediaError) throw mediaError;
    }

    const { error: publishError } = await socialDb
      .from("social_posts")
      .update({ status: "published" })
      .eq("id", postId)
      .select("id")
      .single();
    if (publishError) throw publishError;
    return postId;
  } catch (error) {
    if (uploadedPaths.length > 0) {
      await socialDb.storage.from(SOCIAL_MEDIA_BUCKET).remove(uploadedPaths);
    }
    if (postCreated) await socialDb.from("social_posts").delete().eq("id", postId);
    throw error;
  }
}

export async function setSocialLike(postId: string, liked: boolean): Promise<void> {
  const { data, error: authError } = await socialDb.auth.getUser();
  if (authError || !data.user) throw new Error("Connecte-toi pour aimer une publication.");

  if (liked) {
    const { error } = await socialDb
      .from("social_post_likes")
      .insert({ post_id: postId, user_id: data.user.id });
    if (error && error.code !== "23505") throw error;
    return;
  }

  const { error } = await socialDb
    .from("social_post_likes")
    .delete()
    .eq("post_id", postId)
    .eq("user_id", data.user.id);
  if (error) throw error;
}

export async function createSocialComment(
  postId: string,
  bodyValue: string,
): Promise<SocialComment> {
  const body = bodyValue.trim();
  if (!body) throw new Error("Écris un commentaire avant de l'envoyer.");
  if (body.length > 1000) throw new Error("Le commentaire est limité à 1 000 caractères.");

  const { data: authData, error: authError } = await socialDb.auth.getUser();
  if (authError || !authData.user) throw new Error("Connecte-toi pour commenter.");

  const { data, error } = await socialDb
    .from("social_comments")
    .insert({
      post_id: postId,
      user_id: authData.user.id,
      body,
    })
    .select("id,post_id,body,status,author_display_name,author_avatar_url,created_at,updated_at")
    .single();
  if (error) throw error;
  return {
    id: String(data.id),
    post_id: String(data.post_id),
    body: String(data.body),
    status: String(data.status),
    author_display_name: String(data.author_display_name || "Membre EVENTA"),
    author_avatar_url: data.author_avatar_url ? String(data.author_avatar_url) : null,
    created_at: String(data.created_at),
    updated_at: String(data.updated_at),
  };
}

export async function shareSocialPost(
  post: Pick<SocialPost, "id" | "body" | "organizer">,
): Promise<"shared" | "copied" | "cancelled"> {
  if (typeof window === "undefined") return "cancelled";
  const url = `${window.location.origin}/post/${post.id}`;
  const title = `${post.organizer.name} sur EVENTA`;
  const text = post.body?.slice(0, 180) || "Découvre cette publication sur EVENTA.";

  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    }
  }

  await navigator.clipboard.writeText(url);
  return "copied";
}
