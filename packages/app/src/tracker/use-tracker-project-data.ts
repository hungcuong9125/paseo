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
  /** Which status sections to keep loaded. Omitted means all four —
   * Kanban's requirement (it renders all five lanes from this one shared
   * fetch) and List's own default when no status-shaped filter narrows the
   * view. List narrows this to exactly the one section a status filter
   * needs (`listVisibleStatusesForFilter` in tracker-stats.ts — a priority
   * filter still spans every status, so it leaves this unset). Growing the
   * set fetches only the newly-added sections against the current scope; a
   * section dropped from the set is left loaded rather than purged, since
   * switching back to it should not re-pay for data already in hand. Only a
   * change to the project/type/priority/enabled scope invalidates
   * already-loaded sections. */
  sections?: readonly TrackerStatus[];
}

export interface UseTrackerProjectDataResult {
  /** Only the pages actually loaded, already narrowed by `options.type` /
   * `options.priority` — feeds both TrackerTable (bucketed by status) and
   * TrackerKanbanBoard (partitioned by buildTrackerBoard) from the exact
   * same data. May include sections outside `options.sections`' current
   * value if they were loaded under an earlier value (left in place, not
   * purged — see that option's docstring). */
  trackers: AggregatedTracker[];
  /** Summed `pageInfo.totalCount` across the in-scope projects, per status.
   * `null` when any in-scope project did not report one (old CLI binary, an
   * offline host, a fetch error, or the section was never requested) — the
   * screen falls back to loaded-so-far counts (`trackers.length`) in that
   * case. */
  sectionTotals: Record<TrackerStatus, number | null>;
  /** True while any in-scope project still has more pages for that status. */
  sectionHasMore: Record<TrackerStatus, boolean>;
  /** True while a `loadMore` fetch is in flight for that status. */
  sectionLoadingMore: Record<TrackerStatus, boolean>;
  /** Fetches exactly one more page per in-scope project for that status —
   * no automatic follow-up, the caller decides when to page again. */
  loadMore: (status: TrackerStatus) => void;
  /** True while any status currently in `options.sections` (or all four,
   * if omitted) is still waiting on its first page for the current scope. */
  isLoading: boolean;
  projectErrors: TrackerProjectError[];
  /** Replaces the tracker by id wherever it currently lives (any section, any
   * project), re-filing it into the section matching `updated.status` — or
   * inserts it if not found (covers a newly created tracker). Used to apply
   * the result of the user's own mutations without a re-fetch. */
  patchTracker: (updated: AggregatedTracker) => void;
  /** Removes trackers by id from wherever they live, across every section. */
  removeTrackers: (ids: string[]) => void;
  /** Restarts pagination from scratch for the current scope, re-fetching
   * whatever `options.sections` currently asks for. */
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

  const desiredSections = useMemo(
    () => (options.sections ? [...options.sections] : [...LIST_SECTION_STATUSES]),
    [options.sections],
  );
  // Stable primitive proxy for desiredSections' contents — a fresh array
  // reference from the caller every render must not by itself re-trigger the
  // sync effect below.
  const desiredSectionsKey = useMemo(
    () => [...desiredSections].sort().join(","),
    [desiredSections],
  );

  // Everything that defines "which dataset is loaded" — deliberately NOT
  // including which sections are currently desired. Growing or shrinking
  // that set (below) fetches or leaves-in-place sections without discarding
  // the rest; only a change here invalidates already-loaded data and forces
  // a full reset.
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
  // Statuses whose first page (for the current scope) is still in flight —
  // exists purely to derive isLoading reactively. requestedStatusesRef below
  // is the actual "don't fetch this status again" guard.
  const [pendingStatuses, setPendingStatuses] = useState<ReadonlySet<TrackerStatus>>(
    () => new Set(desiredSections),
  );
  const isLoading = useMemo(
    () => desiredSections.some((status) => pendingStatuses.has(status)),
    [desiredSections, pendingStatuses],
  );
  const [sectionLoadingMore, setSectionLoadingMore] = useState<Record<TrackerStatus, boolean>>(() =>
    createEmptyStatusRecord(false),
  );
  const [projectErrors, setProjectErrors] = useState<TrackerProjectError[]>([]);
  const loadSeqRef = useRef(0);
  // The scopeKey last seen by syncSections — lets it detect "this is a new
  // scope" imperatively without needing scopeKey in a dependency array that
  // would also fire on every desiredSections change.
  const lastScopeKeyRef = useRef<string | null>(null);
  // Statuses whose first page has been requested (in flight or resolved) for
  // the current scope — checked before firing a new fetch so growing
  // desiredSections only ever fetches what's actually new.
  const requestedStatusesRef = useRef<Set<TrackerStatus>>(new Set());
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

