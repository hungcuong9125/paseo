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
  it("partitions trackers into open, in_progress, done, and cancelled lanes by status", () => {
    const trackers = [
      tracker({ id: "a", status: "open" }),
      tracker({ id: "b", status: "in_progress" }),
      tracker({ id: "c", status: "closed" }),
      tracker({ id: "d", status: "cancelled" }),
    ];

    const board = buildTrackerBoard(trackers, "all");

    expect(board.visibleLanes).toEqual(["open", "in_progress", "done", "cancelled"]);
    expect(board.open.map((card) => card.tracker.id)).toEqual(["a"]);
    expect(board.in_progress.map((card) => card.tracker.id)).toEqual(["b"]);
    expect(board.done.map((card) => card.tracker.id)).toEqual(["c"]);
    expect(board.cancelled.map((card) => card.tracker.id)).toEqual(["d"]);
  });

  it("keeps open items in Todo and marks only unready items as blocked", () => {
    const trackers = [
      tracker({ id: "unblocked", status: "open" }),
      tracker({ id: "blocked", status: "open" }),
      tracker({ id: "doing", status: "in_progress" }),
      tracker({ id: "finished", status: "closed" }),
    ];
    const readyIds = new Set(["unblocked", "doing", "finished"]);

    const board = buildTrackerBoard(trackers, "all", readyIds);

    expect(board.visibleLanes).toEqual(["open", "in_progress", "done", "cancelled"]);
    expect(board.open.map((card) => card.tracker.id)).toEqual(["blocked", "unblocked"]);
    expect(board.open.find((card) => card.tracker.id === "unblocked")?.isBlocked).toBe(false);
    expect(board.open.find((card) => card.tracker.id === "blocked")?.isBlocked).toBe(true);
    expect(board.in_progress.map((card) => card.tracker.id)).toEqual(["doing"]);
    expect(board.done.map((card) => card.tracker.id)).toEqual(["finished"]);
  });

  it("leaves everything open-status in Open when readyIds is not supplied, never crashing", () => {
    const trackers = [tracker({ id: "a", status: "open" }), tracker({ id: "b", status: "open" })];

    const board = buildTrackerBoard(trackers, "all");

    expect(board.open.map((card) => card.tracker.id)).toEqual(["a", "b"]);
    expect(board.open.every((card) => !card.isBlocked)).toBe(true);
  });

  it("puts cancelled items in their own lane with a distinguishing flag, closed items without it", () => {
    const trackers = [
      tracker({ id: "closed-1", status: "closed" }),
      tracker({ id: "cancelled-1", status: "cancelled" }),
    ];

    const board = buildTrackerBoard(trackers, "all");
    const doneById = Object.fromEntries(board.done.map((card) => [card.tracker.id, card]));
    const cancelledById = Object.fromEntries(
      board.cancelled.map((card) => [card.tracker.id, card]),
    );

    expect(doneById["closed-1"]?.isCancelled).toBe(false);
    expect(cancelledById["cancelled-1"]?.isCancelled).toBe(true);
  });

  it.each(["all", "open", "in_progress", "done", "p0", "p1", "p2", "p3", "p4"] as const)(
    "always shows every lane, regardless of filter %s — Kanban never hides a lane",
    (filter) => {
      const board = buildTrackerBoard([], filter);
      expect(board.visibleLanes).toEqual(["open", "in_progress", "done", "cancelled"]);
    },
  );

  it("'open'/'in_progress'/'done' — the List-only filters — leave every card on the board, same as 'all'", () => {
    const trackers = [
      tracker({ id: "open-1", status: "open" }),
      tracker({ id: "progress-1", status: "in_progress" }),
      tracker({ id: "closed-1", status: "closed" }),
      tracker({ id: "cancelled-1", status: "cancelled" }),
    ];

    for (const filter of ["open", "in_progress", "done"] as const) {
      const board = buildTrackerBoard(trackers, filter);
      const allIds = [...board.open, ...board.in_progress, ...board.done, ...board.cancelled].map(
        (card) => card.tracker.id,
      );
      expect(allIds.sort()).toEqual(["cancelled-1", "closed-1", "open-1", "progress-1"]);
    }
  });

  it.each(["p0", "p1", "p2", "p3", "p4"] as const)(
    "%s removes cards that don't match that priority from their lane, regardless of status, without hiding any lane",
    (filter: TrackerBoardFilter) => {
      const priority = filter.toUpperCase() as TrackerSummary["priority"];
      const otherPriority = priority === "P0" ? "P1" : "P0";
      const trackers = [
        tracker({ id: "match-unblocked", status: "open", priority }),
        tracker({ id: "match-open", status: "open", priority }),
        tracker({ id: "match-in-progress", status: "in_progress", priority }),
        tracker({ id: "wrong-priority", status: "open", priority: otherPriority }),
        tracker({ id: "done-same-priority", status: "closed", priority }),
        tracker({ id: "done-wrong-priority", status: "closed", priority: otherPriority }),
      ];
      const readyIds = new Set(["match-unblocked"]);

      const board = buildTrackerBoard(trackers, filter, readyIds);

      expect(board.visibleLanes).toEqual(["open", "in_progress", "done", "cancelled"]);
      expect(board.open.map((card) => card.tracker.id)).toEqual(["match-open", "match-unblocked"]);
      expect(board.in_progress.map((card) => card.tracker.id)).toEqual(["match-in-progress"]);
      // Priority counting/filtering spans every status now (matching the toolbar's
      // stat count), so a same-priority Done card stays — only its priority decides.
      expect(board.done.map((card) => card.tracker.id)).toEqual(["done-same-priority"]);
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

  // pas-2KY5X.37 (this function's own sibling defect): done/cancelled used
  // to re-sort by compareByCreatedNewest on every call. `trackers` (the
  // shared data hook) already hands them newest-first, position-stable order
  // — the k-way merge appends its already-correct window instead of
  // re-sorting, specifically so an already-shown row never moves when a
  // later page arrives. Re-sorting here, with a tiebreak (id) that has no
  // relationship to fetch order, undid that: a same-tied card arriving on a
  // later page could rank above an already-shown one and jump above it —
  // the Kanban Done lane surface the human originally reported. This
  // function now trusts input order for Done/Cancelled instead of deriving
  // its own.
  it("the done lane preserves trackers' input order, not a fresh createdAt sort", () => {
    const trackers = [
      tracker({ id: "older", status: "closed", createdAt: "2026-01-01T00:00:00Z" }),
      tracker({ id: "newer", status: "closed", createdAt: "2026-06-01T00:00:00Z" }),
    ];

    const board = buildTrackerBoard(trackers, "all");

    // Fed oldest-first — a fresh createdAt-descending sort would put "newer"
    // first. It doesn't: the lane mirrors exactly the input order.
    expect(board.done.map((card) => card.tracker.id)).toEqual(["older", "newer"]);
  });

  it("the cancelled lane preserves trackers' input order for tied createdAt, not an id tiebreak", () => {
    const tied = "2026-01-01T00:00:00Z";
    const trackers = [
      tracker({ id: "a", status: "cancelled", createdAt: tied }),
      tracker({ id: "z", status: "cancelled", createdAt: tied }),
      tracker({ id: "m", status: "cancelled", createdAt: tied }),
    ];

    const board = buildTrackerBoard(trackers, "all");

    // Fed a-z-m — an id-descending tiebreak would produce z-m-a. It doesn't:
    // exactly the input order.
    expect(board.cancelled.map((card) => card.tracker.id)).toEqual(["a", "z", "m"]);
  });
});
