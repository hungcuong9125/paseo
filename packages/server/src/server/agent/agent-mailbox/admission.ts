import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";

import type { AgentManager } from "../agent-manager.js";
import { formatAgentMessage } from "../agent-messages/envelope.js";
import type { DurableAdmission } from "../agent-messages/delivery.js";
import type { PromptDispatchDisposition } from "../agent-prompt.js";
import type { AgentStorage } from "../agent-storage.js";
import type { MailboxSource } from "./store.js";

export interface MailboxAdmissionDependencies {
  agentManager: Partial<Pick<AgentManager, "getMailbox">>;
  agentStorage: Pick<AgentStorage, "get">;
  /** This daemon's id, to tell a parent on this host from one on another. */
  serverId: string;
}

/**
 * Where agent messages and finish notices for a recipient with a mailbox go
 * instead of steering its running turn. The receipt comes back only after the
 * item is on disk. A recipient without a mailbox (or an archived one, which
 * has no turn to protect) gets `null`, and the caller keeps upstream delivery.
 *
 * A mailbox holds text, so `activeTurnBehavior` and `clearPendingPermissions`
 * do not apply: nothing an agent sends may cut into a running turn.
 */
export function createMailboxAdmission(deps: MailboxAdmissionDependencies): DurableAdmission {
  return {
    async enqueue(message) {
      const mailbox = deps.agentManager.getMailbox?.();
      if (!mailbox) return null;
      const record = await deps.agentStorage.get(message.recipientId);
      if (!record || record.archivedAt) return null;
      if (!(await mailbox.resolvePolicy(message.recipientId)).enabled) return null;
      if (typeof message.prompt !== "string") {
        throw new Error(
          `Agent ${message.recipientId} has a mailbox, which accepts only text prompts from other agents`,
        );
      }

      const { source } = message;
      let entrySource: MailboxSource;
      let text: string;
      if (source.kind === "agent-notification") {
        entrySource = {
          kind: "notification",
          childAgentId: source.agentId,
          ...permissionRequestId(source.event, message.prompt),
        };
        text = formatAgentMessage({ id: message.messageId, source, text: message.prompt });
      } else {
        entrySource = {
          kind: "agent",
          senderAgentId: source.agentId,
          ...(source.serverId ? { serverId: source.serverId } : {}),
          ...(source.title ? { title: source.title } : {}),
        };
        text = message.prompt;
        // A parent's message lifts a person's stop, so what waits behind it is delivered.
        const parent = getParentAddressFromLabels(record.labels, deps.serverId);
        if (
          parent?.agentId === source.agentId &&
          parent.serverId === (source.serverId ?? deps.serverId)
        ) {
          await mailbox.resume(message.recipientId);
        }
      }

      let settle!: (disposition: PromptDispatchDisposition) => void;
      const dispatched = new Promise<PromptDispatchDisposition>((resolve) => {
        settle = resolve;
      });
      await mailbox.enqueue(message.recipientId, {
        source: entrySource,
        text,
        ...(message.sessionMode ? { sessionMode: message.sessionMode } : {}),
        onDispatch: (disposition) => {
          settle(disposition);
          message.onDispatch?.(disposition);
        },
      });
      return { status: "queued", messageId: message.messageId, durable: true, dispatched };
    },
    hasPending: (recipientId) =>
      deps.agentManager.getMailbox?.()?.hasUndispatched(recipientId) ?? false,
    waitForDispatch: async (recipientId, signal) => {
      await deps.agentManager.getMailbox?.()?.waitForDispatch(recipientId, signal);
    },
  };
}

/** A permission notice names a request that dies with its provider, so recovery rewrites it. */
function permissionRequestId(event: string, body: string): { requestId?: string } {
  if (event !== "permission-required") return {};
  const requestId = /"requestId":\s*"([^"]+)"/.exec(body)?.[1];
  return requestId ? { requestId } : {};
}
