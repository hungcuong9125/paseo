import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import {
  formatSystemNotificationPrompt,
  isSystemInjectedEnvelope,
  sendPromptToAgent,
  setupFinishNotification,
} from "./agent-prompt.js";
import type { FinishNotificationRegistration } from "./agent-prompt.js";
import type { AgentManagerEvent, ManagedAgent } from "./agent-manager.js";
import type { AgentStreamEvent } from "./agent-sdk-types.js";

type Lifecycle = "idle" | "running" | "error" | "closed";

interface FakeAgentState {
  lifecycle: Lifecycle;
  activeForegroundTurnId: string | null;
  title: string;
  archivedAt?: string;
  parentAgentId?: string | null;
}

interface Subscription {
  agentId: string | null;
  callback: (event: AgentManagerEvent) => void;
}

interface Harness {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  /** Prompts handed to an agent, in delivery order. */
  deliveredTo(agentId: string): string[];
  failNextDeliveries(count: number): void;
  setLifecycle(agentId: string, lifecycle: Lifecycle, turnId?: string | null): void;
  emitStream(agentId: string, event: AgentStreamEvent): void;
  archive(agentId: string): void;
}

const CALLER = "caller-agent";

function createHarness(options?: {
  agents?: Record<string, Partial<FakeAgentState>>;
  lastAssistantMessage?: (agentId: string) => string | null;
}): Harness {
  const states = new Map<string, FakeAgentState>();
  const subscriptions = new Set<Subscription>();
  const delivered = new Map<string, string[]>();
  let deliveryFailuresLeft = 0;

  function ensureState(agentId: string): FakeAgentState {
    const existing = states.get(agentId);
    if (existing) {
      return existing;
    }
    const created: FakeAgentState = {
      lifecycle: "idle",
      activeForegroundTurnId: null,
      title: agentId,
    };
    states.set(agentId, created);
    return created;
  }

  ensureState(CALLER);
  for (const [agentId, patch] of Object.entries(options?.agents ?? {})) {
    Object.assign(ensureState(agentId), patch);
  }

  function snapshotOf(agentId: string): ManagedAgent | null {
    const state = states.get(agentId);
    if (!state) {
      return null;
    }
    const snapshot: ManagedAgent = Object.create(null);
    Reflect.set(snapshot, "id", agentId);
    Reflect.set(snapshot, "lifecycle", state.lifecycle);
    Reflect.set(snapshot, "activeForegroundTurnId", state.activeForegroundTurnId);
    Reflect.set(snapshot, "config", { title: state.title });
    return snapshot;
  }

  function dispatch(agentId: string, event: AgentManagerEvent): void {
    for (const subscription of subscriptions) {
      if (subscription.agentId !== null && subscription.agentId !== agentId) {
        continue;
      }
      subscription.callback(event);
    }
  }

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(agentManager, "getAgent", (agentId: string) => snapshotOf(agentId));
  Reflect.set(
    agentManager,
    "subscribe",
    (callback: (event: AgentManagerEvent) => void, opts?: { agentId?: string }) => {
      const subscription: Subscription = { agentId: opts?.agentId ?? null, callback };
      subscriptions.add(subscription);
      return () => subscriptions.delete(subscription);
    },
  );
  Reflect.set(agentManager, "getLastAssistantMessage", async (agentId: string) => {
    return options?.lastAssistantMessage?.(agentId) ?? null;
  });
  Reflect.set(agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(agentManager, "hasInFlightRun", (agentId: string) => {
    return states.get(agentId)?.lifecycle === "running";
  });
  Reflect.set(agentManager, "streamAgent", (agentId: string, prompt: string) => {
    if (deliveryFailuresLeft > 0) {
      deliveryFailuresLeft -= 1;
      throw new Error(`Agent ${agentId} already has an active run`);
    }
    const existing = delivered.get(agentId);
    if (existing) {
      existing.push(prompt);
    } else {
      delivered.set(agentId, [prompt]);
    }
    return (async function* noop() {})();
  });
  Reflect.set(agentManager, "replaceAgentRun", async (agentId: string) => {
    throw new Error(`Agent ${agentId} already has an active run`);
  });

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", async (agentId: string) => {
    const state = states.get(agentId);
    if (!state) {
      return null;
    }
    const parentAgentId = state.parentAgentId === undefined ? CALLER : state.parentAgentId;
    return {
      title: state.title,
      ...(state.archivedAt ? { archivedAt: state.archivedAt } : {}),
      labels: parentAgentId ? { "paseo.parent-agent-id": parentAgentId } : {},
    };
  });

  return {
    agentManager,
    agentStorage,
    deliveredTo(agentId) {
      return delivered.get(agentId) ?? [];
    },
    failNextDeliveries(count) {
      deliveryFailuresLeft = count;
    },
    setLifecycle(agentId, lifecycle, turnId) {
      const state = ensureState(agentId);
      state.lifecycle = lifecycle;
      if (turnId !== undefined) {
        state.activeForegroundTurnId = turnId;
      }
      const agent = snapshotOf(agentId);
      if (agent) {
        dispatch(agentId, { type: "agent_state", agent });
      }
    },
    emitStream(agentId, event) {
      dispatch(agentId, { type: "agent_stream", agentId, event });
    },
    archive(agentId) {
      ensureState(agentId).archivedAt = "2026-01-01T00:00:00.000Z";
    },
  };
}

