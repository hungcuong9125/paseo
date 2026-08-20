import { describe, expect, it } from "vitest";
import {
  createPendingTrackerSet,
  getTrackerTransition,
  type TrackerLane,
} from "./tracker-transitions";

const LANES: TrackerLane[] = ["open", "in_progress", "done"];

describe("getTrackerTransition", () => {
  it("maps open -> in_progress to update in_progress", () => {
    expect(getTrackerTransition("open", "in_progress")).toEqual({
      kind: "update",
      status: "in_progress",
    });
  });

  it("maps in_progress -> open to update open", () => {
    expect(getTrackerTransition("in_progress", "open")).toEqual({
      kind: "update",
      status: "open",
    });
  });

  it("maps open -> done to close", () => {
    expect(getTrackerTransition("open", "done")).toEqual({ kind: "close" });
  });

  it("maps in_progress -> done to close", () => {
    expect(getTrackerTransition("in_progress", "done")).toEqual({ kind: "close" });
  });

  it("maps done -> open to reopen (covers closed and cancelled)", () => {
    expect(getTrackerTransition("done", "open")).toEqual({ kind: "reopen" });
  });

  it("returns null for same-lane drops", () => {
    expect(getTrackerTransition("open", "open")).toBeNull();
    expect(getTrackerTransition("in_progress", "in_progress")).toBeNull();
    expect(getTrackerTransition("done", "done")).toBeNull();
  });

  it("returns null for unsupported cross-lane pairs (done only flows to open)", () => {
    expect(getTrackerTransition("done", "in_progress")).toBeNull();
  });

  it("returns null for every from/to pair not in the matrix", () => {
    for (const from of LANES) {
      for (const to of LANES) {
        const supported =
          (from === "open" && (to === "in_progress" || to === "done")) ||
          (from === "in_progress" && (to === "open" || to === "done")) ||
          (from === "done" && to === "open");
        if (!supported) {
          expect(getTrackerTransition(from, to)).toBeNull();
        }
      }
    }
  });

  it("never offers cancel as a drop target", () => {
    // cancel has no lane; exhaustively confirm no matrix pair yields a cancel kind.
    for (const from of LANES) {
      for (const to of LANES) {
        const transition = getTrackerTransition(from, to);
        expect(transition).not.toEqual({ kind: "cancel" });
        if (transition) {
          expect(["update", "close", "reopen"]).toContain(transition.kind);
        }
      }
    }
  });
});

describe("createPendingTrackerSet", () => {
  it("is not pending before marking and pending after marking", () => {
    const set = createPendingTrackerSet();
    const id = "paseo-abc.1";
    expect(set.isPending(id)).toBe(false);
    set.markPending(id);
    expect(set.isPending(id)).toBe(true);
  });

  it("clears pending and stays cleared", () => {
    const set = createPendingTrackerSet();
    const id = "paseo-abc.1";
    set.markPending(id);
    set.clearPending(id);
    expect(set.isPending(id)).toBe(false);
  });

  it("tracks multiple ids independently", () => {
    const set = createPendingTrackerSet();
    set.markPending("a");
    set.markPending("b");
    expect(set.isPending("a")).toBe(true);
    expect(set.isPending("b")).toBe(true);
    set.clearPending("a");
    expect(set.isPending("a")).toBe(false);
    expect(set.isPending("b")).toBe(true);
  });

  it("double mark is idempotent", () => {
    const set = createPendingTrackerSet();
    set.markPending("a");
    set.markPending("a");
    expect(set.isPending("a")).toBe(true);
  });

  it("clearing when not marked is a no-op", () => {
    const set = createPendingTrackerSet();
    expect(() => set.clearPending("never-marked")).not.toThrow();
    expect(set.isPending("never-marked")).toBe(false);
  });
});
