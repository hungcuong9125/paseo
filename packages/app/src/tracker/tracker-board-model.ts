import type { TrackerStatus, TrackerSummary } from "@getpaseo/protocol/tracker/types";
import { compareTrackers } from "@/tracker/tracker-hierarchy";
import { matchesTrackerStatFilter, type TrackerStatFilter } from "@/tracker/tracker-stats";

// Same domain as the toolbar's filter, reused directly — see "Toolbar contract"
// in docs/refactors/tracker-kanban-redesign.md: Kanban gives this one control a
// second meaning (lane projection) rather than inventing a parallel filter type.
export type TrackerBoardFilter = TrackerStatFilter;

export type TrackerBoardLaneKey = "open" | "in_progress" | "done";

export interface TrackerBoardCard {
  tracker: TrackerSummary;
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

function isPriorityFilter(filter: TrackerBoardFilter): filter is "p0" | "p1" | "p2" | "p3" | "p4" {
  return (
    filter === "p0" || filter === "p1" || filter === "p2" || filter === "p3" || filter === "p4"
  );
}

// `updatedAt` is optional on TrackerSummary (older callers may not populate
// it yet), so missing values still sort last. ISO-8601 strings sort
// lexicographically the same as chronologically.
function compareByRecency(left: TrackerSummary, right: TrackerSummary): number {
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
  trackers: readonly TrackerSummary[],
  filter: TrackerBoardFilter,
): TrackerBoard {
  const visibleLanes = visibleLanesForFilter(filter);
  const isPriority = isPriorityFilter(filter);

  const open: TrackerBoardCard[] = [];
  const inProgress: TrackerBoardCard[] = [];
  const done: TrackerBoardCard[] = [];

  for (const tracker of trackers) {
    const lane = laneForStatus(tracker.status);
    if (!visibleLanes.includes(lane)) {
      continue;
    }
    if (isPriority && !matchesTrackerStatFilter(tracker, filter)) {
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

  open.sort((a, b) => compareTrackers(a.tracker, b.tracker));
  inProgress.sort((a, b) => compareTrackers(a.tracker, b.tracker));
  done.sort((a, b) => compareByRecency(a.tracker, b.tracker));

  return { visibleLanes, open, in_progress: inProgress, done };
}
