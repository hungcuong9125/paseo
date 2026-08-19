import { z } from "zod";
import { findExecutable } from "../executable-resolution/executable-resolution.js";
import { execCommand } from "../utils/spawn.js";
import {
  bufferOrStringToString,
  createCachedCliPathResolver,
  parseCliJsonOutput,
} from "./forge-cli-command.js";
import { IssuesErrorCodeSchema, type IssuesErrorCode } from "@getpaseo/protocol/issues/rpc-schemas";
import type {
  CreateIssueInput,
  IssueDetail,
  IssueNote,
  IssuePriority,
  IssueSummary,
  IssueType,
  UpdateIssueInput,
} from "@getpaseo/protocol/issues/types";

const AIT_TIMEOUT_MS = 15_000;
const AIT_MAX_BUFFER = 10 * 1024 * 1024;
const KNOWN_ERROR_CODES = new Set<string>(IssuesErrorCodeSchema.options);

export class AitCliError extends Error {
  readonly code: IssuesErrorCode;

  constructor(code: IssuesErrorCode, message: string) {
    super(message);
    this.name = "AitCliError";
    this.code = code;
  }
}

export interface ListIssuesOptions {
  cwd: string;
  all?: boolean;
}

export interface ListIssuesResult {
  issues: IssueSummary[];
  hiddenCount: number;
}

export interface ShowIssueOptions {
  cwd: string;
  issueId: string;
}

export interface CreateIssueOptions {
  cwd: string;
  input: CreateIssueInput;
}

export interface UpdateIssueOptions {
  cwd: string;
  issueId: string;
  input: UpdateIssueInput;
}

export interface CloseIssueOptions {
  cwd: string;
  issueId: string;
  note?: string;
}

export interface ReopenIssueOptions {
  cwd: string;
  issueId: string;
}

export interface CancelIssueOptions {
  cwd: string;
  issueId: string;
  reason?: string;
}

export interface AddNoteOptions {
  cwd: string;
  issueId: string;
  body: string;
}

export interface InitTrackerOptions {
  cwd: string;
  prefix?: string;
}

export interface AitService {
  listIssues(options: ListIssuesOptions): Promise<ListIssuesResult>;
  showIssue(options: ShowIssueOptions): Promise<IssueDetail>;
  createIssue(options: CreateIssueOptions): Promise<IssueSummary>;
  updateIssue(options: UpdateIssueOptions): Promise<IssueSummary>;
  closeIssue(options: CloseIssueOptions): Promise<IssueSummary>;
  reopenIssue(options: ReopenIssueOptions): Promise<IssueSummary>;
  cancelIssue(options: CancelIssueOptions): Promise<IssueSummary>;
  addNote(options: AddNoteOptions): Promise<IssueNote>;
  initTracker(options: InitTrackerOptions): Promise<{ initialised: boolean }>;
}

// The `ait` CLI's own wire shapes (snake_case, see the `ait` skill contract). Kept private to
// this module — callers only ever see the camelCase protocol types from `@getpaseo/protocol/issues`.
const AitIssueTypeSchema = z.enum(["initiative", "epic", "task"]);
const AitIssueStatusSchema = z.enum(["open", "in_progress", "closed", "cancelled"]);
const AitIssuePrioritySchema = z.enum(["P0", "P1", "P2", "P3", "P4"]);

const AitIssueRefSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: AitIssueStatusSchema,
  type: AitIssueTypeSchema,
  priority: AitIssuePrioritySchema,
});

