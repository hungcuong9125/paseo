import type { Logger } from "pino";

import type {
  AgentPermissionRequest,
  AgentPromptInput,
  AgentRunOptions,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import { getAgentStreamEventTurnId } from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import { AgentNotificationQueue } from "./agent-notification-queue.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

/** Key for a terminal event a provider emitted without a turn id. */
const UNIDENTIFIED_TURN = "unidentified-turn";

/**
 * A cancelled turn is over but did not finish its work. Calling that "finished"
 * hands the caller a partial answer as if it were the result.
 */
function terminalTurnReason(type: AgentStreamEvent["type"]): FinishNotificationReason {
  if (type === "turn_failed") {
    return "errored";
  }
  if (type === "turn_canceled") {
    return "was interrupted";
  }
  return "finished";
}

function isTurnTerminalStreamEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

export type AgentUnarchiveController = Pick<AgentManager, "notifyAgentState" | "unarchiveSnapshot">;

export type AgentRunController = Pick<
  AgentManager,
  "getAgent" | "tryRunOutOfBand" | "hasInFlightRun" | "replaceAgentRun" | "streamAgent"
>;

export interface StartAgentRunOptions {
  replaceRunning?: boolean;
  runOptions?: AgentRunOptions;
}

export async function startAgentRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ outOfBand: boolean }> {
  const snapshot = agentManager.getAgent(agentId);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      turnId: snapshot?.activeForegroundTurnId ?? undefined,
      promptType: typeof prompt === "string" ? "string" : "structured",
      hasRunOptions: Boolean(options?.runOptions),
      replaceRunning: Boolean(options?.replaceRunning),
    },
    "agent.session.start_stream.request",
  );
  // Out-of-band commands (e.g. /goal pause) must run WITHOUT canceling an
  // in-flight turn — replaceAgentRun would interrupt the running turn. The
  // intercept lives at this layer so it covers every prompt entrypoint.
  if (agentManager.tryRunOutOfBand(agentId, prompt, options?.runOptions)) {
    return { outOfBand: true };
  }
  const shouldReplace = Boolean(options?.replaceRunning && agentManager.hasInFlightRun(agentId));
  const runOptions = options?.runOptions;
  const iterator = shouldReplace
    ? await agentManager.replaceAgentRun(agentId, prompt, runOptions)
    : agentManager.streamAgent(agentId, prompt, runOptions);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      shouldReplace,
    },
    "agent.session.start_stream.iterator_returned",
  );
  void (async () => {
    try {
      for await (const _ of iterator) {
        // Events are broadcast via AgentManager subscribers.
      }
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
        },
        "agent.session.iterator.drained",
      );
    } catch (error) {
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
          err: error,
        },
        "agent.session.iterator.error",
      );
      logger.error({ err: error, agentId }, "Agent stream failed");
    }
  })();
  return { outOfBand: false };
}

/**
 * Clear the archived flag from a stored agent record.
 * Shared across Session (app/WS), MCP, and CLI so every surface that acts on
 * an archived agent unarchives it the same way.
 */
export async function unarchiveAgentState(
  _agentStorage: AgentStorage,
  agentManager: AgentUnarchiveController,
  agentId: string,
  updates?: { workspaceId?: string; labels?: Record<string, string | null> },
): Promise<boolean> {
  const unarchived = await agentManager.unarchiveSnapshot(agentId, updates);
  if (!unarchived) return false;
  agentManager.notifyAgentState(agentId);
  return true;
}

/**
 * Wrap a body in <paseo-system>…</paseo-system> so the receiving agent
 * recognizes the prompt as system-injected context — not a user turn.
 * Used by chat mentions, schedule fires, and notify-on-finish.
 */
export function formatSystemNotificationPrompt(reason: string): string {
  return `<paseo-system>\n${reason}\n</paseo-system>`;
}

const SYSTEM_ENVELOPE_PATTERN = /^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/;

export function isSystemInjectedEnvelope(text: string): boolean {
  return SYSTEM_ENVELOPE_PATTERN.test(text);
}

export interface SendPromptToAgentParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  /** Prompt to dispatch to the provider (may include image blocks or wrapped text). */
  prompt: AgentPromptInput;
  messageId?: string;
  runOptions?: AgentRunOptions;
  /** Optional mode to set on the agent before the run starts. */
  sessionMode?: string;
  /**
   * Default true. When false, archived agents are skipped instead of being
   * unarchived. Use false for system-injected prompts (chat mentions,
   * schedule fires, notify-on-finish).
   */
  unarchive?: boolean;
  /**
   * Default true, which cancels the agent's in-flight turn and takes its place.
   * That is right for a prompt a human just typed and wrong for anything the
   * daemon injects on its own: a finish notification that replaces a running
   * turn destroys whatever the agent was doing with the previous one. Pass
   * false to fail loudly instead, and let the caller wait for idle and retry.
   */
  replaceRunning?: boolean;
  logger: Logger;
}

