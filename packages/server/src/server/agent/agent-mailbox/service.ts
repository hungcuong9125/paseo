import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import type { AgentManager, AgentManagerEvent } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import type { MailboxPolicy } from "./policy.js";
import {
  createEmptyMailboxFile,
  type MailboxEntry,
  type MailboxFile,
  type MailboxSource,
  type MailboxStore,
  type MailboxWatch,
} from "./store.js";

const DELIVERY_BASE_BACKOFF_MS = 1_000;
const DELIVERY_MAX_BACKOFF_MS = 30_000;
/**
 * How long one drain keeps retrying a refused delivery. A caller parked on an
 * unanswered permission prompt stays "running" for hours. Giving up only ends
 * this drain; the mail stays on disk for the next enqueue, resume, or restart.
 */
const DELIVERY_MAX_WAIT_MS = 24 * 60 * 60_000;
const DELIVERY_WARN_EVERY = 10;
const IDLE_WAIT_TIMEOUT_MS = 300_000;
/** A run can settle without emitting agent_state, so never trust the edge alone. */
const IDLE_POLL_INTERVAL_MS = 1_000;
/** Consecutive items are merged into one prompt up to this many characters. */
const MAX_BATCH_TEXT_CHARS = 64_000;
const STARTUP_RESUME_CONCURRENCY = 3;
/**
 * Turns an item may start without completing before it is held. Five covers a
 * provider hiccup or a rate limit; past that the turn is failing on the item
 * itself, and each retry is a paid model turn.
 */
export const MAX_TURN_ATTEMPTS = 5;
const TURN_RETRY_BASE_MS = 5_000;
const TURN_RETRY_MAX_MS = 5 * 60_000;

/** 5 s, 20 s, 80 s, then 5 min: about seven minutes from first failure to held. */
export function turnRetryDelayMs(attempts: number): number {
  return Math.min(TURN_RETRY_BASE_MS * 4 ** Math.max(attempts - 1, 0), TURN_RETRY_MAX_MS);
}

export interface MailboxDelivery {
  agentId: string;
  entries: MailboxEntry[];
  sessionMode?: string;
  /**
   * Fresh finish notifications to an agent without a mailbox keep the plain
   * merged shape they had before mail was durable. Everything else is wrapped
   * per item so a redelivered item can be recognized.
   */
  plainNotifications: boolean;
}

export interface MailboxEnqueueInput {
  source: MailboxSource;
  text: string;
  sessionMode?: string;
  notifyCallerAgentId?: string;
}

export type MailboxAdmission<T> =
  | { status: "queued"; entry: MailboxEntry; position: number }
  | { status: "dispatched"; result: T };

export interface AgentMailboxDependencies {
  store: MailboxStore;
  agentManager: Pick<AgentManager, "hasInFlightRun" | "subscribe">;
  agentStorage: Pick<AgentStorage, "get">;
  resolvePolicy: (agentId: string) => Promise<MailboxPolicy>;
  /** Starts the turn that carries one batch. Throwing schedules a retry. */
  deliver: (delivery: MailboxDelivery) => Promise<void>;
  logger: Logger;
  /** Test seam. Defaults to setTimeout. */
  delay?: (ms: number) => Promise<void>;
  /** Test seam. Defaults to Date.now. */
  now?: () => number;
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

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What the agent reported for the turn that carried the last batch. */
interface BatchTurnWatch {
  outcome: "completed" | "interrupted" | null;
  unsubscribe: () => void;
}

type DrainStep =
  | { kind: "delivered" }
  | { kind: "busy" }
  | { kind: "stop" }
  /** The last batch's turn did not complete; wait this long before the next one. */
  | { kind: "retry"; delayMs: number }
  | { kind: "failed"; error: unknown };

/**
 * The per-agent mailbox: an ordered, durable list of prompts waiting for the
 * receiver to go idle, plus the finish watches the receiver has armed on other
 * agents.
 *
 * Every read-modify-write of one agent's file, and every dispatch the mailbox
 * makes or admits for that agent, runs under that agent's lock. That is what
 * keeps a prompt arriving just as the agent goes idle from overtaking mail
 * that was already waiting.
 */
export class AgentMailbox {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly draining = new Map<string, symbol>();
  private readonly batchTurns = new Map<string, BatchTurnWatch>();
  private readonly delay: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly stopSignal = createDeferred();
  private stopped = false;