const AitIssueLongSchema = z.object({
  id: z.string(),
  type: AitIssueTypeSchema,
  title: z.string(),
  description: z.string(),
  status: AitIssueStatusSchema,
  parent_id: z.string().nullable(),
  priority: AitIssuePrioritySchema,
  claimed_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const AitListResponseSchema = z.object({
  hidden_count: z.number().int().nonnegative().optional(),
  issues: z.array(AitIssueLongSchema),
});

const AitNoteSchema = z.object({
  id: z.string(),
  issue_id: z.string(),
  body: z.string(),
  created_at: z.string(),
});

const AitShowResponseSchema = z.object({
  issue: AitIssueLongSchema,
  children: z.array(AitIssueLongSchema),
  blockers: z.array(AitIssueLongSchema),
  notes: z.array(AitNoteSchema),
});

const AitNoteAddResponseSchema = z.object({
  issue_id: z.string(),
  note_id: z.string(),
  ok: z.boolean(),
});

const AitNoteListResponseSchema = z.object({
  issue_id: z.string(),
  notes: z.array(AitNoteSchema),
});

const AitInitResponseSchema = z.object({
  created: z.boolean(),
});

function toIssueSummary(raw: z.infer<typeof AitIssueLongSchema>): IssueSummary {
  return {
    id: raw.id,
    title: raw.title,
    type: raw.type,
    status: raw.status,
    priority: raw.priority,
    parentId: raw.parent_id,
  };
}

function toIssueNote(raw: z.infer<typeof AitNoteSchema>): IssueNote {
  return { id: raw.id, body: raw.body, createdAt: raw.created_at };
}

function toIssueDetail(raw: z.infer<typeof AitShowResponseSchema>): IssueDetail {
  return {
    id: raw.issue.id,
    title: raw.issue.title,
    type: raw.issue.type,
    status: raw.issue.status,
    priority: raw.issue.priority,
    parentId: raw.issue.parent_id,
    description: raw.issue.description.length > 0 ? raw.issue.description : null,
    claimedBy: raw.issue.claimed_by,
    createdAt: raw.issue.created_at,
    updatedAt: raw.issue.updated_at,
    children: raw.children.map(toIssueSummary),
    blockedBy: raw.blockers.map(toIssueSummary),
    notes: raw.notes.map(toIssueNote),
  };
}

interface ExecFailureLike {
  code?: string | number | null;
  stderr?: string | Buffer;
  message?: string;
}

function toExecFailure(error: unknown): ExecFailureLike {
  if (!error || typeof error !== "object") {
    return { message: String(error) };
  }
  const record = error as Record<string, unknown>;
  return {
    code:
      typeof record.code === "string" || typeof record.code === "number" || record.code === null
        ? record.code
        : undefined,
    stderr:
      typeof record.stderr === "string" || Buffer.isBuffer(record.stderr)
        ? (record.stderr as string | Buffer)
        : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}

// `ait` prints `{ "error": { "code", "message" } }` to stderr on any non-zero exit (see the `ait`
// skill contract's Output Modes section) — this is the same shape for every failure, so we parse
// it once here rather than string-matching per call site.
function parseAitErrorEnvelope(stderr: string): { code: string; message: string } | null {
  try {
    const parsed: unknown = JSON.parse(stderr);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const errorField = (parsed as { error: unknown }).error;
      if (
        errorField &&
        typeof errorField === "object" &&
        "code" in errorField &&
        "message" in errorField
      ) {
        const { code, message } = errorField as { code: unknown; message: unknown };
        if (typeof code === "string" && typeof message === "string") {
          return { code, message };
        }
      }
    }
  } catch {
    // stderr wasn't the JSON envelope (crash, OOM, etc.) — fall through to a generic error.
  }
  return null;
}

function toIssuesErrorCode(code: string): IssuesErrorCode {
  return KNOWN_ERROR_CODES.has(code) ? (code as IssuesErrorCode) : "unknown";
}

function classifyAitError(error: unknown, context: { args: string[] }): AitCliError {
  if (error instanceof AitCliError) {
    return error;
  }
  const failure = toExecFailure(error);
  if (failure.code === "ENOENT") {
    return new AitCliError("cli_missing", "The 'ait' CLI is not installed on this host.");
  }
  const stderr = bufferOrStringToString(failure.stderr);
  const envelope = parseAitErrorEnvelope(stderr);
  if (envelope) {
    return new AitCliError(toIssuesErrorCode(envelope.code), envelope.message);
  }
  const message = stderr.trim() || failure.message || `ait ${context.args.join(" ")} failed`;
  return new AitCliError("unknown", message);
}

export function createAitService(): AitService {
  const resolveCliPath = createCachedCliPathResolver(() => findExecutable("ait"));

  async function run<T>(args: string[], cwd: string, schema: z.ZodType<T>): Promise<T> {
    const cliPath = await resolveCliPath();
    if (!cliPath) {
      throw new AitCliError("cli_missing", "The 'ait' CLI is not installed on this host.");
    }
    let stdout: string;
    try {
      ({ stdout } = await execCommand(cliPath, args, {
        cwd,
        maxBuffer: AIT_MAX_BUFFER,
        timeout: AIT_TIMEOUT_MS,
      }));
    } catch (error) {
      throw classifyAitError(error, { args });
    }
    return parseCliJsonOutput({
      commandName: "ait",
      args,
      cwd,
      stdout,
      schema,
      createCommandError: (params) => new AitCliError("unknown", params.stderr),
    });
  }

  async function getIssueSummary(cwd: string, issueId: string): Promise<IssueSummary> {
    const raw = await run(["show", issueId], cwd, AitShowResponseSchema);
    return toIssueSummary(raw.issue);
  }

  async function listIssues({ cwd, all }: ListIssuesOptions): Promise<ListIssuesResult> {
    const args = all ? ["list", "--long", "--all"] : ["list", "--long"];
    const raw = await run(args, cwd, AitListResponseSchema);
    return {
      issues: raw.issues.map(toIssueSummary),
      hiddenCount: raw.hidden_count ?? 0,
    };
  }

  async function showIssue({ cwd, issueId }: ShowIssueOptions): Promise<IssueDetail> {
    const raw = await run(["show", issueId], cwd, AitShowResponseSchema);
    return toIssueDetail(raw);
  }

  function issueTypeArg(issueType: IssueType | undefined): string[] {
    return issueType ? ["--type", issueType] : [];
  }

  function priorityArg(priority: IssuePriority | undefined): string[] {
    return priority ? ["--priority", priority] : [];
  }

  async function createIssue({ cwd, input }: CreateIssueOptions): Promise<IssueSummary> {
    const args = [
      "create",
      "--title",
      input.title,
      ...issueTypeArg(input.issueType),
      ...priorityArg(input.priority),
      ...(input.parentId ? ["--parent", input.parentId] : []),
      ...(input.description ? ["--description", input.description] : []),
    ];
    const ref = await run(args, cwd, AitIssueRefSchema);
    return getIssueSummary(cwd, ref.id);
  }

  async function updateIssue({ cwd, issueId, input }: UpdateIssueOptions): Promise<IssueSummary> {
    const args = [
      "update",
      issueId,
      ...(input.title ? ["--title", input.title] : []),
      ...(input.status ? ["--status", input.status] : []),
      ...priorityArg(input.priority),
    ];
    await run(args, cwd, AitIssueRefSchema);
    return getIssueSummary(cwd, issueId);
  }

  async function closeIssue({ cwd, issueId, note }: CloseIssueOptions): Promise<IssueSummary> {
    const args = ["close", issueId, ...(note ? ["--note", note] : [])];
    await run(args, cwd, AitIssueRefSchema);
    return getIssueSummary(cwd, issueId);
  }

  async function reopenIssue({ cwd, issueId }: ReopenIssueOptions): Promise<IssueSummary> {
    await run(["reopen", issueId], cwd, AitIssueRefSchema);
    return getIssueSummary(cwd, issueId);
  }

  async function cancelIssue({ cwd, issueId, reason }: CancelIssueOptions): Promise<IssueSummary> {
    const args = ["cancel", issueId, ...(reason ? ["--reason", reason] : [])];
    await run(args, cwd, AitIssueRefSchema);
    return getIssueSummary(cwd, issueId);
  }

  async function addNote({ cwd, issueId, body }: AddNoteOptions): Promise<IssueNote> {
    const added = await run(["note", "add", issueId, body], cwd, AitNoteAddResponseSchema);
    const list = await run(["note", "list", issueId], cwd, AitNoteListResponseSchema);
    const match = list.notes.find((entry) => entry.id === added.note_id);
    if (!match) {
      throw new AitCliError("unknown", "Note was created but could not be read back");
    }
    return toIssueNote(match);
  }

  async function initTracker({
    cwd,
    prefix,
  }: InitTrackerOptions): Promise<{ initialised: boolean }> {
    const args = ["init", ...(prefix ? ["--prefix", prefix] : [])];
    const raw = await run(args, cwd, AitInitResponseSchema);
    return { initialised: raw.created };
  }

  return {
    listIssues,
    showIssue,
    createIssue,
    updateIssue,
    closeIssue,
    reopenIssue,
    cancelIssue,
    addNote,
    initTracker,
  };
}
