import { expect, test } from "vitest";
import { createAgentMessageDelivery, parseAgentMessages } from "./index.js";
import type { AgentPromptInput } from "../agent-sdk-types.js";

test("durable admission must finish before a queued receipt is returned", async () => {
  let save!: () => void;
  const saving = new Promise<void>((resolve) => {
    save = resolve;
  });
  let acknowledged = false;
  let dispatched = false;
  const delivery = createAgentMessageDelivery({
    admission: {
      enqueue: async (message) => {
        await saving;
        return {
          status: "queued",
          messageId: message.messageId,
          durable: true,
          dispatched: new Promise<"turn_started">(() => {}),
        };
      },
      hasPending: () => true,
      waitForDispatch: async () => {},
    },
    dispatch: async () => {
      dispatched = true;
      return "steered";
    },
    onError: (error) => {
      throw error;
    },
  });
  const receipt = Promise.resolve(
    delivery.enqueue({
      recipientId: "parent",
      messageId: "saved",
      source: { kind: "agent-message", agentId: "child" },
      prompt: "result",
    }),
  ).then((value) => {
    acknowledged = true;
    return value;
  });
  await Promise.resolve();
  expect(acknowledged).toBe(false);
  save();
  await expect(receipt).resolves.toMatchObject({
    status: "queued",
    messageId: "saved",
    durable: true,
  });
  await delivery.close();
  expect(dispatched).toBe(false);
});

test("completion wait includes a durable admission still writing when the wait starts", async () => {
  const saving = Promise.withResolvers<void>();
  const dispatch = Promise.withResolvers<void>();
  const checked = Promise.withResolvers<void>();
  let persisted = false;
  let observedPersisted = false;
  const delivery = createAgentMessageDelivery({
    admission: {
      enqueue: async (message) => {
        await saving.promise;
        persisted = true;
        return {
          status: "queued",
          messageId: message.messageId,
          durable: true,
          dispatched: dispatch.promise.then(() => "turn_started" as const),
        };
      },
      hasPending: () => persisted,
      waitForDispatch: async () => {
        observedPersisted = persisted;
        checked.resolve();
        if (persisted) await dispatch.promise;
      },
    },
    dispatch: async () => {
      throw new Error("Unexpected in-memory dispatch");
    },
    onError: (error) => {
      throw error;
    },
  });
  const receipt = delivery.enqueue({
    recipientId: "parent",
    prompt: "work",
    source: { kind: "agent-message", agentId: "child" },
  });
  const waiting = delivery.waitForDispatch("parent", new AbortController().signal);
  try {
    saving.resolve();
    await receipt;
    await checked.promise;
    expect(observedPersisted).toBe(true);
  } finally {
    dispatch.resolve();
    await waiting;
    await delivery.close();
  }
});

function createClock() {
  let now = 0;
  const jobs = new Map<() => void, number>();
  return {
    schedule(delayMs: number, callback: () => void) {
      jobs.set(callback, now + delayMs);
      return () => {
        jobs.delete(callback);
      };
    },
    advance(ms: number) {
      now += ms;
      for (const [callback, deadline] of jobs) {
        if (deadline > now) continue;
        jobs.delete(callback);
        callback();
      }
    },
  };
}

test("a failed durable admission returns no receipt, stays out of the memory queue, and is no wait's error", async () => {
  const dispatched: string[] = [];
  const delivery = createAgentMessageDelivery({
    admission: {
      enqueue: async () => {
        throw new Error("disk full");
      },
      hasPending: () => false,
      waitForDispatch: async () => {},
    },
    dispatch: async (request) => {
      dispatched.push(...request.messageIds);
      return "steered";
    },
    onError: (error) => {
      throw error;
    },
  });

  const failing = delivery.enqueue({
    recipientId: "parent",
    messageId: "lost",
    source: { kind: "agent-message", agentId: "child" },
    prompt: "result",
  });
  const waiting = delivery.waitForDispatch("parent", new AbortController().signal);

  await expect(failing).rejects.toThrow("disk full");
  await expect(waiting).resolves.toBeUndefined();
  expect(delivery.hasPending("parent")).toBe(false);
  await delivery.close();
  expect(dispatched).toEqual([]);
});

