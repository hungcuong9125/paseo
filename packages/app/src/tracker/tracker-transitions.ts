// Pure status-transition mapping and pending-state tracking for the tracker board.
//
// This module has no UI/framework dependency: it maps a (fromLane, toLane) drop
// to the mutation it implies, and tracks which tracker ids are mid-RPC. The web
// drag-and-drop board and the native action sheet both consume it so the two
// surfaces can never disagree on which transitions exist. Wiring to
// useTrackerMutations is a downstream task (see docs/refactors/tracker-kanban-redesign.md).

// The four board columns. `done` holds `closed` items; `cancelled` is its own
// lane. `ready` is never a TrackerLane — it's a display-only split of `open`
// resolved at the UI layer (tracker-kanban-column.tsx's `transitionLaneFor`).
export type TrackerLane = "open" | "in_progress" | "done" | "cancelled";

// The mutation a drop implies, as a framework-free description the caller wires
// to useTrackerMutations. `cancel` is a real transition now (cancelled is a lane,
// and cancel-without-reason is a single kebab action), so it is part of the union.
export type TrackerTransition =
  | { kind: "update"; status: "in_progress" }
  | { kind: "update"; status: "open" }
  | { kind: "close" }
  | { kind: "reopen" }
  | { kind: "cancel" };

// Returns the mutation a drop from `from` to `to` should trigger, or null when
// the board must not offer that transition (same lane, unsupported pairs, or
// anything not listed). Never throws.
export function getTrackerTransition(from: TrackerLane, to: TrackerLane): TrackerTransition | null {
  if (from === to) return null;

  switch (`${from}->${to}`) {
    case "open->in_progress":
      return { kind: "update", status: "in_progress" };
    case "in_progress->open":
      return { kind: "update", status: "open" };
    case "open->done":
    case "in_progress->done":
      return { kind: "close" };
    case "open->cancelled":
    case "in_progress->cancelled":
      return { kind: "cancel" };
    case "done->open":
    case "cancelled->open":
      // Covers both closed->open and cancelled->open. ait reopen's help text:
      // "Reopen a closed or cancelled issue (sets status back to open)".
      return { kind: "reopen" };
    default:
      return null;
  }
}

export interface PendingTrackerSet {
  markPending: (trackerId: string) => void;
  clearPending: (trackerId: string) => void;
  isPending: (trackerId: string) => boolean;
}

// Framework-free shared pending tracker id primitive. Marking a card pending
// while an RPC is in flight lets the UI render it disabled/reduced opacity. The
// flag clears deterministically on either RPC success or failure — both are the
// caller's responsibility; this only tracks the boolean (no timers, no retry).
export function createPendingTrackerSet(): PendingTrackerSet {
  const pending = new Set<string>();
  return {
    markPending: (trackerId) => pending.add(trackerId),
    clearPending: (trackerId) => pending.delete(trackerId),
    isPending: (trackerId) => pending.has(trackerId),
  };
}
