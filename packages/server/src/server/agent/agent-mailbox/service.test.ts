import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager, type AgentManagerEvent } from "../agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";
import type { MailboxPolicy } from "./policy.js";
import { AgentMailbox, MAX_TURN_ATTEMPTS, type MailboxDelivery } from "./service.js";
import { createEmptyMailboxFile, FileMailboxStore, type MailboxStore } from "./store.js";

const ENABLED: MailboxPolicy = { enabled: true, resumeOnStartup: false };
const fixtureMailboxes: AgentMailbox[] = [];

/**
 * What the turn started by one delivery does: completes at once, fails or is
 * interrupted at once, never starts, or keeps running until `endTurn`.
 */
type TurnOutcome = "completed" | "failed" | "canceled" | "never-started" | "keeps-running";

interface Fixture {
  mailbox: AgentMailbox;
  store: MailboxStore;
  deliveries: MailboxDelivery[];
  /** Every wait the drain asked for, in order. */
  delays: number[];
  setRunning(agentId: string, running: boolean): void;
  endTurn(agentId: string, outcome: "completed" | "failed" | "canceled"): void;
  archive(agentId: string): void;
  setRecord(agentId: string, patch: Partial<StoredAgentRecord>): void;
}

const TURN_EVENT = {
  completed: "turn_completed",
  failed: "turn_failed",
  canceled: "turn_canceled",
} as const;

