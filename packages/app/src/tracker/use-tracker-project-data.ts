import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TrackerPriority, TrackerStatus, TrackerType } from "@getpaseo/protocol/tracker/types";
import {
  fetchTrackerPage,
  toTrackerProjectError,
  type AggregatedTracker,
  type TrackerProjectError,
  type TrackerProjectInput,
  type TrackersRuntime,
} from "@/tracker/aggregated-trackers";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

// Same four sections, same order, as TrackerTable's LIST_SECTIONS and
// tracker-board-model.ts's buildTrackerBoard — kept as a plain status tuple
// here because the hook must not import from a component.
const LIST_SECTION_STATUSES = ["open", "in_progress", "closed", "cancelled"] as const;

interface CursorState {
  cursor: string | null;
  hasMore: boolean;
  /** From the page's `pageInfo.totalCount`. `null` when this project's page
   * didn't report one (old CLI binary, or the fetch failed) — poisons the
   * section's summed total, matching `sectionTotals`' contract. */
  totalCount: number | null;
}

const ERRORED_CURSOR: CursorState = { cursor: null, hasMore: false, totalCount: null };

interface SectionPageState {
  trackers: AggregatedTracker[];
  // One cursor per project: each project pages independently.
  cursors: Record<string, CursorState>;
}

type SectionsState = Record<TrackerStatus, SectionPageState>;

function createEmptySections(): SectionsState {
  return {
    open: { trackers: [], cursors: {} },
    in_progress: { trackers: [], cursors: {} },
    closed: { trackers: [], cursors: {} },
    cancelled: { trackers: [], cursors: {} },
  };
}

function sortMerged(trackers: AggregatedTracker[]): void {
  trackers.sort((a, b) => a.projectId.localeCompare(b.projectId) || a.id.localeCompare(b.id));
}

function projectKeyOf(project: TrackerProjectInput): string {
  return `${project.serverId}:${project.projectId}`;
}

function hasErrorForProject(errors: TrackerProjectError[], project: TrackerProjectInput): boolean {
  return errors.some((e) => e.serverId === project.serverId && e.projectId === project.projectId);
}

function findTrackerStatus(sections: SectionsState, id: string): TrackerStatus | null {
  for (const status of LIST_SECTION_STATUSES) {
    if (sections[status].trackers.some((tracker) => tracker.id === id)) {
      return status;
    }
  }
  return null;
}

function createEmptyStatusRecord<T>(value: T): Record<TrackerStatus, T> {
  return {
    open: value,
    in_progress: value,
    closed: value,
    cancelled: value,
  };
}

// Adjusts one project's cursor.totalCount by `delta` — used by patchTracker
// and removeTrackers to keep the authoritative sectionTotals in sync with a
// local mutation instead of waiting for the next refetch. A cursor that
// doesn't exist yet, or already reports `totalCount: null`, is left alone:
// there is nothing to adjust, and a null total must stay null.
function adjustProjectTotal(
  cursors: Record<string, CursorState>,
  projectKey: string,
  delta: number,
): Record<string, CursorState> {
  const cursorState = cursors[projectKey];
  if (!cursorState || cursorState.totalCount === null) {
    return cursors;
  }
  return {
    ...cursors,
    [projectKey]: { ...cursorState, totalCount: cursorState.totalCount + delta },
  };
}

export interface UseTrackerProjectDataOptions {
  projects: readonly TrackerProjectInput[];
  selectedProjectId: string | null;
  all: boolean;
  enabled: boolean;
  pageSize: number;
  /** Applies to both views — narrows the fetched rows and `sectionTotals`
   * together, so a filtered page never renders under a header counting the
   * unfiltered set. */
  type?: TrackerType;
  /** List only — Kanban's stat filter projects lanes, it does not filter the
   * fetched dataset. */
  priority?: TrackerPriority;
}

