import { describe, expect, it } from "vitest";
import type { AggregatedTracker } from "./aggregated-trackers";
import {
  getTrackerStatCounts,
  matchesListStatFilter,
  matchesTrackerStatFilter,
} from "./tracker-stats";

function tracker(
  id: string,
  overrides: Pick<AggregatedTracker, "type" | "status" | "priority">,
): AggregatedTracker {
  const projectId = id.startsWith("a-") ? "project-a" : "project-b";
  return {
    id,
    title: id,
    parentId: null,
    serverId: projectId === "project-a" ? "host-a" : "host-b",
    serverName: projectId === "project-a" ? "Host A" : "Host B",
    projectId,
    projectName: projectId,
    ...overrides,
  };
}

describe("getTrackerStatCounts", () => {
  it("counts across projects by status/priority only — the caller applies the type filter first", () => {
    const trackers = [
      tracker("a-epic-open", { type: "epic", status: "open", priority: "P1" }),
      tracker("a-task-open", { type: "task", status: "open", priority: "P0" }),
      tracker("a-task-progress", { type: "task", status: "in_progress", priority: "P2" }),
      tracker("a-task-closed", { type: "task", status: "closed", priority: "P0" }),
      tracker("b-initiative-open", { type: "initiative", status: "open", priority: "P2" }),
      tracker("b-epic-progress", { type: "epic", status: "in_progress", priority: "P0" }),
      tracker("b-initiative-cancelled", {
        type: "initiative",
        status: "cancelled",
        priority: "P3",
      }),
      tracker("b-task-cancelled", { type: "task", status: "cancelled", priority: "P4" }),
    ];

    expect(getTrackerStatCounts(trackers)).toEqual({
      open: 3,
      inProgress: 2,
      // Priority counts span every status, not just open/in_progress — the
      // closed a-task-closed (P0) and cancelled b-initiative-cancelled (P3) /
      // b-task-cancelled (P4) all still count toward their priority level.
      p0: 3,
      p1: 1,
      p2: 2,
      p3: 1,
      p4: 1,
      done: 3,
      all: 8,
    });
  });

  it("reflects only epics when the caller pre-filters to epics — the toolbar counts must track the selected type filter, not always tasks", () => {
    const trackers = [
      tracker("a-epic-open", { type: "epic", status: "open", priority: "P1" }),
      tracker("a-task-open", { type: "task", status: "open", priority: "P0" }),
      tracker("b-epic-progress", { type: "epic", status: "in_progress", priority: "P0" }),
    ];
    const epicsOnly = trackers.filter((t) => t.type === "epic");

    expect(getTrackerStatCounts(epicsOnly)).toEqual({
      open: 1,
      inProgress: 1,
      p0: 1,
      p1: 1,
      p2: 0,
      p3: 0,
      p4: 0,
      done: 0,
      all: 2,
    });
  });

  it("counts a priority regardless of status — a closed or cancelled item still counts toward its priority", () => {
    const trackers = [
      tracker("open-p1", { type: "task", status: "open", priority: "P1" }),
      tracker("closed-p1", { type: "task", status: "closed", priority: "P1" }),
      tracker("cancelled-p1", { type: "task", status: "cancelled", priority: "P1" }),
    ];

    expect(getTrackerStatCounts(trackers).p1).toBe(3);
  });

  it("matches status filters across tracker types, and priority filters regardless of status", () => {
    const doneTask = tracker("done-task", { type: "task", status: "closed", priority: "P0" });
    expect(
      matchesTrackerStatFilter(
        tracker("open-epic", { type: "epic", status: "open", priority: "P1" }),
        "open",
      ),
    ).toBe(true);
    expect(
      matchesTrackerStatFilter(
        tracker("progress-initiative", {
          type: "initiative",
          status: "in_progress",
          priority: "P2",
        }),
        "in_progress",
      ),
    ).toBe(true);
    expect(matchesTrackerStatFilter(doneTask, "done")).toBe(true);
    expect(matchesTrackerStatFilter(doneTask, "p0")).toBe(true);
    expect(matchesTrackerStatFilter(doneTask, "all")).toBe(true);

    const priorityPairs = [
      ["P0", "p0"],
      ["P1", "p1"],
      ["P2", "p2"],
      ["P3", "p3"],
      ["P4", "p4"],
    ] as const;
    for (const [priority, filter] of priorityPairs) {
      expect(
        matchesTrackerStatFilter(
          tracker(`active-${priority}`, { type: "initiative", status: "open", priority }),
          filter,
        ),
      ).toBe(true);
      expect(
        matchesTrackerStatFilter(
          tracker(`done-${priority}`, { type: "initiative", status: "closed", priority }),
          filter,
        ),
      ).toBe(true);
    }
  });
});

describe("matchesListStatFilter", () => {
  it("'done' matches closed only — cancelled never surfaces under Done in the List view", () => {
    const closed = tracker("closed", { type: "task", status: "closed", priority: "P0" });
    const cancelled = tracker("cancelled", { type: "task", status: "cancelled", priority: "P0" });
    expect(matchesListStatFilter(closed, "done")).toBe(true);
    expect(matchesListStatFilter(cancelled, "done")).toBe(false);
  });

  it("priority filters match a tracker of that priority in any status, not just open/in_progress", () => {
    const openP2 = tracker("open-p2", { type: "task", status: "open", priority: "P2" });
    const doneP2 = tracker("done-p2", { type: "task", status: "closed", priority: "P2" });
    const cancelledP2 = tracker("cancelled-p2", {
      type: "task",
      status: "cancelled",
      priority: "P2",
    });
    const doneP3 = tracker("done-p3", { type: "task", status: "closed", priority: "P3" });
    expect(matchesListStatFilter(openP2, "p2")).toBe(true);
    expect(matchesListStatFilter(doneP2, "p2")).toBe(true);
    expect(matchesListStatFilter(cancelledP2, "p2")).toBe(true);
    expect(matchesListStatFilter(doneP3, "p2")).toBe(false);
  });

  it("applies to every tracker type, not just tasks — Epics/Initiatives respect the toolbar filter too", () => {
    const inProgressEpic = tracker("epic", { type: "epic", status: "in_progress", priority: "P1" });
    const openInitiative = tracker("initiative", {
      type: "initiative",
      status: "open",
      priority: "P1",
    });
    expect(matchesListStatFilter(inProgressEpic, "in_progress")).toBe(true);
    expect(matchesListStatFilter(inProgressEpic, "open")).toBe(false);
    expect(matchesListStatFilter(openInitiative, "open")).toBe(true);
    expect(matchesListStatFilter(openInitiative, "in_progress")).toBe(false);
  });

  it("'open'/'in_progress'/'all' behave the same as the shared predicate", () => {
    const open = tracker("open", { type: "task", status: "open", priority: "P0" });
    const inProgress = tracker("in-progress", {
      type: "task",
      status: "in_progress",
      priority: "P0",
    });
    expect(matchesListStatFilter(open, "open")).toBe(true);
    expect(matchesListStatFilter(inProgress, "in_progress")).toBe(true);
    expect(matchesListStatFilter(open, "all")).toBe(true);
    expect(matchesListStatFilter(inProgress, "all")).toBe(true);
  });
});