function createFixture(options: {
  directory: string;
  policy?: MailboxPolicy;
  running?: string[];
  /** Consumed one per delivery; once empty every turn ends as `everyTurn`. */
  turns?: TurnOutcome[];
  everyTurn?: TurnOutcome;
}): Fixture {
  const delays: number[] = [];
  const running = new Set(options.running ?? []);
  const turns = [...(options.turns ?? [])];
  const records = new Map<string, Partial<StoredAgentRecord>>();
  const listeners = new Set<{
    agentId: string;
    callback: (event: AgentManagerEvent) => void;
  }>();
  const deliveries: MailboxDelivery[] = [];
  const store = new FileMailboxStore(options.directory, createTestLogger());

  function record(agentId: string): Partial<StoredAgentRecord> {
    const existing = records.get(agentId);
    if (existing) return existing;
    const created: Partial<StoredAgentRecord> = { id: agentId, title: `Title of ${agentId}` };
    records.set(agentId, created);
    return created;
  }

  function emit(agentId: string, event: AgentManagerEvent): void {
    for (const listener of listeners) {
      if (listener.agentId === agentId) listener.callback(event);
    }
  }

  function setRunning(agentId: string, isRunning: boolean): void {
    if (isRunning) running.add(agentId);
    else running.delete(agentId);
    emit(agentId, { type: "agent_state" } as AgentManagerEvent);
  }

  function endTurn(agentId: string, outcome: "completed" | "failed" | "canceled"): void {
    emit(agentId, {
      type: "agent_stream",
      agentId,
      event: { type: TURN_EVENT[outcome], provider: "codex", turnId: "turn" },
    } as AgentManagerEvent);
    setRunning(agentId, false);
  }

  const agentManager = {
    hasInFlightRun: (agentId: string) => running.has(agentId),
    subscribe: (
      callback: (event: AgentManagerEvent) => void,
      subscribeOptions?: { agentId?: string | null },
    ) => {
      const listener = { agentId: subscribeOptions?.agentId ?? "", callback };
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as Pick<AgentManager, "hasInFlightRun" | "subscribe">;
  const agentStorage = {
    get: async (agentId: string) => record(agentId) as StoredAgentRecord,
  } as unknown as Pick<AgentStorage, "get">;

  const mailbox = new AgentMailbox({
    store,
    agentManager,
    agentStorage,
    resolvePolicy: async () => options.policy ?? ENABLED,
    deliver: async (delivery) => {
      deliveries.push(structuredClone(delivery));
      const outcome = turns.shift() ?? options.everyTurn ?? "completed";
      if (outcome === "never-started") return;
      setRunning(delivery.agentId, true);
      if (outcome !== "keeps-running") endTurn(delivery.agentId, outcome);
    },
    logger: createTestLogger(),
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  fixtureMailboxes.push(mailbox);

  return {
    mailbox,
    store,
    deliveries,
    delays,
    setRunning,
    endTurn,
    archive(agentId) {
      record(agentId).archivedAt = "2026-10-07T00:00:00.000Z";
    },
    setRecord(agentId, patch) {
      Object.assign(record(agentId), patch);
    },
  };
}

function standingNotice(childAgentId: string, text: string) {
  return { source: { kind: "notification" as const, childAgentId, standing: true }, text };
}

async function seedStandingWatch(directory: string, caller: string, childAgentId: string) {
  const store = new FileMailboxStore(directory, createTestLogger());
  const file = createEmptyMailboxFile(caller);
  file.watches.push({
    id: `watch_${childAgentId}`,
    childAgentId,
    turnId: null,
    armedAt: "2026-10-11T00:00:00.000Z",
    mode: "standing",
  });
  await store.save(file);
}

function agentPrompt(text: string, senderAgentId = "peer") {
  return { source: { kind: "agent" as const, senderAgentId }, text };
}

describe("AgentMailbox", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "mailbox-service-"));
  });

  afterEach(async () => {
    for (const mailbox of fixtureMailboxes.splice(0)) {
      mailbox.stop();
      await vi.waitFor(() => expect(mailbox.isBusy()).toBe(false));
      await mailbox.flush();
    }
    await rm(directory, { recursive: true, force: true });
  });

  test("a prompt for a running agent is queued and never dispatched over its turn", async () => {
    const fixture = createFixture({ directory, running: ["lead"] });
    const dispatch = vi.fn(async () => "dispatched");

    const first = await fixture.mailbox.admit("lead", agentPrompt("one"), dispatch);
    const second = await fixture.mailbox.admit("lead", agentPrompt("two"), dispatch);

    expect(first).toMatchObject({ status: "queued", position: 1 });
    expect(second).toMatchObject({ status: "queued", position: 2 });
    expect(dispatch).not.toHaveBeenCalled();
    expect(fixture.deliveries).toEqual([]);
    fixture.mailbox.stop();
  });

  test("an idle agent with nothing waiting gets the prompt directly", async () => {
    const fixture = createFixture({ directory });

    const admission = await fixture.mailbox.admit("lead", agentPrompt("now"), async () => "ran");

    expect(admission).toEqual({ status: "dispatched", result: "ran" });
    expect(await fixture.mailbox.listEntries("lead")).toEqual([]);
  });

  test("does not dispatch over a delivered batch awaiting its turn outcome", async () => {
    const fixture = createFixture({ directory, running: ["lead"] });
    await fixture.mailbox.enqueue("lead", agentPrompt("first"));
    fixture.mailbox.stop();
    await fixture.mailbox.flush();
    const file = await fixture.store.load("lead");
    if (!file) throw new Error("Expected persisted mail");
    file.entries[0]!.state = "delivering";
    await fixture.store.save(file);
    fixture.setRunning("lead", false);
    const dispatch = vi.fn(async () => "ran");
    const admission = await fixture.mailbox.admit("lead", agentPrompt("second"), dispatch);
    expect(admission.status).toBe("queued");
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("when the agent goes idle the mail arrives as one batch in seq order", async () => {
    const fixture = createFixture({ directory, running: ["lead"], turns: ["keeps-running"] });
    for (const text of ["one", "two", "three"]) {
      await fixture.mailbox.admit("lead", agentPrompt(text), async () => undefined);
    }

    fixture.setRunning("lead", false);
    await vi.waitFor(() => expect(fixture.deliveries).toHaveLength(1));

    const delivered = fixture.deliveries[0]?.entries ?? [];
    expect(delivered.map((entry) => entry.prompt.text)).toEqual(["one", "two", "three"]);
    expect(delivered.map((entry) => entry.seq)).toEqual([0, 1, 2]);
    expect(fixture.deliveries[0]?.plainNotifications).toBe(false);
    // Delivered mail stays on disk until the turn carrying it ends.
    expect((await fixture.mailbox.listEntries("lead")).map((entry) => entry.state)).toEqual([
      "delivering",
      "delivering",
      "delivering",
    ]);

    fixture.endTurn("lead", "completed");
    await vi.waitFor(async () => expect(await fixture.mailbox.listEntries("lead")).toEqual([]));
    expect(fixture.deliveries).toHaveLength(1);
  });

  test.each([
    ["fails", "failed"],
    ["is interrupted", "canceled"],
    ["never starts", "never-started"],
  ] as const)(
    "mail whose turn %s goes back in line and is delivered again",
    async (_label, outcome) => {
      const fixture = createFixture({ directory, running: ["lead"], turns: [outcome] });
      await fixture.mailbox.admit("lead", agentPrompt("must arrive"), async () => undefined);

      fixture.setRunning("lead", false);
      await vi.waitFor(() => expect(fixture.deliveries).toHaveLength(2));
      await vi.waitFor(async () => expect(await fixture.mailbox.listEntries("lead")).toEqual([]));

      const [first, second] = fixture.deliveries;
      expect(first?.entries[0]).toMatchObject({ prompt: { text: "must arrive" } });
      expect(first?.entries[0]?.redelivered).toBeUndefined();
      expect(second?.entries[0]).toMatchObject({
        id: first?.entries[0]?.id,
        redelivered: true,
        attempts: 1,
      });
    },
  );

  test("a batch whose turns keep failing backs off, then is held on disk until resumed", async () => {
    const fixture = createFixture({ directory, running: ["lead"], everyTurn: "failed" });
    await fixture.mailbox.admit("lead", agentPrompt("poison"), async () => undefined);

    fixture.setRunning("lead", false);
    await vi.waitFor(() => expect(fixture.deliveries).toHaveLength(MAX_TURN_ATTEMPTS));
    await vi.waitFor(() => expect(fixture.mailbox.isBusy()).toBe(false));

    expect(MAX_TURN_ATTEMPTS).toBe(5);
    expect(fixture.deliveries).toHaveLength(5);
    expect(fixture.delays).toEqual([5_000, 20_000, 80_000, 300_000]);
    const reopened = new FileMailboxStore(directory, createTestLogger());
    expect((await reopened.load("lead"))?.entries).toEqual([
      expect.objectContaining({ prompt: { text: "poison" }, state: "held", attempts: 5 }),
    ]);

    await fixture.mailbox.kick("lead");
    expect(fixture.deliveries).toHaveLength(5);

    await fixture.mailbox.resume("lead");
    await fixture.mailbox.kick("lead");
    await vi.waitFor(() => expect(fixture.deliveries).toHaveLength(6));
    expect(fixture.deliveries[5]?.entries[0]).toMatchObject({
      prompt: { text: "poison" },
      attempts: 0,
      redelivered: true,
    });
  });

  test("held mail does not keep newer mail from being delivered", async () => {
    const fixture = createFixture({
      directory,
      running: ["lead"],
      turns: ["failed", "failed", "failed", "failed", "failed"],
    });
    await fixture.mailbox.admit("lead", agentPrompt("poison"), async () => undefined);
    fixture.setRunning("lead", false);
    await vi.waitFor(() => expect(fixture.mailbox.isBusy()).toBe(false));

    await fixture.mailbox.enqueue("lead", agentPrompt("fresh"));
    await vi.waitFor(() => expect(fixture.deliveries).toHaveLength(6));

    expect(fixture.deliveries[5]?.entries.map((entry) => entry.prompt.text)).toEqual(["fresh"]);
    expect((await fixture.mailbox.listEntries("lead")).map((entry) => entry.state)).toEqual([
      "held",
    ]);
  });

  test("delivered mail stays delivering while its turn runs", async () => {
    const fixture = createFixture({ directory, running: ["lead"], turns: ["keeps-running"] });
    await fixture.mailbox.admit("lead", agentPrompt("in flight"), async () => undefined);
    fixture.setRunning("lead", false);
    await vi.waitFor(() => expect(fixture.deliveries).toHaveLength(1));

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await fixture.mailbox.listEntries("lead")).map((entry) => entry.state)).toEqual([
      "delivering",
    ]);
    expect(fixture.deliveries).toHaveLength(1);
  });

  test("a prompt arriving while mail waits lines up behind it even if the agent is idle", async () => {
    const fixture = createFixture({ directory, running: ["lead"] });
    await fixture.mailbox.admit("lead", agentPrompt("first"), async () => undefined);
    await fixture.mailbox.pause("lead");
    fixture.setRunning("lead", false);
    const dispatch = vi.fn(async () => undefined);

    const admission = await fixture.mailbox.admit("lead", agentPrompt("second"), dispatch);

    expect(admission).toMatchObject({ status: "queued", position: 2 });
    expect(dispatch).not.toHaveBeenCalled();
    fixture.mailbox.stop();
  });

  test("a paused mailbox holds its mail until it is resumed", async () => {
    const fixture = createFixture({ directory, running: ["lead"] });
    await fixture.mailbox.admit("lead", agentPrompt("held"), async () => undefined);
    await fixture.mailbox.pause("lead");

    fixture.setRunning("lead", false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fixture.deliveries).toEqual([]);
    expect(await fixture.mailbox.isPaused("lead")).toBe(true);

    await fixture.mailbox.resume("lead");
    await fixture.mailbox.kick("lead");
    await vi.waitFor(() => expect(fixture.deliveries).toHaveLength(1));
    expect(await fixture.mailbox.isPaused("lead")).toBe(false);
  });

  test("pausing an agent without a mailbox writes nothing", async () => {
    const fixture = createFixture({
      directory,
      policy: { enabled: false, resumeOnStartup: false },
    });

    await fixture.mailbox.pause("peer");

    expect(await fixture.store.listAgentIds()).toEqual([]);
  });

  test("mail survives the process and is recovered by a new service on the same directory", async () => {
    const before = createFixture({ directory, running: ["lead"] });
    await before.mailbox.admit("lead", agentPrompt("one"), async () => undefined);
    await before.mailbox.admit("lead", agentPrompt("two"), async () => undefined);
    before.mailbox.stop();
    await before.mailbox.flush();

    const after = createFixture({ directory, running: ["lead"] });
    const withMail = await after.mailbox.recover();

    expect(withMail).toEqual(["lead"]);
    const entries = await after.mailbox.listEntries("lead");
    expect(entries.map((entry) => entry.prompt.text)).toEqual(["one", "two"]);

    after.setRunning("lead", false);
    await after.mailbox.kick("lead");
    await vi.waitFor(() => expect(after.deliveries).toHaveLength(1));
    expect(after.deliveries[0]?.entries.map((entry) => entry.prompt.text)).toEqual(["one", "two"]);
  });

  test("recovery requeues an interrupted batch as redelivered and reports dead watches and permissions", async () => {
    const store = new FileMailboxStore(directory, createTestLogger());
    const file = createEmptyMailboxFile("lead");
    file.entries.push(
      {
        id: "mbx_inflight",
        seq: 0,
        state: "delivering",
        attempts: 0,
        source: { kind: "agent", senderAgentId: "peer" },
        prompt: { text: "was being handled" },
        enqueuedAt: "2026-10-07T00:00:00.000Z",
      },
      {
        id: "mbx_permission",
        seq: 1,
        state: "queued",
        attempts: 0,
        source: { kind: "notification", childAgentId: "child-a", requestId: "req-1" },
        prompt: { text: "Agent child-a needs permission. <permission-request>…" },
        enqueuedAt: "2026-10-07T00:00:00.000Z",
      },
    );
    file.nextSeq = 2;
    file.watches.push({
      id: "watch_1",
      childAgentId: "child-b",
      turnId: null,
      armedAt: "2026-10-07T00:00:00.000Z",
    });
    await store.save(file);

    const fixture = createFixture({ directory });
    await fixture.mailbox.recover();

    expect(await fixture.mailbox.listWatches("lead")).toEqual([]);
    const entries = await fixture.mailbox.listEntries("lead");
    expect(entries[0]).toMatchObject({ id: "mbx_inflight", state: "queued", redelivered: true });
    expect(entries[1]?.prompt.text).toBe(
      "Agent child-a (Title of child-a) asked for permission (request req-1), but the request expired when the daemon restarted. Nothing is waiting on it anymore; check the agent with get_agent_status.",
    );
    expect(entries[1]?.source).toEqual({ kind: "notification", childAgentId: "child-a" });
    expect(entries[2]).toMatchObject({
      seq: 2,
      source: { kind: "restart", childAgentId: "child-b" },
      prompt: {
        text: "Agent child-b (Title of child-b) was interrupted by a daemon restart before it reported back. Check it with get_agent_status before relying on its work.",
      },
    });
  });

  test("one unreadable or strangely named file does not stop the others from recovering", async () => {
    const seeded = createFixture({ directory, running: ["good", "locked"] });
    await seeded.mailbox.admit("good", agentPrompt("kept"), async () => undefined);
    await seeded.mailbox.admit("locked", agentPrompt("unreadable"), async () => undefined);
    seeded.mailbox.stop();
    await seeded.mailbox.flush();
    await writeFile(path.join(directory, "%zz.json"), "{}");
    await chmod(path.join(directory, "locked.json"), 0o000);

    try {
      const fixture = createFixture({ directory, running: ["good"] });
      expect(await fixture.mailbox.recover()).toEqual(["good"]);
      expect((await fixture.mailbox.listEntries("good")).map((e) => e.prompt.text)).toEqual([
        "kept",
      ]);
    } finally {
      await chmod(path.join(directory, "locked.json"), 0o600);
    }
  });

  test("startup resume only drains agents whose policy asks for it", async () => {
    const seeded = createFixture({ directory, running: ["lead"] });
    await seeded.mailbox.admit("lead", agentPrompt("waiting"), async () => undefined);
    seeded.mailbox.stop();

    const off = createFixture({ directory });
    await off.mailbox.resumeOnStartup(await off.mailbox.recover());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(off.deliveries).toEqual([]);
    off.mailbox.stop();

    const on = createFixture({ directory, policy: { enabled: true, resumeOnStartup: true } });
    await on.mailbox.resumeOnStartup(await on.mailbox.recover());
    await vi.waitFor(() => expect(on.deliveries).toHaveLength(1));
  });

  test("an archived agent keeps its mail undelivered; deleting the agent removes it", async () => {
    const fixture = createFixture({ directory, running: ["lead"] });
    await fixture.mailbox.admit("lead", agentPrompt("kept"), async () => undefined);
    fixture.archive("lead");

    fixture.setRunning("lead", false);
    await vi.waitFor(() => expect(fixture.mailbox.isBusy()).toBe(false));
    expect(fixture.deliveries).toEqual([]);
    expect(await fixture.store.listAgentIds()).toEqual(["lead"]);

    await fixture.mailbox.deleteAgent("lead");
    expect(await fixture.store.listAgentIds()).toEqual([]);
  });

  test("deleting an agent's state removes its mailbox file", async () => {
    const fixture = createFixture({ directory, running: ["lead"] });
    await fixture.mailbox.admit("lead", agentPrompt("doomed"), async () => undefined);
    const manager = new AgentManager({ logger: createTestLogger() });
    manager.setMailbox(fixture.mailbox);

    await manager.deleteAgentState("lead");

    expect(await fixture.store.listAgentIds()).toEqual([]);
  });

  test("a watch resolved by its notice is replaced in one write", async () => {
    const fixture = createFixture({ directory, running: ["lead"] });
    await fixture.mailbox.armWatch("lead", {
      id: "watch_1",
      childAgentId: "child",
      turnId: null,
      armedAt: "2026-10-07T00:00:00.000Z",
    });

    await fixture.mailbox.enqueue(
      "lead",
      { source: { kind: "notification", childAgentId: "child" }, text: "child finished" },
      { resolvesWatchId: "watch_1" },
    );

    const onDisk = await fixture.store.load("lead");
    expect(onDisk?.watches).toEqual([]);
    expect(onDisk?.entries.map((entry) => entry.prompt.text)).toEqual(["child finished"]);
    fixture.mailbox.stop();
  });

  test("fresh notifications to an agent without a mailbox keep the plain shape", async () => {
    const fixture = createFixture({
      directory,
      policy: { enabled: false, resumeOnStartup: false },
    });

    await fixture.mailbox.enqueue("caller", {
      source: { kind: "notification", childAgentId: "child" },
      text: "child finished",
    });

    await vi.waitFor(() => expect(fixture.deliveries).toHaveLength(1));
    expect(fixture.deliveries[0]?.plainNotifications).toBe(true);
  });

  test("recovery keeps a standing watch on an idle child and reports nothing", async () => {
    await seedStandingWatch(directory, "supervisor", "lead");
    const fixture = createFixture({ directory });
    fixture.setRecord("lead", { lastStatus: "idle", labels: {} });

    await fixture.mailbox.recover();

    expect(await fixture.mailbox.listEntries("supervisor")).toEqual([]);
    expect(await fixture.mailbox.listWatches("supervisor")).toMatchObject([
      { id: "watch_lead", mode: "standing" },
    ]);
    expect(fixture.mailbox.takeRecoveredStandingWatches()).toMatchObject([
      { callerAgentId: "supervisor", watch: { id: "watch_lead", childAgentId: "lead" } },
    ]);
    expect(fixture.mailbox.takeRecoveredStandingWatches()).toEqual([]);
  });

  test("recovery reports a restart once for a standing watch whose child was running", async () => {
    await seedStandingWatch(directory, "supervisor", "lead");
    const fixture = createFixture({ directory });
    fixture.setRecord("lead", { lastStatus: "running" });

    await fixture.mailbox.recover();

    const entries = await fixture.mailbox.listEntries("supervisor");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toEqual({ kind: "restart", childAgentId: "lead" });
    expect(await fixture.mailbox.listWatches("supervisor")).toHaveLength(1);
  });

  test("recovery drops a standing watch whose child or caller is archived", async () => {
    await seedStandingWatch(directory, "supervisor", "lead");
    await seedStandingWatch(directory, "archived-caller", "peer");
    const fixture = createFixture({ directory });
    fixture.archive("lead");
    fixture.archive("archived-caller");

    await fixture.mailbox.recover();

    expect(await fixture.mailbox.listWatches("supervisor")).toEqual([]);
    expect(await fixture.mailbox.listWatches("archived-caller")).toEqual([]);
    expect(fixture.mailbox.takeRecoveredStandingWatches()).toEqual([]);
  });

  test("a standing notice replaces one from the same child that is still waiting", async () => {
    const fixture = createFixture({ directory, running: ["supervisor"] });

    await fixture.mailbox.enqueue("supervisor", standingNotice("lead", "first turn"));
    await fixture.mailbox.enqueue("supervisor", standingNotice("other", "other child"));
    await fixture.mailbox.enqueue("supervisor", standingNotice("lead", "second turn"));

    const entries = await fixture.mailbox.listEntries("supervisor");
    expect(entries.map((entry) => entry.prompt.text)).toEqual(["second turn", "other child"]);
    fixture.mailbox.stop();
  });

  test("a one-shot notice is never folded into a standing one", async () => {
    const fixture = createFixture({ directory, running: ["supervisor"] });

    await fixture.mailbox.enqueue("supervisor", standingNotice("lead", "standing"));
    await fixture.mailbox.enqueue("supervisor", {
      source: { kind: "notification", childAgentId: "lead" },
      text: "prompted turn",
    });

    expect(await fixture.mailbox.listEntries("supervisor")).toHaveLength(2);
    fixture.mailbox.stop();
  });

  test("archiving drops the stop flag and the watches; an empty mailbox disappears", async () => {
    const fixture = createFixture({ directory });
    await fixture.mailbox.pause("lead");
    await fixture.mailbox.armWatch("lead", {
      id: "watch_peer",
      childAgentId: "peer",
      turnId: null,
      armedAt: "2026-10-11T00:00:00.000Z",
    });

    await fixture.mailbox.onAgentArchived("lead");

    expect(await fixture.store.listAgentIds()).toEqual([]);
  });

  test("archiving keeps mail that never got delivered", async () => {
    const fixture = createFixture({ directory, running: ["lead"] });
    await fixture.mailbox.admit("lead", agentPrompt("still waiting"), async () => undefined);
    await fixture.mailbox.pause("lead");
    fixture.mailbox.stop();

    await fixture.mailbox.onAgentArchived("lead");

    const file = await fixture.store.load("lead");
    expect(file?.entries.map((entry) => entry.prompt.text)).toEqual(["still waiting"]);
    expect(file?.paused).toBe(true);
  });
});