export interface UseTrackerProjectDataResult {
  /** Only the pages actually loaded, already narrowed by `options.type` /
   * `options.priority` — feeds both TrackerTable (bucketed by status) and
   * TrackerKanbanBoard (partitioned by buildTrackerBoard) from the exact
   * same data. */
  trackers: AggregatedTracker[];
  /** Summed `pageInfo.totalCount` across the in-scope projects, per status.
   * `null` when any in-scope project did not report one (old CLI binary, an
   * offline host, or a fetch error) — the screen falls back to
   * loaded-so-far counts (`trackers.length`) in that case. */
  sectionTotals: Record<TrackerStatus, number | null>;
  /** True while any in-scope project still has more pages for that status. */
  sectionHasMore: Record<TrackerStatus, boolean>;
  /** True while a `loadMore` fetch is in flight for that status. */
  sectionLoadingMore: Record<TrackerStatus, boolean>;
  /** Fetches exactly one more page per in-scope project for that status —
   * no automatic follow-up, the caller decides when to page again. */
  loadMore: (status: TrackerStatus) => void;
  /** True only until the first page of every section/project has landed. */
  isLoading: boolean;
  projectErrors: TrackerProjectError[];
  /** Replaces the tracker by id wherever it currently lives (any section, any
   * project), re-filing it into the section matching `updated.status` — or
   * inserts it if not found (covers a newly created tracker). Used to apply
   * the result of the user's own mutations without a re-fetch. */
  patchTracker: (updated: AggregatedTracker) => void;
  /** Removes trackers by id from wherever they live, across every section. */
  removeTrackers: (ids: string[]) => void;
  /** Restarts pagination from scratch for the current scope. */
  refetch: () => void;
}

/**
 * The single shared data source for both the List and Kanban tracker views.
 * Per relevant project x per status section, loads exactly the first page of
 * `project.tracker.list` — no automatic background paging. `loadMore(status)`
 * advances every in-scope project by one more page for that status; the
 * caller (the screen/table) decides when that happens.
 *
 * This replaces the split design where Kanban read a full live-snapshot fetch
 * and List read its own per-status pagination: both views now read the exact
 * same loaded array, so switching view mode never changes how data loads,
 * only how it renders.
 */
