import {
  formatSystemNotificationPrompt,
  formatAgentMessage,
  parseAgentMessage,
  prepareAgentMessage,
  type AgentPromptSource,
} from "./agent-messages/index.js";
import type { Logger } from "pino";

import type {
  AgentPermissionRequest,
  AgentPromptInput,
  AgentRunOptions,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import { getAgentStreamEventTurnId } from "./agent-sdk-types.js";
import { randomUUID } from "node:crypto";

import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import { AgentMailbox, type MailboxDelivery } from "./agent-mailbox/service.js";
import type { MailboxPolicy } from "./agent-mailbox/policy.js";
import type { MailboxStore } from "./agent-mailbox/store.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { isStaleProviderSessionError } from "./stale-provider-session-error.js";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";

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
  | "getAgent"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "replaceAgentRun"
  | "steerOrReplaceActiveTurn"
  | "streamAgent"
> & {
  reloadAgentSession(agentId: string): Promise<unknown>;
};

export interface StartAgentRunOptions {
  replaceRunning?: boolean;
  activeTurnBehavior?: ActiveTurnBehavior;
  runOptions?: AgentRunOptions;
  /** Ask the provider to deny permissions blocking this steer. */
  clearPendingPermissions?: boolean;
}

export type PromptDispatchDisposition = "out_of_band" | "steered" | "turn_started";

export type SendPromptResult =
  | { disposition: PromptDispatchDisposition }
  /** The receiver's mailbox holds the prompt until its current turn ends. */
  | { disposition: "queued"; position: number };

/**
 * Who a prompt comes from decides whether it may interrupt the receiver.
 * People and the receiver's parent agent may; any other agent and schedules
 * wait in the receiver's mailbox when it has one.
 */
export type PromptSender =
  | { kind: "human" }
  | { kind: "agent"; agentId: string | null }
  | { kind: "schedule"; scheduleId: string }
  /** The mailbox handing over mail it already held. */
  | { kind: "mailbox" };

const HUMAN_SENDER: PromptSender = { kind: "human" };

async function steerOrReplaceActiveRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  options: StartAgentRunOptions | undefined,
): Promise<
  | { disposition: "steered" }
  | {
      disposition: "turn_started";
      iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
    }
  | null
> {
  if (options?.activeTurnBehavior !== "steer") {
    return null;
  }
  const steerOptions = options.clearPendingPermissions
    ? { ...options.runOptions, clearPendingPermissions: true }
    : options.runOptions;
  const result = await agentManager.steerOrReplaceActiveTurn(agentId, prompt, steerOptions);
  if (result.status === "steered") {
    return { disposition: "steered" };
  }
  if (result.status === "replaced") {
    return { disposition: "turn_started", iterator: result.iterator };
  }
  return null;
}

async function startOrReplaceRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  options: StartAgentRunOptions | undefined,
): Promise<{
  iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
  replaced: boolean;
}> {
  const replaced = Boolean(options?.replaceRunning && agentManager.hasInFlightRun(agentId));
  const iterator = replaced
    ? await agentManager.replaceAgentRun(agentId, prompt, options?.runOptions)
    : agentManager.streamAgent(agentId, prompt, options?.runOptions);
  return { iterator, replaced };
}

async function drainAgentRunIterator(
  iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>,
): Promise<void> {
  for await (const _ of iterator) {
    // Events are broadcast via AgentManager subscribers.
  }
}

export async function startAgentRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ disposition: PromptDispatchDisposition }> {
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
    return { disposition: "out_of_band" };
  }
  try {
    return await startAgentRunInner(agentManager, agentId, prompt, logger, options);
  } catch (error) {
    if (!isStaleProviderSessionError(error)) throw error;
    logger.info({ agentId, err: error }, "Provider session went stale; reopening from persistence");
    // The live session belongs to a retired plugin runtime. Reload swaps in a
    // fresh session on the current runtime while preserving history and labels.
    await agentManager.reloadAgentSession(agentId);
    return await startAgentRunInner(agentManager, agentId, prompt, logger, options);
  }
}

