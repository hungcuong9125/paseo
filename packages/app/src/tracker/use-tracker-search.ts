import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  searchTrackerPage,
  type AggregatedTracker,
  type TrackerPageInfo,
  type TrackerProjectInput,
  type TrackersRuntime,
} from "@/tracker/aggregated-trackers";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

export interface UseTrackerSearchOptions {
  projects: readonly TrackerProjectInput[];
  selectedProjectId: string | null;
  /** Already gated (3-char minimum) and debounced by the caller — this hook
   * does not fork that logic, it just stays idle while the query is empty. */
  query: string;
  enabled: boolean;
  pageSize: number;
}

export interface UseTrackerSearchResult {
  results: AggregatedTracker[];
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}

interface ProjectCursorState {
  cursor: string | null;
  hasMore: boolean;
}

function sortMerged(trackers: AggregatedTracker[]): void {
  trackers.sort((a, b) => a.projectId.localeCompare(b.projectId) || a.id.localeCompare(b.id));
}

function projectKeyOf(project: TrackerProjectInput): string {
  return `${project.serverId}:${project.projectId}`;
}

function findProjectByKey(
  projects: readonly TrackerProjectInput[],
  key: string,
): TrackerProjectInput | undefined {
  return projects.find((candidate) => projectKeyOf(candidate) === key);
}

/**
 * Search-mode pagination for the List view. Fans `searchTrackerPage` out to the
 * selected project(s) in parallel and merges into ONE flat result list — not
 * bucketed by status; a single `loadMore()` advances every project's search
 * cursor by one page. Search is always a real server-side query, so items on
 * not-yet-loaded browse pages stay findable.
 */
export function useTrackerSearch(options: UseTrackerSearchOptions): UseTrackerSearchResult {
  const runtime: TrackersRuntime = getHostRuntimeStore();

  const relevantProjects = useMemo(
    () =>
      options.selectedProjectId
        ? options.projects.filter((project) => project.projectId === options.selectedProjectId)
        : options.projects,
    [options.projects, options.selectedProjectId],
  );

  const scopeKey = useMemo(
    () =>
      [
        options.enabled ? "1" : "0",
        options.query,
        options.pageSize,
        ...relevantProjects.map((p) => `${p.serverId}:${p.projectId}`).sort(),
      ].join("|"),
    [options.enabled, options.query, options.pageSize, relevantProjects],
  );

  const [results, setResults] = useState<AggregatedTracker[]>([]);
  const [cursors, setCursors] = useState<Record<string, ProjectCursorState>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadSeqRef = useRef(0);

  const runSearch = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    if (!options.enabled || options.query.length === 0 || relevantProjects.length === 0) {
      setResults([]);
      setCursors({});
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const merged: AggregatedTracker[] = [];
    const nextCursors: Record<string, ProjectCursorState> = {};
    await Promise.all(
      relevantProjects.map(async (project) => {
        try {
          const page = await searchTrackerPage({
            project,
            runtime,
            query: options.query,
            limit: options.pageSize,
          });
          if (seq !== loadSeqRef.current) {
            return;
          }
          merged.push(...page.trackers);
          nextCursors[projectKeyOf(project)] = {
            cursor: page.pageInfo.nextCursor,
            hasMore: page.pageInfo.hasMore,
          };
        } catch {
          // Silently skip, same tolerance as fetchTrackerReadyIds — that
          // project just contributes no results instead of failing the search.
        }
      }),
    );
    if (seq !== loadSeqRef.current) {
      return;
    }
    sortMerged(merged);
    setResults(merged);
    setCursors(nextCursors);
    setIsLoading(false);
    // scopeKey covers every option this closure reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, runtime]);

  useEffect(() => {
    void runSearch();
  }, [runSearch]);

  const hasMore = useMemo(
    () => Object.values(cursors).some((cursorState) => cursorState.hasMore),
    [cursors],
  );

  const loadMore = useCallback(() => {
    if (isLoadingMore || !hasMore) {
      return;
    }
    const pending = Object.entries(cursors).filter(
      ([, cursorState]) => cursorState.hasMore && cursorState.cursor !== null,
    );
    if (pending.length === 0) {
      return;
    }
    setIsLoadingMore(true);
    void (async () => {
      const seq = loadSeqRef.current;
      const fetched: Array<{
        trackers: AggregatedTracker[];
        pageInfo: TrackerPageInfo;
        key: string;
      }> = [];
      await Promise.all(
        pending.map(async ([key, cursorState]) => {
          const project = findProjectByKey(relevantProjects, key);
          if (!project) {
            return;
          }
          try {
            const page = await searchTrackerPage({
              project,
              runtime,
              query: options.query,
              limit: options.pageSize,
              cursor: cursorState.cursor ?? undefined,
            });
            fetched.push({ trackers: page.trackers, pageInfo: page.pageInfo, key });
          } catch {
            // Same silent per-project tolerance as the initial search.
            // Stop retrying this project's cursor on subsequent "Load more"
            // presses, while allowing the other projects' pages to merge.
            fetched.push({
              trackers: [],
              pageInfo: { nextCursor: null, hasMore: false },
              key,
            });
          }
        }),
      );
      if (seq !== loadSeqRef.current) {
        return;
      }
      setResults((current) => {
        const merged = [...current];
        for (const page of fetched) {
          merged.push(...page.trackers);
        }
        sortMerged(merged);
        return merged;
      });
      setCursors((current) => {
        const next = { ...current };
        for (const page of fetched) {
          next[page.key] = {
            cursor: page.pageInfo.nextCursor,
            hasMore: page.pageInfo.hasMore,
          };
        }
        return next;
      });
      setIsLoadingMore(false);
    })();
  }, [cursors, isLoadingMore, hasMore, relevantProjects, runtime, options.query, options.pageSize]);

  return { results, hasMore, isLoading, isLoadingMore, loadMore };
}
