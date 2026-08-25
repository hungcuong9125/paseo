import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";

// Guards against malformed `parentId` chains emitted by the `ait` CLI:
// ancestor cycles (a tracker that is its own descendant) and unbounded depth.
// These mirror the protections that previously lived inline in kanban-grouping.ts.
export const MAX_TREE_DEPTH = 32;

export interface DescendantStats {
  childCount: number;
  doneCount: number;
}

// `closed` and `cancelled` both count as done for progress purposes. The card's
// child-progress line ("3/7") is derived from this, so a cancelled subtree still
// advances the count — but the board must never present cancelled as "completed
// successfully" (the UI owns that distinction).
export function isDone(tracker: TrackerSummary): boolean {
  return tracker.status === "closed" || tracker.status === "cancelled";
}

// The implicit card ordering used everywhere the board sorts trackers: priority
// first, then id as a stable tiebreaker. Exported so the status board names its
// sort instead of re-deriving it.
export function compareTrackers(left: TrackerSummary, right: TrackerSummary): number {
  return left.priority.localeCompare(right.priority) || left.id.localeCompare(right.id);
}

// Mirrors `ait list --sort newest`'s own order (pas-2KY5X.19): createdAt
// descending, id descending as the tiebreaker — the tiebreaker follows the
// sort direction there, so it has to here too, or a client-side sort or merge
// picks a different "next" row than the server would have for the same
// stream. A row missing createdAt (a response from before sort support
// existed) sorts after everything that has one rather than crashing the
// comparison.
//
// The single shared "newest" key across selection (use-tracker-project-data's
// k-way merge), lane ordering (tracker-board-model's Done/Cancelled lanes),
// and the card label (tracker-kanban-card renders createdAt) — pas-2KY5X.23
// found those three disagreeing (two different fields, two different
// tiebreakers) and produced a visibly scrambled order. Sharing this function
// is what keeps them from drifting apart again; do not re-derive a local copy.
export function compareByCreatedNewest(left: TrackerSummary, right: TrackerSummary): number {
  if (
    left.createdAt !== undefined &&
    right.createdAt !== undefined &&
    left.createdAt !== right.createdAt
  ) {
    return left.createdAt < right.createdAt ? 1 : -1;
  }
  if (left.createdAt !== undefined && right.createdAt === undefined) {
    return -1;
  }
  if (left.createdAt === undefined && right.createdAt !== undefined) {
    return 1;
  }
  return left.id < right.id ? 1 : -1;
}

// A precomputed parent/child index over a flat `TrackerSummary[]`. Built once and
// reused so descendant stats cost no repeated scans. The guards live inside
// `descendantStats`, which is the operation a status board calls per parent.
export interface TrackerHierarchy {
  trackerMap: ReadonlyMap<string, TrackerSummary>;
  childrenOf: ReadonlyMap<string, TrackerSummary[]>;
  // Aggregates the entire subtree under `parentId` (direct children + all
  // descendants). `childCount`/`doneCount` match the descendantStats shape the
  // card progress line consumes. Never visits an ancestor twice and never descends
  // past `MAX_TREE_DEPTH`, so a cyclic or deep `parentId` chain cannot loop.
  descendantStats(
    parentId: string,
    ancestors?: ReadonlySet<string>,
    depth?: number,
  ): DescendantStats;
}

export function buildTrackerHierarchy(trackers: TrackerSummary[]): TrackerHierarchy {
  const trackerMap = new Map<string, TrackerSummary>(
    trackers.map((tracker) => [tracker.id, tracker]),
  );
  const childrenOf = new Map<string, TrackerSummary[]>();
  for (const tracker of trackers) {
    if (!tracker.parentId) {
      continue;
    }
    const children = childrenOf.get(tracker.parentId) ?? [];
    children.push(tracker);
    childrenOf.set(tracker.parentId, children);
  }
  for (const children of childrenOf.values()) {
    children.sort(compareTrackers);
  }

  const descendantStats = (
    parentId: string,
    ancestors: ReadonlySet<string> = new Set<string>(),
    depth = 0,
  ): DescendantStats => {
    if (depth >= MAX_TREE_DEPTH || ancestors.has(parentId)) {
      return { childCount: 0, doneCount: 0 };
    }
    const nextAncestors = new Set(ancestors).add(parentId);
    let childCount = 0;
    let doneCount = 0;
    for (const child of childrenOf.get(parentId) ?? []) {
      childCount += 1;
      doneCount += isDone(child) ? 1 : 0;
      const nested = descendantStats(child.id, nextAncestors, depth + 1);
      childCount += nested.childCount;
      doneCount += nested.doneCount;
    }
    return { childCount, doneCount };
  };

  return { trackerMap, childrenOf, descendantStats };
}