async function startAgentRunInner(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const snapshot = agentManager.getAgent(agentId);
  const steered = await steerOrReplaceActiveRun(agentManager, agentId, prompt, options);
  if (steered?.disposition === "steered") {
    return steered;
  }
  const { iterator, replaced } = steered
    ? { iterator: steered.iterator, replaced: true }
    : await startOrReplaceRun(agentManager, agentId, prompt, options);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      shouldReplace: replaced,
    },
    "agent.session.start_stream.iterator_returned",
  );
  void (async () => {
    try {
      try {
        await drainAgentRunIterator(iterator);
      } catch (error) {
        if (!isStaleProviderSessionError(error)) throw error;
        logger.info(
          { agentId, err: error },
          "Provider session went stale; reopening from persistence",
        );
        await agentManager.reloadAgentSession(agentId);
        const retry = await startOrReplaceRun(agentManager, agentId, prompt, options);
        await drainAgentRunIterator(retry.iterator);
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
  return { disposition: "turn_started" };
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

function unwrapSystemEnvelope(text: string): string {
  const match = /^<paseo-system>\n([\s\S]*)\n<\/paseo-system>$/.exec(text);
  return match?.[1] ?? text;
}
export interface SendPromptToAgentParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  /** Prompt to dispatch to the provider (may include image blocks or wrapped text). */
  prompt: AgentPromptInput;
  source?: AgentPromptSource;
  messageId?: string;
  activeTurnBehavior?: ActiveTurnBehavior;
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
  /** See {@link StartAgentRunOptions.clearPendingPermissions}. */
  clearPendingPermissions?: boolean;
  /** Defaults to a person, which keeps every existing entrypoint's behavior. */
  sender?: PromptSender;
  /** Agent to notify when a queued prompt's turn ends; armed when it is delivered. */
  notifyCallerAgentId?: string;
  logger: Logger;
}

export interface StartCreatedAgentInitialPromptParams {
  agentStorage: AgentStorage;
  agentManager: AgentManager;
  agentId: string;
  snapshot?: ManagedAgent;
  prompt: AgentPromptInput | null;
  source?: AgentPromptSource;
  runOptions?: AgentRunOptions;
  logger: Logger;
}

/**
 * Outer bound on a run reaching "started" after dispatch.
 *
 * This wraps provider startup, so it MUST stay larger than the slowest provider's own
 * startup budget — otherwise it aborts a start the provider was still allowed to be
 * working on, and the provider's budget can never apply. OpenCode is the slowest today:
 * up to 30s for the server to boot (OPENCODE_SERVER_STARTUP_TIMEOUT_MS) and then a
 * session.create on the same budget, so this is deliberately set well above 30s.
 *
 * Not derived from the provider constant on purpose: this module is provider-agnostic
 * and must not depend on a specific provider's internals.
 */
const AGENT_RUN_START_TIMEOUT_MS = 60_000;

export async function waitForAgentRunStartWithTimeout(
  agentManager: AgentManager,
  agentId: string,
  signal?: AbortSignal,
): Promise<void> {
  const provider = agentManager.getAgent(agentId)?.provider ?? "provider";
  const startAbort = new AbortController();
  const startTimeout = setTimeout(
    () =>
      startAbort.abort(
        new Error(
          `${provider} run did not start within ${AGENT_RUN_START_TIMEOUT_MS / 1000} seconds (phase: run start)`,
        ),
      ),
    AGENT_RUN_START_TIMEOUT_MS,
  );

  try {
    await agentManager.waitForAgentRunStart(agentId, {
      signal: signal ? AbortSignal.any([startAbort.signal, signal]) : startAbort.signal,
    });
  } finally {
    clearTimeout(startTimeout);
  }
}

async function resolvePromptSource(
  source: AgentPromptSource | undefined,
  manager: Pick<AgentManager, "getAgent">,
  storage: AgentStorage,
): Promise<AgentPromptSource | undefined> {
  if (!source) return undefined;
  const title = (
    manager.getAgent(source.agentId)?.config.title ?? (await storage.get(source.agentId))?.title
  )?.trim();
  return title ? { ...source, title } : source;
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
 * no-op (returns the normal turn-start disposition) — the agent is not run.
 */
export async function sendPromptToAgent(
  params: SendPromptToAgentParams,
): Promise<SendPromptResult> {
  const unarchive = params.unarchive ?? true;

  const record = await params.agentStorage.get(params.agentId);
  let archivedAtToRestore: string | null = null;
  if (record?.archivedAt) {
    if (!unarchive) {
      return { disposition: "turn_started" };
    }
    if (await unarchiveAgentState(params.agentStorage, params.agentManager, params.agentId)) {
      archivedAtToRestore = record.archivedAt;
    }
  }

  try {
    await ensureAgentLoaded(params.agentId, {
      agentManager: params.agentManager,
      agentStorage: params.agentStorage,
      logger: params.logger,
    });
  } catch (error) {
    // A send that could not load the agent leaves it where it was: still archived.
    // Concurrent sends share this load, so none of them holds a live session.
    if (archivedAtToRestore) {
      await params.agentManager.archiveSnapshot(params.agentId, archivedAtToRestore);
    }
    throw error;
  }

  const sender = params.sender ?? HUMAN_SENDER;
  if (sender.kind === "mailbox") {
    return await dispatchPrompt(params);
  }
  const mailbox = getAgentMailbox(params.agentManager);
  if (hasInterruptAuthority(sender, record?.labels)) {
    // Someone with authority prompting is the cue a person's stop is over.
    await mailbox.resume(params.agentId);
    const result = await dispatchPrompt(params);
    // Kicked after the turn exists, so waiting mail follows it instead of
    // starting first and being replaced. This also drains mail a restart left.
    void mailbox.kick(params.agentId);
    return result;
  }
  if (!(await mailbox.resolvePolicy(params.agentId)).enabled) {
    return await dispatchPrompt(params);
  }
  // Replacing the run would break the mailbox's promise, and it stores text only.
  if (typeof params.prompt !== "string") {
    throw new Error(
      `Agent ${params.agentId} has a mailbox, which accepts only text prompts from other agents and schedules`,
    );
  }
  // Out-of-band commands never open a turn, so they never wait for one to end.
  if (params.agentManager.tryRunOutOfBand(params.agentId, params.prompt, params.runOptions)) {
    return { disposition: "out_of_band" };
  }
  const admission = await mailbox.admit(
    params.agentId,
    {
      source:
        sender.kind === "schedule"
          ? { kind: "schedule", scheduleId: sender.scheduleId }
          : { kind: "agent", senderAgentId: sender.kind === "agent" ? sender.agentId : null },
      text: unwrapSystemEnvelope(params.prompt),
      ...(params.sessionMode ? { sessionMode: params.sessionMode } : {}),
      ...(params.notifyCallerAgentId ? { notifyCallerAgentId: params.notifyCallerAgentId } : {}),
    },
    () => dispatchPrompt(params),
  );
  return admission.status === "queued"
    ? { disposition: "queued", position: admission.position }
    : admission.result;
}

/** A person, or the receiver's own parent agent, may cut into its turn. */
function hasInterruptAuthority(
  sender: PromptSender,
  receiverLabels: Record<string, unknown> | undefined,
): boolean {
  if (sender.kind === "human") {
    return true;
  }
  if (sender.kind !== "agent" || !sender.agentId) {
    return false;
  }
  return getParentAgentIdFromLabels(receiverLabels) === sender.agentId;
}

async function dispatchPrompt(
  params: SendPromptToAgentParams,
): Promise<{ disposition: PromptDispatchDisposition }> {
  if (params.sessionMode) {
    await params.agentManager.setAgentMode(params.agentId, params.sessionMode);
  }

  const sender = params.sender ?? HUMAN_SENDER;
  const source = await resolvePromptSource(params.source, params.agentManager, params.agentStorage);
  const isUserOrigin = sender.kind === "human" || (sender.kind === "agent" && !sender.agentId);
  const preparedDelivery =
    source || isUserOrigin
      ? prepareAgentMessage(params.prompt, source, params.messageId)
      : { prompt: params.prompt, messageId: params.messageId };
  const runOptions = preparedDelivery.messageId
    ? { ...params.runOptions, clientMessageId: preparedDelivery.messageId }
    : params.runOptions;

  return await startAgentRun(
    params.agentManager,
    params.agentId,
    preparedDelivery.prompt,
    params.logger,
    {
      replaceRunning: params.replaceRunning ?? true,
      activeTurnBehavior: params.activeTurnBehavior,
      clearPendingPermissions: params.clearPendingPermissions,
      runOptions,
    },
  );
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

  const delivery = prepareAgentMessage(
    params.prompt,
    await resolvePromptSource(params.source, params.agentManager, params.agentStorage),
    params.runOptions?.clientMessageId,
  );
  const dispatchResult = await startAgentRun(
    params.agentManager,
    params.agentId,
    delivery.prompt,
    params.logger,
    { runOptions: { ...params.runOptions, clientMessageId: delivery.messageId } },
  );

  if (dispatchResult.disposition === "turn_started") {
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

export interface CreateAgentMailboxParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  store: MailboxStore;
  resolvePolicy: (agentId: string) => Promise<MailboxPolicy>;
  logger: Logger;
}

export function createAgentMailbox(params: CreateAgentMailboxParams): AgentMailbox {
  const { agentManager, agentStorage, logger } = params;
  return new AgentMailbox({
    store: params.store,
    agentManager,
    agentStorage,
    resolvePolicy: params.resolvePolicy,
    logger: logger.child({ module: "agent-mailbox" }),
    deliver: (delivery) => deliverMailboxBatch({ agentManager, agentStorage, logger }, delivery),
  });
}

export function getAgentMailbox(agentManager: AgentManager): AgentMailbox {
  const registered = agentManager.getMailbox();
  if (!registered) throw new Error("Agent mailbox must be registered before dispatching prompts");
  return registered;
}

/** Whether prompts without interrupt authority wait in this agent's mailbox. */
export async function isMailboxEnabled(
  agentManager: AgentManager,
  agentId: string,
): Promise<boolean> {
  const mailbox = getAgentMailbox(agentManager);
  return (await mailbox.resolvePolicy(agentId)).enabled;
}

function renderMailboxDelivery(delivery: MailboxDelivery): { prompt: string } {
  if (delivery.plainNotifications && delivery.entries.length === 1) {
    const entry = delivery.entries[0]!;
    if (
      entry.source.kind === "notification" &&
      parseAgentMessage(entry.prompt.text)?.source?.kind === "agent-notification"
    ) {
      return { prompt: entry.prompt.text };
    }
  }
  if (delivery.plainNotifications) {
    return {
      prompt: formatSystemNotificationPrompt(
        delivery.entries.map((entry) => entry.prompt.text).join("\n\n"),
      ),
    };
  }
  const items = delivery.entries.map((entry) => {
    const attributes = [`id="${entry.id}"`, `from="${describeMailboxSource(entry)}"`];
    if (entry.redelivered) {
      attributes.push(`redelivered="true"`);
    }
    return `<paseo-mailbox-item ${attributes.join(" ")}>\n${entry.prompt.text}\n</paseo-mailbox-item>`;
  });
  return { prompt: formatSystemNotificationPrompt(items.join("\n\n")) };
}

function describeMailboxSource(entry: MailboxDelivery["entries"][number]): string {
  switch (entry.source.kind) {
    case "agent":
      return entry.source.senderAgentId ? `agent:${entry.source.senderAgentId}` : "agent";
    case "schedule":
      return `schedule:${entry.source.scheduleId}`;
    case "notification":
      return `notification:${entry.source.childAgentId}`;
    case "restart":
      return "daemon";
  }
}

async function deliverMailboxBatch(
  deps: { agentManager: AgentManager; agentStorage: AgentStorage; logger: Logger },
  delivery: MailboxDelivery,
): Promise<void> {
  const { agentManager, agentStorage, logger } = deps;
  // A queued prompt's finish watch is armed now, when its turn really starts,
  // so it belongs to that turn and not to whatever ran while it waited.
  const callers = new Set(
    delivery.entries.flatMap((entry) =>
      entry.notifyCallerAgentId ? [entry.notifyCallerAgentId] : [],
    ),
  );
  const watches = [...callers].map((callerAgentId) =>
    setupFinishNotification({
      agentManager,
      agentStorage,
      childAgentId: delivery.agentId,
      callerAgentId,
      watch: "next-turn",
      logger,
    }),
  );
  let dispatch: SendPromptResult;
  try {
    dispatch = await sendPromptToAgent({
      agentManager,
      agentStorage,
      agentId: delivery.agentId,
      ...renderMailboxDelivery(delivery),
      ...(delivery.sessionMode ? { sessionMode: delivery.sessionMode } : {}),
      sender: { kind: "mailbox" },
      unarchive: false,
      replaceRunning: false,
      logger,
    });
  } catch (error) {
    for (const watch of watches) {
      watch.cancel();
    }
    throw error;
  }
  if (dispatch.disposition !== "turn_started") {
    for (const watch of watches) {
      watch.cancel();
    }
    return;
  }
  if (watches.length > 0) {
    void bindWatchesToStartedTurn(agentManager, delivery.agentId, watches, logger);
  }
}

async function bindWatchesToStartedTurn(
  agentManager: AgentManager,
  agentId: string,
  watches: readonly FinishNotificationRegistration[],
  logger: Logger,
): Promise<void> {
  try {
    await waitForAgentRunStartWithTimeout(agentManager, agentId);
  } catch (error) {
    logger.debug({ err: error, agentId }, "Run start wait expired before binding mailbox watches");
  }
  const turnId = agentManager.getAgent(agentId)?.activeForegroundTurnId ?? null;
  for (const watch of watches) {
    watch.bindTurn(turnId);
  }
}

type FinishNotificationReason =
  | "finished"
  | "errored"
  | "was interrupted"
  | "needs permission"
  | "was closed";

function finishNotificationEvent(
  reason: FinishNotificationReason,
): Extract<AgentPromptSource, { kind: "agent-notification" }>["event"] | undefined {
  switch (reason) {
    case "finished":
      return "finished";
    case "errored":
      return "errored";
    case "needs permission":
      return "permission-required";
    case "was closed":
      return "closed";
    case "was interrupted":
      return undefined;
  }
}

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

// A caller waits on a child through one armed notification. Arming again, such as a
// follow-up prompt while the child still runs, replaces the earlier one so the child's
// next finish reaches the caller once.
const armedFinishNotifications = new WeakMap<AgentManager, Map<string, () => void>>();

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
  const mailbox = getAgentMailbox(agentManager);
  // The watch is written into the caller's mailbox so a restart that kills the
  // child mid-turn still tells the caller, instead of leaving it waiting.
  const watchId = `watch_${randomUUID()}`;
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

  const armedByManager = armedFinishNotifications.get(agentManager) ?? new Map();
  armedFinishNotifications.set(agentManager, armedByManager);
  const armedKey = JSON.stringify([childAgentId, callerAgentId]);
  armedByManager.get(armedKey)?.();
  armedByManager.set(armedKey, release);

  function detach(): void {
    const subscribed = unsubscribe;
    unsubscribe = null;
    subscribed?.();
    if (armedByManager.get(armedKey) === release) {
      armedByManager.delete(armedKey);
    }
  }

  function forgetPersistedWatch(): void {
    void mailbox.removeWatch(callerAgentId, watchId).catch((error: unknown) => {
      logger.error({ err: error, childAgentId, callerAgentId }, "Failed to remove finish watch");
    });
  }

  function release(): void {
    detach();
    forgetPersistedWatch();
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
      // Terminal: this watch is done. The persisted watch stays until the
      // notice replaces it in one write, so a crash in between still reports.
      fired = true;
      detach();
    }
    const terminal = reason !== "needs permission";

    const callerRecord = await agentStorage.get(callerAgentId);
    if (callerRecord?.archivedAt) {
      if (terminal) forgetPersistedWatch();
      return;
    }

    const record = await agentStorage.get(childAgentId);
    if (requireParentOwnership && getParentAgentIdFromLabels(record?.labels) !== callerAgentId) {
      if (terminal) forgetPersistedWatch();
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

    const messageEvent = finishNotificationEvent(reason);
    const notification = messageEvent
      ? formatAgentMessage({
          id: watchId,
          source: {
            kind: "agent-notification",
            agentId: childAgentId,
            title,
            event: messageEvent,
          },
          text: body,
        })
      : body;

    await mailbox.enqueue(
      callerAgentId,
      {
        source: {
          kind: "notification",
          childAgentId,
          ...(permissionRequest ? { requestId: permissionRequest.id } : {}),
        },
        text: notification,
      },
      terminal ? { resolvesWatchId: watchId } : undefined,
    );
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
      if (event.type === "timeline_replacement") {
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
    detach();
    cancelled = true;
    return { cancel: detach, bindTurn: () => undefined, willNotifyCaller: () => false };
  }
  void mailbox
    .armWatch(callerAgentId, {
      id: watchId,
      childAgentId,
      turnId: expectedTurnId ?? null,
      armedAt: new Date().toISOString(),
    })
    .catch((error: unknown) => {
      logger.error({ err: error, childAgentId, callerAgentId }, "Failed to persist finish watch");
    });
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
