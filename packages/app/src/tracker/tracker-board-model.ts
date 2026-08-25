import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";
import { compareByCreatedNewest, compareTrackers } from "@/tracker/tracker-hierarchy";
import { matchesTrackerStatFilter, type TrackerStatFilter } from "@/tracker/tracker-stats";

// Same domain as the toolbar's filter, reused directly. Only the priority
// values (p0-p4) actually affect the board (a card not matching the selected
// priority is left out of its lane entirely); "open"/"in_progress"/"done"
// only filter the List view's dataset and reach here as "all" would (every
// lane stays visible, nothing filtered) if ever passed.
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
  /** Every lane, in display order — the priority filter removes individual
   * cards from a lane, it never removes the lane itself (unlike the old
   * status filter behaviour, which collapsed the board down to whichever
   * lanes still matched and left one lane stretched full-width). This field
   * stays mainly for the compact single-lane-at-a-time layout's switcher. */
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

function isPriorityFilter(filter: TrackerBoardFilter): filter is "p0" | "p1" | "p2" | "p3" | "p4" {
  return (
    filter === "p0" || filter === "p1" || filter === "p2" || filter === "p3" || filter === "p4"
  );
}

/**
 * Partitions a flat tracker list into the five Kanban lanes, every one of
 * which always renders — the toolbar's priority filter (the only Kanban stat
 * filter left; Open/In Progress/Done only filter the List view) removes
 * non-matching cards from their lane rather than hiding the lane itself.
 * Partitioning is by `status` (plus `readyIds` membership for the open/ready
 * split) alone — `parentId` is never read, so malformed or cyclic hierarchy
 * data cannot affect lane placement.
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
  const isPriority = isPriorityFilter(filter);

  const ready: TrackerBoardCard[] = [];
  const open: TrackerBoardCard[] = [];
  const inProgress: TrackerBoardCard[] = [];
  const done: TrackerBoardCard[] = [];
  const cancelled: TrackerBoardCard[] = [];

  for (const tracker of trackers) {
    if (isPriority && !matchesTrackerStatFilter(tracker, filter)) {
      continue;
    }
    const lane = laneForTracker(tracker, readyIds);
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
  // pas-2KY5X.23: createdAt is the single recency key across selection, lane
  // order, and the card label — this used to re-sort by updatedAt, which
  // disagreed with both.
  done.sort((a, b) => compareByCreatedNewest(a.tracker, b.tracker));
  cancelled.sort((a, b) => compareByCreatedNewest(a.tracker, b.tracker));

  return { visibleLanes: ALL_LANES, ready, open, in_progress: inProgress, done, cancelled };
}
