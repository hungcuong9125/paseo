import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

import { syncDirectory, writeFileDurable } from "../../atomic-file.js";
import { PRIVATE_FILE_MODE } from "../../private-files.js";

const MailboxSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), senderAgentId: z.string().nullable() }),
  z.object({ kind: z.literal("schedule"), scheduleId: z.string() }),
  z.object({
    kind: z.literal("notification"),
    childAgentId: z.string(),
    requestId: z.string().optional(),
  }),
  z.object({ kind: z.literal("restart"), childAgentId: z.string() }),
]);

const MailboxEntrySchema = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  /** "held": its turns kept failing; it waits for a person or the parent to prompt the agent. */
  state: z.enum(["queued", "delivering", "held"]),
  /** Turns that carried this item and did not complete. */
  attempts: z.number().int().nonnegative(),
  source: MailboxSourceSchema,
  prompt: z.object({ text: z.string() }),
  sessionMode: z.string().optional(),
  notifyCallerAgentId: z.string().optional(),
  enqueuedAt: z.string(),
  redelivered: z.boolean().optional(),
});

const MailboxWatchSchema = z.object({
  id: z.string(),
  childAgentId: z.string(),
  turnId: z.string().nullable(),
  armedAt: z.string(),
});

const MailboxFileSchema = z.object({
  version: z.literal(1),
  agentId: z.string(),
  nextSeq: z.number().int().nonnegative(),
  paused: z.boolean(),
  watches: z.array(MailboxWatchSchema),
  entries: z.array(MailboxEntrySchema),
});

export type MailboxSource = z.infer<typeof MailboxSourceSchema>;
export type MailboxEntry = z.infer<typeof MailboxEntrySchema>;
export type MailboxWatch = z.infer<typeof MailboxWatchSchema>;
export type MailboxFile = z.infer<typeof MailboxFileSchema>;

export function createEmptyMailboxFile(agentId: string): MailboxFile {
  return { version: 1, agentId, nextSeq: 0, paused: false, watches: [], entries: [] };
}

function isEmptyMailboxFile(file: MailboxFile): boolean {
  return file.entries.length === 0 && file.watches.length === 0 && !file.paused;
}

export interface MailboxStore {
  load(agentId: string): Promise<MailboxFile | null>;
  /** An empty mailbox is removed instead of written. */
  save(file: MailboxFile): Promise<void>;
  remove(agentId: string): Promise<void>;
  listAgentIds(): Promise<string[]>;
}

const FILE_SUFFIX = ".json";

/** One current file per agent, atomically replaced and fsynced. */
export class FileMailboxStore implements MailboxStore {
  constructor(
    private readonly directory: string,
    private readonly logger: Logger,
  ) {}

  async load(agentId: string): Promise<MailboxFile | null> {
    return await this.readFile(agentId, this.currentPath(agentId));
  }

  async save(file: MailboxFile): Promise<void> {
    if (isEmptyMailboxFile(file)) {
      await this.remove(file.agentId);
      return;
    }
    const currentPath = this.currentPath(file.agentId);
    await writeFileDurable(currentPath, JSON.stringify(file, null, 2), { mode: PRIVATE_FILE_MODE });
  }

  async remove(agentId: string): Promise<void> {
    try {
      await fs.unlink(this.currentPath(agentId));
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    try {
      await syncDirectory(this.directory);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }

  async listAgentIds(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.directory);
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
    const ids = new Set<string>();
    for (const name of names) {
      const encoded = mailboxNameStem(name);
      if (encoded === null) {
        continue;
      }
      try {
        ids.add(decodeURIComponent(encoded));
      } catch {
        // Not a name this store wrote; one stray file must not hide the rest.
        this.logger.warn({ name, directory: this.directory }, "Ignoring unrecognized mailbox file");
      }
    }
    return [...ids].sort();
  }

  private currentPath(agentId: string): string {
    return path.join(this.directory, `${encodeURIComponent(agentId)}${FILE_SUFFIX}`);
  }

  private async readFile(agentId: string, filePath: string): Promise<MailboxFile | null> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
    const parsed = MailboxFileSchema.parse(JSON.parse(raw));
    if (parsed.agentId !== agentId) {
      throw new Error(`Mailbox file belongs to ${parsed.agentId}`);
    }
    return parsed;
  }
}

export class MemoryMailboxStore implements MailboxStore {
  private readonly files = new Map<string, MailboxFile>();

  async load(agentId: string): Promise<MailboxFile | null> {
    const file = this.files.get(agentId);
    return file ? structuredClone(file) : null;
  }

  async save(file: MailboxFile): Promise<void> {
    if (isEmptyMailboxFile(file)) {
      this.files.delete(file.agentId);
      return;
    }
    this.files.set(file.agentId, structuredClone(file));
  }

  async remove(agentId: string): Promise<void> {
    this.files.delete(agentId);
  }

  async listAgentIds(): Promise<string[]> {
    return [...this.files.keys()].sort();
  }
}

function mailboxNameStem(name: string): string | null {
  if (name.startsWith(".")) {
    return null;
  }
  if (name.endsWith(FILE_SUFFIX)) {
    return name.slice(0, -FILE_SUFFIX.length);
  }
  return null;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
