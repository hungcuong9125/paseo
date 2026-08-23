import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  TrackerSort,
  TrackerStatus,
  TrackerSummary,
  TrackerType,
  UpdateTrackerInput,
} from "@getpaseo/protocol/tracker/types";

const AIT_TIMEOUT_MS = 15_000;
const AIT_MAX_BUFFER = 10 * 1024 * 1024;
const KNOWN_ERROR_CODES = new Set<string>(TrackerErrorCodeSchema.options);
// `ait` derives a project prefix from cwd's basename even for `--db :memory:`,
// and rejects a basename that isn't all lowercase letters/numbers/hyphens.
// The sort-capability probe below must not inherit the daemon process's own
// cwd for this reason — a GUI-launched daemon's cwd is `/` (empty basename),
// which fails that validation and makes the probe report unsupported no
// matter what the binary actually supports (pas-2KY5X.35). A fixed directory
// keeps the probe's answer a fact about the binary, not about whatever
// directory the daemon happened to start in.
const SORT_PROBE_CWD = join(tmpdir(), "paseo-ait-sort-probe");

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
  status?: TrackerStatus;
  type?: TrackerType;
  priority?: TrackerPriority;
  sort?: TrackerSort;
  limit?: number;
  // Only ever sent together with `limit` — the CLI rejects a bare `--offset`
  // with a usage error.
  offset?: number;
}

export interface TrackerPageInfoResult {
  hasMore: boolean;
  nextCursor: string | null;
  totalCount?: number;
}

export interface ListTrackersResult {
  trackers: TrackerSummary[];
  hiddenCount: number;
  /** Absent — not false — when the request was unpaginated. */
  pageInfo?: TrackerPageInfoResult;
}

export interface SearchTrackersOptions {
  cwd: string;
  query: string;
  limit: number;
  offset?: number;
}

