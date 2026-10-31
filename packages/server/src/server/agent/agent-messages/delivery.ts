import type { PromptDispatchDisposition } from "../agent-prompt.js";
import { randomUUID } from "node:crypto";
import type { AgentPromptInput, AgentPromptContentBlock } from "../agent-sdk-types.js";
import { prepareAgentMessage, type AgentPromptSource } from "./envelope.js";

export interface Message {
  recipientId: string;
  messageId?: string;
  source: AgentPromptSource;
  prompt: AgentPromptInput;
  sessionMode?: string;
  unarchive?: boolean;
  clearPendingPermissions?: boolean;
  activeTurnBehavior?: "steer" | "interrupt";
  beforeDispatch?: () => void;
  onDispatch?: (disposition: PromptDispatchDisposition) => void;
}
export interface Receipt {
  /** The recipient's mailbox has accepted responsibility for replay after restart. */
  durable?: boolean;
  status: "queued";
  messageId: string;
  dispatched: Promise<PromptDispatchDisposition>;
}
interface Admitted extends Message {
  receipt: Receipt;
  resolve(disposition: PromptDispatchDisposition): void;
  reject(error: unknown): void;
}
interface DispatchRequest {
  recipientId: string;
  messageIds: readonly string[];
  prompt: AgentPromptInput;
  activeTurnBehavior: "steer" | "interrupt";
  sessionMode?: string;
  clearPendingPermissions: boolean;
  unarchive: boolean;
  onDispatch(disposition: PromptDispatchDisposition): void;
}
export interface DurableAdmission {
  enqueue(message: Message & { messageId: string }): Promise<Receipt | null>;
  hasPending(recipientId: string): boolean;
  waitForDispatch(recipientId: string, signal: AbortSignal): Promise<void>;
}
interface Dependencies {
  admission?: DurableAdmission;
  dispatch(request: DispatchRequest): Promise<PromptDispatchDisposition>;
  onError(error: unknown, request: DispatchRequest): void;
  /** Return a cancellation function. Production uses the daemon's event loop. */
  schedule?: (delayMs: number, callback: () => void) => () => void;
}
export interface AgentMessageDelivery {
  enqueue(message: Message): Promise<Receipt>;
  /** Queued messages and provider dispatches still owned by this recipient. */
  hasPending(recipientId: string): boolean;
  /** Stop admission, flush pending messages, and await provider dispatch acknowledgments. */
  close(): Promise<void>;
  /** Existing completion waits include agent messages admitted before the wait. */
  waitForDispatch(recipientId: string, signal: AbortSignal): Promise<void>;
}