  constructor(private readonly dependencies: AgentMailboxDependencies) {
    this.delay = dependencies.delay ?? defaultDelay;
    this.now = dependencies.now ?? Date.now;
  }

  resolvePolicy(agentId: string): Promise<MailboxPolicy> {
    return this.dependencies.resolvePolicy(agentId);
  }

  /**
   * Queue the prompt when the receiver is busy, already has mail waiting, or
   * was stopped by a person; otherwise run `dispatch` while still holding the
   * lock, so nothing can slip in between the check and the turn starting.
   */
  async admit<T>(
    agentId: string,
    input: MailboxEnqueueInput,
    dispatch: () => Promise<T>,
  ): Promise<MailboxAdmission<T>> {
    const admission = await this.withLock(agentId, async (): Promise<MailboxAdmission<T>> => {
      const file = await this.loadOrCreate(agentId);
      const queued = file.entries.filter((entry) => entry.state === "queued");
      if (
        !file.paused &&
        queued.length === 0 &&
        !file.entries.some((entry) => entry.state === "delivering") &&
        !this.dependencies.agentManager.hasInFlightRun(agentId)
      ) {
        return { status: "dispatched", result: await dispatch() };
      }
      const entry = this.append(file, input);
      await this.dependencies.store.save(file);
      return { status: "queued", entry, position: queued.length + 1 };
    });
    if (admission.status === "queued") {
      void this.kick(agentId);
    }
    return admission;
  }

  /** Always queues. `resolvesWatchId` retires that watch in the same write. */
  async enqueue(
    agentId: string,
    input: MailboxEnqueueInput,
    options?: { resolvesWatchId?: string },
  ): Promise<MailboxEntry> {
    const entry = await this.withLock(agentId, async () => {
      const file = await this.loadOrCreate(agentId);
      if (options?.resolvesWatchId) {
        file.watches = file.watches.filter((watch) => watch.id !== options.resolvesWatchId);
      }
      const appended = this.append(file, input);
      await this.dependencies.store.save(file);
      return appended;
    });
    void this.kick(agentId);
    return entry;
  }

  async armWatch(callerAgentId: string, watch: MailboxWatch): Promise<void> {
    await this.withLock(callerAgentId, async () => {
      const file = await this.loadOrCreate(callerAgentId);
      file.watches = [...file.watches.filter((existing) => existing.id !== watch.id), watch];
      await this.dependencies.store.save(file);
    });
  }

  async removeWatch(callerAgentId: string, watchId: string): Promise<void> {
    await this.withLock(callerAgentId, async () => {
      const file = await this.dependencies.store.load(callerAgentId);
      if (!file || !file.watches.some((watch) => watch.id === watchId)) {
        return;
      }
      file.watches = file.watches.filter((watch) => watch.id !== watchId);
      await this.dependencies.store.save(file);
    });
  }

  /** A person stopped the agent: hold its mail until someone with authority prompts it. */
  async pause(agentId: string): Promise<void> {
    if (!(await this.resolvePolicy(agentId)).enabled) {
      return;
    }
    await this.withLock(agentId, async () => {
      const file = await this.loadOrCreate(agentId);
      if (file.paused) {
        return;
      }
      file.paused = true;
      await this.dependencies.store.save(file);
    });
  }

