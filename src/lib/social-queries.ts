/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export const SOCIAL_MEDIA_BUCKET = "social-media";
export const SOCIAL_PAGE_SIZE = 12;
export const SOCIAL_MAX_MEDIA = 6;
export const SOCIAL_MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const SOCIAL_MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const SOCIAL_MAX_FILE_BYTES = SOCIAL_MAX_VIDEO_BYTES;
export const SOCIAL_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
] as const;

export type SocialFeedFilter = "all" | "following" | "events" | "recent";
export type SocialVisibility = "public" | "followers" | "private";

export type SocialOrganizer = {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
  is_verified: boolean;
  kind: "organizer" | "profile";
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
  user_id: string | null;
  body: string;
  status: string;
  author_display_name: string;
  author_avatar_url: string | null;
  created_at: string;
  updated_at: string;
};

export type SocialPost = {
  id: string;
  organizer_id: string | null;
  author_user_id: string | null;
  created_by: string | null;
  event_id: string | null;
  body: string | null;
  status: "draft" | "published" | "hidden";
  visibility: SocialVisibility;
  location_name: string | null;
  mood: string | null;
  tags: string[];
  comments_enabled: boolean;
  allow_sharing: boolean;
  like_count: number;
  comment_count: number;
  share_count: number;
  save_count: number;
  liked_by_viewer: boolean;
  saved_by_viewer: boolean;
  followed_by_viewer: boolean;
  published_at: string;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
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

export type PersonalPostingOption = {
  id: string;
  name: string;
  avatar_url: string | null;
};

export type SocialPostingContext = {
  personal: PersonalPostingOption;
  organizers: OrganizerPostingOption[];
  events: SocialEvent[];
};

export type CreateSocialPostInput = {
  organizerId: string | null;
  body: string;
  eventId: string | null;
  files: File[];
  visibility: SocialVisibility;
  locationName: string | null;
  commentsEnabled: boolean;
  clientRequestId: string;
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

type ViewerState = {
  likes: Set<string>;
  saves: Set<string>;
  followedUsers: Set<string>;
  followedOrganizers: Set<string>;
};

// The social migration and generated Database type can land independently. Keep
// this boundary untyped while exposing a typed API to the rest of the app.
const socialDb = supabase as unknown as SupabaseClient<any>;

const POST_SELECT = `
  id,
  organizer_id,
  author_user_id,
  created_by,
  author_display_name,
  author_avatar_url,
  event_id,
  body,
  status,
  visibility,
  location_name,
  mood,
  tags,
  comments_enabled,
  allow_sharing,
  like_count,
  comment_count,
  share_count,
  save_count,
  published_at,
  created_at,
  updated_at,
  edited_at,
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
    .filter((occurrence) => occurrence.starts_at)
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

function normalizeAuthor(raw: any): SocialOrganizer {
  const organizer = firstRelation<any>(raw.organizer);
  if (organizer?.id && organizer?.name) {
    return {
      id: String(organizer.id),
      slug: String(organizer.slug ?? organizer.id),
      name: String(organizer.name),
      logo_url: organizer.logo_url ? String(organizer.logo_url) : null,
      is_verified: Boolean(organizer.is_verified),
      kind: "organizer",
    };
  }
  const userId = String(raw.author_user_id ?? raw.created_by ?? "community");
  return {
    id: userId,
    slug: userId,
    name: String(raw.author_display_name || "Membre Global Party"),
    logo_url: raw.author_avatar_url ? String(raw.author_avatar_url) : null,
    is_verified: false,
    kind: "profile",
  };
}

function normalizePost(raw: any, viewer: ViewerState): SocialPost {
  const author = normalizeAuthor(raw);
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
  const postId = String(raw.id);
  const authorUserId = raw.author_user_id ? String(raw.author_user_id) : null;
  const organizerId = raw.organizer_id ? String(raw.organizer_id) : null;

  return {
    id: postId,
    organizer_id: organizerId,
    author_user_id: authorUserId,
    created_by: raw.created_by ? String(raw.created_by) : null,
    event_id: raw.event_id ? String(raw.event_id) : null,
    body: raw.body ? String(raw.body) : null,
    status: raw.status as SocialPost["status"],
    visibility: ["followers", "private"].includes(raw.visibility) ? raw.visibility : "public",
    location_name: raw.location_name ? String(raw.location_name) : null,
    mood: raw.mood ? String(raw.mood) : null,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 20) : [],
    comments_enabled: raw.comments_enabled !== false,
    allow_sharing: raw.allow_sharing !== false,
    like_count: Number(raw.like_count ?? 0),
    comment_count: Number(raw.comment_count ?? 0),
    share_count: Number(raw.share_count ?? 0),
    save_count: Number(raw.save_count ?? 0),
    liked_by_viewer: viewer.likes.has(postId),
    saved_by_viewer: viewer.saves.has(postId),
    followed_by_viewer:
      (authorUserId ? viewer.followedUsers.has(authorUserId) : false) ||
      (organizerId ? viewer.followedOrganizers.has(organizerId) : false),
    published_at: String(raw.published_at ?? raw.created_at),
    created_at: String(raw.created_at),
    updated_at: String(raw.updated_at),
    edited_at: raw.edited_at ? String(raw.edited_at) : null,
    organizer: author,
    media,
    event: normalizeEvent(raw.event),
  };
}

async function fetchViewerState(postIds: string[], userId: string | null): Promise<ViewerState> {
  if (!userId) {
    return {
      likes: new Set(),
      saves: new Set(),
      followedUsers: new Set(),
      followedOrganizers: new Set(),
    };
  }
  const [likesResult, savesResult, usersResult, organizersResult] = await Promise.all([
    postIds.length
      ? socialDb.from("social_post_likes").select("post_id").eq("user_id", userId).in("post_id", postIds)
      : Promise.resolve({ data: [], error: null }),
    postIds.length
      ? socialDb.from("social_post_saves").select("post_id").eq("user_id", userId).in("post_id", postIds)
      : Promise.resolve({ data: [], error: null }),
    socialDb
      .from("social_user_follows")
      .select("followed_id")
      .eq("follower_id", userId)
      .eq("status", "accepted"),
    socialDb.from("followed_organizers").select("organizer_id").eq("user_id", userId),
  ]);
  for (const result of [likesResult, savesResult, usersResult, organizersResult]) {
    if (result.error) throw result.error;
  }
  return {
    likes: new Set((likesResult.data ?? []).map((row: any) => String(row.post_id))),
    saves: new Set((savesResult.data ?? []).map((row: any) => String(row.post_id))),
    followedUsers: new Set((usersResult.data ?? []).map((row: any) => String(row.followed_id))),
    followedOrganizers: new Set(
      (organizersResult.data ?? []).map((row: any) => String(row.organizer_id)),
    ),
  };
}

async function fetchFollowingTargets(userId: string) {
  const [usersResult, organizersResult] = await Promise.all([
    socialDb
      .from("social_user_follows")
      .select("followed_id")
      .eq("follower_id", userId)
      .eq("status", "accepted"),
    socialDb.from("followed_organizers").select("organizer_id").eq("user_id", userId),
  ]);
  if (usersResult.error) throw usersResult.error;
  if (organizersResult.error) throw organizersResult.error;
  return {
    userIds: (usersResult.data ?? []).map((row: any) => String(row.followed_id)),
    organizerIds: (organizersResult.data ?? []).map((row: any) => String(row.organizer_id)),
  };
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
    .lte("published_at", new Date().toISOString())
    .order("published_at", { ascending: false })
    .limit(SOCIAL_PAGE_SIZE + 1);

  if (args.cursor) query = query.lt("published_at", args.cursor);
  if (args.filter === "events") query = query.not("event_id", "is", null);
  if (args.filter === "following") {
    if (!args.userId) return { posts: [], nextCursor: null };
    const targets = await fetchFollowingTargets(args.userId);
    const clauses: string[] = [];
    if (targets.userIds.length) clauses.push(`author_user_id.in.(${targets.userIds.join(",")})`);
    if (targets.organizerIds.length) {
      clauses.push(`organizer_id.in.(${targets.organizerIds.join(",")})`);
    }
    clauses.push(`author_user_id.eq.${args.userId}`);
    query = query.or(clauses.join(","));
  }

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []) as any[];
  const hasMore = rows.length > SOCIAL_PAGE_SIZE;
  const visibleRows = rows.slice(0, SOCIAL_PAGE_SIZE);
  const viewer = await fetchViewerState(
    visibleRows.map((row) => String(row.id)),
    args.userId,
  );
  const posts = visibleRows.map((row) => normalizePost(row, viewer));

  return {
    posts,
    nextCursor: hasMore ? (posts.at(-1)?.published_at ?? null) : null,
  };
}

export async function fetchSocialPost(
  postId: string,
  userId: string | null,
): Promise<SocialPost | null> {
  const safePostId = validateUuid(postId, "Publication invalide");
  const { data, error } = await socialDb
    .from("social_posts")
    .select(POST_SELECT)
    .eq("id", safePostId)
    .eq("status", "published")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const viewer = await fetchViewerState([safePostId], userId);
  return normalizePost(data, viewer);
}

export async function fetchSocialComments(postId: string): Promise<SocialComment[]> {
  const safePostId = validateUuid(postId, "Publication invalide");
  const { data, error } = await socialDb
    .from("social_comments")
    .select("id,post_id,user_id,body,status,author_display_name,author_avatar_url,created_at,updated_at")
    .eq("post_id", safePostId)
    .eq("status", "published")
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: String(row.id),
    post_id: String(row.post_id),
    user_id: row.user_id ? String(row.user_id) : null,
    body: String(row.body),
    status: String(row.status),
    author_display_name: String(row.author_display_name || "Membre Global Party"),
    author_avatar_url: row.author_avatar_url ? String(row.author_avatar_url) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }));
}

export async function fetchSocialPostingContext(userId: string): Promise<SocialPostingContext> {
  const safeUserId = validateUuid(userId, "Utilisateur invalide");
  const [{ data: profileRow, error: profileError }, { data: membershipRows, error: membershipError }] =
    await Promise.all([
      socialDb.from("profiles").select("id,display_name,avatar_url").eq("id", safeUserId).single(),
      socialDb
        .from("organizer_members")
        .select("organizer_id,role,organizer:organizers(id,slug,name,logo_url,is_verified)")
        .eq("user_id", safeUserId)
        .in("role", ["owner", "admin", "editor"]),
    ]);
  if (profileError) throw profileError;
  if (membershipError) throw membershipError;

  const organizers: OrganizerPostingOption[] = (membershipRows ?? []).flatMap((row: any) => {
    const organizer = firstRelation<any>(row.organizer);
    if (!organizer || !["owner", "admin", "editor"].includes(row.role)) return [];
    return [
      {
        id: String(organizer.id),
        slug: String(organizer.slug),
        name: String(organizer.name),
        logo_url: organizer.logo_url ? String(organizer.logo_url) : null,
        is_verified: Boolean(organizer.is_verified),
        kind: "organizer" as const,
        role: row.role as OrganizerPostingOption["role"],
      },
    ];
  });

  let events: SocialEvent[] = [];
  if (organizers.length) {
    const { data: eventRows, error: eventError } = await socialDb
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
    events = (eventRows ?? []).flatMap((event: any) => {
      const normalized = normalizeEvent(event as RawEvent);
      return normalized ? [normalized] : [];
    });
  }

  return {
    personal: {
      id: safeUserId,
      name: String(profileRow.display_name || "Mon profil"),
      avatar_url: profileRow.avatar_url ? String(profileRow.avatar_url) : null,
    },
    organizers,
    events,
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
    const limit = file.type.startsWith("video/")
      ? SOCIAL_MAX_VIDEO_BYTES
      : SOCIAL_MAX_IMAGE_BYTES;
    if (file.size > limit) {
      throw new Error(
        `${file.name} dépasse la limite de ${Math.round(limit / 1024 / 1024)} Mio.`,
      );
    }
  }
}

export async function createSocialPost(input: CreateSocialPostInput): Promise<string> {
  const body = input.body.trim().slice(0, 5_000);
  validateSocialFiles(input.files);
  if (!body && !input.eventId && input.files.length === 0) {
    throw new Error("Ajoute un message, un média ou un événement.");
  }
  if (!["public", "followers", "private"].includes(input.visibility)) {
    throw new Error("Audience de publication invalide.");
  }
  validateUuid(input.clientRequestId, "Identifiant de requête invalide");

  const { data: authData, error: authError } = await socialDb.auth.getUser();
  if (authError || !authData.user) throw new Error("Connecte-toi pour publier.");

  const postId = crypto.randomUUID();
  const ownerId = input.organizerId ?? authData.user.id;
  const uploadedPaths: string[] = [];
  let postCreated = false;

  try {
    const { error: postError } = await socialDb.from("social_posts").insert({
      id: postId,
      organizer_id: input.organizerId,
      author_user_id: input.organizerId ? null : authData.user.id,
      created_by: authData.user.id,
      event_id: input.eventId,
      body: body || null,
      status: "draft",
      visibility: input.organizerId ? "public" : input.visibility,
      location_name: input.locationName?.trim().slice(0, 160) || null,
      tags: extractHashtags(body),
      comments_enabled: input.commentsEnabled,
      allow_sharing: input.visibility !== "private",
      client_request_id: input.clientRequestId,
    });
    if (postError) {
      if (postError.code === "23505") {
        const { data: existing } = await socialDb
          .from("social_posts")
          .select("id")
          .eq("author_user_id", authData.user.id)
          .eq("client_request_id", input.clientRequestId)
          .maybeSingle();
        if (existing?.id) return String(existing.id);
      }
      throw postError;
    }
    postCreated = true;

    const mediaRows: Array<Record<string, unknown>> = [];
    for (const [index, file] of input.files.entries()) {
      const storagePath = `${ownerId}/${postId}/${crypto.randomUUID()}.${extensionFor(file)}`;
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
        alt_text: file.type.startsWith("image/") ? "Image jointe à la publication" : null,
        sort_order: index,
      });
    }

    if (mediaRows.length) {
      const { error: mediaError } = await socialDb.from("social_post_media").insert(mediaRows);
      if (mediaError) throw mediaError;
    }

    const { error: publishError } = await socialDb
      .from("social_posts")
      .update({ status: "published", published_at: new Date().toISOString() })
      .eq("id", postId)
      .select("id")
      .single();
    if (publishError) throw publishError;
    return postId;
  } catch (error) {
    if (uploadedPaths.length) {
      await socialDb.storage.from(SOCIAL_MEDIA_BUCKET).remove(uploadedPaths);
    }
    if (postCreated) await socialDb.from("social_posts").delete().eq("id", postId);
    throw error;
  }
}

export async function setSocialLike(postId: string, liked: boolean): Promise<void> {
  const safePostId = validateUuid(postId, "Publication invalide");
  const { data, error: authError } = await socialDb.auth.getUser();
  if (authError || !data.user) throw new Error("Connecte-toi pour aimer une publication.");
  if (liked) {
    const { error } = await socialDb
      .from("social_post_likes")
      .insert({ post_id: safePostId, user_id: data.user.id });
    if (error && error.code !== "23505") throw error;
    return;
  }
  const { error } = await socialDb
    .from("social_post_likes")
    .delete()
    .eq("post_id", safePostId)
    .eq("user_id", data.user.id);
  if (error) throw error;
}

export async function setSocialSave(postId: string, saved: boolean): Promise<void> {
  const safePostId = validateUuid(postId, "Publication invalide");
  const { data, error: authError } = await socialDb.auth.getUser();
  if (authError || !data.user) throw new Error("Connecte-toi pour enregistrer une publication.");
  if (saved) {
    const { error } = await socialDb
      .from("social_post_saves")
      .insert({ post_id: safePostId, user_id: data.user.id });
    if (error && error.code !== "23505") throw error;
    return;
  }
  const { error } = await socialDb
    .from("social_post_saves")
    .delete()
    .eq("post_id", safePostId)
    .eq("user_id", data.user.id);
  if (error) throw error;
}

export async function setSocialFollow(
  author: Pick<SocialPost, "organizer_id" | "author_user_id" | "followed_by_viewer">,
): Promise<void> {
  const { data, error: authError } = await socialDb.auth.getUser();
  if (authError || !data.user) throw new Error("Connecte-toi pour gérer tes abonnements.");
  const next = !author.followed_by_viewer;
  if (author.organizer_id) {
    if (next) {
      const { error } = await socialDb
        .from("followed_organizers")
        .insert({ user_id: data.user.id, organizer_id: author.organizer_id });
      if (error && error.code !== "23505") throw error;
    } else {
      const { error } = await socialDb
        .from("followed_organizers")
        .delete()
        .eq("user_id", data.user.id)
        .eq("organizer_id", author.organizer_id);
      if (error) throw error;
    }
    return;
  }
  if (!author.author_user_id) throw new Error("Auteur indisponible.");
  const { error } = await socialDb.rpc("set_social_follow", {
    _followed_id: author.author_user_id,
    _active: next,
  });
  if (error) throw error;
}

export async function reportSocialPost(postId: string, details: string): Promise<void> {
  const safePostId = validateUuid(postId, "Publication invalide");
  const cleanDetails = details.trim().slice(0, 1_500);
  const { data, error: authError } = await socialDb.auth.getUser();
  if (authError || !data.user) throw new Error("Connecte-toi pour signaler un contenu.");
  const { error } = await socialDb.from("social_content_reports").insert({
    reporter_id: data.user.id,
    subject_type: "post",
    subject_id: safePostId,
    reason: "other",
    details: cleanDetails || null,
  });
  if (error && error.code !== "23505") throw error;
}

export async function hideSocialAuthor(post: SocialPost): Promise<void> {
  const { data, error: authError } = await socialDb.auth.getUser();
  if (authError || !data.user) throw new Error("Connecte-toi pour masquer un compte.");
  const { error } = await socialDb.from("social_user_mutes").insert({
    user_id: data.user.id,
    muted_user_id: post.author_user_id,
    muted_organizer_id: post.organizer_id,
  });
  if (error && error.code !== "23505") throw error;
}

export async function deleteSocialPost(post: SocialPost): Promise<void> {
  const safePostId = validateUuid(post.id, "Publication invalide");
  const { error } = await socialDb.from("social_posts").delete().eq("id", safePostId);
  if (error) throw error;
  const paths = post.media.map((item) => item.storage_path);
  if (paths.length) await socialDb.storage.from(SOCIAL_MEDIA_BUCKET).remove(paths);
}

export async function createSocialComment(
  postId: string,
  bodyValue: string,
): Promise<SocialComment> {
  const safePostId = validateUuid(postId, "Publication invalide");
  const body = bodyValue.trim();
  if (!body) throw new Error("Écris un commentaire avant de l'envoyer.");
  if (body.length > 1_000) throw new Error("Le commentaire est limité à 1 000 caractères.");

  const { data: authData, error: authError } = await socialDb.auth.getUser();
  if (authError || !authData.user) throw new Error("Connecte-toi pour commenter.");

  const { data, error } = await socialDb
    .from("social_comments")
    .insert({ post_id: safePostId, user_id: authData.user.id, body })
    .select("id,post_id,user_id,body,status,author_display_name,author_avatar_url,created_at,updated_at")
    .single();
  if (error) throw error;
  return {
    id: String(data.id),
    post_id: String(data.post_id),
    user_id: data.user_id ? String(data.user_id) : null,
    body: String(data.body),
    status: String(data.status),
    author_display_name: String(data.author_display_name || "Membre Global Party"),
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
  const title = `${post.organizer.name} sur Global Party`;
  const text = post.body?.slice(0, 180) || "Découvre cette publication sur Global Party.";
  let result: "shared" | "copied" | "cancelled" = "cancelled";
  let channel = "copy";

  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      result = "shared";
      channel = "native";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    }
  }
  if (result !== "shared") {
    await navigator.clipboard.writeText(url);
    result = "copied";
  }

  const { data } = await socialDb.auth.getUser();
  if (data.user) {
    await socialDb.from("social_share_events").insert({
      user_id: data.user.id,
      entity_type: "post",
      entity_id: post.id,
      channel,
      client_request_id: crypto.randomUUID(),
    });
  }
  return result;
}

function extractHashtags(text: string) {
  const tags = new Set<string>();
  for (const match of text.matchAll(/#([\p{L}\p{N}_-]{2,40})/gu)) {
    tags.add(match[1].toLocaleLowerCase());
    if (tags.size >= 20) break;
  }
  return [...tags];
}

function validateUuid(value: string, message: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(message);
  }
  return value;
}
