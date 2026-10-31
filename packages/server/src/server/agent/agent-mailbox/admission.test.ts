import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentManager } from "../agent-manager.js";
import { parseAgentMessage } from "../agent-messages/index.js";
import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";
import { createMailboxAdmission } from "./admission.js";
import type { MailboxPolicy } from "./policy.js";
import { AgentMailbox } from "./service.js";
import { MemoryMailboxStore } from "./store.js";

const mailboxes: AgentMailbox[] = [];

afterEach(async () => {
  for (const mailbox of mailboxes.splice(0)) {
    mailbox.stop();
    await vi.waitFor(() => expect(mailbox.isBusy()).toBe(false));
    await mailbox.flush();
  }
});

function setup(
  options: {
    policy?: MailboxPolicy;
    record?: Partial<StoredAgentRecord> | null;
    running?: boolean;
    withMailbox?: boolean;
  } = {},
) {
  let running = options.running ?? true;
  const store = new MemoryMailboxStore();
  const delivered: string[] = [];
  const mailbox = new AgentMailbox({
    store,
    agentManager: {
      hasInFlightRun: () => running,
      subscribe: () => () => undefined,
    } as unknown as Pick<AgentManager, "hasInFlightRun" | "subscribe">,
    agentStorage: { get: async () => ({ id: "lead" }) } as unknown as Pick<AgentStorage, "get">,
    resolvePolicy: async () => options.policy ?? { enabled: true, resumeOnStartup: false },
    deliver: async (delivery) => {
      delivered.push(...delivery.entries.map((entry) => entry.prompt.text));
      return "turn_started";
    },
    logger: createTestLogger(),
    delay: async () => undefined,
  });
  mailboxes.push(mailbox);
  const record = options.record === undefined ? { id: "lead", labels: {} } : options.record;
  const admission = createMailboxAdmission({
    agentManager: {
      getMailbox: () => (options.withMailbox === false ? null : mailbox),
    } as unknown as Pick<AgentManager, "getMailbox">,
    agentStorage: { get: async () => record } as unknown as Pick<AgentStorage, "get">,
    serverId: "self",
  });
  return {
    admission,
    mailbox,
    store,
    delivered,
    setRunning: (value: boolean) => {
      running = value;
    },
  };
}

const fromPeer = {
  recipientId: "lead",
  messageId: "message-1",
  prompt: "please review",
  source: { kind: "agent-message" as const, agentId: "peer", title: "Peer" },
};

describe("mailbox admission", () => {
  test.each([
    ["the recipient has no mailbox", { policy: { enabled: false, resumeOnStartup: false } }],
    ["the recipient is archived", { record: { id: "lead", archivedAt: "2026-10-12T00:00:00Z" } }],
    ["the recipient has no record", { record: null }],
    ["the daemon has no mailbox", { withMailbox: false }],
  ])("leaves delivery to upstream when %s", async (_label, options) => {
    const { admission, store } = setup(options);

    expect(await admission.enqueue(fromPeer)).toBeNull();
    expect(await store.listAgentIds()).toEqual([]);
  });

  test("saves an agent's message and answers only afterwards with a durable receipt", async () => {
    const { admission, store } = setup();

    const receipt = await admission.enqueue({
      ...fromPeer,
      source: { ...fromPeer.source, serverId: "other-host" },
      sessionMode: "plan",
    });

    expect(receipt).toMatchObject({ status: "queued", messageId: "message-1", durable: true });
    const [entry] = (await store.load("lead"))!.entries;
    expect(entry).toMatchObject({
      state: "queued",
      source: { kind: "agent", senderAgentId: "peer", serverId: "other-host", title: "Peer" },
      prompt: { text: "please review" },
      sessionMode: "plan",
    });
  });

  test("keeps a finish notice's envelope so the recipient sees who and what", async () => {
    const { admission, store } = setup();

    await admission.enqueue({
      recipientId: "lead",
      messageId: "notice-1",
      prompt: 'Agent child needs permission.\n\n"requestId": "req-7"',
      source: { kind: "agent-notification", agentId: "child", event: "permission-required" },
    });

    const [entry] = (await store.load("lead"))!.entries;
    expect(entry?.source).toEqual({
      kind: "notification",
      childAgentId: "child",
      requestId: "req-7",
    });
    expect(parseAgentMessage(entry!.prompt.text)).toMatchObject({
      id: "notice-1",
      source: { kind: "agent-notification", agentId: "child", event: "permission-required" },
    });
  });

  test("refuses what a text mailbox cannot hold instead of steering it in", async () => {
    const { admission, store } = setup();

    await expect(
      admission.enqueue({
        ...fromPeer,
        prompt: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      }),
    ).rejects.toThrow("accepts only text prompts");
    expect(await store.listAgentIds()).toEqual([]);
  });

  test("returns no receipt when the item cannot be saved", async () => {
    const { admission, store, mailbox } = setup();
    vi.spyOn(store, "save").mockRejectedValue(new Error("disk full"));

    await expect(admission.enqueue(fromPeer)).rejects.toThrow("disk full");

    expect(mailbox.hasUndispatched("lead")).toBe(false);
    expect(admission.hasPending("lead")).toBe(false);
  });

  test("a message from the recipient's parent lifts a person's stop; others do not", async () => {
    const parent = { id: "lead", labels: { "paseo.parent-agent-id": "boss" } };
    const lifted = setup({ record: parent });
    await lifted.mailbox.pause("lead");
    await lifted.admission.enqueue({
      ...fromPeer,
      source: { kind: "agent-message", agentId: "boss" },
    });
    expect(await lifted.mailbox.isPaused("lead")).toBe(false);

    const stranger = setup({ record: parent });
    await stranger.mailbox.pause("lead");
    await stranger.admission.enqueue(fromPeer);
    expect(await stranger.mailbox.isPaused("lead")).toBe(true);

    const impostor = setup({ record: parent });
    await impostor.mailbox.pause("lead");
    await impostor.admission.enqueue({
      ...fromPeer,
      source: { kind: "agent-message", agentId: "boss", serverId: "other-host" },
    });
    expect(await impostor.mailbox.isPaused("lead")).toBe(true);
  });

  test("its dispatch promise and the message callback settle when the mailbox hands the mail over", async () => {
    const { admission, setRunning, delivered } = setup();
    const onDispatch = vi.fn();

    const receipt = await admission.enqueue({ ...fromPeer, onDispatch });
    expect(admission.hasPending("lead")).toBe(true);
    expect(onDispatch).not.toHaveBeenCalled();

    setRunning(false);
    await expect(receipt!.dispatched).resolves.toBe("turn_started");
    expect(onDispatch).toHaveBeenCalledWith("turn_started");
    expect(delivered).toEqual(["please review"]);
    await vi.waitFor(() => expect(admission.hasPending("lead")).toBe(false));
  });

  test("waits for mail that was still queued, and gives up when told to", async () => {
    const { admission, setRunning } = setup();
    await admission.enqueue(fromPeer);

    const stop = new AbortController();
    const abandoned = admission.waitForDispatch("lead", stop.signal);
    stop.abort();
    await expect(abandoned).rejects.toThrow("Wait aborted");

    const wait = admission.waitForDispatch("lead", new AbortController().signal);
    setRunning(false);
    await wait;
  });
});