export interface StartCreatedAgentInitialPromptParams {
  agentManager: AgentManager;
  agentId: string;
  snapshot?: ManagedAgent;
  prompt: AgentPromptInput | null;
  runOptions?: AgentRunOptions;
  logger: Logger;
}

const AGENT_RUN_START_TIMEOUT_MS = 15_000;

export async function waitForAgentRunStartWithTimeout(
  agentManager: AgentManager,
  agentId: string,
): Promise<void> {
  const startAbort = new AbortController();
  const startTimeout = setTimeout(() => startAbort.abort("timeout"), AGENT_RUN_START_TIMEOUT_MS);

  try {
    await agentManager.waitForAgentRunStart(agentId, { signal: startAbort.signal });
  } finally {
    clearTimeout(startTimeout);
  }
}

/**
 * Full send-prompt orchestration: (optional unarchive) → load → (optional
 * mode change) → start run.
 *
 * Every surface that sends a prompt to an agent (Session/WS, MCP, CLI-through-MCP,
 * chat mentions, notify-on-finish) MUST go through this so behavior can never
 * drift between them.
 *
 * When `unarchive` is false and the agent is archived, the call is a silent
 * no-op (returns `{ outOfBand: false }`) — the agent is not run.
 */
export async function sendPromptToAgent(
  params: SendPromptToAgentParams,
): Promise<{ outOfBand: boolean }> {
  const unarchive = params.unarchive ?? true;

  const record = await params.agentStorage.get(params.agentId);
  if (record?.archivedAt) {
    if (!unarchive) {
      return { outOfBand: false };
    }
    await unarchiveAgentState(params.agentStorage, params.agentManager, params.agentId);
  }

  await ensureAgentLoaded(params.agentId, {
    agentManager: params.agentManager,
    agentStorage: params.agentStorage,
    logger: params.logger,
  });

  if (params.sessionMode) {
    await params.agentManager.setAgentMode(params.agentId, params.sessionMode);
  }

  const runOptions = params.messageId
    ? { ...params.runOptions, clientMessageId: params.messageId }
    : params.runOptions;

  return await startAgentRun(params.agentManager, params.agentId, params.prompt, params.logger, {
    replaceRunning: params.replaceRunning ?? true,
    runOptions,
  });
}

export async function startCreatedAgentInitialPrompt(
  params: StartCreatedAgentInitialPromptParams,
): Promise<ManagedAgent> {
  const currentSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!currentSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }

  if (params.prompt === null) {
    return currentSnapshot;
  }

  const dispatchResult = await startAgentRun(
    params.agentManager,
    params.agentId,
    params.prompt,
    params.logger,
    {
      runOptions: params.runOptions,
    },
  );

  if (!dispatchResult.outOfBand) {
    await waitForAgentRunStartWithTimeout(params.agentManager, params.agentId);
  }

  const refreshedSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!refreshedSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }
  return refreshedSnapshot;
}

export interface SetupFinishNotificationParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  childAgentId: string;
  callerAgentId: string;
  /**
   * Which of the child's turns this callback belongs to.
   *
   * "next-turn" reports one specific turn. Arm it *before* dispatching, then
   * name the turn with `bindTurn` once the dispatch has started one. A child
   * that ends a turn without finishing its work — answering a handshake, asking
   * a question, hitting a permission prompt — must not retire the watch, which
   * is what "any-idle" does.
   *
   * "any-idle" (default) fires on the first running→idle transition, whichever
   * turn produced it.
   */
  watch?: "next-turn" | "any-idle";
  /**
   * Bind to a turn that is already running instead of waiting for `bindTurn`.
   * Use it when a blocking wait gave up on a turn still in progress.
   */
  expectedTurnId?: string;
  requireParentOwnership?: boolean;
  logger: Logger;
}

export interface FinishNotificationRegistration {
  /** Tears the watch down. Nothing will be delivered for it. */
  cancel(): void;
  /**
   * Names the turn this watch belongs to, once the dispatch that created it has
   * started one. Pass null when the id could not be determined — the watch then
   * takes the next turn to end (or one that already ended while arming).
   *
   * Until this is called a "next-turn" watch holds its fire. Anyone else can
   * open a turn on the same child inside the arming window, and a dispatch that
   * replaces that turn cancels it; reporting that cancellation would wake the
   * caller with a stranger's result and retire the watch before the caller's own
   * turn ever ends.
   */
  bindTurn(turnId: string | null): void;
  /**
   * Whether the caller will hear about this dispatch — still waiting, or
   * already notified. False only once the watch has been torn down. Tool
   * responses must key their "you will be notified" guidance off this and not
   * off the request, or an out-of-band prompt promises a callback it cancelled.
   */
  willNotifyCaller(): boolean;
}

