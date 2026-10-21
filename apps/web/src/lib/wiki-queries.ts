import type {
  WikiImportInput,
  WikiImportResult,
  WikiLintResult,
  WikiLogEntry,
  WikiOverview,
  WikiPage,
  WikiPageCreateInput,
  WikiPageHealth,
  WikiPageUpdateInput,
  WikiRelatedPage,
  WikiReviewItem,
  WikiReviewStatus,
  WikiRevision,
  WikiRevisionSummary,
  WikiSearchResult,
  WikiSource,
  WikiSourceDeleteResult,
  WikiSourceUploadResult,
} from "@orlok/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiUpload } from "./api";

export const wikiKeys = {
  all: (officeId: string) => ["wiki", officeId] as const,
  overview: (officeId: string) => ["wiki", officeId, "overview"] as const,
  search: (officeId: string, q: string) => ["wiki", officeId, "search", q] as const,
  log: (officeId: string) => ["wiki", officeId, "log"] as const,
  sources: (officeId: string) => ["wiki", officeId, "sources"] as const,
  page: (officeId: string, slug: string) => ["wiki", officeId, "page", slug] as const,
  revisions: (officeId: string, slug: string) =>
    ["wiki", officeId, "page", slug, "revisions"] as const,
  revision: (officeId: string, slug: string, revision: number) =>
    ["wiki", officeId, "page", slug, "revisions", revision] as const,
};

const base = (officeId: string) => `/offices/${officeId}/wiki`;

export function useWikiOverview(officeId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: wikiKeys.overview(officeId),
    queryFn: () => apiFetch<WikiOverview>(base(officeId)),
  });
}

export function useWikiSearch(officeId: string, q: string) {
  return useQuery({
    queryKey: wikiKeys.search(officeId, q),
    queryFn: () =>
      apiFetch<WikiSearchResult[]>(`${base(officeId)}/search?q=${encodeURIComponent(q)}`),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
  });
}

export function useWikiLog(officeId: string) {
  return useQuery({
    queryKey: wikiKeys.log(officeId),
    queryFn: () => apiFetch<WikiLogEntry[]>(`${base(officeId)}/log`),
  });
}

export function useWikiPage(officeId: string, slug: string | undefined) {
  return useQuery({
    queryKey: wikiKeys.page(officeId, slug ?? ""),
    queryFn: () => apiFetch<WikiPage>(`${base(officeId)}/pages/${slug}`),
    enabled: Boolean(slug),
    retry: false,
  });
}

export function useWikiRevisions(officeId: string, slug: string) {
  return useQuery({
    queryKey: wikiKeys.revisions(officeId, slug),
    queryFn: () => apiFetch<WikiRevisionSummary[]>(`${base(officeId)}/pages/${slug}/revisions`),
  });
}

export function useWikiRevision(officeId: string, slug: string, revision: number | null) {
  return useQuery({
    queryKey: wikiKeys.revision(officeId, slug, revision ?? 0),
    queryFn: () => apiFetch<WikiRevision>(`${base(officeId)}/pages/${slug}/revisions/${revision}`),
    enabled: revision !== null,
  });
}

// Every change can affect lists, backlinks, search and the log: refresh the whole office wiki.
function useInvalidateWiki(officeId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: wikiKeys.all(officeId) });
}

