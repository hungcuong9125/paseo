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
import { getHostRuntimeStore, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";
import { MAX_TREE_DEPTH, isDone } from "@/tracker/tracker-hierarchy";

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

// Which status section currently holds each loaded tracker id — an ancestor
// can sit in any section (its own status is unrelated to its descendants'),
// so adjusting one means first finding where it lives.
function locateTrackers(sections: SectionsState): Map<string, TrackerStatus> {
  const location = new Map<string, TrackerStatus>();
  for (const status of LIST_SECTION_STATUSES) {
    for (const tracker of sections[status].trackers) {
      location.set(tracker.id, status);
    }
  }
  return location;
}

// Bumps childCount/doneCount by a known delta on every *loaded* ancestor of
// `parentId` — the client-side counterpart to the server's
// `withTrackerSubtreeStats` (docs/tracker-data.md), applied incrementally
// instead of recomputed, so it can't undercount from a partially-loaded
// subtree the way a full local recompute over `trackers` would. No RPC
// exists to refetch just an ancestor chain by id (`project.tracker.list`
// only filters by status/type/priority + pagination, not by id — pas-2KY5X.11
// investigation), so this is the whole fix rather than a stopgap. The walk
// stops the moment an ancestor isn't in the loaded set: its own `parentId` is
// then unknown, so the chain can't continue, and it — along with everything
// above it — stays stale until the next real fetch, same posture as every
// other "only correct what's actually in hand" fallback in this file. A
// tracker whose own count is `undefined` (predates server-side subtree
// stats) is left `undefined`, never given a fabricated value.
function adjustAncestorCounts(
  sections: SectionsState,
  parentId: string | null,
  doneDelta: number,
  childDelta: number,
  startId: string,
): SectionsState {
  if ((doneDelta === 0 && childDelta === 0) || parentId === null) {
    return sections;
  }
  const location = locateTrackers(sections);
  const next: SectionsState = { ...sections };
  // Seeded with the mutated tracker's own id: malformed/cyclic `parentId`
  // data must never loop back onto the row this same patch just re-filed.
  const visited = new Set<string>([startId]);
  let currentId: string | null = parentId;
  let depth = 0;
  while (currentId !== null && !visited.has(currentId) && depth < MAX_TREE_DEPTH) {
    visited.add(currentId);
    const status = location.get(currentId);
    if (status === undefined) {
      break;
    }
    const section = next[status];
    const index = section.trackers.findIndex((tracker) => tracker.id === currentId);
    if (index === -1) {
      break;
    }
    const ancestor = section.trackers[index];
    if (next[status] === sections[status]) {
      next[status] = { ...section, trackers: [...section.trackers] };
    }
    next[status].trackers[index] = {
      ...ancestor,
      childCount: ancestor.childCount === undefined ? undefined : ancestor.childCount + childDelta,
      doneCount: ancestor.doneCount === undefined ? undefined : ancestor.doneCount + doneDelta,
    };
    currentId = ancestor.parentId;
    depth += 1;
  }
  return next;
}

interface AncestorCountDelta {
  childDelta: number;
  doneDelta: number;
}

// removeTrackers' counterpart to adjustAncestorCounts — a delete-tree cascade
// removes a whole subtree in one `removeTrackers(ids)` call, so the delta per
// surviving ancestor isn't always ±1 the way a single patchTracker mutation
// is. Walks each removed tracker's own parentId chain through `current` (the
// PRE-removal snapshot, not the survivors being built) so a removed ancestor
// still passes its removed descendants' contribution up to whatever further
// ancestor survives — e.g. deleting a parent and its child together in one
// cascade decrements the grandparent by 2, not 1, even though the parent
// itself (one hop of that walk) is also being removed and never gets its own
// row updated. Deltas are accumulated per surviving ancestor id before any
// row is touched, so two removed siblings under the same parent net to a
// single -2 write instead of two racing -1s.
function computeAncestorRemovalDeltas(
  current: SectionsState,
  removedIds: ReadonlySet<string>,
): Map<string, AncestorCountDelta> {
  const location = locateTrackers(current);
  const deltas = new Map<string, AncestorCountDelta>();
  for (const removedId of removedIds) {
    const status = location.get(removedId);
    const removedTracker =
      status !== undefined ? current[status].trackers.find((t) => t.id === removedId) : undefined;
    if (!removedTracker) {
      continue;
    }
    const wasDone = isDone(removedTracker);
    const visited = new Set<string>([removedId]);
    let currentId: string | null = removedTracker.parentId;
    let depth = 0;
    while (currentId !== null && !visited.has(currentId) && depth < MAX_TREE_DEPTH) {
      visited.add(currentId);
      const ancestorStatus = location.get(currentId);
      const ancestor =
        ancestorStatus !== undefined
          ? current[ancestorStatus].trackers.find((t) => t.id === currentId)
          : undefined;
      if (!ancestor) {
        break;
      }
      if (!removedIds.has(currentId)) {
        const delta = deltas.get(currentId) ?? { childDelta: 0, doneDelta: 0 };
        delta.childDelta -= 1;
        if (wasDone) {
          delta.doneDelta -= 1;
        }
        deltas.set(currentId, delta);
      }
      currentId = ancestor.parentId;
      depth += 1;
    }
  }
  return deltas;
}

// Applies each accumulated delta to whichever surviving section holds that
// ancestor — every id here was, by construction, excluded from the removed
// set, so it is still present in `sections`. Same undefined-stays-undefined
// rule as adjustAncestorCounts.
function applyAncestorRemovalDeltas(
  sections: SectionsState,
  deltas: ReadonlyMap<string, AncestorCountDelta>,
): SectionsState {
  if (deltas.size === 0) {
    return sections;
  }
  const location = locateTrackers(sections);
  const next: SectionsState = { ...sections };
  for (const [id, delta] of deltas) {
    const status = location.get(id);
    if (status === undefined) {
      continue;
    }
    const section = next[status];
    const index = section.trackers.findIndex((tracker) => tracker.id === id);
    if (index === -1) {
      continue;
    }
    const ancestor = section.trackers[index];
    if (next[status] === sections[status]) {
      next[status] = { ...section, trackers: [...section.trackers] };
    }
    next[status].trackers[index] = {
      ...ancestor,
      childCount:
        ancestor.childCount === undefined ? undefined : ancestor.childCount + delta.childDelta,
      doneCount:
        ancestor.doneCount === undefined ? undefined : ancestor.doneCount + delta.doneDelta,
    };
  }
  return next;
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

  // fetchTrackerPage silently returns an empty page for a host whose
  // connectionStatus isn't "online" (imperative `runtime.getSnapshot` read).
  // `connectionStatuses` is this hook's reactive trigger for that fact
  // changing later — but unlike pas-2KY5X.1's stats fix, it does NOT feed
  // scopeKey: an early version folded it in, and any status change on any one
  // host took the isNewScope path, wiping every project's already-loaded
  // pages and cursors, not just the reconnected one's — worse at mount, where
  // N hosts individually settle from "connecting" to "online" and each
  // transition re-triggered a full reset-and-refetch storm across the whole
  // workspace (caught in review, pas-2KY5X.11/.13). `connectionStatuses` is
  // read instead by retryReconnectedProjects below, which re-fetches only the
  // specific projects `offlineProjectKeysRef` marked offline, merging into
  // the existing state via `mergePage` — the same targeted shape `loadMore`
  // already uses, so every other project's paging progress survives.
  const relevantServerIds = useMemo(
    () => [...new Set(relevantProjects.map((project) => project.serverId))],
    [relevantProjects],
  );
  const connectionStatuses = useHostRuntimeConnectionStatuses(relevantServerIds);
  // Project keys (projectKeyOf) whose most recent fetch was served by
  // fetchTrackerPage's offline short-circuit — cleared on every scope reset,
  // populated by syncSections, drained by retryReconnectedProjects once that
  // project gets real data.
  const offlineProjectKeysRef = useRef<Set<string>>(new Set());

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
  // every merge for no reason). Assigned during render, not in a `useEffect`
  // (pas-2KY5X.16): a passive effect only flushes after the browser paints,
  // so the "Show more" button — visible the instant `sections` state carries
  // `hasMore: true` — could already be clickable while `sectionsRef` still
  // held the pre-merge cursors. A press landing in that window read
  // `hasMore: undefined` for every project, found no targets, and returned
  // without fetching at all; a second press, by then past the effect flush,
  // worked. Assigning in the render body keeps the ref exactly as current as
  // the state it mirrors, with no such window.
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;

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
        offlineProjectKeysRef.current = new Set();
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
        relevantProjects.flatMap((project) => {
          // Checked once per project, before its statuses fan out — cheap,
          // and connectivity doesn't flip mid-batch in practice. Feeds
          // offlineProjectKeysRef below so retryReconnectedProjects knows
          // which projects to revisit once this host comes back.
          const wasOfflineAtFetch =
            runtime.getSnapshot(project.serverId)?.connectionStatus !== "online";
          return toFetch.map(async (status) => {
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
              return { project, status, result, error: null as unknown, wasOfflineAtFetch };
            } catch (error) {
              return { project, status, result: null, error, wasOfflineAtFetch };
            }
          });
        }),
      );
      if (seq !== loadSeqRef.current) {
        // Stale — a newer scope reset already reseeded pendingStatuses and
        // sections for the current scope; this batch belongs to an abandoned
        // one and must not touch either.
        return;
      }
      for (const page of pages) {
        const projectKey = projectKeyOf(page.project);
        if (page.wasOfflineAtFetch) {
          offlineProjectKeysRef.current.add(projectKey);
        } else {
          offlineProjectKeysRef.current.delete(projectKey);
        }
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

  // Re-fetches exactly the projects offlineProjectKeysRef marked offline,
  // for whatever statuses the current scope already has loaded — merged into
  // the existing sections via mergePage, the same targeted shape `loadMore`
  // uses, so every other project's already-loaded pages are untouched
  // (pas-2KY5X.13). A no-op whenever nothing is flagged offline or nothing
  // just reconnected, so this is safe to call on every trigger.
  const retryReconnectedProjects = useCallback(async (): Promise<void> => {
    if (offlineProjectKeysRef.current.size === 0) {
      return;
    }
    const statuses = [...requestedStatusesRef.current];
    if (statuses.length === 0) {
      return;
    }
    const seq = loadSeqRef.current;
    const targets = relevantProjects.filter(
      (project) =>
        offlineProjectKeysRef.current.has(projectKeyOf(project)) &&
        runtime.getSnapshot(project.serverId)?.connectionStatus === "online",
    );
    if (targets.length === 0) {
      return;
    }
    const retryOne = async (project: TrackerProjectInput, status: TrackerStatus): Promise<void> => {
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
        if (seq !== loadSeqRef.current) {
          return;
        }
        offlineProjectKeysRef.current.delete(projectKeyOf(project));
        mergePage(status, projectKeyOf(project), result.trackers, {
          cursor: result.pageInfo?.nextCursor ?? null,
          hasMore: result.pageInfo?.hasMore ?? false,
          totalCount: result.pageInfo?.totalCount ?? null,
        });
      } catch (error) {
        if (seq !== loadSeqRef.current) {
          return;
        }
        // Fetched while online (targets already required that), so a thrown
        // error is a real RPC failure, not an offline masking — clear the
        // offline flag so a future reconnect doesn't retry a failure that
        // has nothing to do with connectivity.
        offlineProjectKeysRef.current.delete(projectKeyOf(project));
        setProjectErrors((current) =>
          hasErrorForProject(current, project)
            ? current
            : [...current, toTrackerProjectError(project, error)],
        );
        mergePage(status, projectKeyOf(project), [], ERRORED_CURSOR);
      }
    };
    await Promise.all(
      targets.flatMap((project) => statuses.map((status) => retryOne(project, status))),
    );
  }, [
    relevantProjects,
    runtime,
    options.all,
    options.pageSize,
    options.type,
    options.priority,
    mergePage,
  ]);

  useEffect(() => {
    void retryReconnectedProjects();
    // connectionStatuses is the reactive trigger for the imperative
    // runtime.getSnapshot reads inside retryReconnectedProjects — same
    // pattern as pas-2KY5X.1's featureSupportKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryReconnectedProjects, connectionStatuses]);

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
      const previousTracker =
        previousStatus !== null
          ? (current[previousStatus].trackers.find((tracker) => tracker.id === updated.id) ?? null)
          : null;
      let next = createEmptySections();
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
      // A parent's subtree badge ("1 of 2 done") is server-computed per row
      // (docs/tracker-data.md) and this patch only ever touches `updated`'s
      // own row — left alone, every ancestor's childCount/doneCount would go
      // stale the moment a descendant's done-state changes (pas-2KY5X.11).
      // Reparenting has no UI path today (create is the only mutation that
      // sets parentId, and it always targets a fresh, previously-absent row),
      // so it's intentionally not handled here: adjusting one chain without
      // knowing the other risks a wrong count, which is worse than a stale
      // one that a real refetch will still correct.
      const reparented = previousTracker !== null && previousTracker.parentId !== updated.parentId;
      if (!reparented) {
        const wasDone = previousTracker !== null && isDone(previousTracker);
        const isDoneNow = isDone(updated);
        let doneDelta = 0;
        if (isDoneNow && !wasDone) {
          doneDelta = 1;
        } else if (!isDoneNow && wasDone) {
          doneDelta = -1;
        }
        const childDelta = previousTracker === null ? 1 : 0;
        next = adjustAncestorCounts(next, updated.parentId, doneDelta, childDelta, updated.id);
      }
      return next;
    });
  }, []);

  const removeTrackers = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    setSections((current) => {
      // Computed from `current` (pre-removal) before any row is dropped —
      // see computeAncestorRemovalDeltas for why the walk needs to see
      // through an ancestor that is itself part of this same removal.
      const ancestorDeltas = computeAncestorRemovalDeltas(current, idSet);
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
      // A parent's subtree badge must lose exactly what this delete removed
      // (pas-2KY5X.11) — the same staleness patchTracker's ancestor walk
      // fixes for a status/create mutation, on the delete path.
      return applyAncestorRemovalDeltas(next, ancestorDeltas);
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