  /**
   * Someone with authority prompted the agent: lift a person's stop and give
   * held items a fresh set of attempts. The caller kicks the drain once its
   * own turn has started.
   */
  async resume(agentId: string): Promise<void> {
    const { enabled } = await this.resolvePolicy(agentId);
    await this.withLock(agentId, async () => {
      const file = await this.dependencies.store.load(agentId);
      if (!file) {
        return;
      }
      let changed = false;
      if (enabled && file.paused) {
        file.paused = false;
        changed = true;
      }
      for (const entry of file.entries) {
        if (entry.state === "held") {
          entry.state = "queued";
          entry.attempts = 0;
          changed = true;
        }
      }
      if (changed) {
        await this.dependencies.store.save(file);
      }
    });
  }

  async isPaused(agentId: string): Promise<boolean> {
    return Boolean((await this.dependencies.store.load(agentId))?.paused);
  }

  async listEntries(agentId: string): Promise<MailboxEntry[]> {
    return (await this.dependencies.store.load(agentId))?.entries ?? [];
  }

  async listWatches(agentId: string): Promise<MailboxWatch[]> {
    return (await this.dependencies.store.load(agentId))?.watches ?? [];
  }

  /** Archive keeps the file; only deleting the agent removes it. */
  async deleteAgent(agentId: string): Promise<void> {
    await this.withLock(agentId, () => this.dependencies.store.remove(agentId));
  }

  /**
   * Bring every mailbox on disk back after a restart. Nothing that was in
   * flight survived the old process: a delivering batch goes back in line
   * marked as redelivered, a permission notice points at a request that died
   * with its provider, and every armed watch belongs to a child that was
   * stopped mid-turn. Returns the agents that have mail waiting.
   */
  async recover(): Promise<string[]> {
    const withMail: string[] = [];
    let agentIds: string[];
    try {
      agentIds = await this.dependencies.store.listAgentIds();
    } catch (error) {
      this.dependencies.logger.error({ err: error }, "Failed to list mailboxes; none recovered");
      return withMail;
    }
    for (const agentId of agentIds) {
      try {
        const hasMail = await this.withLock(agentId, () => this.recoverOne(agentId));
        if (hasMail) {
          withMail.push(agentId);
        }
      } catch (error) {
        // One unreadable mailbox must not keep the daemon from starting. It
        // stays on disk for a person to inspect.
        this.dependencies.logger.error({ err: error, agentId }, "Failed to recover mailbox");
      }
    }
    return withMail;
  }

  /** Drain the given agents when their policy asks for it, a few at a time. */
  async resumeOnStartup(agentIds: readonly string[]): Promise<void> {
    const pending: string[] = [];
    for (const agentId of agentIds) {
      if ((await this.resolvePolicy(agentId)).resumeOnStartup) {
        pending.push(agentId);
      }
    }
    const worker = async () => {
      for (let agentId = pending.shift(); agentId; agentId = pending.shift()) {
        await this.kick(agentId);
      }
    };
    await Promise.all(Array.from({ length: STARTUP_RESUME_CONCURRENCY }, worker));
  }

  /** Stop starting turns. Enqueues still reach the disk. */
  stop(): void {
    this.stopped = true;
    this.stopSignal.resolve();
    for (const watch of this.batchTurns.values()) {
      watch.unsubscribe();
    }
    this.batchTurns.clear();
  }

  /** Resolves once every write already requested has finished. */
  async flush(): Promise<void> {
    await Promise.allSettled(this.tails.values());
  }

  /** True while any drain is running. Tests wait on this. */
  isBusy(): boolean {
    return this.draining.size > 0;
  }

  /**
   * Start draining unless a drain is already running. Resolves after the
   * drain's first delivery attempt, or once it has nothing to do.
   */
  kick(agentId: string): Promise<void> {
    if (this.stopped || this.draining.has(agentId)) {
      return Promise.resolve();
    }
    const token = Symbol(agentId);
    this.draining.set(agentId, token);
    const firstAttempt = createDeferred();
    void this.drain(agentId, token, firstAttempt);
    return firstAttempt.promise;
  }

