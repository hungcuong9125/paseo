import { getMailboxLabelSetting } from "@getpaseo/protocol/agent-labels";
import type { MailboxSettings } from "@getpaseo/protocol/provider-config";

export interface MailboxPolicy {
  /** Prompts from anyone without interrupt authority wait in the mailbox. */
  enabled: boolean;
  /** Drain leftover mail when the daemon starts, which can start turns by itself. */
  resumeOnStartup: boolean;
}

export const DISABLED_MAILBOX_POLICY: MailboxPolicy = { enabled: false, resumeOnStartup: false };

export interface MailboxPolicyInput {
  labels: Record<string, unknown> | null | undefined;
  providerSettings: MailboxSettings | undefined;
  globalSettings: MailboxSettings | undefined;
}

/** Label beats provider entry beats global; everything defaults off. */
export function resolveMailboxPolicy(input: MailboxPolicyInput): MailboxPolicy {
  return {
    enabled:
      getMailboxLabelSetting(input.labels) ??
      input.providerSettings?.enabled ??
      input.globalSettings?.enabled ??
      false,
    resumeOnStartup:
      input.providerSettings?.resumeOnStartup ?? input.globalSettings?.resumeOnStartup ?? false,
  };
}
