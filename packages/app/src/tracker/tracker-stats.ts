import type { TrackerStatus, TrackerSummary } from "@getpaseo/protocol/tracker/types";

export type TrackerStatFilter =
  | "open"
  | "in_progress"
  | "p0"
  | "p1"
  | "p2"
  | "p3"
  | "p4"
  | "done"
  | "all";

export interface TrackerStatCounts {
  open: number;
  inProgress: number;
  p0: number;
  p1: number;
  p2: number;
  p3: number;
  p4: number;
  done: number;
  all: number;
}

export function matchesTrackerStatFilter(
  tracker: TrackerSummary,
  filter: TrackerStatFilter,
): boolean {
  switch (filter) {
    case "open":
      return tracker.status === "open";
    case "in_progress":
      return tracker.status === "in_progress";
    case "p0":
      return tracker.priority === "P0";
    case "p1":
      return tracker.priority === "P1";
    case "p2":
      return tracker.priority === "P2";
    case "p3":
      return tracker.priority === "P3";
    case "p4":
      return tracker.priority === "P4";
    case "done":
      return tracker.status === "closed" || tracker.status === "cancelled";
    case "all":
      return true;
  }
}

// Which real statuses the List view's toolbar filter surfaces, applied to
// whichever type granularity (Tasks/Epics/Initiatives/All) is currently
// selected — unlike Kanban's lane projection (laneForTracker in
// tracker-board-model.ts), which keeps cancelled as its own lane separate
// from Done, List's flat sections split them the same way: "done" here means
// closed only, so selecting it never surfaces a Cancelled section. Priority
// filters span every status instead of only open/in_progress — List is a
// lookup table, not a live triage board, so a P2 item that's already Done is
// still worth finding by priority. Exported so useTrackerProjectData's
// caller can derive exactly which sections a status filter needs fetched
// (pas-2KY5X.4) from the same source matchesListStatFilter uses, instead of
// a second, driftable copy of this mapping.
export function listVisibleStatusesForFilter(filter: TrackerStatFilter): readonly TrackerStatus[] {
  switch (filter) {
    case "open":
      return ["open"];
    case "in_progress":
      return ["in_progress"];
    case "done":
      return ["closed"];
    case "p0":
    case "p1":
    case "p2":
    case "p3":
    case "p4":
    case "all":
      return ["open", "in_progress", "closed", "cancelled"];
  }
}

const PRIORITY_FILTER_TO_LEVEL: Readonly<Record<"p0" | "p1" | "p2" | "p3" | "p4", string>> = {
  p0: "P0",
  p1: "P1",
  p2: "P2",
  p3: "P3",
  p4: "P4",
};

// The single source of truth for the List view's status/priority filter — both
// the dataset filter (tracker-screen.tsx) and the section-visibility decision
// (tracker-table.tsx hides a section once it has zero items) derive from it,
// so the two can never drift out of sync.
export function matchesListStatFilter(tracker: TrackerSummary, filter: TrackerStatFilter): boolean {
  if (!listVisibleStatusesForFilter(filter).includes(tracker.status)) {
    return false;
  }
  const priorityLevel = (PRIORITY_FILTER_TO_LEVEL as Record<string, string | undefined>)[filter];
  return priorityLevel === undefined || tracker.priority === priorityLevel;
}

// Counts whatever set it is given — it does not filter by `type` itself. The
// caller applies the Tasks/Epics/Initiatives/All type filter first (the same
// `typeFilter` that drives the tracker set shown on screen), so these counts
// track whichever granularity is currently selected instead of always
// counting tasks regardless of it. Priority counts span every status (not
// just open/in_progress) — they must match matchesListStatFilter's priority
// predicate, which a P2 item that's already Done still satisfies; counting
// only active work here would show a number smaller than what the filter
// actually surfaces once selected.
export function getTrackerStatCounts(trackers: readonly TrackerSummary[]): TrackerStatCounts {
  const done = trackers.filter(
    (tracker) => tracker.status === "closed" || tracker.status === "cancelled",
  ).length;
  const inProgress = trackers.filter((tracker) => tracker.status === "in_progress").length;
  const priorityCount = (priority: string): number =>
    trackers.filter((tracker) => tracker.priority === priority).length;

  const p0 = priorityCount("P0");
  const p1 = priorityCount("P1");
  const p2 = priorityCount("P2");
  const p3 = priorityCount("P3");
  const p4 = priorityCount("P4");

  return {
    open: trackers.length - done - inProgress,
    inProgress,
    p0,
    p1,
    p2,
    p3,
    p4,
    done,
    all: trackers.length,
  };
}