/** Recipient-owned agent delivery. Human prompts never enter this module. */
export function createAgentMessageDelivery(dependencies: Dependencies): AgentMessageDelivery {
  const schedule =
    dependencies.schedule ??
    ((delayMs, callback) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });
  const pending = new Map<string, { messages: Admitted[]; cancel(): void }>();
  const dispatching = new Map<string, Promise<void>>();
  const admissions = new Map<string, Set<Promise<Receipt>>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  function dispatch(recipientId: string, messages: Admitted[]): void {
    const prompts = messages.map(
      (message) =>
        prepareAgentMessage(message.prompt, message.source, message.receipt.messageId).prompt,
    );
    const prompt: AgentPromptInput = prompts.every((entry) => typeof entry === "string")
      ? prompts.join("\n\n")
      : prompts.flatMap((entry): AgentPromptContentBlock[] =>
          typeof entry === "string" ? [{ type: "text", text: entry }] : entry,
        );
    const request: DispatchRequest = {
      recipientId,
      messageIds: messages.map((message) => message.receipt.messageId),
      prompt,
      activeTurnBehavior: messages[0]!.activeTurnBehavior ?? "steer",
      sessionMode: messages.find((message) => message.sessionMode)?.sessionMode,
      clearPendingPermissions: messages.some((message) => message.clearPendingPermissions),
      unarchive: messages.some((message) => message.unarchive !== false),
      onDispatch: (disposition) => {
        for (const message of messages) {
          try {
            message.onDispatch?.(disposition);
          } catch (error) {
            dependencies.onError(error, request);
          }
        }
      },
    };
    const previous = dispatching.get(recipientId) ?? Promise.resolve();
    const dispatched = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          for (const message of messages) message.beforeDispatch?.();
          const disposition = await dependencies.dispatch(request);
          for (const message of messages) message.resolve(disposition);
          return undefined;
        } catch (error) {
          for (const message of messages) message.reject(error);
          dependencies.onError(error, request);
          throw error;
        }
      });
    dispatching.set(recipientId, dispatched);
    void dispatched
      .finally(() => {
        if (dispatching.get(recipientId) === dispatched) dispatching.delete(recipientId);
      })
      .catch(() => undefined);
  }

  function flush(recipientId: string): void {
    const entry = pending.get(recipientId);
    if (!entry) return;
    pending.delete(recipientId);
    entry.cancel();
    let group: Admitted[] = [];
    let mode: string | undefined;
    for (const message of entry.messages) {
      // Explicitly conflicting send options require separate, ordered dispatches.
      if (
        group.length &&
        ((message.activeTurnBehavior ?? "steer") !== (group[0]!.activeTurnBehavior ?? "steer") ||
          (mode && message.sessionMode && mode !== message.sessionMode))
      ) {
        dispatch(recipientId, group);
        group = [];
        mode = undefined;
      }
      group.push(message);
      mode ??= message.sessionMode;
    }
    if (group.length) dispatch(recipientId, group);
  }

  function enqueueInMemory(message: Message): Receipt {
    let resolve!: Admitted["resolve"];
    let reject!: Admitted["reject"];
    const dispatched = new Promise<PromptDispatchDisposition>((accepted, failed) => {
      resolve = accepted;
      reject = failed;
    });
    void dispatched.catch(() => undefined);
    const receipt: Receipt = {
      status: "queued",
      messageId: message.messageId ?? randomUUID(),
      dispatched,
    };
    const entry = pending.get(message.recipientId) ?? { messages: [], cancel: () => {} };
    entry.cancel();
    entry.messages.push({ ...message, receipt, resolve, reject });
    entry.cancel = schedule(2000, () => flush(message.recipientId));
    pending.set(message.recipientId, entry);
    return receipt;
  }

  return {
    hasPending: (recipientId) =>
      admissions.has(recipientId) ||
      pending.has(recipientId) ||
      dispatching.has(recipientId) ||
      Boolean(dependencies.admission?.hasPending(recipientId)),
    enqueue(message) {
      if (closed) return Promise.reject(new Error("Agent message delivery is closed"));
      const accepting = (async () => {
        const normalized = { ...message, messageId: message.messageId ?? randomUUID() };
        const durable = await dependencies.admission?.enqueue(normalized);
        return durable ?? enqueueInMemory(normalized);
      })();
      const group = admissions.get(message.recipientId) ?? new Set<Promise<Receipt>>();
      group.add(accepting);
      admissions.set(message.recipientId, group);
      void accepting
        .finally(() => {
          group.delete(accepting);
          if (!group.size) admissions.delete(message.recipientId);
        })
        .catch(() => undefined);
      return accepting;
    },
    async waitForDispatch(recipientId, signal) {
      signal.throwIfAborted();
      const admitted =
        pending.get(recipientId)?.messages.map((message) => message.receipt.dispatched) ?? [];
      let aborted!: () => void;
      const cancellation = new Promise<never>((_resolve, reject) => {
        aborted = () => reject(new DOMException("Wait aborted", "AbortError"));
        signal.addEventListener("abort", aborted, { once: true });
      });
      try {
        await Promise.race([
          Promise.all([
            dispatching.get(recipientId),
            ...admitted,
            // A failed admission is its sender's error. A durable receipt's dispatch is
            // covered by the admission's own wait, which also sees mail from before a restart.
            ...[...(admissions.get(recipientId) ?? [])].map((receipt) =>
              receipt.then(
                (value) => (value.durable ? undefined : value.dispatched),
                () => undefined,
              ),
            ),
            (async () => {
              // Queue counts become visible only after admission's durable write.
              await Promise.allSettled(admissions.get(recipientId) ?? []);
              signal.throwIfAborted();
              await dependencies.admission?.waitForDispatch(recipientId, signal);
            })(),
          ]),
          cancellation,
        ]);
      } finally {
        signal.removeEventListener("abort", aborted);
      }
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        // Finish durable writes, not mailbox turns: a paused recipient must not block shutdown.
        const writes: Promise<Receipt>[] = [];
        for (const group of admissions.values()) writes.push(...group);
        await Promise.allSettled(writes);
        for (const recipientId of pending.keys()) flush(recipientId);
        await Promise.allSettled(dispatching.values());
      })();
      return closing;
    },
  };
}
