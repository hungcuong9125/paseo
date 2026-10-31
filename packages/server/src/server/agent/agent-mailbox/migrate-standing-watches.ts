import type { Logger } from "pino";
import type { FinishSubscription, FinishSubscriptionStore } from "../finish-subscriptions/index.js";
import type { AgentMailbox } from "./service.js";

/** Complete transfers before observers start; unfinished copies remain dormant on disk. */
export async function migrateStandingWatches(
  mailbox: AgentMailbox,
  store: FinishSubscriptionStore,
  logger: Logger,
): Promise<void> {
  const stored = new Map((await store.list()).map((record) => [record.id, record]));
  const transfers = new Map<string, FinishSubscription>();
  // A crash after source cleanup still leaves enough information to activate the copy.
  for (const record of stored.values()) {
    if (record.legacyWatchId) transfers.set(record.id, record);
  }
  for (const { callerAgentId, watch } of mailbox.takeRecoveredStandingWatches()) {
    const id = JSON.stringify(["legacy-mailbox", callerAgentId, watch.id]);
    transfers.set(id, {
      ...(stored.get(id) ?? {
        id,
        callerAgentId,
        childAgentId: watch.childAgentId,
        requireParentOwnership: true,
        everyTurn: true,
      }),
      legacyWatchId: watch.id,
    });
  }
  for (const record of transfers.values()) {
    try {
      if (!stored.has(record.id)) await store.put(record);
      await mailbox.acknowledgeStandingWatch(record.callerAgentId, record.legacyWatchId!);
      const { legacyWatchId: _source, ...active } = record;
      await store.put(active);
    } catch (error) {
      logger.error(
        { err: error, callerAgentId: record.callerAgentId, childAgentId: record.childAgentId },
        "Failed to migrate a standing watch; durable transfer retained for next startup",
      );
    }
  }
}
