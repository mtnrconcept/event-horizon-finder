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
  deleteSocialPost,
  fetchSocialComments,
  fetchSocialFeed,
  fetchSocialPost,
  fetchSocialPostingContext,
  hideSocialAuthor,
  reportSocialPost,
  setSocialFollow,
  setSocialLike,
  setSocialSave,
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
      queryClient.invalidateQueries({ queryKey: ["social-posting-context"] });
    });
    return () => data.subscription.unsubscribe();
  }, [queryClient]);

  return query;
}

export function useSocialFeed(filter: SocialFeedFilter, userId: string | null) {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: ["social-feed", filter, userId ?? "anonymous"],
    queryFn: ({ pageParam }) => fetchSocialFeed({ filter, cursor: pageParam, userId }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const invalidate = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["social-feed"] });
      }, 400);
    };
    const channel = supabase
      .channel(`social-feed-${filter}-${userId ?? "anonymous"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "social_posts" }, invalidate)
      .on("postgres_changes", { event: "*", schema: "public", table: "social_comments" }, invalidate)
      .on("postgres_changes", { event: "*", schema: "public", table: "social_post_likes" }, invalidate)
      .on("postgres_changes", { event: "*", schema: "public", table: "social_post_saves" }, invalidate)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [filter, queryClient, userId]);

  return query;
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
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["social-comments", postId],
    queryFn: () => fetchSocialComments(postId),
    enabled,
    staleTime: 10_000,
  });

  useEffect(() => {
    if (!enabled) return;
    const channel = supabase
      .channel(`social-comments-${postId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "social_comments", filter: `post_id=eq.${postId}` },
        () => queryClient.invalidateQueries({ queryKey: ["social-comments", postId] }),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [enabled, postId, queryClient]);

  return query;
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

function removePostFromCaches(queryClient: ReturnType<typeof useQueryClient>, postId: string) {
  queryClient.setQueriesData<InfiniteData<SocialFeedPage, string | null>>(
    { queryKey: ["social-feed"] },
    (data) => {
      if (!data) return data;
      return {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          posts: page.posts.filter((post) => post.id !== postId),
        })),
      };
    },
  );
  queryClient.removeQueries({ queryKey: ["social-post", postId] });
}

export function useToggleSocialLike() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ postId, currentlyLiked }: { postId: string; currentlyLiked: boolean }) =>
      setSocialLike(postId, !currentlyLiked),
    onMutate: async ({ postId, currentlyLiked }) => {
      await queryClient.cancelQueries({ queryKey: ["social-feed"] });
      patchSocialPostCaches(queryClient, postId, (post) => ({
        ...post,
        liked_by_viewer: !currentlyLiked,
        like_count: Math.max(0, post.like_count + (currentlyLiked ? -1 : 1)),
      }));
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["social-feed"] });
      toast.error("Impossible de mettre à jour ce J'aime");
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: ["social-feed"] });
      queryClient.invalidateQueries({ queryKey: ["social-post", variables.postId] });
    },
  });
}

export function useToggleSocialSave() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ postId, currentlySaved }: { postId: string; currentlySaved: boolean }) =>
      setSocialSave(postId, !currentlySaved),
    onMutate: ({ postId, currentlySaved }) => {
      patchSocialPostCaches(queryClient, postId, (post) => ({
        ...post,
        saved_by_viewer: !currentlySaved,
        save_count: Math.max(0, post.save_count + (currentlySaved ? -1 : 1)),
      }));
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["social-feed"] });
      toast.error("Impossible de mettre à jour les éléments enregistrés");
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: ["social-feed"] });
      queryClient.invalidateQueries({ queryKey: ["social-post", variables.postId] });
    },
  });
}

export function useToggleSocialFollow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (post: SocialPost) => setSocialFollow(post),
    onMutate: (post) => {
      queryClient.setQueriesData<InfiniteData<SocialFeedPage, string | null>>(
        { queryKey: ["social-feed"] },
        (data) => {
          if (!data) return data;
          return {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              posts: page.posts.map((item) => {
                const sameAuthor =
                  (post.author_user_id && item.author_user_id === post.author_user_id) ||
                  (post.organizer_id && item.organizer_id === post.organizer_id);
                return sameAuthor
                  ? { ...item, followed_by_viewer: !post.followed_by_viewer }
                  : item;
              }),
            })),
          };
        },
      );
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["social-feed"] });
      toast.error("L’abonnement n’a pas pu être modifié");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["social-feed"] }),
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
    mutationKey: ["social", "create-post"],
    mutationFn: (input: CreateSocialPostInput) => createSocialPost(input),
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["social-feed"] });
    },
  });
}

export function useReportSocialPost() {
  return useMutation({
    mutationFn: ({ postId, details }: { postId: string; details: string }) =>
      reportSocialPost(postId, details),
  });
}

export function useHideSocialAuthor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (post: SocialPost) => hideSocialAuthor(post),
    onSuccess: (_data, post) => {
      queryClient.setQueriesData<InfiniteData<SocialFeedPage, string | null>>(
        { queryKey: ["social-feed"] },
        (data) => {
          if (!data) return data;
          return {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              posts: page.posts.filter(
                (item) =>
                  !(
                    (post.author_user_id && item.author_user_id === post.author_user_id) ||
                    (post.organizer_id && item.organizer_id === post.organizer_id)
                  ),
              ),
            })),
          };
        },
      );
    },
  });
}

export function useDeleteSocialPost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (post: SocialPost) => deleteSocialPost(post),
    onSuccess: (_data, post) => removePostFromCaches(queryClient, post.id),
  });
}