/** Permission prompts no longer consume the watch, so cap how many they can send. */
const MAX_PERMISSION_NOTICES = 5;

const notificationQueues = new WeakMap<AgentManager, AgentNotificationQueue>();

function getNotificationQueue(
  agentManager: AgentManager,
  agentStorage: AgentStorage,
  logger: Logger,
): AgentNotificationQueue {
  const existing = notificationQueues.get(agentManager);
  if (existing) {
    return existing;
  }

  const queue = new AgentNotificationQueue({
    agentManager,
    agentStorage,
    logger,
    deliver: async (callerAgentId, body) => {
      await sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId: callerAgentId,
        prompt: formatSystemNotificationPrompt(body),
        unarchive: false,
        replaceRunning: false,
        logger,
      });
    },
  });
  notificationQueues.set(agentManager, queue);
  return queue;
}

type FinishNotificationReason =
  | "finished"
  | "errored"
  | "was interrupted"
  | "needs permission"
  | "was closed";

const FINISH_NOTIFICATION_MESSAGE_LIMIT = 4000;

interface FinishNotificationBodyInput {
  childAgentId: string;
  title: string;
  reason: FinishNotificationReason;
  lastAssistantMessage: string | null;
  permissionRequest?: AgentPermissionRequest;
}

function formatFinishNotificationBody(params: FinishNotificationBodyInput): string {
  const statusLine = `Agent ${params.childAgentId} (${params.title}) ${params.reason}.`;
  const sections = [statusLine];
  if (params.reason === "needs permission" && params.permissionRequest) {
    sections.push(
      "Respond with `respond_to_permission` using the `agentId` and `requestId` below.",
      `<permission-request>\n${JSON.stringify(
        {
          agentId: params.childAgentId,
          requestId: params.permissionRequest.id,
          request: params.permissionRequest,
        },
        null,
        2,
      )}\n</permission-request>`,
    );
  }
  let lastAssistantMessage = params.lastAssistantMessage?.trim();
  if (lastAssistantMessage) {
    if (lastAssistantMessage.length > FINISH_NOTIFICATION_MESSAGE_LIMIT) {
      const omitted = lastAssistantMessage.length - FINISH_NOTIFICATION_MESSAGE_LIMIT;
      lastAssistantMessage = `${lastAssistantMessage.slice(0, FINISH_NOTIFICATION_MESSAGE_LIMIT)}\n[truncated ${omitted} chars; use get_agent_activity for the full response]`;
    }
    sections.push(`<agent-response>\n${lastAssistantMessage}\n</agent-response>`);
  }
  return sections.join("\n\n");
}