test("a recipient without a mailbox keeps the two-second in-memory batch", async () => {
  const clock = createClock();
  const sent: string[] = [];
  const delivery = createAgentMessageDelivery({
    admission: {
      enqueue: async () => null,
      hasPending: () => false,
      waitForDispatch: async () => {},
    },
    schedule: clock.schedule,
    dispatch: async (request) => {
      sent.push(...request.messageIds);
      return "steered";
    },
    onError: (error) => {
      throw error;
    },
  });

  const receipt = await delivery.enqueue({
    recipientId: "parent",
    messageId: "report",
    source: { kind: "agent-message", agentId: "child" },
    prompt: "result",
  });

  expect(receipt.durable).toBeUndefined();
  expect(sent).toEqual([]);
  clock.advance(2000);
  await expect(receipt.dispatched).resolves.toBe("steered");
  expect(sent).toEqual(["report"]);
});

test("a queued child report and completion reach the recipient in one steer after two quiet seconds", async () => {
  const clock = createClock();
  const sent: Array<{ recipientId: string; prompt: AgentPromptInput }> = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    dispatch: async (batch) => {
      sent.push(batch);
      return "steered";
    },
    onError: (error) => {
      throw error;
    },
  });
  const receipt = await delivery.enqueue({
    recipientId: "parent",
    messageId: "report",
    prompt: "Results <ready>",
    source: { kind: "agent-message", agentId: "worker" },
  });
  expect(receipt).toMatchObject({ status: "queued", messageId: "report" });
  expect(sent).toEqual([]);
  clock.advance(1000);
  await delivery.enqueue({
    recipientId: "parent",
    messageId: "finish",
    prompt: "Worker finished",
    source: { kind: "agent-notification", agentId: "worker", event: "finished" },
  });
  clock.advance(1999);
  expect(sent).toEqual([]);
  clock.advance(1);
  await delivery.close();
  expect(
    sent.map((batch) => ({
      recipientId: batch.recipientId,
      messages: parseAgentMessages(String(batch.prompt)),
    })),
  ).toEqual([
    {
      recipientId: "parent",
      messages: [
        {
          id: "report",
          source: { kind: "agent-message", agentId: "worker" },
          text: "Results <ready>",
        },
        {
          id: "finish",
          source: { kind: "agent-notification", agentId: "worker", event: "finished" },
          text: "Worker finished",
        },
      ],
    },
  ]);
});

test("recipient timers are independent, later messages form another batch, and close flushes pending work", async () => {
  const clock = createClock();
  const sent: string[] = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    dispatch: async (request) => {
      sent.push(`${request.recipientId}:${request.messageIds.join(",")}`);
      return "steered";
    },
    onError: (error) => {
      throw error;
    },
  });
  const source = { kind: "agent-message" as const, agentId: "worker" };
  const a = await delivery.enqueue({ recipientId: "a", messageId: "first", source, prompt: "one" });
  clock.advance(1000);
  const b = await delivery.enqueue({
    recipientId: "b",
    messageId: "independent",
    source,
    prompt: "two",
  });
  clock.advance(1000);
  await a.dispatched;
  expect(sent).toEqual(["a:first"]);
  await delivery.enqueue({ recipientId: "a", messageId: "later", source, prompt: "three" });
  clock.advance(1000);
  await b.dispatched;
  expect(sent).toEqual(["a:first", "b:independent"]);
  await delivery.close();
  expect(sent).toEqual(["a:first", "b:independent", "a:later"]);
  await expect(delivery.enqueue({ recipientId: "a", source, prompt: "closed" })).rejects.toThrow(
    "closed",
  );
});

test("explicit interrupt and conflicting session modes retain ordered dispatch boundaries", async () => {
  const sent: Array<{
    activeTurnBehavior: string;
    sessionMode?: string;
    messageIds: readonly string[];
  }> = [];
  const delivery = createAgentMessageDelivery({
    dispatch: async (request) => {
      sent.push(request);
      request.onDispatch("steered");
      return "steered";
    },
    onError: (error) => {
      throw error;
    },
  });
  const source = { kind: "agent-message" as const, agentId: "worker" };
  await delivery.enqueue({
    recipientId: "parent",
    source,
    prompt: "interrupt",
    messageId: "interrupt",
    activeTurnBehavior: "interrupt",
  });
  await delivery.enqueue({
    recipientId: "parent",
    source,
    prompt: "review",
    messageId: "review",
    sessionMode: "plan",
  });
  await delivery.enqueue({
    recipientId: "parent",
    source,
    prompt: "execute",
    messageId: "execute",
    sessionMode: "full-access",
  });
  await delivery.enqueue({
    recipientId: "parent",
    source: { kind: "agent-notification", agentId: "worker", event: "finished" },
    prompt: "done",
    messageId: "finished",
  });
  await delivery.close();
  expect(
    sent.map(({ activeTurnBehavior, sessionMode, messageIds }) => ({
      activeTurnBehavior,
      sessionMode,
      messageIds,
    })),
  ).toEqual([
    { activeTurnBehavior: "interrupt", sessionMode: undefined, messageIds: ["interrupt"] },
    { activeTurnBehavior: "steer", sessionMode: "plan", messageIds: ["review"] },
    {
      activeTurnBehavior: "steer",
      sessionMode: "full-access",
      messageIds: ["execute", "finished"],
    },
  ]);
});

