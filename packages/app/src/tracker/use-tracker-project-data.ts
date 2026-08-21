import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TrackerStatus } from "@getpaseo/protocol/tracker/types";
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
}

interface SectionPageState {
  trackers: AggregatedTracker[];
  // One cursor per project: each project sweeps its own pages independently.
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

export interface UseTrackerProjectDataOptions {
  projects: readonly TrackerProjectInput[];
  selectedProjectId: string | null;
  all: boolean;
  enabled: boolean;
  pageSize: number;
}

export interface UseTrackerProjectDataResult {
  /** Every loaded tracker across every relevant project and status section,
   * flattened and sorted (projectId then id) — feeds both TrackerTable
   * (bucketed by status) and TrackerKanbanBoard (partitioned by
   * buildTrackerBoard) from the exact same data. Not filtered by tracker
   * type — a type filter is applied downstream by the screen, same as the
   * status/priority toolbar filters, so this array always has the full
   * range a hierarchy needs to compute real child counts. */
  trackers: AggregatedTracker[];
  /** True once every relevant project's every status section has exhausted
   * its pagination (`hasMore` false everywhere). Child-count-derived UI
   * (Kanban lane counts, card progress, the delete cascade check) can only
   * ever undercount while this is false. */
  isComplete: boolean;
  /** True only until the first page of every section/project has landed —
   * mirrors the old aggregate fetch's "loading" state for the screen's body
   * state machine. Does not go true again during the background sweep. */
  isLoading: boolean;
  projectErrors: TrackerProjectError[];
  /** Replaces the tracker by id wherever it currently lives (any section, any
   * project), re-filing it into the section matching `updated.status` — or
   * inserts it if not found (covers a newly created tracker). Used to apply
   * the result of the user's own mutations without a re-fetch. */
  patchTracker: (updated: AggregatedTracker) => void;
  /** Removes trackers by id from wherever they live, across every section. */
  removeTrackers: (ids: string[]) => void;
  /** Restarts the whole sweep from scratch for the current scope. */
  refetch: () => void;
}

/**
 * The single shared data source for both the List and Kanban tracker views.
 * Per relevant project x per status section, pages through
 * `project.tracker.list` automatically in the background — no manual "load
 * more" — until every section's `hasMore` is false. One in-flight page fetch
 * per (project, section) pair at a time; different pairs sweep concurrently.
 *
 * This replaces the split design where Kanban read a full live-snapshot fetch
 * and List read its own per-status pagination: both views now read the exact
 * same growing array, so switching view mode never changes how data loads,
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
  // loadSeqRef, which is how every in-flight fetch (initial or background
  // sweep) recognizes it has gone stale and must discard its result instead
  // of merging it into the current (new-scope) state.
  const scopeKey = useMemo(
    () =>
      [
        options.enabled ? "1" : "0",
        options.selectedProjectId ?? "all",
        options.all ? "all" : "scoped",
        String(options.pageSize),
        ...relevantProjects.map((p) => `${p.serverId}:${p.projectId}`).sort(),
      ].join("|"),
    [options.enabled, options.selectedProjectId, options.all, options.pageSize, relevantProjects],
  );

  const [sections, setSections] = useState<SectionsState>(createEmptySections);
  const [isLoading, setIsLoading] = useState(true);
  const [projectErrors, setProjectErrors] = useState<TrackerProjectError[]>([]);
  const loadSeqRef = useRef(0);

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

  // Sweeps one (project, status) pair page by page, one fetch in flight at a
  // time, until hasMore is false. Runs detached from the initial-load
  // Promise.all — it is the "automatic background sweep", not a manual
  // loadMore. Aborts at its next checkpoint (before firing a fetch and again
  // after each await) the moment the scope has moved on.
  const sweepOne = useCallback(
    async (
      seq: number,
      project: TrackerProjectInput,
      status: TrackerStatus,
      startCursor: string | null,
    ): Promise<void> => {
      let cursor = startCursor;
      const projectKey = projectKeyOf(project);
      for (;;) {
        if (seq !== loadSeqRef.current) {
          return;
        }
        let result;
        try {
          result = await fetchTrackerPage({
            project,
            runtime,
            status,
            all: options.all,
            limit: options.pageSize,
            cursor: cursor ?? undefined,
          });
        } catch (error) {
          if (seq !== loadSeqRef.current) {
            return;
          }
          setProjectErrors((current) => [...current, toTrackerProjectError(project, error)]);
          setSections((current) => ({
            ...current,
            [status]: {
              ...current[status],
              cursors: {
                ...current[status].cursors,
                [projectKey]: { cursor: null, hasMore: false },
              },
            },
          }));
          return;
        }
        if (seq !== loadSeqRef.current) {
          return;
        }
        const hasMore = result.pageInfo?.hasMore ?? false;
        const nextCursor = result.pageInfo?.nextCursor ?? null;
        mergePage(status, projectKey, result.trackers, { cursor: nextCursor, hasMore });
        if (!hasMore) {
          return;
        }
        cursor = nextCursor;
      }
    },
    [runtime, options.all, options.pageSize, mergePage],
  );

  const runSweep = useCallback(async (): Promise<void> => {
    const seq = ++loadSeqRef.current;
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
    for (const page of firstPages) {
      const projectKey = projectKeyOf(page.project);
      if (page.error) {
        errors.push(toTrackerProjectError(page.project, page.error));
        nextSections[page.status].cursors[projectKey] = { cursor: null, hasMore: false };
        continue;
      }
      const result = page.result!;
      nextSections[page.status].trackers.push(...result.trackers);
      nextSections[page.status].cursors[projectKey] = {
        cursor: result.pageInfo?.nextCursor ?? null,
        hasMore: result.pageInfo?.hasMore ?? false,
      };
    }
    for (const status of LIST_SECTION_STATUSES) {
      sortMerged(nextSections[status].trackers);
    }
    setSections(nextSections);
    setProjectErrors(errors);
    setIsLoading(false);

    // Kick off the automatic background sweep for every (project, status)
    // pair that still has more pages — fire-and-forget, not awaited here.
    for (const page of firstPages) {
      if (page.error) {
        continue;
      }
      const cursorState = nextSections[page.status].cursors[projectKeyOf(page.project)];
      if (cursorState?.hasMore) {
        void sweepOne(seq, page.project, page.status, cursorState.cursor);
      }
    }
    // scopeKey covers every option this closure reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, runtime, sweepOne]);

  useEffect(() => {
    void runSweep();
  }, [runSweep]);

  const isComplete = useMemo(
    () =>
      !isLoading &&
      LIST_SECTION_STATUSES.every((status) =>
        Object.values(sections[status].cursors).every((cursorState) => !cursorState.hasMore),
      ),
    [isLoading, sections],
  );

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
    setSections((current) => {
      const next = createEmptySections();
      for (const status of LIST_SECTION_STATUSES) {
        next[status].cursors = current[status].cursors;
        next[status].trackers = current[status].trackers.filter(
          (tracker) => tracker.id !== updated.id,
        );
      }
      next[updated.status].trackers.push(updated);
      sortMerged(next[updated.status].trackers);
      return next;
    });
  }, []);

  const removeTrackers = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    setSections((current) => {
      const next = createEmptySections();
      for (const status of LIST_SECTION_STATUSES) {
        next[status].cursors = current[status].cursors;
        next[status].trackers = current[status].trackers.filter(
          (tracker) => !idSet.has(tracker.id),
        );
      }
      return next;
    });
  }, []);

  const refetch = useCallback(() => {
    void runSweep();
  }, [runSweep]);

  return { trackers, isComplete, isLoading, projectErrors, patchTracker, removeTrackers, refetch };
}
