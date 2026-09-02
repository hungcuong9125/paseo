/**
 * Deterministic reproduction harness for peer finish-notification delivery.
 *
 * Runs a real daemon (own port, own PASEO_HOME) against a scripted provider so
 * turn boundaries are controlled instead of guessed. The same file runs against
 * the pre-fix and post-fix trees; the printed verdicts are the A/B evidence.
 *
 * Usage: npx tsx packages/server/scripts/notify-repro.ts [scenario...]
 */
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import pino from "pino";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createPaseoDaemon } from "../src/server/bootstrap.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentMode,
  AgentPermissionRequest,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  ProviderCatalog,
} from "../src/server/agent/agent-sdk-types.js";

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

const MODES: AgentMode[] = [
  { id: "default", label: "Default" },
  { id: "slow", label: "Slow (parks in setMode)" },
];

function promptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") return prompt;
  return prompt
    .flatMap((block) => (block.type === "text" && !("mimeType" in block) ? [block.text] : []))
    .join("\n");
}

interface TurnHandle {
  agentId: string;
  prompt: string;
  release: (finalText: string) => void;
  requestPermission: () => void;
}

/**
 * Every scripted session parks its turn here. Tests decide when a turn ends,
 * so "the child is still working" and "two children finish at once" are exact
 * states instead of races against a real model.
 */
class Director {
  readonly prompts = new Map<string, string[]>();
  private readonly waiting: TurnHandle[] = [];
  private readonly watchers = new Set<() => void>();

  record(agentId: string, prompt: string): void {
    const existing = this.prompts.get(agentId);
    if (existing) existing.push(prompt);
    else this.prompts.set(agentId, [prompt]);
  }

  promptsFor(agentId: string): string[] {
    return this.prompts.get(agentId) ?? [];
  }

  park(handle: TurnHandle): void {
    this.waiting.push(handle);
    for (const watcher of this.watchers) watcher();
  }

  unpark(handle: TurnHandle): void {
    const index = this.waiting.indexOf(handle);
    if (index >= 0) this.waiting.splice(index, 1);
  }

  open(agentId: string): TurnHandle | undefined {
    return this.waiting.find((handle) => handle.agentId === agentId);
  }

  openMatching(agentId: string, needle: string): TurnHandle | undefined {
    return this.waiting.find(
      (handle) => handle.agentId === agentId && handle.prompt.includes(needle),
    );
  }