function watchNextTurn(harness: Harness, childAgentId: string) {
  return setupFinishNotification({
    agentManager: harness.agentManager,
    agentStorage: harness.agentStorage,
    childAgentId,
    callerAgentId: CALLER,
    watch: "next-turn",
    logger: createTestLogger(),
  });
}

function startTurn(harness: Harness, childAgentId: string, turnId: string): void {
  harness.setLifecycle(childAgentId, "running", turnId);
  harness.emitStream(childAgentId, { type: "turn_started", provider: "codex", turnId });
}

function endTurn(harness: Harness, childAgentId: string, turnId: string): void {
  harness.emitStream(childAgentId, { type: "turn_completed", provider: "codex", turnId });
  harness.setLifecycle(childAgentId, "idle", null);
}

/** Arm, dispatch, bind — the order every real dispatch site follows. */
function runTurn(
  harness: Harness,
  childAgentId: string,
  turnId: string,
  existing?: FinishNotificationRegistration,
): void {
  const registration = existing ?? watchNextTurn(harness, childAgentId);
  startTurn(harness, childAgentId, turnId);
  registration.bindTurn(turnId);
  endTurn(harness, childAgentId, turnId);
}

test("isSystemInjectedEnvelope matches the envelope formatSystemNotificationPrompt produces", () => {
  expect(isSystemInjectedEnvelope(formatSystemNotificationPrompt("child finished"))).toBe(true);
  expect(isSystemInjectedEnvelope("hello world")).toBe(false);
});

test("sendPromptToAgent forwards the client message id as run options", async () => {
  const agent: ManagedAgent = Object.create(null);
  Reflect.set(agent, "id", "agent-1");
  Reflect.set(agent, "provider", "codex");

  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn(() => agent),
  );
  Reflect.set(agentManager, "tryRunOutOfBand", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "streamAgent", streamAgentSpy);

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(
    agentStorage,
    "get",
    vi.fn(async () => null),
  );

  await sendPromptToAgent({
    agentManager,
    agentStorage,
    agentId: "agent-1",
    prompt: "hello",
    messageId: "msg-client-1",
    runOptions: { outputSchema: { type: "object" } },
    logger: createTestLogger(),
  });

  expect(streamAgentSpy).toHaveBeenCalledWith("agent-1", "hello", {
    outputSchema: { type: "object" },
    clientMessageId: "msg-client-1",
  });
});

test("sendPromptToAgent can refuse to replace an in-flight run", async () => {
  const harness = createHarness({ agents: { child: { lifecycle: "running" } } });

  await expect(
    sendPromptToAgent({
      agentManager: harness.agentManager,
      agentStorage: harness.agentStorage,
      agentId: "child",
      prompt: "hello",
      replaceRunning: false,
      logger: createTestLogger(),
    }),
  ).resolves.toEqual({ outOfBand: false });

  expect(harness.deliveredTo("child")).toEqual(["hello"]);
});

test("finish notifications tell the caller the child's last assistant message", async () => {
  const harness = createHarness({
    agents: { child: { title: "Child Agent" } },
    lastAssistantMessage: () => "Implemented the cleanup and all checks pass.",
  });

  watchNextTurn(harness, "child");
  runTurn(harness, "child", "turn-1");

  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(1));
  expect(harness.deliveredTo(CALLER)[0]).toEqual(
    formatSystemNotificationPrompt(
      "Agent child (Child Agent) finished.\n\n<agent-response>\nImplemented the cleanup and all checks pass.\n</agent-response>",
    ),
  );
});

test("a turn belonging to someone else does not consume the watch", async () => {
  const harness = createHarness({ agents: { child: {} } });

  const registration = watchNextTurn(harness, "child");

  // Another writer's turn opens and is cancelled inside the arming window.
  startTurn(harness, "child", "foreign-turn");
  harness.emitStream("child", {
    type: "turn_canceled",
    provider: "codex",
    reason: "interrupted",
    turnId: "foreign-turn",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(harness.deliveredTo(CALLER)).toEqual([]);

  // Our dispatch names its own turn.
  startTurn(harness, "child", "work-turn");
  registration.bindTurn("work-turn");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(harness.deliveredTo(CALLER)).toEqual([]);

  endTurn(harness, "child", "work-turn");
  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(1));
  expect(harness.deliveredTo(CALLER)[0]).toContain("Agent child (child) finished.");
});

test("a turn that ended while arming is delivered once the watch is bound", async () => {
  const harness = createHarness({ agents: { child: {} } });

  const registration = watchNextTurn(harness, "child");
  startTurn(harness, "child", "fast-turn");
  endTurn(harness, "child", "fast-turn");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(harness.deliveredTo(CALLER)).toEqual([]);

  registration.bindTurn("fast-turn");
  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(1));
});

