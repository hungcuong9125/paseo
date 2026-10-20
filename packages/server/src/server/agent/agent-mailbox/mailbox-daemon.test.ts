import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";

import { createTestPaseoDaemon, type TestPaseoDaemon } from "../../test-utils/paseo-daemon.js";
import { cancelAgentRunCommand } from "../lifecycle-command.js";
import { sendPromptToAgent } from "../agent-prompt.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
} from "../agent-sdk-types.js";
import type { MailboxFile } from "./store.js";

const CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
} as const;

interface RecordedTurn {
  turnId: string;
  prompt: string;
  outcome: "running" | "completed" | "failed" | "canceled";
}

/** A provider whose turns run until the test ends them. */
class ScriptedSession implements AgentSession {
  readonly capabilities = CAPABILITIES;
  readonly turns: RecordedTurn[] = [];
  interrupts = 0;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private active: RecordedTurn | null = null;

  constructor(
    readonly provider: AgentProvider,
    readonly id: string,
  ) {}

  async run(): Promise<AgentRunResult> {
    throw new Error("ScriptedSession only runs streamed turns");
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    if (this.active) throw new Error("A foreground turn is already active");
    const turn: RecordedTurn = {
      turnId: `${this.id}-turn-${this.turns.length + 1}`,
      prompt: typeof prompt === "string" ? prompt : JSON.stringify(prompt),
      outcome: "running",
    };
    this.turns.push(turn);
    this.active = turn;
    return { turnId: turn.turnId };
  }

  end(outcome: "completed" | "failed"): void {
    const turn = this.active;
    if (!turn) throw new Error(`${this.id} has no running turn`);
    this.active = null;
    turn.outcome = outcome;
    this.emit(
      outcome === "completed"
        ? { type: "turn_completed", provider: this.provider, turnId: turn.turnId }
        : { type: "turn_failed", provider: this.provider, error: "boom", turnId: turn.turnId },
    );
  }

  emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}
  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode(): Promise<string | null> {
    return null;
  }
  /** Runs once, inside the next setMode, before the mode change returns. */
  onNextSetMode: (() => void) | null = null;
  async setMode(): Promise<void> {
    const hook = this.onNextSetMode;
    this.onNextSetMode = null;
    hook?.();
  }
  getPendingPermissions() {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }
  async interrupt(): Promise<void> {
    this.interrupts += 1;
    const turn = this.active;
    if (!turn) return;
    this.active = null;
    turn.outcome = "canceled";
    this.emit({
      type: "turn_canceled",
      provider: this.provider,
      reason: "interrupted",
      turnId: turn.turnId,
    });
  }
  async close(): Promise<void> {}
}

class ScriptedClient implements AgentClient {
  readonly capabilities = CAPABILITIES;
  readonly sessions = new Map<string, ScriptedSession>();

  constructor(readonly provider: AgentProvider) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async createSession(_config: unknown, launchContext?: AgentLaunchContext): Promise<AgentSession> {
    return this.open(launchContext?.agentId);
  }
  async resumeSession(
    handle: AgentPersistenceHandle,
    _overrides?: unknown,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    return this.open(launchContext?.agentId ?? handle.sessionId);
  }
  async fetchCatalog() {
    return { models: [], modes: [] };
  }
  session(agentId: string): ScriptedSession {
    const session = this.sessions.get(agentId);
    if (!session) throw new Error(`No session for ${agentId}`);
    return session;
  }
  private open(agentId: string | undefined): ScriptedSession {
    if (!agentId) throw new Error("ScriptedClient needs the agent id");
    const session = new ScriptedSession(this.provider, agentId);
    this.sessions.set(agentId, session);
    return session;
  }
}

interface MailboxDaemon {
  handle: TestPaseoDaemon;
  codex: ScriptedClient;
  claude: ScriptedClient;
}

