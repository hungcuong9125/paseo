import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";

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
  const active = tracker.status === "open" || tracker.status === "in_progress";
  switch (filter) {
    case "open":
      return tracker.status === "open";
    case "in_progress":
      return tracker.status === "in_progress";
    case "p0":
      return active && tracker.priority === "P0";
    case "p1":
      return active && tracker.priority === "P1";
    case "p2":
      return active && tracker.priority === "P2";
    case "p3":
      return active && tracker.priority === "P3";
    case "p4":
      return active && tracker.priority === "P4";
    case "done":
      return tracker.status === "closed" || tracker.status === "cancelled";
    case "all":
      return true;
  }
}

// Counts whatever set it is given — it does not filter by `type` itself. The
// caller applies the Tasks/Epics/Initiatives/All type filter first (the same
// `typeFilter` that drives the tracker set shown on screen), so these counts
// track whichever granularity is currently selected instead of always
// counting tasks regardless of it.
export function getTrackerStatCounts(trackers: readonly TrackerSummary[]): TrackerStatCounts {
  const done = trackers.filter(
    (tracker) => tracker.status === "closed" || tracker.status === "cancelled",
  ).length;
  const inProgress = trackers.filter((tracker) => tracker.status === "in_progress").length;
  const active = trackers.filter(
    (tracker) => tracker.status === "open" || tracker.status === "in_progress",
  );
  const priorityCount = (priority: string): number =>
    active.filter((tracker) => tracker.priority === priority).length;

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