  private async recoverOne(agentId: string): Promise<boolean> {
    const file = await this.dependencies.store.load(agentId);
    if (!file) {
      return false;
    }
    for (const entry of file.entries) {
      if (entry.state === "delivering") {
        entry.attempts += 1;
        entry.state = entry.attempts >= MAX_TURN_ATTEMPTS ? "held" : "queued";
        entry.redelivered = true;
      }
      if (entry.source.kind === "notification" && entry.source.requestId) {
        entry.prompt.text = await this.expiredPermissionText(
          entry.source.childAgentId,
          entry.source.requestId,
        );
        entry.source = { kind: "notification", childAgentId: entry.source.childAgentId };
      }
    }
    for (const watch of file.watches) {
      this.append(file, {
        source: { kind: "restart", childAgentId: watch.childAgentId },
        text: await this.restartText(watch.childAgentId),
      });
    }
    file.watches = [];
    await this.dependencies.store.save(file);
    return file.entries.some((entry) => entry.state !== "held");
  }

  private async drain(agentId: string, token: symbol, firstAttempt: Deferred): Promise<void> {
    let failures = 0;
    const startedAt = this.now();
    try {
      for (;;) {
        if (this.stopped || !(await this.hasMail(agentId, token))) {
          return;
        }
        // A missing record may be an agent not persisted yet, so the mail is
        // kept; deleting the agent is what removes it.
        const record = await this.dependencies.agentStorage.get(agentId);
        if (!record || record.archivedAt) {
          return;
        }
        const policy = await this.resolvePolicy(agentId);
        await this.waitUntilIdle(agentId);
        if (this.stopped) {
          return;
        }

        const step = await this.withLock(agentId, () =>
          this.deliverNextBatch(agentId, policy, token),
        );
        firstAttempt.resolve();
        if (step.kind === "stop") {
          return;
        }
        if (step.kind === "retry") {
          await this.delay(step.delayMs);
          continue;
        }
        if (step.kind !== "failed") {
          failures = 0;
          continue;
        }

        failures += 1;
        const waitedMs = this.now() - startedAt;
        if (waitedMs >= DELIVERY_MAX_WAIT_MS) {
          this.dependencies.logger.error(
            { err: step.error, agentId, attempts: failures, waitedMs },
            "Gave up draining mailbox for now; mail stays on disk",
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
            { err: step.error, agentId, attempt: failures, backoffMs, waitedMs },
            "Mailbox delivery failed, retrying",
          );
        }
        await this.delay(backoffMs);
      }
    } catch (error) {
      this.dependencies.logger.error({ err: error, agentId }, "Mailbox drain loop failed");
    } finally {
      if (this.draining.get(agentId) === token) {
        this.draining.delete(agentId);
      }
      firstAttempt.resolve();
    }
  }

  /**
   * Checked under the lock and released in the same step, so an enqueue that
   * lands right after this sees no drain and starts one.
   */
  private async hasMail(agentId: string, token: symbol): Promise<boolean> {
    return await this.withLock(agentId, async () => {
      const file = await this.dependencies.store.load(agentId);
      if (file?.entries.some((entry) => entry.state !== "held")) {
        return true;
      }
      this.releaseDrain(agentId, token);
      return false;
    });
  }

