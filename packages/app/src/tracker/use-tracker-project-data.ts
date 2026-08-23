import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  TrackerPriority,
  TrackerSort,
  TrackerStatus,
  TrackerType,
} from "@getpaseo/protocol/tracker/types";
import {
  fetchTrackerPage,
  toTrackerProjectError,
  type AggregatedTracker,
  type TrackerProjectError,
  type TrackerProjectInput,
  type TrackersRuntime,
} from "@/tracker/aggregated-trackers";
import { getHostRuntimeStore, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";
import { MAX_TREE_DEPTH, compareByCreatedNewest, isDone } from "@/tracker/tracker-hierarchy";
import { useSessionStore } from "@/stores/session-store";

// Same four sections, same order, as TrackerTable's LIST_SECTIONS and
// tracker-board-model.ts's buildTrackerBoard — kept as a plain status tuple
// here because the hook must not import from a component.
const LIST_SECTION_STATUSES = ["open", "in_progress", "closed", "cancelled"] as const;

interface CursorState {
  cursor: string | null;
  hasMore: boolean;
  /** From the page's `pageInfo.totalCount`. `null` when this project's page
   * didn't report one — an offline host, a real fetch failure, and a
   * genuine old-CLI-binary response predating total_count all look
   * identical here (`{hasMore: false, totalCount: null}`); `sectionTotals`
   * tells them apart by checking whether this project actually has rows in
   * `trackers` for the status, not by this field alone. */
  totalCount: number | null;
  /** Rows fetched from this project (server-sorted newest-first) but not yet
   * merged into the displayed window — only ever populated by the merged
   * "All projects" budget fetch (pas-2KY5X.15); always empty otherwise.
   * Drained before this project is asked for another page, so a project
   * that was over-fetched relative to the current budget doesn't pay for
   * the same rows twice on the next "Show more". */
  buffer: AggregatedTracker[];
}

const ERRORED_CURSOR: CursorState = { cursor: null, hasMore: false, totalCount: null, buffer: [] };

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

// Newest-first, by the one shared "newest" key (compareByCreatedNewest) that
// the k-way merge selects with and the Kanban lanes order by. This used to
// sort by projectId then id, which is arbitrary on both axes: it put whichever
// project sorts first alphabetically at the top of every section regardless of
// age, and it made a freshly paged-in row land at a position decided by its
// project name rather than after the rows already on screen. The Kanban board
// hid that by re-sorting its Done/Cancelled lanes itself; the List rendered
// this order as-is (pas-2KY5X.29).
function sortMerged(trackers: AggregatedTracker[]): void {
  trackers.sort(compareByCreatedNewest);
}

// Narrower than TrackerProjectInput on purpose (pas-2KY5X.28 added a
// required projectRootPath there) — this reads only the two fields every
// caller actually has in common (TrackerProjectInput, TrackerProjectError,
// AggregatedTracker), not the full project shape.
function projectKeyOf(project: { serverId: string; projectId: string }): string {
  return `${project.serverId}:${project.projectId}`;
}

// Narrower than TrackerProjectInput for the same reason as projectKeyOf
// above — a caller sometimes checks a TrackerProjectError (which has no
// projectRootPath) against the accumulated error list.
function hasErrorForProject(
  errors: TrackerProjectError[],
  project: { serverId: string; projectId: string },
): boolean {
  return errors.some((e) => e.serverId === project.serverId && e.projectId === project.projectId);
}

// The k-way merge step: each buffer is one project's rows, already
// newest-first (guaranteed by the server when sort is active). Shifts off and
// returns whichever buffer's head is newest, or null when every buffer is
// empty. Never looks past a buffer's head — a stream being individually
// sorted is exactly what makes that safe: everything that stream hasn't
// revealed yet is guaranteed older than what's at its head, so there's never
// a reason to peek further before taking from a different stream.
//
// Only safe to call when every stream that still has rows on the server has
// a non-empty buffer. An EMPTY buffer is indistinguishable from an exhausted
// stream here, so calling this with a stream that is merely un-refilled
// silently skips it — and its next row may well be newer than the head this
// returns. Enforcing that precondition is the caller's job; see
// fetchMergedStatusWindow's merge frontier.
function shiftNewestRow(
  buffers: ReadonlyMap<string, AggregatedTracker[]>,
): AggregatedTracker | null {
  let bestKey: string | null = null;
  let bestRow: AggregatedTracker | null = null;
  for (const [key, rows] of buffers) {
    const head = rows[0];
    if (head === undefined) {
      continue;
    }
    if (bestRow === null || compareByCreatedNewest(head, bestRow) < 0) {
      bestKey = key;
      bestRow = head;
    }
  }
  if (bestKey === null) {
    return null;
  }
  buffers.get(bestKey)!.shift();
  return bestRow;
}

/** One project's outcome from one merge-fetch round. */
interface MergeFetchOutcome {
  project: TrackerProjectInput;
  trackers: AggregatedTracker[];
  cursor: string | null;
  hasMore: boolean;
  totalCount: number | null;
  wasOfflineAtFetch: boolean;
  error: unknown;
}

interface MergedWindowResult {
  /** Up to `budget` rows, newest-first across every relevant project. */
  taken: AggregatedTracker[];
  /** Every relevant project's updated cursor, including whatever's left in
   * its buffer after `taken` was drawn from it. */
  cursors: Record<string, CursorState>;
  errors: TrackerProjectError[];
  /** Every project actually queried this call, keyed by whether that
   * specific fetch found it offline — a project whose buffer already had
   * enough leftover to satisfy the whole budget never appears here, since it
   * was never queried this round. */
  offlineStatusByProject: ReadonlyMap<string, boolean>;
}

// Counts REFILLS, not passes: round 1 asks every relevant project for one
// even share of `budget`, and each later round tops up whichever streams ran
// dry at the merge frontier mid-emission, one more even share at a time. So
// this bounds round-TRIPS, and since every round costs the same small page,
// it bounds total rows fetched too (roughly `budget` + rounds x share). Sized
// well above the 2-3 a real workspace needs — see this hook's own tests for
// measured fetch counts — because a project whose rows interleave tightly
// with another's can drain several times over one window. Past the cap,
// fetchMergedStatusWindow returns fewer than `budget` rows rather than
// chaining more round-trips, and the section's own hasMore/loadMore already
// know how to offer the rest as a partial page.
const MERGE_MAX_ROUNDS = 12;

/**
 * Assembles up to `budget` additional rows for one status, newest-first
 * across every relevant project — the client-side half of turning "N per
 * project" into "N total" (pas-2KY5X.15). Emission and refilling interleave:
 * a row is emitted only once every stream that might still hold something
 * newer has a buffered head to compare it against, and any stream that runs
 * dry at that frontier is refilled before emission continues — "only refill
 * the stream that's exhausted at the merge frontier", now actually enforced
 * rather than approximated by pre-filling to a row count (pas-2KY5X.29).
 * Each refill fetches only the blocked streams, sized to however many rows
 * are still needed split across just those, not a flat per-project page.
 * Safe to call with rows
 * already sitting in `priorCursors[key].buffer` from a previous call that
 * over-fetched relative to its own budget: those are consumed first, so a
 * project that already gave more than it needed to doesn't pay for the same
 * rows twice on the next "Show more".
 *
 * Relies on each project's own stream being sorted newest-first server-side
 * (`fetchRound` is expected to request that) — `takeNewest` only ever reads
 * a stream's buffered head, and that's only a valid stand-in for "the
 * newest row this project hasn't revealed yet" when the stream is actually
 * sorted; an unsorted project would make the merge silently wrong instead of
 * merely degraded, which is why the caller must not invoke this at all for a
 * project whose host doesn't advertise `aitTrackerSort`.
 */
async function fetchMergedStatusWindow(
  relevantProjects: readonly TrackerProjectInput[],
  budget: number,
  priorCursors: Readonly<Record<string, CursorState>>,
  fetchRound: (
    targets: readonly { project: TrackerProjectInput; cursor: string | null }[],
    limit: number,
  ) => Promise<MergeFetchOutcome[]>,
): Promise<MergedWindowResult> {
  const cursors: Record<string, CursorState> = {};
  const buffers = new Map<string, AggregatedTracker[]>();
  for (const project of relevantProjects) {
    const key = projectKeyOf(project);
    const prior = priorCursors[key] ?? {
      cursor: null,
      hasMore: true,
      totalCount: null,
      buffer: [],
    };
    cursors[key] = prior;
    buffers.set(key, [...prior.buffer]);
  }

  const errors: TrackerProjectError[] = [];
  const seenErrorProjects = new Set<string>();
  const offlineStatusByProject = new Map<string, boolean>();

  const applyOutcomes = (outcomes: readonly MergeFetchOutcome[]): void => {
    for (const outcome of outcomes) {
      const key = projectKeyOf(outcome.project);
      offlineStatusByProject.set(key, outcome.wasOfflineAtFetch);
      if (outcome.error) {
        // Dedup — a project that errors does so the same way every round.
        if (!seenErrorProjects.has(key)) {
          seenErrorProjects.add(key);
          errors.push(toTrackerProjectError(outcome.project, outcome.error));
        }
        cursors[key] = ERRORED_CURSOR;
        buffers.set(key, []);
        continue;
      }
      cursors[key] = {
        cursor: outcome.cursor,
        hasMore: outcome.hasMore,
        totalCount: outcome.totalCount,
        buffer: [],
      };
      buffers.get(key)!.push(...outcome.trackers);
    }
  };

  // Emission is interleaved with refills, not run once after them: a row can
  // only be emitted while every stream that might still hold something newer
  // has a buffered head to compare against. A stream whose buffer is empty
  // while `hasMore !== false` is exactly that unknown — it BLOCKS the merge
  // frontier and has to be refilled before the next row goes out.
  //
  // Filling first and emitting once (what this used to do) is unsound in two
  // ways, both of which shipped: it stopped filling as soon as `budget` rows
  // sat in the buffers, so the window was "the newest few from each project"
  // rather than the newest `budget` overall (with 5 projects and a budget of
  // 30, every project got asked for exactly 6, no matter that one of them
  // owned 20 of the true newest 30); and it never refilled a stream that ran
  // dry partway through emission, so that stream's remaining rows — newer
  // than plenty of what did get emitted — silently dropped out of the window
  // and only surfaced on the next "Show more", landing ABOVE rows already on
  // screen instead of after them (pas-2KY5X.29).
  const taken: AggregatedTracker[] = [];
  let rounds = 0;
  while (taken.length < budget) {
    const blocked = relevantProjects.filter((project) => {
      const key = projectKeyOf(project);
      return buffers.get(key)!.length === 0 && cursors[key].hasMore !== false;
    });
    if (blocked.length > 0) {
      if (rounds >= MERGE_MAX_ROUNDS) {
        // Out of round-trips with the frontier still blocked. Returning the
        // rows gathered so far is the honest outcome: they're a correct
        // newest-first prefix, just a short page, and the section's own
        // hasMore/loadMore already know how to offer the rest.
        break;
      }
      rounds++;
      // One even share of the budget, every time — NOT "whatever is still
      // missing", which is what a blocked stream would get if the remainder
      // were split across just the (usually one) stream that drained. That
      // sizing looks smarter and costs far more: the deeper into a window a
      // stream drains, the bigger its refill, so a handful of drains near the
      // end pulls close to a full budget each. A flat share keeps every
      // round-trip the same small page and lets a stream that keeps
      // contributing simply come back for another one.
      const chunk = Math.max(1, Math.ceil(budget / Math.max(1, relevantProjects.length)));
      applyOutcomes(
        await fetchRound(
          blocked.map((project) => ({
            project,
            cursor: cursors[projectKeyOf(project)].cursor,
          })),
          chunk,
        ),
      );
      continue;
    }
    const next = shiftNewestRow(buffers);
    if (next === null) {
      // Frontier is clear and nothing is buffered: every stream is exhausted.
      break;
    }
    taken.push(next);
  }

  for (const project of relevantProjects) {
    const key = projectKeyOf(project);
    cursors[key] = { ...cursors[key], buffer: buffers.get(key) ?? [] };
  }
  return { taken, cursors, errors, offlineStatusByProject };
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
  /** Summed `pageInfo.totalCount` across whichever in-scope projects have
   * reported one so far, per status (pas-2KY5X.25) — a project that hasn't
   * answered yet (including "never requested") or whose fetch failed
   * contributes nothing rather than blanking the whole section. `null` only
   * when a project answered successfully, may have contributed real rows,
   * and still didn't report a total (old CLI binary predating total_count)
   * — the screen falls back to loaded-so-far counts (`trackers.length`) in
   * that one case, since skipping it could otherwise undercount below what's
   * on screen. */
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

  // Reactive trigger for the imperative getLastServerInfoMessage reads below
  // — same shape as useTrackerStats' featureSupportKey (pas-2KY5X.1).
  const sortSupportKey = useSessionStore((state) =>
    relevantProjects
      .map(
        (project) =>
          `${project.serverId}:${
            state.sessions[project.serverId]?.serverInfo?.features?.aitTrackerSort === true
          }`,
      )
      .join("|"),
  );
  // Whether every relevant project's host currently advertises
  // aitTrackerSort, and whether that answer is even known yet.
  // getLastServerInfoMessage() is undefined until a host's hello resolves —
  // reading it before then and treating "undefined" as "false" (the bug this
  // memo now avoids) picks per-project-fallback mode immediately, then flips
  // to merged/budgeted mode the instant every hello lands. mergeMode is
  // baked into scopeKey (below), so that flip is a full isNewScope reset —
  // exactly the "164 rows, then a reset to 20" flap this hook shipped with
  // (pas-2KY5X.25). Checked per project rather than assumed workspace-wide,
  // since each project can sit on a different daemon: all-projects mode
  // needs every relevant project sorted server-side, or the merge below
  // (fetchMergedStatusWindow) would be silently wrong for whichever one
  // isn't — it only ever reads a stream's buffered head, which is only a
  // valid "next newest" candidate when the stream really is sorted.
  //
  // `connectionStatuses` distinguishes "genuinely don't know yet" from
  // "know it's false": daemon-client.ts sets the client's own
  // lastServerInfoMessage synchronously, one call before it flips
  // connectionState (and thus this host's connectionStatus snapshot) to
  // "online" — so a "connecting" host's undefined read really is unresolved,
  // while an "online" host's read is guaranteed final, never a pre-hello
  // miss. "offline"/"error" are deliberately NOT treated as pending: a host
  // cycles those with "connecting" forever on its own reconnect/probe
  // backoff (never a permanent give-up), so waiting on them here would let
  // one unreachable project block every other project's data indefinitely.
  // They resolve to "doesn't support" immediately instead — the same
  // fallback the fetch itself already takes for an offline host — and
  // retryReconnectedProjects re-fetches under the right mode once that host
  // actually comes back.
  const { sortSupportPending, allSupportSort } = useMemo(() => {
    if (relevantProjects.length === 0) {
      return { sortSupportPending: false, allSupportSort: false };
    }
    let pending = false;
    let everySupports = true;
    for (const project of relevantProjects) {
      const status = connectionStatuses.get(project.serverId);
      if (status === undefined || status === "connecting") {
        pending = true;
        everySupports = false;
        continue;
      }
      if (
        status !== "online" ||
        runtime.getClient(project.serverId)?.getLastServerInfoMessage()?.features
          ?.aitTrackerSort !== true
      ) {
        everySupports = false;
      }
    }
    return { sortSupportPending: pending, allSupportSort: everySupports };
    // sortSupportKey is the reactive trigger for the imperative
    // getLastServerInfoMessage reads above; connectionStatuses is the
    // reactive trigger for connectionStatus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relevantProjects, runtime, sortSupportKey, connectionStatuses]);
  // "All projects" (nothing selected) with every relevant project sorted:
  // budget the fetch across all of them via fetchMergedStatusWindow instead
  // of pageSize-per-project (pas-2KY5X.15). A single project selected has
  // nothing to interleave, so it stays on the per-project path below even
  // when sorted — but still requests `sort: "newest"` there, since a real
  // order beats an arbitrary id order for one project too. Any relevant
  // project lacking the capability falls the whole scope back to the
  // per-project path: a partial merge (some projects sorted, one not) can't
  // be done correctly without fetching that one project's entire dataset —
  // exactly the sweep this batch already rejected — so an honest "N per
  // project, but N is now smaller" beats a merge that's silently wrong for
  // one contributor.
  const mergeMode = options.selectedProjectId === null && allSupportSort;

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
  // a full reset. mergeMode is included: switching between the per-project
  // cursor scheme and the merged-budget one (buffers included) mid-flight
  // would leave stale cursors in the shape the other scheme doesn't expect,
  // so a capability change (rare — a daemon upgrading mid-session) resets
  // and re-fetches from scratch, same as any other scope-defining option.
  // This does NOT by itself stop mergeMode's mount-time race (undefined
  // capability reading as false, then flipping true once every hello lands)
  // from bouncing scopeKey — syncSections is what actually closes that gap,
  // by deferring the first fetch of a new scope until sortSupportPending
  // clears, so mergeMode is never guessed-then-corrected in the first place.
  const scopeKey = useMemo(
    () =>
      [
        options.enabled ? "1" : "0",
        options.selectedProjectId ?? "all",
        options.all ? "all" : "scoped",
        String(options.pageSize),
        options.type ?? "any-type",
        options.priority ?? "any-priority",
        mergeMode ? "merged" : "per-project",
        ...relevantProjects.map((p) => `${p.serverId}:${p.projectId}`).sort(),
      ].join("|"),
    [
      options.enabled,
      options.selectedProjectId,
      options.all,
      options.pageSize,
      options.type,
      options.priority,
      mergeMode,
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
  // True while the current scope (lastScopeKeyRef) has been reset but is
  // still withholding its first real fetch, waiting on sortSupportPending to
  // clear. Deliberately separate from the isNewScope check itself: syncSections
  // can end up invoked many times for the exact same scope while this is
  // true — desiredSectionsKey is stable, but syncSections' own identity
  // isn't guaranteed to be, since it depends (via runMergedFetch) on
  // relevantProjects, which is only reference-stable if the caller memoizes
  // `options.projects` — plenty of real call sites don't. Gating the actual
  // reset (setSections/setPendingStatuses/etc., all of which allocate fresh
  // objects) behind isNewScope, and gating the wait itself behind this ref
  // instead of re-deriving it from scopeKey equality, is what makes a repeat
  // call while still pending a true no-op (no setState at all) rather than
  // re-running the reset with fresh references on every invocation — the
  // "Maximum update depth exceeded" render loop an earlier version of this
  // fix produced when combined with an unmemoized caller.
  const awaitingSortCapabilityRef = useRef(false);
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

  // Updates one project's cursor for `status` without touching the
  // displayed trackers — merge mode's retryReconnectedProjects uses this
  // instead of mergePage, since a reconnect's rows land in that project's
  // buffer (picked up by the next "Show more") rather than being spliced
  // into what's already on screen, which would reshuffle a window the user
  // is already looking at.
  const setProjectCursor = useCallback(
    (status: TrackerStatus, projectKey: string, cursor: CursorState) => {
      setSections((current) => {
        const section = current[status];
        return {
          ...current,
          [status]: {
            trackers: section.trackers,
            cursors: { ...section.cursors, [projectKey]: cursor },
          },
        };
      });
    },
    [],
  );

  // Applies one status's MergedWindowResult — shared by syncSections (one
  // call per newly-requested status) and loadMore (one call for the status
  // being paged). Appends `taken` to the displayed trackers, replaces every
  // touched project's cursor (including its leftover buffer) in one write,
  // reconciles offlineProjectKeysRef, and surfaces any fetch errors.
  const applyMergedResult = useCallback((status: TrackerStatus, result: MergedWindowResult) => {
    setSections((current) => {
      const trackers = [...current[status].trackers, ...result.taken];
      sortMerged(trackers);
      return {
        ...current,
        [status]: {
          trackers,
          cursors: { ...current[status].cursors, ...result.cursors },
        },
      };
    });
    for (const [projectKey, wasOffline] of result.offlineStatusByProject) {
      if (wasOffline) {
        offlineProjectKeysRef.current.add(projectKey);
      } else {
        offlineProjectKeysRef.current.delete(projectKey);
      }
    }
    if (result.errors.length > 0) {
      setProjectErrors((current) => {
        const additions = result.errors.filter((error) => !hasErrorForProject(current, error));
        return additions.length > 0 ? [...current, ...additions] : current;
      });
    }
  }, []);

  // Runs fetchMergedStatusWindow for every status in `statuses`, one status
  // per parallel branch (each status's own rounds still run in sequence
  // within itself, since round N needs round N-1's results to know which
  // projects are still hungry). Shared by syncSections (always calls with
  // empty priorCursorsByStatus — a status is only ever synced once per
  // scope, so there's nothing to carry over yet) and loadMore (passes the
  // live cursors, so leftover buffer from an earlier over-fetch is consumed
  // before anything new is requested).
  const runMergedFetch = useCallback(
    async (
      statuses: readonly TrackerStatus[],
      priorCursorsByStatus: Readonly<Partial<Record<TrackerStatus, Record<string, CursorState>>>>,
      budget: number,
    ): Promise<Record<TrackerStatus, MergedWindowResult>> => {
      const fetchRoundFor =
        (status: TrackerStatus) =>
        async (
          targets: readonly { project: TrackerProjectInput; cursor: string | null }[],
          limit: number,
        ): Promise<MergeFetchOutcome[]> =>
          Promise.all(
            targets.map(async ({ project, cursor }) => {
              const wasOfflineAtFetch =
                runtime.getSnapshot(project.serverId)?.connectionStatus !== "online";
              try {
                const result = await fetchTrackerPage({
                  project,
                  runtime,
                  status,
                  all: options.all,
                  limit,
                  type: options.type,
                  priority: options.priority,
                  sort: "newest",
                  cursor: cursor ?? undefined,
                });
                return {
                  project,
                  trackers: result.trackers,
                  cursor: result.pageInfo?.nextCursor ?? null,
                  hasMore: result.pageInfo?.hasMore ?? false,
                  totalCount: result.pageInfo?.totalCount ?? null,
                  wasOfflineAtFetch,
                  error: null as unknown,
                };
              } catch (error) {
                return {
                  project,
                  trackers: [],
                  cursor: null,
                  hasMore: false,
                  totalCount: null,
                  wasOfflineAtFetch,
                  error,
                };
              }
            }),
          );

      const results = await Promise.all(
        statuses.map((status) =>
          fetchMergedStatusWindow(
            relevantProjects,
            budget,
            priorCursorsByStatus[status] ?? {},
            fetchRoundFor(status),
          ),
        ),
      );
      const byStatus = {} as Record<TrackerStatus, MergedWindowResult>;
      statuses.forEach((status, index) => {
        byStatus[status] = results[index]!;
      });
      return byStatus;
    },
    [relevantProjects, runtime, options.all, options.type, options.priority],
  );

  // Pulled out of syncSections purely to keep its own complexity under the
  // lint threshold — this piece is a straight-line reset with no branching
  // of its own worth reasoning about separately from the isNewScope check
  // that calls it.
  const resetScopeState = useCallback(
    (nextScopeKey: string, statuses: readonly TrackerStatus[], willFetch: boolean) => {
      lastScopeKeyRef.current = nextScopeKey;
      // Bumped unconditionally, even if this scope ends up deferred by the
      // capability check right after this returns — any fetch still in
      // flight from the *previous* scope must be rejected as stale the
      // moment it resolves, deferred or not.
      loadSeqRef.current += 1;
      loadingMoreRef.current.clear();
      requestedStatusesRef.current = new Set();
      offlineProjectKeysRef.current = new Set();
      setSections(createEmptySections());
      setSectionLoadingMore(createEmptyStatusRecord(false));
      setProjectErrors([]);
      setPendingStatuses(willFetch ? new Set(statuses) : new Set());
    },
    [],
  );

  // Ensures the first page of every (project, status) pair in `statuses` has
  // been requested for the current scope, merging results into whatever is
  // already loaded rather than replacing it. A scope change (scopeKey)
  // resets everything first — every already-loaded status is invalidated and
  // has to be re-requested, exactly like a fresh mount; a `statuses` change
  // alone (same scope) only fetches whichever of them haven't been requested
  // yet. A brand-new scope whose mergeMode is still undetermined
  // (sortSupportPending) resets display state but withholds the actual fetch
  // until every relevant project's capability is known — see the isNewScope
  // block below.
  const syncSections = useCallback(
    async (statuses: readonly TrackerStatus[]): Promise<void> => {
      const isNewScope = lastScopeKeyRef.current !== scopeKey;
      const willFetch = options.enabled && relevantProjects.length > 0;
      if (isNewScope) {
        // Recognized (and lastScopeKeyRef updated) immediately, before the
        // capability check below — a repeat call for this same scope, from
        // any cause, must see isNewScope as false and skip straight past
        // this whole block without touching state again. syncSections isn't
        // guaranteed to be invoked exactly once per logical scope change: its
        // own identity depends (via runMergedFetch) on relevantProjects,
        // which is only reference-stable across renders if the caller
        // memoizes `options.projects` — not guaranteed. Re-running this
        // reset on every such call would allocate fresh
        // sections/pendingStatuses objects each time, each one a genuine
        // state change that forces another render — an infinite render loop
        // whenever combined with an unmemoized caller and a still-pending
        // capability below (caught by this fix's own tests as "Maximum
        // update depth exceeded").
        resetScopeState(scopeKey, statuses, willFetch);
        awaitingSortCapabilityRef.current = willFetch && sortSupportPending;
      }
      if (awaitingSortCapabilityRef.current) {
        // Every relevant project's aitTrackerSort support must be known
        // before picking merge vs per-project mode — mode is baked into
        // scopeKey, so guessing now (undefined reads as unsupported) and
        // correcting once the last hello lands would mean a second
        // isNewScope reset right after the first paint: a page of rows
        // under the wrong strategy, thrown away and re-fetched under the
        // right one (pas-2KY5X.25). "Pending" only means "still mid
        // handshake" — bounded by the client's own connect timeout, never
        // permanent, see the allSupportSort memo above — so this can't
        // strand the scope in a loading state forever. mergeMode/
        // allSupportSort/sortSupportPending are this callback's own
        // dependencies, so the capability resolving later gives syncSections
        // a new identity, which re-fires the mount effect below — this time
        // with isNewScope already false (lastScopeKeyRef was set above) and
        // sortSupportPending false, so it falls through past this check and
        // actually fetches. pendingStatuses was already set on the isNewScope
        // pass, so isLoading stays true for the whole wait instead of
        // settling on an empty page.
        if (sortSupportPending) {
          return;
        }
        awaitingSortCapabilityRef.current = false;
      }
      const seq = loadSeqRef.current;
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

      // Budgeted across every relevant project instead of pageSize-per, and
      // routed through fetchMergedStatusWindow (pas-2KY5X.15) — see mergeMode
      // above for when this applies. Always called with empty prior cursors:
      // syncSections only ever fetches a status the first time it's
      // requested for the current scope (toFetch already excludes anything
      // requestedStatusesRef has seen), so there is never leftover buffer to
      // carry over here — that only happens on a later loadMore.
      if (mergeMode) {
        const merged = await runMergedFetch(toFetch, {}, options.pageSize);
        if (seq !== loadSeqRef.current) {
          // Stale — a newer scope reset already reseeded pendingStatuses and
          // sections for the current scope; this batch belongs to an
          // abandoned one and must not touch either.
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
        for (const status of toFetch) {
          applyMergedResult(status, merged[status]!);
        }
        return;
      }

      // Per-project pagination — a single project selected, or a relevant
      // project's host not (yet) advertising aitTrackerSort (see mergeMode
      // above). Still requests `sort: "newest"` whenever every relevant
      // project supports it, even without the merge: a real order beats an
      // arbitrary id order for a single project too.
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
                ...(allSupportSort ? { sort: "newest" as TrackerSort } : {}),
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
      // Computed from `pages` (already fully resolved — a plain array, not
      // React state) before setSections rather than inside its updater: a
      // functional setState updater is not guaranteed to run synchronously
      // within this call — React can (and in practice does, per this fix's
      // own tests) defer invoking it until the next reconciliation — so an
      // `errors` array only ever populated *inside* that updater reads back
      // empty here, right after the setSections call, every single time.
      // That was pre-existing pas-2KY5X.25 discovered as a byproduct of
      // testing sectionTotals' own error handling: projectErrors was never
      // populated at all for a project that failed during this initial
      // per-project-fallback fetch, unlike the merge-mode and loadMore
      // fetch paths, which both already compute their error list outside
      // any updater and don't have this problem.
      const seenErrorProjects = new Set<string>();
      const errors: TrackerProjectError[] = [];
      for (const page of pages) {
        if (page.error && !seenErrorProjects.has(projectKeyOf(page.project))) {
          seenErrorProjects.add(projectKeyOf(page.project));
          errors.push(toTrackerProjectError(page.project, page.error));
        }
      }
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
            next[page.status].cursors[projectKey] = ERRORED_CURSOR;
            continue;
          }
          const result = page.result!;
          next[page.status].trackers.push(...result.trackers);
          next[page.status].cursors[projectKey] = {
            cursor: result.pageInfo?.nextCursor ?? null,
            hasMore: result.pageInfo?.hasMore ?? false,
            totalCount: result.pageInfo?.totalCount ?? null,
            buffer: [],
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
    // closure reads. sortSupportPending resolving is what re-fires this
    // callback (and the mount effect below) to actually run a deferred
    // isNewScope fetch — see the isNewScope block above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      scopeKey,
      runtime,
      mergeMode,
      allSupportSort,
      sortSupportPending,
      runMergedFetch,
      applyMergedResult,
      resetScopeState,
    ],
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
    // Lands a reconnected project's page in its buffer rather than splicing
    // it directly into the displayed window in merge mode — see
    // setProjectCursor — and appends it normally otherwise.
    const applyReconnectedPage = (
      status: TrackerStatus,
      projectKey: string,
      trackers: AggregatedTracker[],
      cursor: string | null,
      hasMore: boolean,
      totalCount: number | null,
    ): void => {
      if (mergeMode) {
        const priorBuffer = sectionsRef.current[status].cursors[projectKey]?.buffer ?? [];
        setProjectCursor(status, projectKey, {
          cursor,
          hasMore,
          totalCount,
          buffer: [...priorBuffer, ...trackers],
        });
      } else {
        mergePage(status, projectKey, trackers, { cursor, hasMore, totalCount, buffer: [] });
      }
    };
    const applyReconnectedError = (status: TrackerStatus, projectKey: string): void => {
      if (mergeMode) {
        setProjectCursor(status, projectKey, ERRORED_CURSOR);
      } else {
        mergePage(status, projectKey, [], ERRORED_CURSOR);
      }
    };
    const retryOne = async (project: TrackerProjectInput, status: TrackerStatus): Promise<void> => {
      const projectKey = projectKeyOf(project);
      try {
        const result = await fetchTrackerPage({
          project,
          runtime,
          status,
          all: options.all,
          limit: options.pageSize,
          type: options.type,
          priority: options.priority,
          ...(allSupportSort ? { sort: "newest" as TrackerSort } : {}),
        });
        if (seq !== loadSeqRef.current) {
          return;
        }
        offlineProjectKeysRef.current.delete(projectKey);
        applyReconnectedPage(
          status,
          projectKey,
          result.trackers,
          result.pageInfo?.nextCursor ?? null,
          result.pageInfo?.hasMore ?? false,
          result.pageInfo?.totalCount ?? null,
        );
      } catch (error) {
        if (seq !== loadSeqRef.current) {
          return;
        }
        // Fetched while online (targets already required that), so a thrown
        // error is a real RPC failure, not an offline masking — clear the
        // offline flag so a future reconnect doesn't retry a failure that
        // has nothing to do with connectivity.
        offlineProjectKeysRef.current.delete(projectKey);
        setProjectErrors((current) =>
          hasErrorForProject(current, project)
            ? current
            : [...current, toTrackerProjectError(project, error)],
        );
        applyReconnectedError(status, projectKey);
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
    mergeMode,
    allSupportSort,
    mergePage,
    setProjectCursor,
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

      if (mergeMode) {
        // "More to load" includes leftover buffer, not just hasMore — a
        // project can already be sitting on rows this section over-fetched
        // last time (see fetchMergedStatusWindow), which this call should
        // spend before requesting anything new.
        const hasMoreToLoad = relevantProjects.some((project) => {
          const cursor = currentCursors[projectKeyOf(project)];
          return cursor?.hasMore === true || (cursor?.buffer.length ?? 0) > 0;
        });
        if (!hasMoreToLoad) {
          return;
        }
        loadingMoreRef.current.add(status);
        setSectionLoadingMore((current) => ({ ...current, [status]: true }));
        void (async () => {
          const merged = await runMergedFetch(
            [status],
            { [status]: currentCursors },
            options.pageSize,
          );
          loadingMoreRef.current.delete(status);
          // Clear the in-flight flag unconditionally, before the staleness
          // bail — otherwise a scope change mid-fetch strands this status's
          // spinner on forever, since the scope reset resets it once up
          // front but nothing clears it again once this branch returns
          // early.
          setSectionLoadingMore((current) => ({ ...current, [status]: false }));
          if (seq !== loadSeqRef.current) {
            return;
          }
          applyMergedResult(status, merged[status]!);
        })();
        return;
      }

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
                ...(allSupportSort ? { sort: "newest" as TrackerSort } : {}),
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
            buffer: [],
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
      mergeMode,
      allSupportSort,
      runMergedFetch,
      applyMergedResult,
      mergePage,
    ],
  );

  const sectionHasMore = useMemo(() => {
    const result = createEmptyStatusRecord(false);
    for (const status of LIST_SECTION_STATUSES) {
      result[status] = Object.values(sections[status].cursors).some(
        (cursorState) => cursorState.hasMore || cursorState.buffer.length > 0,
      );
    }
    return result;
  }, [sections]);

  // Sums whichever in-scope projects have actually reported a total, per
  // status — the counterpart to useTrackerStats' pas-2KY5X.14 fix, applied
  // here for the same reason: a project that simply hasn't answered yet (no
  // cursorState) contributes nothing rather than blanking the whole section.
  //
  // A project whose cursorState exists but totalCount is null needs one more
  // check before it can be skipped the same way: did it actually contribute
  // rows to `trackers` for this status? An offline host or a real fetch
  // failure both resolve with zero rows AND totalCount: null (fetchTrackerPage
  // returns an empty page rather than throwing for an offline host, so this
  // can't be told apart from a genuine error by the cursorState shape alone
  // — checking rows instead sidesteps that entirely) — safe to skip, exactly
  // like "hasn't answered yet", since the sum can't end up lower than what's
  // on screen when the project in question isn't on screen at all. A project
  // that answered successfully AND has rows in `trackers` but still didn't
  // report a total (old CLI binary predating total_count) is different:
  // treating it as a silent zero here could sum to less than the row count
  // already rendered — worse than the bug this is fixing. That case keeps
  // the pre-pas-2KY5X.25 behavior: it poisons the whole section to `null`,
  // and the caller (tracker-table.tsx) falls back to the loaded row count,
  // which is never smaller than what's displayed.
  const sectionTotals = useMemo(() => {
    const result = createEmptyStatusRecord<number | null>(0);
    for (const status of LIST_SECTION_STATUSES) {
      const cursors = sections[status].cursors;
      const trackers = sections[status].trackers;
      let sum = 0;
      let poisoned = false;
      for (const project of relevantProjects) {
        const projectKey = projectKeyOf(project);
        const cursorState = cursors[projectKey];
        if (!cursorState) {
          continue;
        }
        if (cursorState.totalCount !== null) {
          sum += cursorState.totalCount;
          continue;
        }
        if (trackers.some((tracker) => projectKeyOf(tracker) === projectKey)) {
          poisoned = true;
          break;
        }
      }
      result[status] = poisoned ? null : sum;
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
