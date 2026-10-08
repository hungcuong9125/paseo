import { describe, expect, it } from "vitest";
import { trackerKey, type AggregatedTracker } from "@/tracker/aggregated-trackers";
import {
  MAX_TREE_DEPTH,
  buildTrackerHierarchy,
  compareTrackers,
  isDone,
} from "./tracker-hierarchy";

function tracker(
  overrides: Partial<AggregatedTracker> & Pick<AggregatedTracker, "id">,
): AggregatedTracker {
  return {
    serverId: "host-a",
    serverName: "Host A",
    projectId: "prj-a",
    projectName: "Project A",
    title: overrides.id,
    type: "task",
    status: "open",
    priority: "P2",
    parentId: null,
    ...overrides,
  };
}

describe("buildTrackerHierarchy", () => {
  it("does not mix descendants when projects reuse parent and child IDs", () => {
    const first = tracker({ id: "root", projectId: "first" });
    const second = tracker({ id: "root", projectId: "second" });
    const hierarchy = buildTrackerHierarchy([
      first,
      second,
      tracker({ id: "child", parentId: "root", projectId: "first", status: "closed" }),
      tracker({ id: "child", parentId: "root", projectId: "second" }),
    ]);
    expect(hierarchy.descendantStats(trackerKey(first))).toEqual({ childCount: 1, doneCount: 1 });
    expect(hierarchy.descendantStats(trackerKey(second))).toEqual({ childCount: 1, doneCount: 0 });
    expect(hierarchy.trackersByKey.size).toBe(4);
  });
  it("aggregates a normal multi-level tree", () => {
    const trackers: AggregatedTracker[] = [
      tracker({ id: "root", type: "epic" }),
      tracker({ id: "mid1", parentId: "root", status: "closed" }),
      tracker({ id: "mid2", parentId: "root" }),
      tracker({ id: "leaf1", parentId: "mid1", status: "cancelled" }),
      tracker({ id: "leaf2", parentId: "mid2" }),
      tracker({ id: "leaf3", parentId: "mid2", status: "closed" }),
      tracker({ id: "orphan" }),
    ];
    const hierarchy = buildTrackerHierarchy(trackers);
    const stats = hierarchy.descendantStats(trackerKey(tracker({ id: "root" })));
    // root has 2 direct children, 3 grandchildren; 3 done (mid1 closed, leaf1
    // cancelled, leaf3 closed) of 5.
    expect(stats.childCount).toBe(5);
    expect(stats.doneCount).toBe(3);
    expect(
      hierarchy.childrenByParentKey.get(trackerKey(tracker({ id: "root" })))?.map((t) => t.id),
    ).toEqual(["mid1", "mid2"]);
    expect(
      hierarchy.childrenByParentKey.get(trackerKey(tracker({ id: "orphan" }))),
    ).toBeUndefined();
  });

  it("does not infinite-loop or crash on a cycle in parentId", () => {
    const trackers: AggregatedTracker[] = [
      tracker({ id: "a", parentId: "b" }),
      tracker({ id: "b", parentId: "c" }),
      tracker({ id: "c", parentId: "a" }),
    ];
    const hierarchy = buildTrackerHierarchy(trackers);
    expect(() => hierarchy.descendantStats(trackerKey(tracker({ id: "a" })))).not.toThrow();
    expect(() => hierarchy.descendantStats(trackerKey(tracker({ id: "b" })))).not.toThrow();
    expect(() => hierarchy.descendantStats(trackerKey(tracker({ id: "c" })))).not.toThrow();
    // The ancestor set and depth guard bound the walk: every node's descendant
    // count stays at or below the total node count of the cycle, no matter which
    // node we start from.
    expect(
      hierarchy.descendantStats(trackerKey(tracker({ id: "a" }))).childCount,
    ).toBeLessThanOrEqual(3);
    expect(
      hierarchy.descendantStats(trackerKey(tracker({ id: "b" }))).childCount,
    ).toBeLessThanOrEqual(3);
    expect(
      hierarchy.descendantStats(trackerKey(tracker({ id: "c" }))).childCount,
    ).toBeLessThanOrEqual(3);
  });

  it("does not infinite-loop on a self-parented tracker", () => {
    const trackers: AggregatedTracker[] = [
      tracker({ id: "self", parentId: "self", status: "closed" }),
    ];
    const hierarchy = buildTrackerHierarchy(trackers);
    expect(() => hierarchy.descendantStats(trackerKey(tracker({ id: "self" })))).not.toThrow();
    const stats = hierarchy.descendantStats(trackerKey(tracker({ id: "self" })));
    expect(stats.childCount).toBe(1);
    expect(stats.doneCount).toBe(1);
  });

  it("treats a parentId pointing to a missing id as a leaf with no self", () => {
    const trackers: AggregatedTracker[] = [tracker({ id: "child", parentId: "ghost" })];
    const hierarchy = buildTrackerHierarchy(trackers);
    // The dangling parentId still forms a child link, but the missing parent
    // tracker itself is never a member of the index, so stat walks that start
    // from an existing tracker never descend into "ghost".
    expect(hierarchy.trackersByKey.has(trackerKey(tracker({ id: "ghost" })))).toBe(false);
    expect(
      hierarchy.childrenByParentKey.get(trackerKey(tracker({ id: "ghost" })))?.map((t) => t.id),
    ).toEqual(["child"]);
    expect(hierarchy.descendantStats(trackerKey(tracker({ id: "child" })))).toEqual({
      childCount: 0,
      doneCount: 0,
    });
    expect(hierarchy.descendantStats(trackerKey(tracker({ id: "ghost" })))).toEqual({
      childCount: 1,
      doneCount: 0,
    });
  });

  it("honors MAX_TREE_DEPTH and stops deep chains", () => {
    const trackers: AggregatedTracker[] = [];
    let prev = "deep0";
    for (let i = 1; i <= MAX_TREE_DEPTH + 5; i += 1) {
      const id = `deep${i}`;
      trackers.push(tracker({ id, parentId: prev }));
      prev = id;
    }
    const hierarchy = buildTrackerHierarchy(trackers);
    const stats = hierarchy.descendantStats(trackerKey(tracker({ id: "deep0" })));
    // Capped at MAX_TREE_DEPTH descendants, not the full chain.
    expect(stats.childCount).toBe(MAX_TREE_DEPTH);
  });
});

describe("compareTrackers", () => {
  it("sorts by priority then id", () => {
    const low = tracker({ id: "z", priority: "P3" });
    const high = tracker({ id: "a", priority: "P0" });
    expect(compareTrackers(low, high)).toBeGreaterThan(0);
    expect(compareTrackers(high, low)).toBeLessThan(0);
    const same = tracker({ id: "b", priority: "P0" });
    expect(compareTrackers(high, same)).toBeLessThan(0);
    expect(compareTrackers(high, high)).toBe(0);
  });
});

describe("isDone", () => {
  it("treats closed and cancelled as done", () => {
    expect(isDone(tracker({ id: "x", status: "closed" }))).toBe(true);
    expect(isDone(tracker({ id: "x", status: "cancelled" }))).toBe(true);
    expect(isDone(tracker({ id: "x", status: "open" }))).toBe(false);
    expect(isDone(tracker({ id: "x", status: "in_progress" }))).toBe(false);
  });
});
