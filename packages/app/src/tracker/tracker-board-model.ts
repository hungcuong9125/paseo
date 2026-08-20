import type {
  TrackerPriority,
  TrackerStatus,
  TrackerSummary,
} from "@getpaseo/protocol/tracker/types";

// `updatedAt` lands on `TrackerSummary` via a sibling protocol task (see
// docs/refactors/tracker-kanban-redesign.md, "Data contract — no per-card fetch").
// Extend locally until it does; switch every reference below to `TrackerSummary` once merged.
export interface TrackerBoardTracker extends TrackerSummary {
  updatedAt?: string;
}

// Same value set as `TrackerStatFilter` in packages/app/src/tracker/tracker-stats.ts,
// declared locally because that file is an uncommitted diff owned by another agent —
// do not import from it.
export type TrackerBoardFilter =
  | "all"
  | "open"
  | "in_progress"
  | "done"
  | "p0"
  | "p1"
  | "p2"
  | "p3"
  | "p4";

export type TrackerBoardLaneKey = "open" | "in_progress" | "done";

export interface TrackerBoardCard {
  tracker: TrackerBoardTracker;
  /** True only for `status === "cancelled"`. Cancelled items share the Done
   * lane with `closed` items but must never render with the plain "success"
   * done treatment — this flag is what lets the card tell the two apart. */
  isCancelled: boolean;
}

export interface TrackerBoard {
  /** Lanes the toolbar filter projects onto, in display order. A lane absent
   * here is a different signal than "this lane has zero cards" — it should
   * not be rendered at all (see docs/refactors/tracker-kanban-redesign.md,
   * "Toolbar contract"). */
  visibleLanes: readonly TrackerBoardLaneKey[];
  open: TrackerBoardCard[];
  in_progress: TrackerBoardCard[];
  done: TrackerBoardCard[];
}

const ALL_LANES: readonly TrackerBoardLaneKey[] = ["open", "in_progress", "done"];

function laneForStatus(status: TrackerStatus): TrackerBoardLaneKey {
  switch (status) {
    case "open":
      return "open";
    case "in_progress":
      return "in_progress";
    case "closed":
    case "cancelled":
      return "done";
  }
}

function visibleLanesForFilter(filter: TrackerBoardFilter): readonly TrackerBoardLaneKey[] {
  switch (filter) {
    case "all":
      return ALL_LANES;
    case "open":
      return ["open"];
    case "in_progress":
      return ["in_progress"];
    case "done":
      return ["done"];
    case "p0":
    case "p1":
    case "p2":
    case "p3":
    case "p4":
      return ["open", "in_progress"];
  }
}

function priorityForFilter(filter: TrackerBoardFilter): TrackerPriority | null {
  switch (filter) {
    case "p0":
      return "P0";
    case "p1":
      return "P1";
    case "p2":
      return "P2";
    case "p3":
      return "P3";
    case "p4":
      return "P4";
    default:
      return null;
  }
}

// Mirrors matchesTrackerStatFilter's p0-p4 semantics in
// packages/app/src/tracker/tracker-stats.ts ("active AND that priority").
// Not imported — that file is an uncommitted diff owned by another agent.
function matchesPriority(tracker: TrackerSummary, priority: TrackerPriority): boolean {
  const active = tracker.status === "open" || tracker.status === "in_progress";
  return active && tracker.priority === priority;
}

// TODO: import compareTrackers from tracker-hierarchy.ts once the sibling
// extraction task lands (docs/refactors/tracker-kanban-redesign.md, "What
// survives from kanban-grouping.ts"). Priority then id, same as the
// unexported compareTrackers in kanban-grouping.ts.
function compareByPriorityThenId(left: TrackerSummary, right: TrackerSummary): number {
  return left.priority.localeCompare(right.priority) || left.id.localeCompare(right.id);
}

// TODO: switch to a real Date comparison once `updatedAt` is guaranteed on
// TrackerSummary. ISO-8601 strings sort lexicographically the same as
// chronologically, which stands in fine until then.
function compareByRecency(left: TrackerBoardTracker, right: TrackerBoardTracker): number {
  if (left.updatedAt && right.updatedAt) {
    return right.updatedAt.localeCompare(left.updatedAt);
  }
  if (left.updatedAt) {
    return -1;
  }
  if (right.updatedAt) {
    return 1;
  }
  return left.id.localeCompare(right.id);
}

/**
 * Partitions a flat tracker list into the three Kanban status lanes and
 * projects them through the toolbar's status filter. Partitioning is by
 * `status` alone — `parentId` is never read, so malformed or cyclic hierarchy
 * data cannot affect lane placement.
 */
export function buildTrackerBoard(
  trackers: readonly TrackerBoardTracker[],
  filter: TrackerBoardFilter,
): TrackerBoard {
  const visibleLanes = visibleLanesForFilter(filter);
  const priority = priorityForFilter(filter);

  const open: TrackerBoardCard[] = [];
  const inProgress: TrackerBoardCard[] = [];
  const done: TrackerBoardCard[] = [];

  for (const tracker of trackers) {
    const lane = laneForStatus(tracker.status);
    if (!visibleLanes.includes(lane)) {
      continue;
    }
    if (priority && !matchesPriority(tracker, priority)) {
      continue;
    }

    const card: TrackerBoardCard = { tracker, isCancelled: tracker.status === "cancelled" };
    switch (lane) {
      case "open":
        open.push(card);
        break;
      case "in_progress":
        inProgress.push(card);
        break;
      case "done":
        done.push(card);
        break;
    }
  }

  open.sort((a, b) => compareByPriorityThenId(a.tracker, b.tracker));
  inProgress.sort((a, b) => compareByPriorityThenId(a.tracker, b.tracker));
  done.sort((a, b) => compareByRecency(a.tracker, b.tracker));

  return { visibleLanes, open, in_progress: inProgress, done };
}
