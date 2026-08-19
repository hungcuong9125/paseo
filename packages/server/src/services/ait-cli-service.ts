import { z } from "zod";
import { findExecutable } from "../executable-resolution/executable-resolution.js";
import { execCommand } from "../utils/spawn.js";
import {
  bufferOrStringToString,
  createCachedCliPathResolver,
  parseCliJsonOutput,
} from "./forge-cli-command.js";
import {
  TrackerErrorCodeSchema,
  type TrackerErrorCode,
} from "@getpaseo/protocol/tracker/rpc-schemas";
import type {
  CreateTrackerInput,
  TrackerDetail,
  TrackerNote,
  TrackerPriority,
  TrackerSummary,
  TrackerType,
  UpdateTrackerInput,
} from "@getpaseo/protocol/tracker/types";

const AIT_TIMEOUT_MS = 15_000;
const AIT_MAX_BUFFER = 10 * 1024 * 1024;
const KNOWN_ERROR_CODES = new Set<string>(TrackerErrorCodeSchema.options);

export class AitCliError extends Error {
  readonly code: TrackerErrorCode;

  constructor(code: TrackerErrorCode, message: string) {
    super(message);
    this.name = "AitCliError";
    this.code = code;
  }
}

export interface ListTrackersOptions {
  cwd: string;
  all?: boolean;
}

export interface ListTrackersResult {
  trackers: TrackerSummary[];
  hiddenCount: number;
}

export interface ShowTrackerOptions {
  cwd: string;
  trackerId: string;
}

export interface CreateTrackerOptions {
  cwd: string;
  input: CreateTrackerInput;
}

export interface UpdateTrackerOptions {
  cwd: string;
  trackerId: string;
  input: UpdateTrackerInput;
}

export interface CloseTrackerOptions {
  cwd: string;
  trackerId: string;
  note?: string;
}

export interface ReopenTrackerOptions {
  cwd: string;
  trackerId: string;
}

export interface CancelTrackerOptions {
  cwd: string;
  trackerId: string;
  reason?: string;
}

export interface AddTrackerNoteOptions {
  cwd: string;
  trackerId: string;
  body: string;
}

export interface InitTrackerOptions {
  cwd: string;
  prefix?: string;
}

export interface AitService {
  listTrackers(options: ListTrackersOptions): Promise<ListTrackersResult>;
  showTracker(options: ShowTrackerOptions): Promise<TrackerDetail>;
  createTracker(options: CreateTrackerOptions): Promise<TrackerSummary>;
  updateTracker(options: UpdateTrackerOptions): Promise<TrackerSummary>;
  closeTracker(options: CloseTrackerOptions): Promise<TrackerSummary>;
  reopenTracker(options: ReopenTrackerOptions): Promise<TrackerSummary>;
  cancelTracker(options: CancelTrackerOptions): Promise<TrackerSummary>;
  addNote(options: AddTrackerNoteOptions): Promise<TrackerNote>;
  initTracker(options: InitTrackerOptions): Promise<{ initialised: boolean }>;
}

// The `ait` CLI's own wire shapes (snake_case, see the `ait` skill contract). Kept private to
// this module — callers only ever see the camelCase protocol types from `@getpaseo/protocol/tracker`.
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

function toTrackerSummary(raw: z.infer<typeof AitIssueLongSchema>): TrackerSummary {
  return {
    id: raw.id,
    title: raw.title,
    type: raw.type,
    status: raw.status,
    priority: raw.priority,
    parentId: raw.parent_id,
  };
}

function toTrackerNote(raw: z.infer<typeof AitNoteSchema>): TrackerNote {
  return { id: raw.id, body: raw.body, createdAt: raw.created_at };
}

