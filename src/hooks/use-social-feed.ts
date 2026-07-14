import { useEffect } from "react";
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  createSocialComment,
  createSocialPost,
  fetchSocialComments,
  fetchSocialFeed,
  fetchSocialPost,
  fetchSocialPostingContext,
  setSocialLike,
  type CreateSocialPostInput,
  type SocialComment,
  type SocialFeedFilter,
  type SocialFeedPage,
  type SocialPost,
} from "@/lib/social-queries";

const currentUserKey = ["social", "current-user"] as const;

export function useCurrentSocialUser() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: currentUserKey,
    queryFn: async (): Promise<User | null> => {
      const { data, error } = await supabase.auth.getUser();
      if (error && error.name !== "AuthSessionMissingError") throw error;
      return data.user ?? null;
    },
    staleTime: 30_000,
  });

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      queryClient.setQueryData(currentUserKey, session?.user ?? null);
      queryClient.invalidateQueries({ queryKey: ["social-feed"] });
    });
    return () => data.subscription.unsubscribe();
  }, [queryClient]);

  return query;
}

export function useSocialFeed(filter: SocialFeedFilter, userId: string | null) {
  return useInfiniteQuery({
    queryKey: ["social-feed", filter, userId ?? "anonymous"],
    queryFn: ({ pageParam }) => fetchSocialFeed({ filter, cursor: pageParam, userId }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 20_000,
    refetchOnWindowFocus: false,
  });
}

export function useSocialPost(
  postId: string,
  userId: string | null,
  placeholderPost?: SocialPost | null,
) {
  return useQuery({
    queryKey: ["social-post", postId, userId ?? "anonymous"],
    queryFn: () => fetchSocialPost(postId, userId),
    placeholderData: placeholderPost ?? undefined,
    staleTime: 15_000,
  });
}

export function useSocialPostingContext(userId: string | null) {
  return useQuery({
    queryKey: ["social-posting-context", userId],
    queryFn: () => fetchSocialPostingContext(userId!),
    enabled: Boolean(userId),
    staleTime: 60_000,
  });
}

export function useSocialComments(postId: string, enabled = true) {
  return useQuery({
    queryKey: ["social-comments", postId],
    queryFn: () => fetchSocialComments(postId),
    enabled,
    staleTime: 10_000,
  });
}

function patchPostInFeed(
  data: InfiniteData<SocialFeedPage, string | null> | undefined,
  postId: string,
  patch: (post: SocialPost) => SocialPost,
) {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      posts: page.posts.map((post) => (post.id === postId ? patch(post) : post)),
    })),
  };
}

function patchSocialPostCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  postId: string,
  patch: (post: SocialPost) => SocialPost,
) {
  queryClient.setQueriesData<InfiniteData<SocialFeedPage, string | null>>(
    { queryKey: ["social-feed"] },
    (data) => patchPostInFeed(data, postId, patch),
  );
  queryClient.setQueriesData<SocialPost | null>({ queryKey: ["social-post", postId] }, (post) =>
    post ? patch(post) : post,
  );
}

export function useToggleSocialLike() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ postId, currentlyLiked }: { postId: string; currentlyLiked: boolean }) =>
      setSocialLike(postId, !currentlyLiked),
    onMutate: async ({ postId, currentlyLiked }) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ["social-feed"] }),
        queryClient.cancelQueries({ queryKey: ["social-post", postId] }),
      ]);
      const feedSnapshots = queryClient.getQueriesData<InfiniteData<SocialFeedPage, string | null>>(
        { queryKey: ["social-feed"] },
      );
      const postSnapshots = queryClient.getQueriesData<SocialPost | null>({
        queryKey: ["social-post", postId],
      });

      patchSocialPostCaches(queryClient, postId, (post) => ({
        ...post,
        liked_by_viewer: !currentlyLiked,
        like_count: Math.max(0, post.like_count + (currentlyLiked ? -1 : 1)),
      }));
      return { feedSnapshots, postSnapshots };
    },
    onError: (_error, _variables, context) => {
      context?.feedSnapshots.forEach(([key, value]) => queryClient.setQueryData(key, value));
      context?.postSnapshots.forEach(([key, value]) => queryClient.setQueryData(key, value));
      toast.error("Impossible de mettre à jour ce J'aime");
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: ["social-feed"] });
      queryClient.invalidateQueries({ queryKey: ["social-post", variables.postId] });
    },
  });
}

export function useAddSocialComment(postId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => createSocialComment(postId, body),
    onSuccess: (comment: SocialComment) => {
      queryClient.setQueryData<SocialComment[]>(["social-comments", postId], (comments) => [
        ...(comments ?? []),
        comment,
      ]);
      patchSocialPostCaches(queryClient, postId, (post) => ({
        ...post,
        comment_count: post.comment_count + 1,
      }));
    },
  });
}

export function useCreateSocialPost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSocialPostInput) => createSocialPost(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["social-feed"] });
    },
  });
}