test("binding with an unknown turn id takes the turn that ended while arming", async () => {
  const harness = createHarness({ agents: { child: {} } });

  const registration = watchNextTurn(harness, "child");
  startTurn(harness, "child", "fast-turn");
  endTurn(harness, "child", "fast-turn");
  registration.bindTurn(null);

  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(1));
});

test("a permission request does not consume the finish watch", async () => {
  const harness = createHarness({ agents: { child: {} } });

  const registration = watchNextTurn(harness, "child");
  startTurn(harness, "child", "turn-1");
  registration.bindTurn("turn-1");
  harness.emitStream("child", {
    type: "permission_requested",
    provider: "codex",
    request: { id: "perm-1", toolName: "bash", input: {} },
  } as AgentStreamEvent);

  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(1));
  expect(harness.deliveredTo(CALLER)[0]).toContain("needs permission");

  endTurn(harness, "child", "turn-1");

  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(2));
  expect(harness.deliveredTo(CALLER)[1]).toContain("finished");
});

test("notifications wait for a busy caller instead of replacing its turn", async () => {
  const harness = createHarness({ agents: { child: {} } });
  harness.setLifecycle(CALLER, "running");

  watchNextTurn(harness, "child");
  runTurn(harness, "child", "turn-1");

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(harness.deliveredTo(CALLER)).toEqual([]);

  harness.setLifecycle(CALLER, "idle");
  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(1));
});

test("notifications that pile up against a busy caller are merged, not dropped", async () => {
  const harness = createHarness({ agents: { "child-a": {}, "child-b": {} } });
  harness.setLifecycle(CALLER, "running");

  watchNextTurn(harness, "child-a");
  watchNextTurn(harness, "child-b");
  runTurn(harness, "child-a", "turn-a");
  runTurn(harness, "child-b", "turn-b");

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(harness.deliveredTo(CALLER)).toEqual([]);

  harness.setLifecycle(CALLER, "idle");
  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(1));

  const notification = harness.deliveredTo(CALLER)[0];
  expect(notification).toContain("Agent child-a (child-a) finished.");
  expect(notification).toContain("Agent child-b (child-b) finished.");
});

test("a delivery that is refused is retried instead of dropped", async () => {
  const harness = createHarness({ agents: { child: {} } });
  harness.failNextDeliveries(1);

  watchNextTurn(harness, "child");
  runTurn(harness, "child", "turn-1");

  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(1), { timeout: 10_000 });
  expect(harness.deliveredTo(CALLER)[0]).toContain("Agent child (child) finished.");
});

test("watching a turn that already ended notifies immediately", async () => {
  const harness = createHarness({ agents: { child: { lifecycle: "running" } } });

  setupFinishNotification({
    agentManager: harness.agentManager,
    agentStorage: harness.agentStorage,
    childAgentId: "child",
    callerAgentId: CALLER,
    watch: "next-turn",
    expectedTurnId: "turn-already-over",
    logger: createTestLogger(),
  });

  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(1));
});

test("cancelling a watch before any turn starts silences it", async () => {
  const harness = createHarness({ agents: { child: {} } });

  const registration = watchNextTurn(harness, "child");
  registration.cancel();
  expect(registration.willNotifyCaller()).toBe(false);

  runTurn(harness, "child", "turn-1", registration);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(harness.deliveredTo(CALLER)).toEqual([]);
});

test("binding twice keeps the first turn", async () => {
  const harness = createHarness({ agents: { child: {} } });

  const registration = watchNextTurn(harness, "child");
  startTurn(harness, "child", "turn-1");
  registration.bindTurn("turn-1");
  registration.bindTurn("turn-2");

  harness.emitStream("child", { type: "turn_completed", provider: "codex", turnId: "turn-2" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(harness.deliveredTo(CALLER)).toEqual([]);

  endTurn(harness, "child", "turn-1");
  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(1));
});

test("detaching a child ends its parent-owned finish notification", async () => {
  const harness = createHarness({ agents: { child: { parentAgentId: null } } });

  const registration = setupFinishNotification({
    agentManager: harness.agentManager,
    agentStorage: harness.agentStorage,
    childAgentId: "child",
    callerAgentId: CALLER,
    watch: "next-turn",
    requireParentOwnership: true,
    logger: createTestLogger(),
  });
  runTurn(harness, "child", "turn-1", registration);

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(harness.deliveredTo(CALLER)).toEqual([]);
});

test("follow-up finish notifications do not require a parent relationship", async () => {
  const harness = createHarness({ agents: { child: { parentAgentId: "another-agent" } } });

  watchNextTurn(harness, "child");
  runTurn(harness, "child", "turn-1");

  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(1));
});

