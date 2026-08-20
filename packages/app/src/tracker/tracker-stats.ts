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

export function getTrackerStatCounts(trackers: readonly TrackerSummary[]): TrackerStatCounts {
  const tasks = trackers.filter((tracker) => tracker.type === "task");
  const done = tasks.filter(
    (task) => task.status === "closed" || task.status === "cancelled",
  ).length;
  const inProgress = tasks.filter((task) => task.status === "in_progress").length;
  const activeTasks = tasks.filter(
    (task) => task.status === "open" || task.status === "in_progress",
  );
  const priorityCount = (priority: string): number =>
    activeTasks.filter((task) => task.priority === priority).length;

  const p0 = priorityCount("P0");
  const p1 = priorityCount("P1");
  const p2 = priorityCount("P2");
  const p3 = priorityCount("P3");
  const p4 = priorityCount("P4");

  return {
    open: tasks.length - done - inProgress,
    inProgress,
    p0,
    p1,
    p2,
    p3,
    p4,
    done,
    all: tasks.length,
  };
}
