import { describe, expect, it } from "vitest";
import type { AggregatedTracker } from "./aggregated-trackers";
import { getTrackerStatCounts, matchesTrackerStatFilter } from "./tracker-stats";

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
  it("counts tasks across projects without counting structural containers", () => {
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
      open: 1,
      inProgress: 1,
      p0: 1,
      p1: 0,
      p2: 1,
      p3: 0,
      p4: 0,
      done: 2,
      all: 4,
    });
  });

  it("matches status and active priority filters across tracker types", () => {
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
    expect(matchesTrackerStatFilter(doneTask, "p0")).toBe(false);
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
    }
  });
});
