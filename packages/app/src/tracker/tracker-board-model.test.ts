import { describe, expect, it } from "vitest";
import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";
import { buildTrackerBoard, type TrackerBoardFilter } from "./tracker-board-model";

function tracker(overrides: Partial<TrackerSummary> & Pick<TrackerSummary, "id">): TrackerSummary {
  return {
    title: overrides.id,
    type: "task",
    status: "open",
    priority: "P2",
    parentId: null,
    ...overrides,
  };
}

describe("buildTrackerBoard", () => {
  it("partitions trackers into open, in_progress, and done lanes by status", () => {
    const trackers = [
      tracker({ id: "a", status: "open" }),
      tracker({ id: "b", status: "in_progress" }),
      tracker({ id: "c", status: "closed" }),
      tracker({ id: "d", status: "cancelled" }),
    ];

    const board = buildTrackerBoard(trackers, "all");

    expect(board.visibleLanes).toEqual(["ready", "open", "in_progress", "done"]);
    expect(board.open.map((card) => card.tracker.id)).toEqual(["a"]);
    expect(board.in_progress.map((card) => card.tracker.id)).toEqual(["b"]);
    expect(board.done.map((card) => card.tracker.id).sort()).toEqual(["c", "d"]);
  });

  it("splits open items into ready and open by readyIds membership, leaving in_progress and done untouched", () => {
    const trackers = [
      tracker({ id: "unblocked", status: "open" }),
      tracker({ id: "blocked", status: "open" }),
      tracker({ id: "doing", status: "in_progress" }),
      tracker({ id: "finished", status: "closed" }),
    ];
    const readyIds = new Set(["unblocked", "doing", "finished"]);

    const board = buildTrackerBoard(trackers, "all", readyIds);

    expect(board.visibleLanes).toEqual(["ready", "open", "in_progress", "done"]);
    expect(board.ready.map((card) => card.tracker.id)).toEqual(["unblocked"]);
    expect(board.open.map((card) => card.tracker.id)).toEqual(["blocked"]);
    expect(board.in_progress.map((card) => card.tracker.id)).toEqual(["doing"]);
    expect(board.done.map((card) => card.tracker.id)).toEqual(["finished"]);
  });

  it("leaves everything open-status in Open when readyIds is not supplied, never crashing", () => {
    const trackers = [tracker({ id: "a", status: "open" }), tracker({ id: "b", status: "open" })];

    const board = buildTrackerBoard(trackers, "all");

    expect(board.ready).toEqual([]);
    expect(board.open.map((card) => card.tracker.id)).toEqual(["a", "b"]);
  });

  it("maps cancelled items into the done lane with a distinguishing flag, closed items without it", () => {
    const trackers = [
      tracker({ id: "closed-1", status: "closed" }),
      tracker({ id: "cancelled-1", status: "cancelled" }),
    ];

    const board = buildTrackerBoard(trackers, "done");
    const byId = Object.fromEntries(board.done.map((card) => [card.tracker.id, card]));

    expect(byId["closed-1"]?.isCancelled).toBe(false);
    expect(byId["cancelled-1"]?.isCancelled).toBe(true);
  });

  it.each([
    ["all", ["ready", "open", "in_progress", "done"]],
    ["open", ["ready", "open"]],
    ["in_progress", ["in_progress"]],
    ["done", ["done"]],
    ["p0", ["ready", "open", "in_progress"]],
    ["p1", ["ready", "open", "in_progress"]],
    ["p2", ["ready", "open", "in_progress"]],
    ["p3", ["ready", "open", "in_progress"]],
    ["p4", ["ready", "open", "in_progress"]],
  ] as const)("projects filter %s onto lanes %j", (filter, expectedLanes) => {
    const board = buildTrackerBoard([], filter);
    expect(board.visibleLanes).toEqual(expectedLanes);
  });

  it("shows ready and open together — the Open filter must not hide unblocked items", () => {
    const trackers = [
      tracker({ id: "unblocked", status: "open" }),
      tracker({ id: "blocked", status: "open" }),
      tracker({ id: "doing", status: "in_progress" }),
      tracker({ id: "finished", status: "closed" }),
    ];
    const readyIds = new Set(["unblocked"]);

    const board = buildTrackerBoard(trackers, "open", readyIds);

    expect(board.visibleLanes).toEqual(["ready", "open"]);
    expect(board.ready.map((card) => card.tracker.id)).toEqual(["unblocked"]);
    expect(board.open.map((card) => card.tracker.id)).toEqual(["blocked"]);
    expect(board.in_progress).toEqual([]);
    expect(board.done).toEqual([]);
  });

  it.each(["p0", "p1", "p2", "p3", "p4"] as const)(
    "filters %s lane cards to active items matching that priority, excluding done, including ready",
    (filter: TrackerBoardFilter) => {
      const priority = filter.toUpperCase() as TrackerSummary["priority"];
      const otherPriority = priority === "P0" ? "P1" : "P0";
      const trackers = [
        tracker({ id: "match-ready", status: "open", priority }),
        tracker({ id: "match-open", status: "open", priority }),
        tracker({ id: "match-in-progress", status: "in_progress", priority }),
        tracker({ id: "wrong-priority", status: "open", priority: otherPriority }),
        tracker({ id: "done-same-priority", status: "closed", priority }),
      ];
      const readyIds = new Set(["match-ready"]);

      const board = buildTrackerBoard(trackers, filter, readyIds);

      expect(board.ready.map((card) => card.tracker.id)).toEqual(["match-ready"]);
      expect(board.open.map((card) => card.tracker.id)).toEqual(["match-open"]);
      expect(board.in_progress.map((card) => card.tracker.id)).toEqual(["match-in-progress"]);
      expect(board.done).toEqual([]);
    },
  );

  it("does not crash on malformed or missing parentId and still partitions by status", () => {
    const trackers = [
      tracker({ id: "cyclic-a", status: "open", parentId: "cyclic-b" }),
      tracker({ id: "cyclic-b", status: "open", parentId: "cyclic-a" }),
      tracker({ id: "missing-parent", status: "in_progress", parentId: "does-not-exist" }),
      tracker({ id: "self-parent", status: "closed", parentId: "self-parent" }),
    ];

    expect(() => buildTrackerBoard(trackers, "all")).not.toThrow();

    const board = buildTrackerBoard(trackers, "all");
    expect(board.open.map((card) => card.tracker.id).sort()).toEqual(["cyclic-a", "cyclic-b"]);
    expect(board.in_progress.map((card) => card.tracker.id)).toEqual(["missing-parent"]);
    expect(board.done.map((card) => card.tracker.id)).toEqual(["self-parent"]);
  });

  it("sorts open and in_progress lanes by priority then id", () => {
    const trackers = [
      tracker({ id: "b", status: "open", priority: "P1" }),
      tracker({ id: "a", status: "open", priority: "P1" }),
      tracker({ id: "z", status: "open", priority: "P0" }),
    ];

    const board = buildTrackerBoard(trackers, "all");

    expect(board.open.map((card) => card.tracker.id)).toEqual(["z", "a", "b"]);
  });

  it("sorts the done lane by updatedAt descending, with missing updatedAt last", () => {
    const trackers = [
      tracker({ id: "older", status: "closed", updatedAt: "2026-01-01T00:00:00Z" }),
      tracker({ id: "newer", status: "closed", updatedAt: "2026-06-01T00:00:00Z" }),
      tracker({ id: "no-updated-at", status: "closed" }),
    ];

    const board = buildTrackerBoard(trackers, "all");

    expect(board.done.map((card) => card.tracker.id)).toEqual(["newer", "older", "no-updated-at"]);
  });
});