test("dispatch failures reject waits before and after flush and do not poison later messages", async () => {
  const clock = createClock();
  const failed = new Error("provider rejected");
  const errors: unknown[] = [];
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    dispatch: async (request) => {
      if (request.messageIds.includes("bad")) throw failed;
      return "steered";
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  const message = {
    recipientId: "parent",
    source: { kind: "agent-message" as const, agentId: "worker" },
    prompt: "report",
  };
  const bad = await delivery.enqueue({ ...message, messageId: "bad" });
  const before = expect(
    delivery.waitForDispatch("parent", new AbortController().signal),
  ).rejects.toBe(failed);
  clock.advance(2000);
  const after = expect(
    delivery.waitForDispatch("parent", new AbortController().signal),
  ).rejects.toBe(failed);
  await Promise.all([before, after, expect(bad.dispatched).rejects.toBe(failed)]);
  const next = await delivery.enqueue({ ...message, messageId: "next" });
  await delivery.close();
  await expect(next.dispatched).resolves.toBe("steered");
  expect(errors).toEqual([failed]);
});

test("canceling a completion wait leaves queued delivery intact", async () => {
  const clock = createClock();
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    dispatch: async () => "steered",
    onError: (error) => {
      throw error;
    },
  });
  const receipt = await delivery.enqueue({
    recipientId: "parent",
    source: { kind: "agent-message", agentId: "worker" },
    prompt: "report",
  });
  const controller = new AbortController();
  const wait = delivery.waitForDispatch("parent", controller.signal);
  controller.abort();
  await expect(wait).rejects.toMatchObject({ name: "AbortError" });
  await delivery.close();
  await expect(receipt.dispatched).resolves.toBe("steered");
});

test("batches retain each sender's attachment context and image order", async () => {
  let prompt: AgentPromptInput = "";
  const delivery = createAgentMessageDelivery({
    dispatch: async (request) => {
      prompt = request.prompt;
      return "steered";
    },
    onError: (error) => {
      throw error;
    },
  });
  const firstImage = { type: "image" as const, data: "Zmlyc3Q=", mimeType: "image/png" };
  const secondImage = { type: "image" as const, data: "c2Vjb25k", mimeType: "image/png" };
  await delivery.enqueue({
    recipientId: "parent",
    messageId: "first",
    source: { kind: "agent-message", agentId: "one" },
    prompt: [{ type: "text", text: "First" }, firstImage],
  });
  await delivery.enqueue({
    recipientId: "parent",
    messageId: "second",
    source: { kind: "agent-message", agentId: "two" },
    prompt: [
      { type: "text", text: "Second" },
      {
        type: "github_issue",
        mimeType: "application/github-issue",
        number: 42,
        title: "Context",
        url: "https://example.com/42",
        body: "Attached",
      },
      secondImage,
    ],
  });
  await delivery.close();
  expect(prompt).toEqual([
    {
      type: "text",
      text: '<paseo-system version="1" kind="agent-message" source-agent-id="one" message-id="first">\nFirst\n</paseo-system>',
    },
    firstImage,
    {
      type: "text",
      text: '<paseo-system version="1" kind="agent-message" source-agent-id="two" message-id="second">\nSecond\n\nGitHub Issue #42: Context\nhttps://example.com/42\n\nAttached\n</paseo-system>',
    },
    secondImage,
  ]);
  expect(
    parseAgentMessages(
      (prompt as Exclude<AgentPromptInput, string>)
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n"),
    )?.map((message) => message.source?.agentId),
  ).toEqual(["one", "two"]);
});

test("runtime safety sees queued messages until provider dispatch settles", async () => {
  const clock = createClock();
  let release!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivery = createAgentMessageDelivery({
    schedule: clock.schedule,
    dispatch: async () => {
      await dispatched;
      return "steered";
    },
    onError: (error) => {
      throw error;
    },
  });
  expect(delivery.hasPending("parent")).toBe(false);
  await delivery.enqueue({
    recipientId: "parent",
    prompt: "finished",
    source: { kind: "agent-message", agentId: "child" },
  });
  expect(delivery.hasPending("parent")).toBe(true);
  clock.advance(2000);
  expect(delivery.hasPending("parent")).toBe(true);
  release();
  await delivery.close();
  expect(delivery.hasPending("parent")).toBe(false);
});
