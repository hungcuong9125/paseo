import { mkdtemp, readdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createEmptyMailboxFile, FileMailboxStore, type MailboxFile } from "./store.js";

function fileWithOneEntry(agentId: string, text: string): MailboxFile {
  const file = createEmptyMailboxFile(agentId);
  file.entries.push({
    id: `mbx_${text}`,
    seq: file.nextSeq,
    state: "queued",
    attempts: 0,
    source: { kind: "agent", senderAgentId: "peer" },
    prompt: { text },
    enqueuedAt: "2026-10-07T00:00:00.000Z",
  });
  file.nextSeq += 1;
  return file;
}

describe("FileMailboxStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = path.join(await mkdtemp(path.join(tmpdir(), "mailbox-store-")), "mailbox");
  });

  afterEach(async () => {
    await rm(path.dirname(directory), { recursive: true, force: true });
  });

  test("a saved mailbox is readable by a store opened later, and only by its owner", async () => {
    await new FileMailboxStore(directory, createTestLogger()).save(
      fileWithOneEntry("agent-1", "first"),
    );

    const reopened = new FileMailboxStore(directory, createTestLogger());
    expect(await reopened.listAgentIds()).toEqual(["agent-1"]);
    expect((await reopened.load("agent-1"))?.entries[0]?.prompt.text).toBe("first");

    const mode = (await stat(path.join(directory, "agent-1.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("an empty mailbox leaves no file behind", async () => {
    const store = new FileMailboxStore(directory, createTestLogger());
    await store.save(fileWithOneEntry("agent-1", "first"));
    await store.save(fileWithOneEntry("agent-1", "second"));

    await store.save(createEmptyMailboxFile("agent-1"));

    expect(await store.load("agent-1")).toBeNull();
    expect(await readdir(directory)).toEqual([]);
  });

  test("invalid current data fails closed and stays available for inspection", async () => {
    const store = new FileMailboxStore(directory, createTestLogger());
    await store.save(fileWithOneEntry("agent-1", "first"));
    const file = createEmptyMailboxFile("agent-1");
    const invalid = { ...file, nextSeq: -1 };
    const encoded = JSON.stringify(invalid);
    await writeFile(path.join(directory, "agent-1.json"), encoded);
    await expect(store.load("agent-1")).rejects.toThrow();
    expect(await readFile(path.join(directory, "agent-1.json"), "utf8")).toBe(encoded);
  });

  test("atomic replacement exposes only the current mailbox", async () => {
    const store = new FileMailboxStore(directory, createTestLogger());
    await store.save(fileWithOneEntry("agent-1", "first"));
    await store.save(fileWithOneEntry("agent-1", "second"));
    expect(await store.load("agent-1")).toEqual(fileWithOneEntry("agent-1", "second"));
    expect(await readdir(directory)).toEqual(["agent-1.json"]);
  });

  test("remove deletes the mailbox", async () => {
    const store = new FileMailboxStore(directory, createTestLogger());
    await store.save(fileWithOneEntry("agent-1", "first"));
    await store.save(fileWithOneEntry("agent-1", "second"));

    await store.remove("agent-1");

    expect(await store.listAgentIds()).toEqual([]);
    expect(await store.load("agent-1")).toBeNull();
  });

  test("removing an absent mailbox succeeds before the directory has been created", async () => {
    const store = new FileMailboxStore(directory, createTestLogger());
    await expect(store.remove("never-created")).resolves.toBeUndefined();
    expect(await store.listAgentIds()).toEqual([]);
  });
});