function toTrackerDetail(raw: z.infer<typeof AitShowResponseSchema>): TrackerDetail {
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
    children: raw.children.map(toTrackerSummary),
    blockedBy: raw.blockers.map(toTrackerSummary),
    notes: raw.notes.map(toTrackerNote),
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

function toTrackerErrorCode(code: string): TrackerErrorCode {
  return KNOWN_ERROR_CODES.has(code) ? (code as TrackerErrorCode) : "unknown";
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
    return new AitCliError(toTrackerErrorCode(envelope.code), envelope.message);
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

  async function getTrackerSummary(cwd: string, trackerId: string): Promise<TrackerSummary> {
    const raw = await run(["show", trackerId], cwd, AitShowResponseSchema);
    return toTrackerSummary(raw.issue);
  }

  async function listTrackers({ cwd, all }: ListTrackersOptions): Promise<ListTrackersResult> {
    const args = all ? ["list", "--long", "--all"] : ["list", "--long"];
    const raw = await run(args, cwd, AitListResponseSchema);
    return {
      trackers: raw.issues.map(toTrackerSummary),
      hiddenCount: raw.hidden_count ?? 0,
    };
  }

  async function showTracker({ cwd, trackerId }: ShowTrackerOptions): Promise<TrackerDetail> {
    const raw = await run(["show", trackerId], cwd, AitShowResponseSchema);
    return toTrackerDetail(raw);
  }

  function trackerTypeArg(trackerType: TrackerType | undefined): string[] {
    return trackerType ? ["--type", trackerType] : [];
  }

  function priorityArg(priority: TrackerPriority | undefined): string[] {
    return priority ? ["--priority", priority] : [];
  }

  async function createTracker({ cwd, input }: CreateTrackerOptions): Promise<TrackerSummary> {
    const args = [
      "create",
      "--title",
      input.title,
      ...trackerTypeArg(input.trackerType),
      ...priorityArg(input.priority),
      ...(input.parentId ? ["--parent", input.parentId] : []),
      ...(input.description ? ["--description", input.description] : []),
    ];
    const ref = await run(args, cwd, AitIssueRefSchema);
    return getTrackerSummary(cwd, ref.id);
  }

  async function updateTracker({
    cwd,
    trackerId,
    input,
  }: UpdateTrackerOptions): Promise<TrackerSummary> {
    const args = [
      "update",
      trackerId,
      ...(input.title ? ["--title", input.title] : []),
      ...(input.status ? ["--status", input.status] : []),
      ...priorityArg(input.priority),
    ];
    await run(args, cwd, AitIssueRefSchema);
    return getTrackerSummary(cwd, trackerId);
  }

  async function closeTracker({
    cwd,
    trackerId,
    note,
  }: CloseTrackerOptions): Promise<TrackerSummary> {
    const args = ["close", trackerId, ...(note ? ["--note", note] : [])];
    await run(args, cwd, AitIssueRefSchema);
    return getTrackerSummary(cwd, trackerId);
  }

  async function reopenTracker({ cwd, trackerId }: ReopenTrackerOptions): Promise<TrackerSummary> {
    await run(["reopen", trackerId], cwd, AitIssueRefSchema);
    return getTrackerSummary(cwd, trackerId);
  }

  async function cancelTracker({
    cwd,
    trackerId,
    reason,
  }: CancelTrackerOptions): Promise<TrackerSummary> {
    const args = ["cancel", trackerId, ...(reason ? ["--reason", reason] : [])];
    await run(args, cwd, AitIssueRefSchema);
    return getTrackerSummary(cwd, trackerId);
  }

  async function addNote({ cwd, trackerId, body }: AddTrackerNoteOptions): Promise<TrackerNote> {
    const added = await run(["note", "add", trackerId, body], cwd, AitNoteAddResponseSchema);
    const list = await run(["note", "list", trackerId], cwd, AitNoteListResponseSchema);
    const match = list.notes.find((entry) => entry.id === added.note_id);
    if (!match) {
      throw new AitCliError("unknown", "Note was created but could not be read back");
    }
    return toTrackerNote(match);
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
    listTrackers,
    showTracker,
    createTracker,
    updateTracker,
    closeTracker,
    reopenTracker,
    cancelTracker,
    addNote,
    initTracker,
  };
}
