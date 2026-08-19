import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";

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
