import type { SocialPost } from "@/lib/social-queries";

export type FeedIntent = "all" | "tonight" | "free" | "nearby" | "popular";

const FREE_PATTERN = /\b(gratuit|gratuite|free|entrée libre|senza costo|gratis|bezpłatn)\b/i;
const TONIGHT_PATTERN = /\b(ce soir|tonight|stasera|esta noche|сегодня вечером|dziś wieczorem)\b/i;

function searchableText(post: SocialPost): string {
  return [
    post.body,
    post.location_name,
    post.event?.title,
    post.event?.short_description,
    ...post.tags,
  ]
    .filter(Boolean)
    .join(" ");
}

export function feedRelevanceScore(post: SocialPost, intent: FeedIntent, now = new Date()): number {
  const ageHours = Math.max(0, (now.getTime() - new Date(post.published_at).getTime()) / 3_600_000);
  const freshness = Math.max(0, 36 - ageHours) / 6;
  const engagement = Math.log2(
    1 + post.like_count * 2 + post.comment_count * 3 + post.save_count * 2,
  );
  const text = searchableText(post);
  let intentBoost = 0;

  if (intent === "free" && (post.event?.is_free || FREE_PATTERN.test(text))) intentBoost = 14;
  if (intent === "nearby" && (post.location_name || post.event?.city_name)) intentBoost = 10;
  if (intent === "popular") intentBoost = engagement * 2;
  if (intent === "tonight") {
    const startsAt = post.event?.starts_at ? new Date(post.event.starts_at) : null;
    const sameDay = startsAt && startsAt.toDateString() === now.toDateString();
    if (sameDay || TONIGHT_PATTERN.test(text)) intentBoost = 14;
  }

  return (
    freshness +
    engagement +
    intentBoost +
    (post.event ? 2 : 0) +
    (post.organizer.is_verified ? 1 : 0)
  );
}

export function rankFeedPosts(
  posts: SocialPost[],
  intent: FeedIntent,
  now = new Date(),
): SocialPost[] {
  if (intent === "all") return posts;
  return [...posts].sort(
    (left, right) => feedRelevanceScore(right, intent, now) - feedRelevanceScore(left, intent, now),
  );
}

export function buildFeedBriefing(posts: SocialPost[]) {
  const places = new Map<string, number>();
  const topics = new Map<string, number>();
  let freeCount = 0;
  let conversationCount = 0;

  for (const post of posts) {
    if (post.event?.is_free || FREE_PATTERN.test(searchableText(post))) freeCount += 1;
    conversationCount += post.comment_count;
    const place = post.event?.city_name || post.location_name;
    if (place) places.set(place, (places.get(place) ?? 0) + 1);
    for (const tag of post.tags) topics.set(tag, (topics.get(tag) ?? 0) + 1);
  }

  const best = (values: Map<string, number>) =>
    [...values.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

  return {
    postCount: posts.length,
    freeCount,
    conversationCount,
    topPlace: best(places),
    topTopic: best(topics),
  };
}

export function improveSocialDraft(body: string, eventTitle?: string | null): string {
  const clean = body.trim().replace(/\s+/g, " ");
  if (!clean) {
    return eventTitle
      ? `Qui vient à ${eventTitle} ? ✨ Dites-moi ce que vous avez le plus hâte de découvrir !`
      : "Quel est votre meilleur plan du moment ? Partagez le lieu, l’ambiance et votre conseil à la communauté ✨";
  }
  const punctuated = /[.!?…]$/.test(clean) ? clean : `${clean}.`;
  const hasQuestion = punctuated.includes("?");
  return `${punctuated}${hasQuestion ? "" : " Vous en pensez quoi ?"}`;
}