  private async deliverNextBatch(
    agentId: string,
    policy: MailboxPolicy,
    token: symbol,
  ): Promise<DrainStep> {
    const file = await this.dependencies.store.load(agentId);
    if (!file) {
      this.releaseDrain(agentId, token);
      return { kind: "stop" };
    }
    // Still running: the turn carrying the last batch, or someone else's.
    // Nothing about the delivered mail is known yet.
    if (this.dependencies.agentManager.hasInFlightRun(agentId)) {
      return { kind: "busy" };
    }
    const settled = this.settleDeliveredBatch(agentId, file);
    if (policy.enabled && file.paused) {
      await this.dependencies.store.save(file);
      this.releaseDrain(agentId, token);
      return { kind: "stop" };
    }
    if (settled.kind === "requeued") {
      await this.dependencies.store.save(file);
      return { kind: "retry", delayMs: turnRetryDelayMs(settled.attempts) };
    }
    if (settled.kind === "held") {
      await this.dependencies.store.save(file);
      return { kind: "busy" };
    }
    const batch = selectBatch(file.entries);
    if (batch.length === 0) {
      await this.dependencies.store.save(file);
      return { kind: "busy" };
    }
    for (const entry of batch) {
      entry.state = "delivering";
    }
    await this.dependencies.store.save(file);

    // Armed before the hand-over so a turn that ends at once is still seen.
    this.watchBatchTurn(agentId);
    try {
      await this.dependencies.deliver({
        agentId,
        entries: batch,
        ...(batch[0]?.sessionMode ? { sessionMode: batch[0].sessionMode } : {}),
        plainNotifications:
          !policy.enabled &&
          batch.every((entry) => entry.source.kind === "notification" && !entry.redelivered),
      });
      return { kind: "delivered" };
    } catch (error) {
      // No turn started, so this does not count against the items' attempts;
      // the drain's own backoff paces it.
      this.forgetBatchTurn(agentId);
      for (const entry of batch) {
        entry.state = "queued";
      }
      await this.dependencies.store.save(file);
      return { kind: "failed", error };
    }
  }

  /**
   * Delivered mail leaves the box only when its turn is seen completing. A
   * turn that failed, was interrupted, or never started (a run whose start
   * fails after hand-over reports nothing back) puts the mail back in line,
   * until MAX_TURN_ATTEMPTS: then it is held on disk instead of retried.
   */
  private settleDeliveredBatch(
    agentId: string,
    file: MailboxFile,
  ): { kind: "nothing" | "completed" | "held" } | { kind: "requeued"; attempts: number } {
    const watch = this.batchTurns.get(agentId);
    this.forgetBatchTurn(agentId);
    const delivering = file.entries.filter((entry) => entry.state === "delivering");
    if (delivering.length === 0) {
      return { kind: "nothing" };
    }
    if (watch?.outcome === "completed") {
      file.entries = file.entries.filter((entry) => entry.state !== "delivering");
      return { kind: "completed" };
    }
    let attempts = 0;
    for (const entry of delivering) {
      entry.redelivered = true;
      entry.attempts += 1;
      entry.state = entry.attempts >= MAX_TURN_ATTEMPTS ? "held" : "queued";
      attempts = Math.max(attempts, entry.attempts);
    }
    if (delivering.some((entry) => entry.state === "held")) {
      this.dependencies.logger.warn(
        { agentId, held: delivering.map((entry) => entry.id), attempts },
        "Holding mailbox items whose turns keep failing until a person or the parent prompts",
      );
    }
    if (delivering.every((entry) => entry.state === "held")) {
      return { kind: "held" };
    }
    return { kind: "requeued", attempts };
  }

  private watchBatchTurn(agentId: string): void {
    this.forgetBatchTurn(agentId);
    const watch: BatchTurnWatch = { outcome: null, unsubscribe: () => undefined };
    watch.unsubscribe = this.dependencies.agentManager.subscribe(
      (event: AgentManagerEvent) => {
        if (watch.outcome !== null || event.type !== "agent_stream") {
          return;
        }
        if (event.event.type === "turn_completed") {
          watch.outcome = "completed";
        } else if (event.event.type === "turn_failed" || event.event.type === "turn_canceled") {
          watch.outcome = "interrupted";
        }
      },
      { agentId, replayState: false },
    );
    this.batchTurns.set(agentId, watch);
  }

  private forgetBatchTurn(agentId: string): void {
    this.batchTurns.get(agentId)?.unsubscribe();
    this.batchTurns.delete(agentId);
  }

  /** Called under the lock, so an enqueue right after sees no drain and starts one. */
  private releaseDrain(agentId: string, token: symbol): void {
    if (this.draining.get(agentId) === token) {
      this.draining.delete(agentId);
    }
  }