test("does not notify archived callers", async () => {
  const harness = createHarness({ agents: { child: {} } });
  harness.archive(CALLER);

  watchNextTurn(harness, "child");
  runTurn(harness, "child", "turn-1");

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(harness.deliveredTo(CALLER)).toEqual([]);
});

test("a child that is not loaded yet keeps its watch", async () => {
  const harness = createHarness();

  // No state for "cold-child": getAgent returns null, the normal case when the
  // watch is armed before the dispatch that loads the agent.
  const registration = watchNextTurn(harness, "cold-child");
  expect(registration.willNotifyCaller()).toBe(true);

  runTurn(harness, "cold-child", "turn-1", registration);
  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(1));
});

test("an interrupted turn is not reported as finished", async () => {
  const harness = createHarness({ agents: { child: {} } });

  const registration = watchNextTurn(harness, "child");
  startTurn(harness, "child", "turn-1");
  registration.bindTurn("turn-1");
  harness.emitStream("child", {
    type: "turn_canceled",
    provider: "codex",
    reason: "interrupted",
    turnId: "turn-1",
  });

  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(1));
  expect(harness.deliveredTo(CALLER)[0]).toContain("was interrupted");
  expect(harness.deliveredTo(CALLER)[0]).not.toContain("finished");
});

test("a fired watch still reports that the caller will hear about it", async () => {
  const harness = createHarness({ agents: { child: {} } });

  const registration = watchNextTurn(harness, "child");
  runTurn(harness, "child", "turn-1", registration);

  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(1));
  expect(registration.willNotifyCaller()).toBe(true);
});

test("the legacy any-idle watch still fires on the first idle", async () => {
  const harness = createHarness({ agents: { child: {} } });

  setupFinishNotification({
    agentManager: harness.agentManager,
    agentStorage: harness.agentStorage,
    childAgentId: "child",
    callerAgentId: CALLER,
    logger: createTestLogger(),
  });

  harness.setLifecycle("child", "running", "turn-1");
  harness.setLifecycle("child", "idle", null);

  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(1));
});

test("closing a watched child notifies the caller", async () => {
  const harness = createHarness({ agents: { child: { title: "Child Agent" } } });

  const registration = watchNextTurn(harness, "child");
  startTurn(harness, "child", "turn-1");
  registration.bindTurn("turn-1");
  harness.setLifecycle("child", "closed");

  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(1));
  expect(harness.deliveredTo(CALLER)[0]).toEqual(
    formatSystemNotificationPrompt("Agent child (Child Agent) was closed."),
  );
});

test("finish notifications truncate oversized child responses", async () => {
  const included = "x".repeat(4000);
  const omitted = "TAIL-MARKER".repeat(50);
  const harness = createHarness({
    agents: { child: { title: "Child Agent" } },
    lastAssistantMessage: () => included + omitted,
  });

  watchNextTurn(harness, "child");
  runTurn(harness, "child", "turn-1");

  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(1));
  const notification = harness.deliveredTo(CALLER)[0];
  expect(notification).toContain(included);
  expect(notification).toContain(
    `[truncated ${omitted.length} chars; use get_agent_activity for the full response]`,
  );
  expect(notification).not.toContain("TAIL-MARKER");
});

test("permission notifications carry the actionable request payload", async () => {
  const harness = createHarness({ agents: { child: { title: "Child Agent" } } });

  const registration = watchNextTurn(harness, "child");
  startTurn(harness, "child", "turn-1");
  registration.bindTurn("turn-1");
  harness.emitStream("child", {
    type: "permission_requested",
    provider: "codex",
    request: { id: "perm-1", provider: "codex", kind: "tool", name: "Run command", input: {} },
  } as AgentStreamEvent);

  await vi.waitFor(() => expect(harness.deliveredTo(CALLER)).toHaveLength(1));
  const notification = harness.deliveredTo(CALLER)[0];
  expect(notification).toContain("needs permission.");

  const permissionPayload = notification.match(
    /<permission-request>\n([\s\S]+?)\n<\/permission-request>/,
  )?.[1];
  expect(permissionPayload).toBeDefined();
  expect(JSON.parse(permissionPayload!)).toEqual({
    agentId: "child",
    requestId: "perm-1",
    request: { id: "perm-1", provider: "codex", kind: "tool", name: "Run command", input: {} },
  });
});