  async waitForOpenTurnMatching(
    agentId: string,
    needle: string,
    timeoutMs = 30_000,
  ): Promise<TurnHandle> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.openMatching(agentId, needle);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(`no open "${needle}" turn for ${agentId} within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * setMode runs inside sendPromptToAgent, after the watch is armed and before
   * the prompt is dispatched. Parking there opens that window on demand.
   */
  private modeGates: Array<() => void> = [];
  private modeGateHit = false;

  async holdModeGate(): Promise<void> {
    this.modeGateHit = true;
    await new Promise<void>((resolve) => this.modeGates.push(resolve));
  }

  async waitForModeGate(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.modeGateHit) {
      if (Date.now() > deadline) throw new Error("mode gate never reached");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  releaseModeGates(): void {
    const gates = this.modeGates;
    this.modeGates = [];
    this.modeGateHit = false;
    for (const gate of gates) gate();
  }

  async waitForOpenTurn(agentId: string, timeoutMs = 30_000): Promise<TurnHandle> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.open(agentId);
      if (found) return found;
      if (Date.now() > deadline)
        throw new Error(`no open turn for ${agentId} within ${timeoutMs}ms`);
      await new Promise<void>((resolve) => {
        const watcher = () => {
          this.watchers.delete(watcher);
          resolve();
        };
        this.watchers.add(watcher);
        setTimeout(() => {
          this.watchers.delete(watcher);
          resolve();
        }, 50);
      });
    }
  }

  /** Wait until a prompt matching `needle` lands on `agentId`. */
  async waitForPrompt(agentId: string, needle: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.promptsFor(agentId).some((prompt) => prompt.includes(needle))) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

class ScriptedSession implements AgentSession {
  readonly provider: string;
  readonly id: string;
  readonly capabilities = CAPABILITIES;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly pendingPermissions: AgentPermissionRequest[] = [];
  private activeTurnId: string | null = null;
  private turnOrdinal = 0;

  constructor(
    provider: string,
    private readonly agentId: string,
    private readonly director: Director,
    private readonly config: AgentSessionConfig,
  ) {
    this.provider = provider;
    this.id = `scripted-${agentId}`;
  }

  private emit(event: AgentStreamEvent): void {
    const tagged = this.activeTurnId ? { ...event, turnId: this.activeTurnId } : event;
    for (const subscriber of this.subscribers) subscriber(tagged);
  }

  async run(prompt: AgentPromptInput): Promise<AgentRunResult> {
    const text = promptText(prompt);
    return {
      sessionId: this.id,
      finalText: `ran: ${text}`,
      timeline: [{ type: "assistant_message", text: `ran: ${text}` }],
    };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    if (this.activeTurnId) throw new Error("A foreground turn is already active");
    const turnId = `scripted-turn-${(this.turnOrdinal += 1)}`;
    this.activeTurnId = turnId;
    const text = promptText(prompt);
    this.director.record(this.agentId, text);

    this.emit({ type: "turn_started", provider: this.provider, turnId });

    // AUTO: end immediately. HOLD: park until the test releases it.
    const auto = !text.includes("[HOLD]");
    const handle: TurnHandle = {
      agentId: this.agentId,
      prompt: text,
      release: (finalText: string) => {
        this.director.unpark(handle);
        this.finishTurn(turnId, finalText);
      },
      requestPermission: () => {
        const request: AgentPermissionRequest = {
          id: `perm-${turnId}`,
          provider: this.provider,
          name: "scripted",
          kind: "tool",
          title: "scripted permission",
          input: {},
        };
        this.pendingPermissions.push(request);
        this.emit({ type: "permission_requested", provider: this.provider, request, turnId });
      },
    };

    if (auto) {
      setTimeout(() => handle.release(`done: ${text.slice(0, 60)}`), 5);
    } else {
      this.director.park(handle);
    }
    return { turnId };
  }

  private finishTurn(turnId: string, finalText: string): void {
    if (this.activeTurnId !== turnId) return;
    this.emit({
      type: "timeline",
      provider: this.provider,
      item: { type: "assistant_message", text: finalText },
    });
    this.emit({
      type: "turn_completed",
      provider: this.provider,
      turnId,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    this.activeTurnId = null;
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    // No replay needed for these scenarios.
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return { provider: this.provider, sessionId: this.id, modeId: this.config.modeId ?? "default" };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return MODES;
  }

  async getCurrentMode(): Promise<string | null> {
    return this.config.modeId ?? "default";
  }

  async setMode(modeId: string): Promise<void> {
    if (modeId === "slow") {
      await this.director.holdModeGate();
    }
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [...this.pendingPermissions];
  }

  async respondToPermission(requestId: string): Promise<void> {
    const index = this.pendingPermissions.findIndex((request) => request.id === requestId);
    if (index >= 0) this.pendingPermissions.splice(index, 1);
  }

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {
    const turnId = this.activeTurnId;
    if (!turnId) return;
    this.activeTurnId = null;
    this.emit({ type: "turn_canceled", provider: this.provider, reason: "interrupted", turnId });
  }

  async close(): Promise<void> {
    this.activeTurnId = null;
  }
}

class ScriptedClient implements AgentClient {
  readonly capabilities = CAPABILITIES;
  constructor(
    readonly provider: string,
    private readonly director: Director,
  ) {}

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    return new ScriptedSession(
      this.provider,
      launchContext?.agentId ?? `anon-${Math.random()}`,
      this.director,
      config,
    );
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    return new ScriptedSession(
      this.provider,
      launchContext?.agentId ?? `anon-${Math.random()}`,
      this.director,
      { provider: this.provider, cwd: overrides?.cwd ?? process.cwd(), ...overrides },
    );
  }

  async fetchCatalog(): Promise<ProviderCatalog> {
    return {
      models: [{ provider: this.provider, id: "scripted", label: "Scripted", isDefault: true }],
      modes: MODES,
      defaultModeId: "default",
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

async function mcpClient(port: number, callerAgentId?: string): Promise<Client> {
  const url = callerAgentId
    ? `http://127.0.0.1:${port}/mcp/agents?callerAgentId=${encodeURIComponent(callerAgentId)}`
    : `http://127.0.0.1:${port}/mcp/agents`;
  const client = new Client({ name: "notify-repro", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

interface Verdict {
  scenario: string;
  expectation: string;
  observed: string;
  fixed: boolean;
}

const verdicts: Verdict[] = [];

function report(scenario: string, expectation: string, observed: string, fixed: boolean): void {
  verdicts.push({ scenario, expectation, observed, fixed });
  console.log(`\n${fixed ? "PASS" : "FAIL"}  ${scenario}`);
  console.log(`      expect: ${expectation}`);
  console.log(`      actual: ${observed}`);
}

interface ReproContext {
  top: Client;
  port: number;
  director: Director;
  newLead: (title: string) => Promise<string>;
  waitIdle: (agentId: string, timeoutMs?: number) => Promise<void>;
}

async function scenarioR1(ctx: ReproContext): Promise<void> {
  const leadId = await ctx.newLead("R1 Lead");
  await ctx.waitIdle(leadId);
  const lead = await mcpClient(ctx.port, leadId);
  const peer = await callTool(lead, "create_agent", {
    title: "R1 Peer",
    provider: "claude/scripted",
    initialPrompt: "handshake",
  });
  const peerId = String(peer.agentId);
  await ctx.waitIdle(peerId);
  await ctx.waitIdle(leadId);

  // Blocking dispatch. The turn is held past the tool's 30s wait.
  const dispatch = callTool(lead, "send_agent_prompt", {
    agentId: peerId,
    prompt: "[HOLD] R1 real work",
    background: false,
  });
  const handle = await ctx.director.waitForOpenTurn(peerId);
  const blocking = await dispatch;
  console.log(`  R1 blocking returned status=${String(blocking.status)}`);
  handle.release("R1-CAPSULE");
  await ctx.waitIdle(peerId);

  const delivered = await ctx.director.waitForPrompt(leadId, "R1-CAPSULE", 45_000);
  report(
    "R1 blocking dispatch, 30s wait expires",
    "Lead receives the peer's result after the wait gave up",
    delivered ? "Lead received R1-CAPSULE" : "Lead received NOTHING for the work turn",
    delivered,
  );
  await lead.close();
}

async function scenarioR2(ctx: ReproContext): Promise<void> {
  const leadId = await ctx.newLead("R2 Lead");
  await ctx.waitIdle(leadId);
  const lead = await mcpClient(ctx.port, leadId);

  const peerIds: string[] = [];
  for (let index = 1; index <= 3; index += 1) {
    const created = await callTool(lead, "create_agent", {
      title: `R2 Peer ${index}`,
      provider: "claude/scripted",
      initialPrompt: `[HOLD] R2 peer ${index} work`,
    });
    peerIds.push(String(created.agentId));
  }
  for (const peerId of peerIds) await ctx.director.waitForOpenTurn(peerId);

  // Put the Lead mid-turn, then let every peer finish underneath it.
  await callTool(ctx.top, "send_agent_prompt", {
    agentId: leadId,
    prompt: "[HOLD] R2 lead long task",
    background: true,
  });
  const leadTurn = await ctx.director.waitForOpenTurn(leadId);

  for (const [index, peerId] of peerIds.entries()) {
    const handle = await ctx.director.waitForOpenTurn(peerId);
    handle.release(`R2-CAPSULE-${index + 1}`);
  }
  for (const peerId of peerIds) await ctx.waitIdle(peerId);

  // The Lead's own turn must survive the notifications.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const leadTurnSurvived = ctx.director.open(leadId) === leadTurn;
  leadTurn.release("R2-LEAD-TASK-DONE");

  const found: string[] = [];
  for (let index = 1; index <= 3; index += 1) {
    const token = `R2-CAPSULE-${index}`;
    if (await ctx.director.waitForPrompt(leadId, token, 30_000)) found.push(token);
  }
  const ok = found.length === 3 && leadTurnSurvived;
  report(
    "R2 three peers finish while the caller is mid-turn",
    "all three results delivered and the caller's own turn is not cancelled",
    `delivered ${found.length}/3 (${found.join(",") || "none"}); caller turn ${
      leadTurnSurvived ? "survived" : "was CANCELLED"
    }`,
    ok,
  );
  await lead.close();
}

async function scenarioR3(ctx: ReproContext): Promise<void> {
  const leadId = await ctx.newLead("R3 Lead");
  await ctx.waitIdle(leadId);
  const lead = await mcpClient(ctx.port, leadId);
  const peer = await callTool(lead, "create_agent", {
    title: "R3 Peer",
    provider: "claude/scripted",
    initialPrompt: "[HOLD] R3 work needing permission",
  });
  const peerId = String(peer.agentId);
  const handle = await ctx.director.waitForOpenTurn(peerId);

  handle.requestPermission();
  await ctx.director.waitForPrompt(leadId, "needs permission", 20_000);
  handle.release("R3-CAPSULE");
  await ctx.waitIdle(peerId);

  const delivered = await ctx.director.waitForPrompt(leadId, "R3-CAPSULE", 30_000);
  report(
    "R3 permission prompt then completion",
    "Lead is told about the permission AND later about the result",
    delivered ? "Lead received R3-CAPSULE" : "watch was consumed by the permission notice",
    delivered,
  );
  await lead.close();
}

async function scenarioR4(ctx: ReproContext): Promise<void> {
  const leadId = await ctx.newLead("R4 Lead");
  await ctx.waitIdle(leadId);
  const lead = await mcpClient(ctx.port, leadId);
  const peer = await callTool(lead, "create_agent", {
    title: "R4 Peer",
    provider: "claude/scripted",
    initialPrompt: "R4 peer boot",
  });
  const peerId = String(peer.agentId);
  await ctx.waitIdle(peerId);
  await ctx.waitIdle(leadId);

  const promptsBefore = ctx.director.promptsFor(peerId).length;
  const peerClient = await mcpClient(ctx.port, peerId);
  await callTool(peerClient, "send_agent_prompt", {
    agentId: leadId,
    prompt: "R4 PEER HANDBACK",
    background: true,
  });
  await ctx.waitIdle(leadId);
  await new Promise((resolve) => setTimeout(resolve, 5_000));

  const promptsAfter = ctx.director.promptsFor(peerId);
  const pingPong = promptsAfter.length > promptsBefore;
  report(
    "R4 peer reports upward to its own parent",
    "the parent's reply does not wake the peer again",
    pingPong
      ? `peer was woken again: ${JSON.stringify(promptsAfter.slice(promptsBefore))}`
      : "peer received nothing back",
    !pingPong,
  );
  await peerClient.close();
  await lead.close();
}

/**
 * R5 — somebody else opens a turn on the child inside the arming window.
 *
 * The dispatch then replaces that turn, cancelling it. A watch that simply
 * latched onto "the next turn" would report the stranger's cancellation and
 * retire, so the caller's own turn would finish into nothing.
 */
async function scenarioR5(ctx: ReproContext): Promise<void> {
  const leadId = await ctx.newLead("R5 Lead");
  await ctx.waitIdle(leadId);
  const lead = await mcpClient(ctx.port, leadId);
  const created = await callTool(lead, "create_agent", {
    title: "R5 Child",
    provider: "claude/scripted",
    initialPrompt: "R5 child boot",
  });
  const childId = String(created.agentId);
  await ctx.waitIdle(childId);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await ctx.waitIdle(leadId);
  const promptsBefore = ctx.director.promptsFor(leadId).length;

  async function waitForLeadPrompt(needle: string, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = ctx.director
        .promptsFor(leadId)
        .slice(promptsBefore)
        .find((prompt) => prompt.includes(needle));
      if (found) return found;
      if (Date.now() > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const leadDispatch = callTool(lead, "send_agent_prompt", {
    agentId: childId,
    prompt: "[HOLD] R5 lead work",
    background: true,
    sessionMode: "slow",
  });
  await ctx.director.waitForModeGate();

  await callTool(ctx.top, "send_agent_prompt", {
    agentId: childId,
    prompt: "[HOLD] R5 foreign work",
    background: true,
  });
  await ctx.director.waitForOpenTurnMatching(childId, "foreign work");

  ctx.director.releaseModeGates();
  await leadDispatch;

  const leadWorkTurn = await ctx.director.waitForOpenTurnMatching(childId, "lead work", 30_000);
  const premature = await waitForLeadPrompt("finished", 5_000);

  leadWorkTurn.release("R5-CAPSULE");
  await ctx.waitIdle(childId);
  const delivered = await waitForLeadPrompt("R5-CAPSULE", 30_000);
  report(
    "R5 a foreign turn starts inside the arm-before-dispatch window",
    "the Lead hears about ITS OWN turn's result and not about the foreign turn",
    delivered
      ? "Lead received R5-CAPSULE"
      : `Lead received NOTHING for its own turn (premature notice: ${premature ? "yes" : "no"})`,
    Boolean(delivered) && !premature,
  );
  await lead.close();
}

/** R6 — control for R5: same dispatch, nobody else touches the child. */
async function scenarioR6(ctx: ReproContext): Promise<void> {
  const leadId = await ctx.newLead("R6 Lead");
  await ctx.waitIdle(leadId);
  const lead = await mcpClient(ctx.port, leadId);
  const created = await callTool(lead, "create_agent", {
    title: "R6 Child",
    provider: "claude/scripted",
    initialPrompt: "R6 child boot",
  });
  const childId = String(created.agentId);
  await ctx.waitIdle(childId);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await ctx.waitIdle(leadId);
  const promptsBefore = ctx.director.promptsFor(leadId).length;

  const leadDispatch = callTool(lead, "send_agent_prompt", {
    agentId: childId,
    prompt: "[HOLD] R6 lead work",
    background: true,
    sessionMode: "slow",
  });
  await ctx.director.waitForModeGate();
  ctx.director.releaseModeGates();
  await leadDispatch;

  const leadWorkTurn = await ctx.director.waitForOpenTurnMatching(childId, "lead work", 30_000);
  leadWorkTurn.release("R6-CAPSULE");
  await ctx.waitIdle(childId);

  const deadline = Date.now() + 30_000;
  let delivered = false;
  while (!delivered && Date.now() < deadline) {
    delivered = ctx.director
      .promptsFor(leadId)
      .slice(promptsBefore)
      .some((prompt) => prompt.includes("R6-CAPSULE"));
    if (!delivered) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  report(
    "R6 control: same dispatch, nobody else touches the child",
    "the Lead receives its own turn's result",
    delivered ? "Lead received R6-CAPSULE" : "Lead received NOTHING",
    delivered,
  );
  await lead.close();
}

async function main(): Promise<void> {
  const wanted = new Set(process.argv.slice(2));
  const runAll = wanted.size === 0;
  const shouldRun = (name: string) => runAll || wanted.has(name);

  const director = new Director();
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-repro-"));
  const paseoHome = path.join(homeRoot, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-repro-static-"));
  const workspaceDir = path.join(homeRoot, "work");
  await mkdir(workspaceDir, { recursive: true });

  const logger = pino({ level: "error" });
  const daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: { claude: new ScriptedClient("claude", director) },
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      relayEndpoint: "relay.paseo.sh:443",
      appBaseUrl: "https://app.paseo.sh",
    },
    logger,
  );
  await daemon.start();
  const target = daemon.getListenTarget();
  const port = target && target.type === "tcp" ? target.port : 0;
  console.log(`daemon on 127.0.0.1:${port}, home ${paseoHome}`);

  const top = await mcpClient(port);

  async function newLead(title: string): Promise<string> {
    const created = await callTool(top, "create_agent", {
      relationship: { kind: "detached" },
      workspace: { kind: "create", source: { kind: "directory", path: workspaceDir } },
      title,
      provider: "claude/scripted",
      initialPrompt: "lead boot",
      background: true,
    });
    return String(created.agentId);
  }

  async function waitIdle(agentId: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snapshot = await callTool(top, "get_agent_status", { agentId });
      if (snapshot.status === "idle") return;
      if (Date.now() > deadline) throw new Error(`${agentId} not idle within ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  try {
    const ctx: ReproContext = { top, port, director, newLead, waitIdle };
    if (shouldRun("R1")) await scenarioR1(ctx);
    if (shouldRun("R2")) await scenarioR2(ctx);
    if (shouldRun("R3")) await scenarioR3(ctx);
    if (shouldRun("R4")) await scenarioR4(ctx);
    if (shouldRun("R5")) await scenarioR5(ctx);
    if (shouldRun("R6")) await scenarioR6(ctx);

    console.log("\n================ SUMMARY ================");
    for (const verdict of verdicts) {
      console.log(`${verdict.fixed ? "PASS" : "FAIL"}  ${verdict.scenario}`);
    }
    const failed = verdicts.filter((verdict) => !verdict.fixed).length;
    console.log(`${verdicts.length - failed}/${verdicts.length} scenarios behave correctly`);
  } finally {
    await top.close().catch(() => undefined);
    await daemon.stop().catch(() => undefined);
    await rm(homeRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(staticDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
