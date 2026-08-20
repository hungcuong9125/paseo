import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";
import { compareTrackers } from "@/tracker/tracker-hierarchy";
import { matchesTrackerStatFilter, type TrackerStatFilter } from "@/tracker/tracker-stats";

// Same domain as the toolbar's filter, reused directly — see "Toolbar contract"
// in docs/refactors/tracker-kanban-redesign.md: Kanban gives this one control a
// second meaning (lane projection) rather than inventing a parallel filter type.
export type TrackerBoardFilter = TrackerStatFilter;

export type TrackerBoardLaneKey = "ready" | "open" | "in_progress" | "done" | "cancelled";

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
  ready: TrackerBoardCard[];
  open: TrackerBoardCard[];
  in_progress: TrackerBoardCard[];
  done: TrackerBoardCard[];
  cancelled: TrackerBoardCard[];
}

const ALL_LANES: readonly TrackerBoardLaneKey[] = [
  "ready",
  "open",
  "in_progress",
  "done",
  "cancelled",
];

// Ready is derived, not a peer TrackerStatus: an item is Ready iff it is
// `open` AND unblocked (its id is in `readyIds`, from `project.tracker.ready`).
// An `open` item not in `readyIds` is blocked and stays in Open. In progress
// and Done never depend on `readyIds`.
function laneForTracker(
  tracker: TrackerSummary,
  readyIds: ReadonlySet<string>,
): TrackerBoardLaneKey {
  switch (tracker.status) {
    case "open":
      return readyIds.has(tracker.id) ? "ready" : "open";
    case "in_progress":
      return "in_progress";
    case "closed":
      return "done";
    case "cancelled":
      return "cancelled";
  }
}

function visibleLanesForFilter(filter: TrackerBoardFilter): readonly TrackerBoardLaneKey[] {
  switch (filter) {
    case "all":
      return ALL_LANES;
    case "open":
      // Ready and Open are both status==="open" under the hood, split only
      // visually — selecting the Open filter must not hide unblocked items.
      return ["ready", "open"];
    case "in_progress":
      return ["in_progress"];
    case "done":
      // Closed and cancelled are both terminal and both excluded from the
      // priority filters; selecting the Done filter must not hide cancelled items.
      return ["done", "cancelled"];
    case "p0":
    case "p1":
    case "p2":
    case "p3":
    case "p4":
      return ["ready", "open", "in_progress"];
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
 * Partitions a flat tracker list into the five Kanban lanes and projects them
 * through the toolbar's status filter. Partitioning is by `status` (plus
 * `readyIds` membership for the open/ready split) alone — `parentId` is never
 * read, so malformed or cyclic hierarchy data cannot affect lane placement.
 *
 * `readyIds` defaults to an empty Set so callers that don't have the data yet
 * (loading, or the server doesn't advertise the capability) degrade to
 * "everything open-status stays in Open, nothing is Ready" rather than
 * crashing or showing a permanently-empty-looking Ready column.
 */
export function buildTrackerBoard(
  trackers: readonly TrackerSummary[],
  filter: TrackerBoardFilter,
  readyIds: ReadonlySet<string> = new Set(),
): TrackerBoard {
  const visibleLanes = visibleLanesForFilter(filter);
  const isPriority = isPriorityFilter(filter);

  const ready: TrackerBoardCard[] = [];
  const open: TrackerBoardCard[] = [];
  const inProgress: TrackerBoardCard[] = [];
  const done: TrackerBoardCard[] = [];
  const cancelled: TrackerBoardCard[] = [];

  for (const tracker of trackers) {
    const lane = laneForTracker(tracker, readyIds);
    if (!visibleLanes.includes(lane)) {
      continue;
    }
    if (isPriority && !matchesTrackerStatFilter(tracker, filter)) {
      continue;
    }

    const card: TrackerBoardCard = { tracker, isCancelled: tracker.status === "cancelled" };
    switch (lane) {
      case "ready":
        ready.push(card);
        break;
      case "open":
        open.push(card);
        break;
      case "in_progress":
        inProgress.push(card);
        break;
      case "done":
        done.push(card);
        break;
      case "cancelled":
        cancelled.push(card);
        break;
    }
  }

  ready.sort((a, b) => compareTrackers(a.tracker, b.tracker));
  open.sort((a, b) => compareTrackers(a.tracker, b.tracker));
  inProgress.sort((a, b) => compareTrackers(a.tracker, b.tracker));
  done.sort((a, b) => compareByRecency(a.tracker, b.tracker));
  cancelled.sort((a, b) => compareByRecency(a.tracker, b.tracker));

  return { visibleLanes, ready, open, in_progress: inProgress, done, cancelled };
}
