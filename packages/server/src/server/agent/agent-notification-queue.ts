import type { Logger } from "pino";

import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";

const DELIVERY_BASE_BACKOFF_MS = 1_000;
const DELIVERY_MAX_BACKOFF_MS = 30_000;
/**
 * How long a payload keeps trying. A caller parked on an unanswered permission
 * prompt stays "running" for as long as nobody answers — hours, overnight — and
 * its children's results have to survive that wait. A fixed attempt count does
 * not: at one attempt per capped backoff it expires while the caller is merely
 * busy, and the watch that produced the payload is already gone.
 */
const DELIVERY_MAX_WAIT_MS = 24 * 60 * 60_000;
const DELIVERY_WARN_EVERY = 10;
const IDLE_WAIT_TIMEOUT_MS = 300_000;
/** A run can settle without emitting agent_state, so never trust the edge alone. */
const IDLE_POLL_INTERVAL_MS = 1_000;

export interface AgentNotificationQueueDependencies {
  agentManager: Pick<AgentManager, "hasInFlightRun" | "subscribe">;
  agentStorage: Pick<AgentStorage, "get">;
  /** Hands one merged body to the receiving agent. Throwing schedules a retry. */
  deliver: (callerAgentId: string, body: string) => Promise<void>;
  logger: Logger;
  /** Test seam. Defaults to setTimeout. */
  delay?: (ms: number) => Promise<void>;
  /** Test seam. Defaults to Date.now. */
  now?: () => number;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Serializes system notifications per receiving agent.
 *
 * Peers finishing at the same moment used to race for the caller's single run
 * slot. The loser threw ("already has an active run") and its payload was gone
 * for good, because the sender marked itself fired before it ever attempted
 * delivery. The winner was no better: it replaced the caller's in-flight run,
 * killing the turn that was digesting the previous notification.
 *
 * Everything addressed to one caller now goes through a single drain loop that
 * waits for that caller to go idle, merges whatever piled up while it was busy
 * into one prompt, and retries with backoff instead of dropping.
 */
export class AgentNotificationQueue {
  private readonly pending = new Map<string, string[]>();
  private readonly draining = new Set<string>();
  private readonly delay: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly dependencies: AgentNotificationQueueDependencies) {
    this.delay = dependencies.delay ?? defaultDelay;
    this.now = dependencies.now ?? Date.now;
  }

  enqueue(callerAgentId: string, body: string): void {
    const queued = this.pending.get(callerAgentId);
    if (queued) {
      queued.push(body);
    } else {
      this.pending.set(callerAgentId, [body]);
    }

    if (this.draining.has(callerAgentId)) {
      return;
    }
    void this.drain(callerAgentId);
  }

  /** True while anything is queued or in flight. Tests wait on this. */
  isBusy(): boolean {
    return this.draining.size > 0 || this.pending.size > 0;
  }

  private async drain(callerAgentId: string): Promise<void> {
    this.draining.add(callerAgentId);
    try {
      let failures = 0;
      const startedAt = this.now();
      for (;;) {
        const queued = this.pending.get(callerAgentId);
        if (!queued || queued.length === 0) {
          this.pending.delete(callerAgentId);
          return;
        }

        if (await this.callerIsUnreachable(callerAgentId)) {
          this.pending.delete(callerAgentId);
          return;
        }
        await this.waitUntilCallerIdle(callerAgentId);

        // Taken after the wait, not before it. Everything that piled up while
        // the caller was busy rides along in one prompt instead of queueing a
        // separate turn per child.
        const batch = this.pending.get(callerAgentId)?.splice(0) ?? [];
        if (batch.length === 0) {
          continue;
        }

        try {
          await this.dependencies.deliver(callerAgentId, batch.join("\n\n"));
          failures = 0;
        } catch (error) {
          failures += 1;
          this.requeue(callerAgentId, batch);
          const waitedMs = this.now() - startedAt;
          if (waitedMs >= DELIVERY_MAX_WAIT_MS) {
            this.pending.delete(callerAgentId);
            this.dependencies.logger.error(
              { err: error, callerAgentId, attempts: failures, waitedMs },
              "Gave up delivering agent notification",
            );
            return;
          }
          const backoffMs = Math.min(
            DELIVERY_BASE_BACKOFF_MS * 2 ** Math.min(failures - 1, 10),
            DELIVERY_MAX_BACKOFF_MS,
          );
          // One line per attempt would bury the log during an overnight stall.
          if (failures === 1 || failures % DELIVERY_WARN_EVERY === 0) {
            this.dependencies.logger.warn(
              { err: error, callerAgentId, attempt: failures, backoffMs, waitedMs },
              "Agent notification delivery failed, retrying",
            );
          }
          await this.delay(backoffMs);
        }
      }
    } catch (error) {
      this.pending.delete(callerAgentId);
      this.dependencies.logger.error(
        { err: error, callerAgentId },
        "Agent notification drain loop failed",
      );
    } finally {
      this.draining.delete(callerAgentId);
    }
  }

  private requeue(callerAgentId: string, batch: string[]): void {
    const queued = this.pending.get(callerAgentId);
    if (queued) {
      queued.unshift(...batch);
      return;
    }
    this.pending.set(callerAgentId, batch);
  }

  private async callerIsUnreachable(callerAgentId: string): Promise<boolean> {
    const record = await this.dependencies.agentStorage.get(callerAgentId);
    return Boolean(record?.archivedAt);
  }

  private async waitUntilCallerIdle(callerAgentId: string): Promise<void> {
    const { agentManager } = this.dependencies;
    if (!agentManager.hasInFlightRun(callerAgentId)) {
      return;
    }

    const wentIdle = createDeferred();
    const unsubscribe = agentManager.subscribe(
      () => {
        if (!agentManager.hasInFlightRun(callerAgentId)) {
          wentIdle.resolve();
        }
      },
      { agentId: callerAgentId, replayState: false },
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    // A caller wedged mid-turn must not hold its queue forever. Falling through
    // hands the payload to the normal retry path.
    const gaveUp = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, IDLE_WAIT_TIMEOUT_MS);
    });

    // The subscription above is edge-triggered and a run can settle without
    // emitting agent_state. Polling alongside it makes a missed edge cost a
    // second instead of the whole five-minute cap.
    let poll: ReturnType<typeof setInterval> | undefined;
    const polledIdle = new Promise<void>((resolve) => {
      poll = setInterval(() => {
        if (!agentManager.hasInFlightRun(callerAgentId)) {
          resolve();
        }
      }, IDLE_POLL_INTERVAL_MS);
    });

    try {
      // The caller may have gone idle between the check above and the
      // subscribe, which would leave nothing left to wake us.
      if (!agentManager.hasInFlightRun(callerAgentId)) {
        return;
      }
      await Promise.race([wentIdle.promise, polledIdle, gaveUp]);
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
      unsubscribe();
    }
  }
}
