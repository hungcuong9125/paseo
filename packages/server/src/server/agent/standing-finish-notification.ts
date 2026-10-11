import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

import { formatAgentMessage } from "./agent-messages/index.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { getAgentStreamEventTurnId } from "./agent-sdk-types.js";
import {
  finishNotificationEvent,
  formatFinishNotificationBody,
  getAgentMailbox,
  isTurnTerminalStreamEvent,
  terminalTurnReason,
  type FinishNotificationReason,
} from "./agent-prompt.js";
import { callerTurnClaims, UNIDENTIFIED_TURN } from "./finish-notification-claims.js";

export interface SetupStandingFinishNotificationParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  childAgentId: string;
  callerAgentId: string;
  logger: Logger;
  /** Re-arming after a restart reuses the id already on disk. */
  watchId?: string;
}

export interface StandingFinishNotification {
  cancel(): void;
}

// One standing watch per (child, caller); arming again replaces the earlier one.
const armedStanding = new WeakMap<AgentManager, Map<string, () => void>>();

/**
 * Tells the caller about every turn of the child that the caller did not
 * prompt itself — a child woken by its own children, by a schedule, or by a
 * person — until the child is closed or either side is archived. A turn the
 * caller prompted is reported by that prompt's own watch, never twice.
 */
export function setupStandingFinishNotification(
  params: SetupStandingFinishNotificationParams,
): StandingFinishNotification {
  const { agentManager, agentStorage, childAgentId, callerAgentId, logger } = params;
  const mailbox = getAgentMailbox(agentManager);
  const watchId = params.watchId ?? `watch_${randomUUID()}`;
  const claims = callerTurnClaims(agentManager, childAgentId, callerAgentId);
  const deferred = new Map<string, FinishNotificationReason>();
  let ended = false;
  let reports = Promise.resolve();

  const byManager = armedStanding.get(agentManager) ?? new Map<string, () => void>();
  armedStanding.set(agentManager, byManager);
  const key = JSON.stringify([childAgentId, callerAgentId]);
  byManager.get(key)?.();
  byManager.set(key, cancel);

  function detach(): void {
    ended = true;
    unsubscribe();
    stopListening();
    deferred.clear();
    if (byManager.get(key) === cancel) byManager.delete(key);
  }

  function cancel(): void {
    if (ended) return;
    detach();
    void mailbox.removeWatch(callerAgentId, watchId).catch((error: unknown) => {
      logger.error({ err: error, childAgentId, callerAgentId }, "Failed to remove standing watch");
    });
  }

  async function report(reason: FinishNotificationReason, final: boolean): Promise<void> {
    const [caller, child] = await Promise.all([
      agentStorage.get(callerAgentId),
      agentStorage.get(childAgentId),
    ]);
    const orphaned =
      !caller || caller.archivedAt || getParentAgentIdFromLabels(child?.labels) !== callerAgentId;
    if (orphaned) {
      cancel();
      return;
    }
    const title = child?.title ?? childAgentId;
    const body = formatFinishNotificationBody({
      childAgentId,
      title,
      reason,
      lastAssistantMessage: await agentManager.getLastAssistantMessage(childAgentId),
    });
    const event = finishNotificationEvent(reason);
    const text = event
      ? formatAgentMessage({
          id: `${watchId}:${randomUUID()}`,
          source: { kind: "agent-notification", agentId: childAgentId, title, event },
          text: body,
        })
      : body;
    await mailbox.enqueue(
      callerAgentId,
      { source: { kind: "notification", childAgentId, standing: true }, text },
      final ? { resolvesWatchId: watchId } : undefined,
    );
  }

  function queueReport(reason: FinishNotificationReason, final = false): void {
    reports = reports
      .then(() => report(reason, final))
      .catch((error: unknown) => {
        logger.error({ err: error, childAgentId, callerAgentId }, "Failed to report child turn");
      });
  }

  function settle(turnKey: string, reason: FinishNotificationReason): void {
    const ownership = claims.ownership(turnKey);
    if (ownership === "claimed") {
      deferred.delete(turnKey);
    } else if (ownership === "pending") {
      deferred.set(turnKey, reason);
    } else {
      deferred.delete(turnKey);
      queueReport(reason);
    }
  }

  const stopListening = claims.onChange(() => {
    for (const [turnKey, reason] of deferred) settle(turnKey, reason);
  });

  const unsubscribe = agentManager.subscribe(
    (event) => {
      if (ended) return;
      if (event.type === "agent_state" && event.agent.lifecycle === "closed") {
        detach();
        queueReport("was closed", true);
        return;
      }
      if (event.type === "agent_stream" && isTurnTerminalStreamEvent(event.event)) {
        const turnKey = getAgentStreamEventTurnId(event.event) ?? UNIDENTIFIED_TURN;
        settle(turnKey, terminalTurnReason(event.event.type));
      }
    },
    { agentId: childAgentId, replayState: false },
  );

  if (!params.watchId) {
    void mailbox
      .armWatch(callerAgentId, {
        id: watchId,
        childAgentId,
        turnId: null,
        armedAt: new Date().toISOString(),
        mode: "standing",
      })
      .catch((error: unknown) => {
        logger.error(
          { err: error, childAgentId, callerAgentId },
          "Failed to persist standing watch",
        );
      });
  }

  return { cancel };
}

/** Re-arm the standing watches the mailbox found on disk at startup. */
export function rearmStandingFinishNotifications(params: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}): number {
  const recovered = getAgentMailbox(params.agentManager).takeRecoveredStandingWatches();
  for (const { callerAgentId, watch } of recovered) {
    setupStandingFinishNotification({
      ...params,
      childAgentId: watch.childAgentId,
      callerAgentId,
      watchId: watch.id,
    });
  }
  return recovered.length;
}
