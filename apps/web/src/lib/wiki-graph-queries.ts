import type { WikiGraph } from "@orlok/shared";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./api";
import { wikiKeys } from "./wiki-queries";

// Knowledge graph of the office wiki (R-MEM-9). Under the wiki key, so every wiki change refreshes it.
export const wikiGraphKey = (officeId: string) => [...wikiKeys.all(officeId), "graph"] as const;

export function useWikiGraph(officeId: string) {
  return useQuery({
    queryKey: wikiGraphKey(officeId),
    queryFn: () => apiFetch<WikiGraph>(`/offices/${officeId}/wiki/graph`),
  });
}