export function setupFinishNotification(
  params: SetupFinishNotificationParams,
): FinishNotificationRegistration {
  const {
    agentManager,
    agentStorage,
    childAgentId,
    callerAgentId,
    watch = "any-idle",
    expectedTurnId,
    requireParentOwnership = false,
    logger,
  } = params;
  const queue = getNotificationQueue(agentManager, agentStorage, logger);
  let hasSeenRunning = false;
  let fired = false;
  let permissionNotices = 0;
  // Bound means the caller has named its turn. The id can still be null: some
  // providers end a turn without one, and a dispatch whose run-start wait
  // expired cannot read one, so null means "the next turn to end is mine".
  let cancelled = false;
  let bound = expectedTurnId !== undefined;
  let watchedTurnId: string | null = expectedTurnId ?? null;
  // Terminal events seen before binding. One of them may turn out to be the
  // caller's own turn finishing inside the arming window.
  const terminalBeforeBind = new Map<string, FinishNotificationReason>();
  let unsubscribe: (() => void) | null = null;

  function release(): void {
    const subscribed = unsubscribe;
    unsubscribe = null;
    subscribed?.();
  }

  async function notify(
    reason: FinishNotificationReason,
    permissionRequest?: AgentPermissionRequest,
  ): Promise<void> {
    if (fired) {
      return;
    }
    if (reason === "needs permission") {
      permissionNotices += 1;
      if (permissionNotices > MAX_PERMISSION_NOTICES) {
        return;
      }
    } else {
      // Terminal: this watch is done. Everything past here can fail without
      // losing the payload, because the queue owns delivery and retries.
      fired = true;
      release();
    }

    const callerRecord = await agentStorage.get(callerAgentId);
    if (callerRecord?.archivedAt) {
      return;
    }

    const record = await agentStorage.get(childAgentId);
    if (requireParentOwnership && getParentAgentIdFromLabels(record?.labels) !== callerAgentId) {
      return;
    }
    const title = record?.title ?? childAgentId;
    const lastAssistantMessage = await agentManager.getLastAssistantMessage(childAgentId);
    const body = formatFinishNotificationBody({
      childAgentId,
      title,
      reason,
      lastAssistantMessage,
      permissionRequest,
    });

    queue.enqueue(callerAgentId, body);
  }

  function notifySafely(
    reason: FinishNotificationReason,
    permissionRequest?: AgentPermissionRequest,
  ): void {
    void notify(reason, permissionRequest).catch((error) => {
      logger.error(
        { err: error, childAgentId, callerAgentId, reason },
        "Failed to notify caller agent",
      );
    });
  }

  function handleLifecycle(lifecycle: ManagedAgent["lifecycle"]): void {
    if (lifecycle === "running") {
      hasSeenRunning = true;
      return;
    }
    if (lifecycle === "closed") {
      notifySafely("was closed");
      return;
    }
    if (watch === "next-turn") {
      // The turn stream decides when a watched turn ends. A bare "idle" here
      // belongs to some other turn. An error with no turn to report it against
      // is the one case the stream cannot cover.
      if (lifecycle === "error" && bound && watchedTurnId === null) {
        notifySafely("errored");
      }
      return;
    }
    if (lifecycle === "error") {
      notifySafely("errored");
      return;
    }
    if (lifecycle === "idle" && hasSeenRunning) {
      notifySafely("finished");
    }
  }

  function isWatchedTurn(turnId: string | undefined): boolean {
    if (!turnId || watchedTurnId === null) {
      return true;
    }
    return turnId === watchedTurnId;
  }

  function handleStreamEvent(streamEvent: AgentStreamEvent): void {
    if (streamEvent.type === "permission_requested") {
      if (
        watch !== "next-turn" ||
        (bound && isWatchedTurn(getAgentStreamEventTurnId(streamEvent)))
      ) {
        notifySafely("needs permission", streamEvent.request);
      }
      return;
    }
    if (watch !== "next-turn") {
      return;
    }
    if (streamEvent.type === "turn_started") {
      hasSeenRunning = true;
      return;
    }
    if (!isTurnTerminalStreamEvent(streamEvent)) {
      return;
    }
    const turnId = getAgentStreamEventTurnId(streamEvent);
    const reason = terminalTurnReason(streamEvent.type);
    if (!bound) {
      terminalBeforeBind.set(turnId ?? UNIDENTIFIED_TURN, reason);
      return;
    }
    if (!isWatchedTurn(turnId)) {
      return;
    }
    notifySafely(reason);
  }

  unsubscribe = agentManager.subscribe(
    (event) => {
      if (fired) {
        return;
      }
      if (event.type === "agent_state") {
        handleLifecycle(event.agent.lifecycle);
        return;
      }
      if (event.type === "agent_stream") {
        handleStreamEvent(event.event);
      }
    },
    { agentId: childAgentId, replayState: false },
  );

  // Check if the child is already running (catches the case where
  // the lifecycle flipped before our subscribe call was processed).
  // Do NOT treat an immediate "idle" as "finished" — the agent may
  // not have started yet (streamAgent sets a pending run before
  // transitioning to "running").
  // A watch is armed before the dispatch that loads the child, so "not in
  // memory yet" is the normal case here and must not retire it. Subscriptions
  // are keyed by agent id and survive the load.
  const childSnapshot = agentManager.getAgent(childAgentId);
  if (childSnapshot?.lifecycle === "closed") {
    fired = true;
    release();
    cancelled = true;
    return { cancel: release, bindTurn: () => undefined, willNotifyCaller: () => false };
  }
  if (childSnapshot?.lifecycle === "running") {
    hasSeenRunning = true;
  } else if (childSnapshot?.lifecycle === "error" && watch !== "next-turn") {
    notifySafely("errored");
  }
  if (expectedTurnId && childSnapshot && childSnapshot.activeForegroundTurnId !== expectedTurnId) {
    // The turn we were handed is already over; its terminal event is gone.
    notifySafely("finished");
  }

  return {
    cancel() {
      if (fired) {
        return;
      }
      fired = true;
      cancelled = true;
      release();
    },
    bindTurn(turnId: string | null) {
      if (fired || bound) {
        return;
      }
      bound = true;
      watchedTurnId = turnId;
      const buffered = turnId
        ? (terminalBeforeBind.get(turnId) ?? terminalBeforeBind.get(UNIDENTIFIED_TURN))
        : // Unknown id: the caller's turn is whichever one ended while arming.
          [...terminalBeforeBind.values()][0];
      terminalBeforeBind.clear();
      if (buffered) {
        notifySafely(buffered);
      }
    },
    willNotifyCaller() {
      return !cancelled;
    },
  };
}