  // Ensures the first page of every (project, status) pair in `statuses` has
  // been requested for the current scope, merging results into whatever is
  // already loaded rather than replacing it. A scope change (scopeKey)
  // resets everything first — every already-loaded status is invalidated and
  // has to be re-requested, exactly like a fresh mount; a `statuses` change
  // alone (same scope) only fetches whichever of them haven't been requested
  // yet.
  const syncSections = useCallback(
    async (statuses: readonly TrackerStatus[]): Promise<void> => {
      const isNewScope = lastScopeKeyRef.current !== scopeKey;
      lastScopeKeyRef.current = scopeKey;
      let seq = loadSeqRef.current;
      const willFetch = options.enabled && relevantProjects.length > 0;
      if (isNewScope) {
        seq = ++loadSeqRef.current;
        loadingMoreRef.current.clear();
        requestedStatusesRef.current = new Set();
        setSections(createEmptySections());
        setSectionLoadingMore(createEmptyStatusRecord(false));
        setProjectErrors([]);
        setPendingStatuses(willFetch ? new Set(statuses) : new Set());
      }
      if (!willFetch) {
        return;
      }
      const toFetch = statuses.filter((status) => !requestedStatusesRef.current.has(status));
      if (toFetch.length === 0) {
        return;
      }
      for (const status of toFetch) {
        requestedStatusesRef.current.add(status);
      }
      if (!isNewScope) {
        setPendingStatuses((current) => new Set([...current, ...toFetch]));
      }
      const pages = await Promise.all(
        relevantProjects.flatMap((project) =>
          toFetch.map(async (status) => {
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
        // Stale — a newer scope reset already reseeded pendingStatuses and
        // sections for the current scope; this batch belongs to an abandoned
        // one and must not touch either.
        return;
      }
      setPendingStatuses((current) => {
        if (current.size === 0) {
          return current;
        }
        const next = new Set(current);
        for (const status of toFetch) {
          next.delete(status);
        }
        return next;
      });
      const seenErrorProjects = new Set<string>();
      const errors: TrackerProjectError[] = [];
      setSections((current) => {
        const next = { ...current };
        for (const status of toFetch) {
          next[status] = {
            trackers: [...current[status].trackers],
            cursors: { ...current[status].cursors },
          };
        }
        for (const page of pages) {
          const projectKey = projectKeyOf(page.project);
          if (page.error) {
            // Dedup — each status fetches independently and fails the same way.
            if (!seenErrorProjects.has(projectKey)) {
              seenErrorProjects.add(projectKey);
              errors.push(toTrackerProjectError(page.project, page.error));
            }
            next[page.status].cursors[projectKey] = ERRORED_CURSOR;
            continue;
          }
          const result = page.result!;
          next[page.status].trackers.push(...result.trackers);
          next[page.status].cursors[projectKey] = {
            cursor: result.pageInfo?.nextCursor ?? null,
            hasMore: result.pageInfo?.hasMore ?? false,
            totalCount: result.pageInfo?.totalCount ?? null,
          };
        }
        for (const status of toFetch) {
          sortMerged(next[status].trackers);
        }
        return next;
      });
      if (errors.length > 0) {
        setProjectErrors((current) => {
          const additions = errors.filter((error) => !hasErrorForProject(current, error));
          return additions.length > 0 ? [...current, ...additions] : current;
        });
      }
    },
    // scopeKey covers every project/type/priority/enabled option this
    // closure reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeKey, runtime],
  );

  useEffect(() => {
    void syncSections(desiredSections);
    // desiredSectionsKey is the stable proxy for desiredSections' contents —
    // scopeKey changes are picked up imperatively inside syncSections via
    // lastScopeKeyRef, not through this dependency array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncSections, desiredSectionsKey]);

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
        // spinner on forever, since the scope reset resets it once up front
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
    // Forces the next syncSections call to treat this as a fresh scope even
    // though scopeKey itself hasn't changed.
    lastScopeKeyRef.current = null;
    void syncSections(desiredSections);
  }, [syncSections, desiredSections]);

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
