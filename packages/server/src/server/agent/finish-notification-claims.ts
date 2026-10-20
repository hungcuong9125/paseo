/**
 * Which of a child's turns a caller already hears about through a per-prompt
 * ("next-turn") watch, so the caller's standing watch on the same child does
 * not report that turn a second time.
 *
 * One registry per (child, caller) pair. A next-turn watch registers a handle
 * while it is armed and claims the turn it reports. The standing watch asks,
 * for each turn that ends, whether the turn is claimed, may still be claimed by
 * a live handle, or belongs to nobody.
 */

/** Key for a terminal event a provider emitted without a turn id. */
export const UNIDENTIFIED_TURN = "unidentified-turn";

/** Claimed turn ids kept per pair; old ones can no longer end again. */
const MAX_REMEMBERED_CLAIMS = 32;

export interface CallerTurnHandle {
  /** The handle's dispatch has started its turn; `turnId` null means "the next to end". */
  bind(turnId: string | null): void;
  /** The turn this handle reported, or the watch was torn down. */
  claim(turnKey: string): void;
  release(): void;
}

interface HandleState {
  bound: boolean;
  turnId: string | null;
}

export type TurnOwnership = "claimed" | "pending" | "unowned";

export class CallerTurnClaims {
  private readonly handles = new Set<HandleState>();
  private readonly claimed: string[] = [];
  private readonly listeners = new Set<() => void>();

  register(): CallerTurnHandle {
    const state: HandleState = { bound: false, turnId: null };
    this.handles.add(state);
    return {
      bind: (turnId) => {
        state.bound = true;
        state.turnId = turnId;
        this.changed();
      },
      claim: (turnKey) => {
        if (!this.claimed.includes(turnKey)) {
          this.claimed.push(turnKey);
          if (this.claimed.length > MAX_REMEMBERED_CLAIMS) this.claimed.shift();
        }
        this.changed();
      },
      release: () => {
        if (this.handles.delete(state)) this.changed();
      },
    };
  }

  /** Whether the caller's own prompt watch reports this turn, may still, or will not. */
  ownership(turnKey: string): TurnOwnership {
    if (this.claimed.includes(turnKey)) {
      return "claimed";
    }
    for (const handle of this.handles) {
      if (!handle.bound || handle.turnId === null || handle.turnId === turnKey) {
        return "pending";
      }
    }
    return "unowned";
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

const registries = new WeakMap<object, Map<string, CallerTurnClaims>>();

/** `scope` is the AgentManager; one daemon has one. */
export function callerTurnClaims(
  scope: object,
  childAgentId: string,
  callerAgentId: string,
): CallerTurnClaims {
  const byPair = registries.get(scope) ?? new Map<string, CallerTurnClaims>();
  registries.set(scope, byPair);
  const key = JSON.stringify([childAgentId, callerAgentId]);
  let claims = byPair.get(key);
  if (!claims) {
    claims = new CallerTurnClaims();
    byPair.set(key, claims);
  }
  return claims;
}