export function useCreateWikiPage(officeId: string) {
  const invalidate = useInvalidateWiki(officeId);
  return useMutation({
    mutationFn: (input: WikiPageCreateInput) =>
      apiFetch<WikiPage>(`${base(officeId)}/pages`, { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

export function useUpdateWikiPage(officeId: string, slug: string) {
  const invalidate = useInvalidateWiki(officeId);
  return useMutation({
    mutationFn: (input: WikiPageUpdateInput) =>
      apiFetch<WikiPage>(`${base(officeId)}/pages/${slug}`, { method: "PATCH", body: input }),
    onSuccess: invalidate,
  });
}

export function useDeleteWikiPage(officeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      apiFetch<void>(`${base(officeId)}/pages/${slug}`, { method: "DELETE" }),
    onSuccess: (_, slug) => {
      queryClient.removeQueries({ queryKey: wikiKeys.page(officeId, slug) });
      return queryClient.invalidateQueries({ queryKey: wikiKeys.all(officeId) });
    },
  });
}

export function useRestoreWikiRevision(officeId: string, slug: string) {
  const invalidate = useInvalidateWiki(officeId);
  return useMutation({
    mutationFn: (revision: number) =>
      apiFetch<WikiPage>(`${base(officeId)}/pages/${slug}/revisions/${revision}/restore`, {
        method: "POST",
      }),
    onSuccess: invalidate,
  });
}

export function useImportWiki(officeId: string) {
  const invalidate = useInvalidateWiki(officeId);
  return useMutation({
    mutationFn: (input: WikiImportInput) =>
      apiFetch<WikiImportResult>(`${base(officeId)}/import`, { method: "POST", body: input }),
    onSuccess: invalidate,
  });
}

// Documents filed by virtual colleagues; polled while some are still waiting or in progress.
export function useWikiSources(officeId: string) {
  return useQuery({
    queryKey: wikiKeys.sources(officeId),
    queryFn: () => apiFetch<WikiSource[]>(`${base(officeId)}/sources`),
    refetchInterval: (query) =>
      query.state.data?.some((item) => item.status === "queued" || item.status === "processing")
        ? 3_000
        : false,
  });
}

export function useUploadWikiSources(officeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (form: FormData) =>
      apiUpload<WikiSourceUploadResult>(`${base(officeId)}/sources`, form),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: wikiKeys.sources(officeId) }),
  });
}

export function useRetryWikiSource(officeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<WikiSource>(`${base(officeId)}/sources/${id}/retry`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: wikiKeys.sources(officeId) }),
  });
}

export function useDeleteWikiSource(officeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // With cascade the pages written only from the document are deleted too.
    mutationFn: ({ id, cascade }: { id: string; cascade: boolean }) =>
      apiFetch<WikiSourceDeleteResult | undefined>(
        `${base(officeId)}/sources/${id}${cascade ? "?cascade=true" : ""}`,
        { method: "DELETE" },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: wikiKeys.all(officeId) }),
  });
}

export function useWikiRelated(officeId: string, slug: string) {
  return useQuery({
    queryKey: [...wikiKeys.page(officeId, slug), "related"],
    queryFn: () => apiFetch<WikiRelatedPage[]>(`${base(officeId)}/pages/${slug}/related`),
  });
}

export function useWikiReview(officeId: string, status: WikiReviewStatus) {
  return useQuery({
    queryKey: ["wiki", officeId, "review", status],
    queryFn: () => apiFetch<WikiReviewItem[]>(`${base(officeId)}/review?status=${status}`),
  });
}

export function useLintWiki(officeId: string) {
  const invalidate = useInvalidateWiki(officeId);
  return useMutation({
    mutationFn: () => apiFetch<WikiLintResult>(`${base(officeId)}/review/lint`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useUpdateReviewItem(officeId: string) {
  const invalidate = useInvalidateWiki(officeId);
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: WikiReviewStatus }) =>
      apiFetch<WikiReviewItem>(`${base(officeId)}/review/${id}`, {
        method: "PATCH",
        body: { status },
      }),
    onSuccess: invalidate,
  });
}

// Applies a colleague's proposed change as its revision (R-MEM-3).
export function useApplyProposal(officeId: string) {
  const invalidate = useInvalidateWiki(officeId);
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`${base(officeId)}/review/${id}/apply`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useSaveWikiPurpose(officeId: string) {
  const invalidate = useInvalidateWiki(officeId);
  return useMutation({
    mutationFn: (purpose: string | null) =>
      apiFetch<{ purpose: string | null }>(`${base(officeId)}/purpose`, {
        method: "PUT",
        body: { purpose },
      }),
    onSuccess: invalidate,
  });
}

export function useSaveWikiSynonyms(officeId: string) {
  const invalidate = useInvalidateWiki(officeId);
  return useMutation({
    mutationFn: (synonyms: string | null) =>
      apiFetch<{ synonyms: string | null }>(`${base(officeId)}/synonyms`, {
        method: "PUT",
        body: { synonyms },
      }),
    onSuccess: invalidate,
  });
}

export function useWikiHealth(officeId: string) {
  return useQuery({
    queryKey: ["wiki", officeId, "health"],
    queryFn: () => apiFetch<WikiPageHealth[]>(`${base(officeId)}/health`),
  });
}

// Starts a round of critical reading by a colleague; findings arrive in the review queue later.
export function useCheckWiki(officeId: string) {
  return useMutation({
    mutationFn: (colleagueId: string) =>
      apiFetch<{ started: boolean }>(`${base(officeId)}/review/check`, {
        method: "POST",
        body: { colleagueId },
      }),
  });
}