  private append(file: MailboxFile, input: MailboxEnqueueInput): MailboxEntry {
    const entry: MailboxEntry = {
      id: `mbx_${randomUUID()}`,
      seq: file.nextSeq,
      state: "queued",
      attempts: 0,
      source: input.source,
      prompt: { text: input.text },
      ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
      ...(input.notifyCallerAgentId ? { notifyCallerAgentId: input.notifyCallerAgentId } : {}),
      enqueuedAt: new Date(this.now()).toISOString(),
    };
    file.nextSeq += 1;
    file.entries.push(entry);
    return entry;
  }

  private async loadOrCreate(agentId: string): Promise<MailboxFile> {
    return (await this.dependencies.store.load(agentId)) ?? createEmptyMailboxFile(agentId);
  }

  private withLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(agentId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.catch(() => undefined);
    this.tails.set(agentId, tail);
    void tail.finally(() => {
      if (this.tails.get(agentId) === tail) {
        this.tails.delete(agentId);
      }
    });
    return result;
  }

  private async describeAgent(agentId: string): Promise<string> {
    const record = await this.dependencies.agentStorage.get(agentId);
    return `Agent ${agentId} (${record?.title ?? agentId})`;
  }

  private async restartText(childAgentId: string): Promise<string> {
    return `${await this.describeAgent(childAgentId)} was interrupted by a daemon restart before it reported back. Check it with get_agent_status before relying on its work.`;
  }

  private async expiredPermissionText(childAgentId: string, requestId: string): Promise<string> {
    return `${await this.describeAgent(childAgentId)} asked for permission (request ${requestId}), but the request expired when the daemon restarted. Nothing is waiting on it anymore; check the agent with get_agent_status.`;
  }

  private async waitUntilIdle(agentId: string): Promise<void> {
    const { agentManager } = this.dependencies;
    if (!agentManager.hasInFlightRun(agentId)) {
      return;
    }

    const wentIdle = createDeferred();
    const unsubscribe = agentManager.subscribe(
      () => {
        if (!agentManager.hasInFlightRun(agentId)) {
          wentIdle.resolve();
        }
      },
      { agentId, replayState: false },
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    // An agent wedged mid-turn must not hold its mail forever. Falling through
    // hands the batch to the normal retry path.
    const gaveUp = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, IDLE_WAIT_TIMEOUT_MS);
    });

    // The subscription is edge-triggered and a run can settle without emitting
    // agent_state. Polling alongside it makes a missed edge cost a second.
    let poll: ReturnType<typeof setInterval> | undefined;
    const polledIdle = new Promise<void>((resolve) => {
      poll = setInterval(() => {
        if (!agentManager.hasInFlightRun(agentId)) {
          resolve();
        }
      }, IDLE_POLL_INTERVAL_MS);
    });

    try {
      // The agent may have gone idle between the check above and the subscribe.
      if (!agentManager.hasInFlightRun(agentId)) {
        return;
      }
      await Promise.race([wentIdle.promise, polledIdle, gaveUp, this.stopSignal.promise]);
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
      unsubscribe();
    }
  }
}

/**
 * Consecutive queued items in seq order, merged up to a size cap. An item
 * that changes the session mode travels alone, since a batch has one mode.
 */
function selectBatch(entries: readonly MailboxEntry[]): MailboxEntry[] {
  const queued = entries
    .filter((entry) => entry.state === "queued")
    .sort((left, right) => left.seq - right.seq);
  const first = queued[0];
  if (!first) {
    return [];
  }
  if (first.sessionMode) {
    return [first];
  }
  const batch = [first];
  let size = first.prompt.text.length;
  for (const entry of queued.slice(1)) {
    if (entry.sessionMode || size + entry.prompt.text.length > MAX_BATCH_TEXT_CHARS) {
      break;
    }
    batch.push(entry);
    size += entry.prompt.text.length;
  }
  return batch;
}