export interface SearchTrackersResult {
  trackers: TrackerSummary[];
  pageInfo: TrackerPageInfoResult;
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

export interface DeleteTrackerOptions {
  cwd: string;
  trackerId: string;
  cascade?: boolean;
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

export interface ListReadyIdsOptions {
  cwd: string;
}

export interface AitService {
  /** Probe the installed binary's current list help for --sort support. */
  supportsSort?: () => Promise<boolean>;
  listTrackers(options: ListTrackersOptions): Promise<ListTrackersResult>;
  searchTrackers(options: SearchTrackersOptions): Promise<SearchTrackersResult>;
  showTracker(options: ShowTrackerOptions): Promise<TrackerDetail>;
  createTracker(options: CreateTrackerOptions): Promise<TrackerSummary>;
  updateTracker(options: UpdateTrackerOptions): Promise<TrackerSummary>;
  closeTracker(options: CloseTrackerOptions): Promise<TrackerSummary>;
  reopenTracker(options: ReopenTrackerOptions): Promise<TrackerSummary>;
  cancelTracker(options: CancelTrackerOptions): Promise<TrackerSummary>;
  // Permanent and unrecorded — returns the ids `ait` actually removed (root
  // plus every cascaded descendant), not a TrackerSummary; there's nothing
  // left to show once the delete succeeds.
  deleteTracker(options: DeleteTrackerOptions): Promise<string[]>;
  addNote(options: AddTrackerNoteOptions): Promise<TrackerNote>;
  initTracker(options: InitTrackerOptions): Promise<{ initialised: boolean }>;
  listReadyIds(options: ListReadyIdsOptions): Promise<string[]>;
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
  // Present on every `ait` build this service targets, but kept optional so an older CLI
  // that predates the column doesn't fail the whole list/show response over one field.
  closed_at: z.string().nullable().optional(),
});

const AitListResponseSchema = z.object({
  hidden_count: z.number().int().nonnegative().optional(),
  issues: z.array(AitIssueLongSchema),
  // Pagination fields from the `ait` CLI's `--limit/--offset` support. Optional:
  // an older binary predating pagination just leaves them out.
  total_count: z.number().int().nonnegative().optional(),
  has_more: z.boolean().optional(),
});

// `ait search` emits the same long issue shape as `list --long` (no --long flag
// exists for search — the detail columns are unconditional), plus its own
// pagination envelope.
const AitSearchResponseSchema = z.object({
  issues: z.array(AitIssueLongSchema),
  total_count: z.number().int().nonnegative().optional(),
  has_more: z.boolean().optional(),
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

const AitReadyResponseSchema = z.object({
  issues: z.array(AitIssueRefSchema),
});

const AitDeleteResponseSchema = z.object({
  deleted: z.array(AitIssueRefSchema),
});

function toTrackerSummary(raw: z.infer<typeof AitIssueLongSchema>): TrackerSummary {
  return {
    id: raw.id,
    title: raw.title,
    type: raw.type,
    status: raw.status,
    priority: raw.priority,
    parentId: raw.parent_id,
    claimedBy: raw.claimed_by,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    closedAt: raw.closed_at ?? null,
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
    closedAt: raw.issue.closed_at ?? null,
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

  async function supportsSort(): Promise<boolean> {
    // Re-resolve the executable for every capability probe so replacing the
    // binary or changing PATH can take effect without restarting the daemon.
    const cliPath = await findExecutable("ait");
    if (!cliPath) {
      return false;
    }
    try {
      mkdirSync(SORT_PROBE_CWD, { recursive: true });
      const { stdout } = await execCommand(cliPath, ["--db", ":memory:", "list", "--help"], {
        cwd: SORT_PROBE_CWD,
        maxBuffer: 64 * 1024,
        timeout: AIT_TIMEOUT_MS,
      });
      return stdout.split(/\s+/).includes("--sort");
    } catch (error) {
      // Silently latching to `false` here is what let pas-2KY5X.35 ship
      // invisibly for a whole release: server_info advertised
      // aitTrackerSort:false with no signal anywhere that the probe itself
      // was failing rather than the binary genuinely lacking `--sort`.
      const failure = toExecFailure(error);
      const detail =
        bufferOrStringToString(failure.stderr).trim() || failure.message || String(error);
      console.warn(
        `ait --sort capability probe failed, advertising aitTrackerSort: false — ${detail}`,
      );
      return false;
    }
  }

  async function getTrackerSummary(cwd: string, trackerId: string): Promise<TrackerSummary> {
    const raw = await run(["show", trackerId], cwd, AitShowResponseSchema);
    return toTrackerSummary(raw.issue);
  }

  function paginationArgs(limit: number | undefined, offset: number | undefined): string[] {
    if (limit === undefined) {
      return [];
    }
    return [
      "--limit",
      String(limit),
      ...(offset !== undefined ? ["--offset", String(offset)] : []),
    ];
  }

  function toPageInfo(
    raw: { total_count?: number; has_more?: boolean },
    limit: number,
    offset: number,
    returnedCount: number,
  ): TrackerPageInfoResult {
    const hasMore =
      raw.has_more ??
      (raw.total_count !== undefined
        ? offset + returnedCount < raw.total_count
        : returnedCount === limit);
    return {
      hasMore,
      nextCursor: hasMore ? String(offset + returnedCount) : null,
      ...(raw.total_count !== undefined ? { totalCount: raw.total_count } : {}),
    };
  }

  async function listTrackers({
    cwd,
    all,
    status,
    type,
    priority,
    sort,
    limit,
    offset,
  }: ListTrackersOptions): Promise<ListTrackersResult> {
    const baseArgs = [
      "list",
      "--long",
      ...(all ? ["--all"] : []),
      ...(status ? ["--status", status] : []),
      ...(type ? ["--type", type] : []),
      ...(priority ? ["--priority", priority] : []),
      ...(sort ? ["--sort", sort] : []),
    ];
    const raw = await run(
      [...baseArgs, ...paginationArgs(limit, offset)],
      cwd,
      AitListResponseSchema,
    );
    const trackers = raw.issues.map(toTrackerSummary);
    return {
      trackers,
      hiddenCount: raw.hidden_count ?? 0,
      pageInfo:
        limit !== undefined ? toPageInfo(raw, limit, offset ?? 0, trackers.length) : undefined,
    };
  }

  async function searchTrackers({
    cwd,
    query,
    limit,
    offset = 0,
  }: SearchTrackersOptions): Promise<SearchTrackersResult> {
    // No old-binary fallback here: search itself arrived alongside pagination,
    // so a binary that rejects --limit predates search too — surface the error.
    const raw = await run(
      ["search", query, ...paginationArgs(limit, offset)],
      cwd,
      AitSearchResponseSchema,
    );
    const trackers = raw.issues.map(toTrackerSummary);
    return { trackers, pageInfo: toPageInfo(raw, limit, offset, trackers.length) };
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
      ...(input.description !== undefined ? ["--description", input.description] : []),
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

  async function deleteTracker({
    cwd,
    trackerId,
    cascade,
  }: DeleteTrackerOptions): Promise<string[]> {
    const args = ["delete", trackerId, "--force", ...(cascade ? ["--cascade"] : [])];
    const raw = await run(args, cwd, AitDeleteResponseSchema);
    return raw.deleted.map((issue) => issue.id);
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

  async function listReadyIds({ cwd }: ListReadyIdsOptions): Promise<string[]> {
    const raw = await run(["ready"], cwd, AitReadyResponseSchema);
    return raw.issues.map((issue) => issue.id);
  }

  return {
    supportsSort,
    listTrackers,
    searchTrackers,
    showTracker,
    createTracker,
    updateTracker,
    closeTracker,
    reopenTracker,
    cancelTracker,
    deleteTracker,
    addNote,
    initTracker,
    listReadyIds,
  };
}