export function useTrackerProjectData(
  options: UseTrackerProjectDataOptions,
): UseTrackerProjectDataResult {
  const runtime: TrackersRuntime = getHostRuntimeStore();

  const relevantProjects = useMemo(
    () =>
      options.selectedProjectId
        ? options.projects.filter((project) => project.projectId === options.selectedProjectId)
        : options.projects,
    [options.projects, options.selectedProjectId],
  );

  // Everything that defines "which dataset is loaded". Any change bumps
  // loadSeqRef, which is how every in-flight fetch (initial or loadMore)
  // recognizes it has gone stale and must discard its result instead of
  // merging it into the current (new-scope) state.
  const scopeKey = useMemo(
    () =>
      [
        options.enabled ? "1" : "0",
        options.selectedProjectId ?? "all",
        options.all ? "all" : "scoped",
        String(options.pageSize),
        options.type ?? "any-type",
        options.priority ?? "any-priority",
        ...relevantProjects.map((p) => `${p.serverId}:${p.projectId}`).sort(),
      ].join("|"),
    [
      options.enabled,
      options.selectedProjectId,
      options.all,
      options.pageSize,
      options.type,
      options.priority,
      relevantProjects,
    ],
  );

  const [sections, setSections] = useState<SectionsState>(createEmptySections);
  const [isLoading, setIsLoading] = useState(true);
  const [sectionLoadingMore, setSectionLoadingMore] = useState<Record<TrackerStatus, boolean>>(() =>
    createEmptyStatusRecord(false),
  );
  const [projectErrors, setProjectErrors] = useState<TrackerProjectError[]>([]);
  const loadSeqRef = useRef(0);
  // Guards loadMore against being fired again for a status while its fetch is
  // still in flight — sectionLoadingMore state exists for the same purpose
  // but is not readable synchronously inside the same tick loadMore is called.
  const loadingMoreRef = useRef<Set<TrackerStatus>>(new Set());
  // Mirrors `sections` for loadMore to read without depending on it — keeps
  // loadMore's identity stable across merges instead of churning on every
  // page (memoized consumers of the callback would otherwise re-render on
  // every merge for no reason).
  const sectionsRef = useRef(sections);
  useEffect(() => {
    sectionsRef.current = sections;
  }, [sections]);

  // Appends one resolved page for (project, status) into the live state,
  // re-sorting only the affected section. Never runs unless the caller has
  // already confirmed `seq === loadSeqRef.current` at the point the fetch
  // resolved — checking that once before calling is not enough on its own
  // (the exact gap the old-CLI-binary pagination fallback had), so every
  // caller re-checks immediately before invoking this.
  const mergePage = useCallback(
    (
      status: TrackerStatus,
      projectKey: string,
      trackers: AggregatedTracker[],
      next: CursorState,
    ) => {
      setSections((current) => {
        const section = current[status];
        const merged = [...section.trackers, ...trackers];
        sortMerged(merged);
        return {
          ...current,
          [status]: {
            trackers: merged,
            cursors: { ...section.cursors, [projectKey]: next },
          },
        };
      });
    },
    [],
  );

  const loadFirstPages = useCallback(async (): Promise<void> => {
    const seq = ++loadSeqRef.current;
    // A fresh load supersedes any loadMore in flight for the old scope —
    // reset immediately so no "Show more" spinner strands on the new scope
    // while that stale fetch's own cleanup is still pending.
    loadingMoreRef.current.clear();
    setSectionLoadingMore(createEmptyStatusRecord(false));
    if (!options.enabled || relevantProjects.length === 0) {
      setSections(createEmptySections());
      setProjectErrors([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setProjectErrors([]);
    const nextSections = createEmptySections();
    const errors: TrackerProjectError[] = [];
    const firstPages = await Promise.all(
      relevantProjects.flatMap((project) =>
        LIST_SECTION_STATUSES.map(async (status) => {
          try {
            const result = await fetchTrackerPage({
              project,
              runtime,
              status,
              all: options.all,
              limit: options.pageSize,
              type: options.type,
              priority: options.priority,
            });
            return { project, status, result, error: null as unknown };
          } catch (error) {
            return { project, status, result: null, error };
          }
        }),
      ),
    );
    if (seq !== loadSeqRef.current) {
      return;
    }
    const seenErrorProjects = new Set<string>();
    for (const page of firstPages) {
      const projectKey = projectKeyOf(page.project);
      if (page.error) {
        // Dedup — each status section fetches independently and fails the same way.
        if (!seenErrorProjects.has(projectKey)) {
          seenErrorProjects.add(projectKey);
          errors.push(toTrackerProjectError(page.project, page.error));
        }
        nextSections[page.status].cursors[projectKey] = ERRORED_CURSOR;
        continue;
      }
      const result = page.result!;
      nextSections[page.status].trackers.push(...result.trackers);
      nextSections[page.status].cursors[projectKey] = {
        cursor: result.pageInfo?.nextCursor ?? null,
        hasMore: result.pageInfo?.hasMore ?? false,
        totalCount: result.pageInfo?.totalCount ?? null,
      };
    }
    for (const status of LIST_SECTION_STATUSES) {
      sortMerged(nextSections[status].trackers);
    }
    setSections(nextSections);
    setProjectErrors(errors);
    setIsLoading(false);
    // scopeKey covers every option this closure reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, runtime]);

  useEffect(() => {
    void loadFirstPages();
  }, [loadFirstPages]);

  // Fetches exactly one more page per in-scope project that still has more
  // for `status` — no follow-up beyond this one page, unlike the deleted
  // background sweep. Concurrent calls for the same status while one is
  // already in flight are ignored.
  const loadMore = useCallback(
    (status: TrackerStatus) => {
      if (loadingMoreRef.current.has(status)) {
        return;
      }
      const seq = loadSeqRef.current;
      const currentCursors = sectionsRef.current[status].cursors;
      const targets = relevantProjects.filter(
        (project) => currentCursors[projectKeyOf(project)]?.hasMore === true,
      );
      if (targets.length === 0) {
        return;
      }
      loadingMoreRef.current.add(status);
      setSectionLoadingMore((current) => ({ ...current, [status]: true }));
      void (async () => {
        const results = await Promise.all(
          targets.map(async (project) => {
            const projectKey = projectKeyOf(project);
            const cursor = currentCursors[projectKey]?.cursor ?? undefined;
            try {
              const result = await fetchTrackerPage({
                project,
                runtime,
                status,
                all: options.all,
                limit: options.pageSize,
                type: options.type,
                priority: options.priority,
                cursor,
              });
              return { project, projectKey, result, error: null as unknown };
            } catch (error) {
              return { project, projectKey, result: null, error };
            }
          }),
        );
        loadingMoreRef.current.delete(status);
        // Clear the in-flight flag unconditionally, before the staleness
        // bail — otherwise a scope change mid-fetch strands this status's
        // spinner on forever, since loadFirstPages resets it once up front
        // but nothing clears it again once this branch returns early.
        setSectionLoadingMore((current) => ({ ...current, [status]: false }));
        if (seq !== loadSeqRef.current) {
          return;
        }
        for (const page of results) {
          if (page.error) {
            setProjectErrors((current) =>
              hasErrorForProject(current, page.project)
                ? current
                : [...current, toTrackerProjectError(page.project, page.error)],
            );
            mergePage(status, page.projectKey, [], ERRORED_CURSOR);
            continue;
          }
          const result = page.result!;
          mergePage(status, page.projectKey, result.trackers, {
            cursor: result.pageInfo?.nextCursor ?? null,
            hasMore: result.pageInfo?.hasMore ?? false,
            totalCount: result.pageInfo?.totalCount ?? null,
          });
        }
      })();
    },
    [
      relevantProjects,
      runtime,
      options.all,
      options.pageSize,
      options.type,
      options.priority,
      mergePage,
    ],
  );

  const sectionHasMore = useMemo(() => {
    const result = createEmptyStatusRecord(false);
    for (const status of LIST_SECTION_STATUSES) {
      result[status] = Object.values(sections[status].cursors).some(
        (cursorState) => cursorState.hasMore,
      );
    }
    return result;
  }, [sections]);

  const sectionTotals = useMemo(() => {
    const result = createEmptyStatusRecord<number | null>(0);
    for (const status of LIST_SECTION_STATUSES) {
      const cursors = sections[status].cursors;
      let sum = 0;
      let allReported = true;
      for (const project of relevantProjects) {
        const cursorState = cursors[projectKeyOf(project)];
        if (!cursorState || cursorState.totalCount === null) {
          allReported = false;
          break;
        }
        sum += cursorState.totalCount;
      }
      result[status] = allReported ? sum : null;
    }
    return result;
  }, [sections, relevantProjects]);

  const trackers = useMemo(() => {
    const merged = [
      ...sections.open.trackers,
      ...sections.in_progress.trackers,
      ...sections.closed.trackers,
      ...sections.cancelled.trackers,
    ];
    sortMerged(merged);
    return merged;
  }, [sections]);

  const patchTracker = useCallback((updated: AggregatedTracker) => {
    const projectKey = projectKeyOf(updated);
    setSections((current) => {
      const previousStatus = findTrackerStatus(current, updated.id);
      const next = createEmptySections();
      for (const status of LIST_SECTION_STATUSES) {
        next[status].cursors = current[status].cursors;
        next[status].trackers = current[status].trackers.filter(
          (tracker) => tracker.id !== updated.id,
        );
      }
      next[updated.status].trackers.push(updated);
      sortMerged(next[updated.status].trackers);
      // A move between sections shifts the count by one on each side; an
      // in-place edit (previousStatus === updated.status) doesn't change
      // either total, and a brand-new tracker (previousStatus === null) only
      // adds to its landing section.
      if (previousStatus !== null && previousStatus !== updated.status) {
        next[previousStatus].cursors = adjustProjectTotal(
          next[previousStatus].cursors,
          projectKey,
          -1,
        );
      }
      if (previousStatus !== updated.status) {
        next[updated.status].cursors = adjustProjectTotal(
          next[updated.status].cursors,
          projectKey,
          1,
        );
      }
      return next;
    });
  }, []);

  const removeTrackers = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    setSections((current) => {
      const next = createEmptySections();
      for (const status of LIST_SECTION_STATUSES) {
        let cursors = current[status].cursors;
        const kept: AggregatedTracker[] = [];
        for (const tracker of current[status].trackers) {
          if (idSet.has(tracker.id)) {
            cursors = adjustProjectTotal(cursors, projectKeyOf(tracker), -1);
            continue;
          }
          kept.push(tracker);
        }
        next[status] = { trackers: kept, cursors };
      }
      return next;
    });
  }, []);

  const refetch = useCallback(() => {
    void loadFirstPages();
  }, [loadFirstPages]);

  return {
    trackers,
    sectionTotals,
    sectionHasMore,
    sectionLoadingMore,
    loadMore,
    isLoading,
    projectErrors,
    patchTracker,
    removeTrackers,
    refetch,
  };
}