/** codex entries resume their mail at startup; claude entries only queue it. */
async function startMailboxDaemon(paseoHomeRoot: string): Promise<MailboxDaemon> {
  const codex = new ScriptedClient("codex");
  const claude = new ScriptedClient("claude");
  const handle = await createTestPaseoDaemon({
    paseoHomeRoot,
    cleanup: false,
    mcpEnabled: false,
    logger: pino({ level: "silent" }),
    agentClients: { codex, claude },
    providerOverrides: {
      codex: { mailbox: { enabled: true, resumeOnStartup: true } },
      claude: { mailbox: { enabled: true } },
    },
  });
  return { handle, codex, claude };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function launch(paseoHomeRoot: string): Promise<MailboxDaemon> {
  const daemon = await startMailboxDaemon(paseoHomeRoot);
  cleanups.push(() => daemon.handle.close());
  return daemon;
}

async function createAgent(
  daemon: MailboxDaemon,
  provider: "codex" | "claude",
  cwd: string,
  labels?: Record<string, string>,
): Promise<string> {
  const agent = await daemon.handle.daemon.agentManager.createAgent({ provider, cwd }, undefined, {
    workspaceId: undefined,
    ...(labels ? { labels } : {}),
  });
  return agent.id;
}

function send(
  daemon: MailboxDaemon,
  agentId: string,
  prompt: string,
  sender?: { kind: "agent"; agentId: string },
  sessionMode?: string,
) {
  return sendPromptToAgent({
    agentManager: daemon.handle.daemon.agentManager,
    agentStorage: daemon.handle.daemon.agentStorage,
    agentId,
    prompt,
    ...(sender ? { sender } : {}),
    ...(sessionMode ? { sessionMode } : {}),
    logger: pino({ level: "silent" }),
  });
}

async function readMailbox(paseoHome: string, agentId: string): Promise<MailboxFile | null> {
  try {
    return JSON.parse(await readFile(path.join(paseoHome, "mailbox", `${agentId}.json`), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function waitForTurns(session: () => ScriptedSession, count: number): Promise<void> {
  await vi.waitFor(() => expect(session().turns).toHaveLength(count), {
    timeout: 15_000,
    interval: 20,
  });
}

function itemOrder(prompt: string): string[] {
  return [...prompt.matchAll(/<paseo-mailbox-item [^>]*>\n([^\n]*)\n/g)].map((match) => match[1]!);
}

test("peers, a non-parent agent, and the parent queue behind a lead's long turn in order", async () => {
  const daemon = await launch(await tempDir("paseo-mbx2-queue-"));
  const lead = await createAgent(daemon, "codex", await tempDir("paseo-mbx2-lead-"), {
    "paseo.parent-agent-id": "supervisor-agent",
  });
  const session = () => daemon.codex.session(lead);

  await send(daemon, lead, "long task");
  await waitForTurns(session, 1);

  const dispositions = [
    await send(daemon, lead, "peer A first", { kind: "agent", agentId: "peer-a" }),
    await send(daemon, lead, "peer B report", { kind: "agent", agentId: "peer-b" }),
    await send(daemon, lead, "peer A second", { kind: "agent", agentId: "peer-a" }),
    await send(daemon, lead, "not my parent", { kind: "agent", agentId: "other-agent" }),
    await send(daemon, lead, "from my parent", { kind: "agent", agentId: "supervisor-agent" }),
  ];
  expect(dispositions).toEqual(
    [1, 2, 3, 4, 5].map((position) => ({ disposition: "queued", position })),
  );
  const queued = await readMailbox(daemon.handle.paseoHome, lead);
  expect(queued?.entries.map((entry) => [entry.seq, entry.state])).toEqual([
    [0, "queued"],
    [1, "queued"],
    [2, "queued"],
    [3, "queued"],
    [4, "queued"],
  ]);
  expect(session().turns).toHaveLength(1);
  expect(session().turns[0]!.outcome).toBe("running");
  expect(session().interrupts).toBe(0);

  session().end("completed");
  await waitForTurns(session, 2);
  expect(session().turns[0]!.outcome).toBe("completed");
  expect(itemOrder(session().turns[1]!.prompt)).toEqual([
    "peer A first",
    "peer B report",
    "peer A second",
    "not my parent",
    "from my parent",
  ]);
  const delivering = await readMailbox(daemon.handle.paseoHome, lead);
  expect(delivering?.entries.map((entry) => entry.state)).toEqual(Array(5).fill("delivering"));

  session().end("completed");
  await vi.waitFor(async () => expect(await readMailbox(daemon.handle.paseoHome, lead)).toBeNull());
  expect(session().interrupts).toBe(0);
});

test("mail is acked only by a completed turn; a failed or stopped one leaves it in the box", async () => {
  const daemon = await launch(await tempDir("paseo-mbx2-ack-"));
  const lead = await createAgent(daemon, "codex", await tempDir("paseo-mbx2-lead-"));
  const session = () => daemon.codex.session(lead);
  const mailbox = () => readMailbox(daemon.handle.paseoHome, lead);

  await send(daemon, lead, "long task");
  await waitForTurns(session, 1);
  await send(daemon, lead, "peer report", { kind: "agent", agentId: "peer-a" });
  session().end("completed");
  await waitForTurns(session, 2);

  session().end("failed");
  await vi.waitFor(async () =>
    expect((await mailbox())?.entries).toEqual([
      expect.objectContaining({ state: "queued", attempts: 1, redelivered: true }),
    ]),
  );
  // The retry waits out turnRetryDelayMs(1) = 5 s.
  await waitForTurns(session, 3);
  expect(session().turns[2]!.prompt).toContain('redelivered="true"');
  expect(itemOrder(session().turns[2]!.prompt)).toEqual(["peer report"]);

  // A person's stop leaves the agent idle without the turn completing.
  await cancelAgentRunCommand(
    { agentManager: daemon.handle.daemon.agentManager, logger: pino({ level: "silent" }) },
    lead,
  );
  expect(session().turns[2]!.outcome).toBe("canceled");
  expect(daemon.handle.daemon.agentManager.hasInFlightRun(lead)).toBe(false);
  await vi.waitFor(async () =>
    expect(await mailbox()).toMatchObject({
      paused: true,
      entries: [{ state: "queued", attempts: 2, redelivered: true }],
    }),
  );
  expect(session().turns).toHaveLength(3);
});

test("a stray terminal event from another turn does not ack the delivered mail", async () => {
  const daemon = await launch(await tempDir("paseo-mbx2-stray-"));
  const lead = await createAgent(daemon, "codex", await tempDir("paseo-mbx2-lead-"));
  const session = () => daemon.codex.session(lead);

  await send(daemon, lead, "long task");
  await waitForTurns(session, 1);
  await send(daemon, lead, "peer report", { kind: "agent", agentId: "peer-a" });
  session().end("completed");
  await waitForTurns(session, 2);

  session().emit({ type: "turn_completed", provider: "codex", turnId: "some-older-turn" });
  session().end("failed");
  await vi.waitFor(async () =>
    expect((await readMailbox(daemon.handle.paseoHome, lead))?.entries).toEqual([
      expect.objectContaining({ state: "queued", attempts: 1, redelivered: true }),
    ]),
  );
});

test("a provider turn that runs while the mail's turn is being set up does not ack the mail", async () => {
  const daemon = await launch(await tempDir("paseo-mbx2-gap-"));
  const lead = await createAgent(daemon, "codex", await tempDir("paseo-mbx2-lead-"));
  const session = () => daemon.codex.session(lead);

  await send(daemon, lead, "long task");
  await waitForTurns(session, 1);
  await send(daemon, lead, "peer report", { kind: "agent", agentId: "peer-a" }, "plan");
  session().onNextSetMode = () => {
    session().emit({ type: "turn_started", provider: "codex" });
    session().emit({ type: "turn_completed", provider: "codex" });
  };
  session().end("completed");
  await waitForTurns(session, 2);
  expect(itemOrder(session().turns[1]!.prompt)).toEqual(["peer report"]);

  session().end("failed");
  await vi.waitFor(async () =>
    expect((await readMailbox(daemon.handle.paseoHome, lead))?.entries).toEqual([
      expect.objectContaining({ state: "queued", attempts: 1, redelivered: true }),
    ]),
  );
});

test("after a crash mid-delivery, mail survives; only an entry with resumeOnStartup starts a turn", async () => {
  const firstHome = await tempDir("paseo-mbx2-crash-");
  const first = await launch(firstHome);
  const resumed = await createAgent(first, "codex", await tempDir("paseo-mbx2-resume-"));
  const waiting = await createAgent(first, "claude", await tempDir("paseo-mbx2-wait-"));

  for (const [agentId, client] of [
    [resumed, first.codex],
    [waiting, first.claude],
  ] as const) {
    const session = () => client.session(agentId);
    await send(first, agentId, "long task");
    await waitForTurns(session, 1);
    await send(first, agentId, "first report", { kind: "agent", agentId: "peer-a" });
    session().end("completed");
    await waitForTurns(session, 2);
    await send(first, agentId, "second report", { kind: "agent", agentId: "peer-b" });
  }
  for (const agentId of [resumed, waiting]) {
    expect(
      (await readMailbox(first.handle.paseoHome, agentId))?.entries.map((entry) => entry.state),
    ).toEqual(["delivering", "queued"]);
  }

  // kill -9: whatever is on disk at this instant is all the next daemon gets.
  await first.handle.daemon.agentManager.flush();
  await first.handle.daemon.agentStorage.flush();
  const crashedHome = await tempDir("paseo-mbx2-crashed-");
  await cp(firstHome, crashedHome, { recursive: true });
  await first.handle.close();

  const second = await launch(crashedHome);
  const paseoHome = second.handle.paseoHome;
  await waitForTurns(() => second.codex.session(resumed), 1);
  const resumedPrompt = second.codex.session(resumed).turns[0]!.prompt;
  expect(itemOrder(resumedPrompt)).toEqual(["first report", "second report"]);
  expect(resumedPrompt).toMatch(/redelivered="true">\nfirst report/);
  expect(resumedPrompt).not.toMatch(/redelivered="true">\nsecond report/);

  const waitingFile = await readMailbox(paseoHome, waiting);
  expect(waitingFile?.entries).toEqual([
    expect.objectContaining({ seq: 0, state: "queued", redelivered: true, attempts: 1 }),
    expect.objectContaining({ seq: 1, state: "queued", prompt: { text: "second report" } }),
  ]);
  expect(waitingFile?.entries[1]?.redelivered).toBeUndefined();
  expect(second.claude.sessions.get(waiting)?.turns ?? []).toEqual([]);

  second.codex.session(resumed).end("completed");
  await vi.waitFor(async () => expect(await readMailbox(paseoHome, resumed)).toBeNull());
  expect(second.claude.sessions.get(waiting)?.turns ?? []).toEqual([]);
  expect((await readMailbox(paseoHome, waiting))?.entries).toHaveLength(2);
});
