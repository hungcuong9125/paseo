import { z } from "zod";
import {
  TrackerDetailSchema,
  TrackerNoteSchema,
  TrackerPrioritySchema,
  TrackerSummarySchema,
  TrackerTypeSchema,
} from "./types.js";

// Structured classification of an `ait` CLI failure, mirrored from the CLI's own
// `{ error: { code, message } }` stderr envelope so the client can render a distinct
// empty state (e.g. "install ait" vs "initialise tracker") without string-matching.
export const TrackerErrorCodeSchema = z.enum([
  "cli_missing",
  "uninitialised",
  "not_found",
  "conflict",
  "validation",
  "confirmation",
  "usage",
  "unknown",
]);
export type TrackerErrorCode = z.infer<typeof TrackerErrorCodeSchema>;

// Scoped by projectId, not workspaceId: `.ait/ait.db` is a property of a project's
// root directory (see the `ait` skill contract — "the database lives at .ait/ait.db
// in the git root"), and a project can be browsed/aggregated even when it has no
// open workspace. The server resolves projectId -> rootPath via the project
// registry; the client never sends a raw filesystem path.

export const ProjectTrackerListRequestSchema = z.object({
  type: z.literal("project.tracker.list.request"),
  requestId: z.string(),
  projectId: z.string(),
  all: z.boolean().optional(),
});

export const ProjectTrackerShowRequestSchema = z.object({
  type: z.literal("project.tracker.show.request"),
  requestId: z.string(),
  projectId: z.string(),
  trackerId: z.string(),
});

export const ProjectTrackerCreateRequestSchema = z.object({
  type: z.literal("project.tracker.create.request"),
  requestId: z.string(),
  projectId: z.string(),
  title: z.string().trim().min(1),
  trackerType: TrackerTypeSchema.optional(),
  priority: TrackerPrioritySchema.optional(),
  parentId: z.string().trim().min(1).optional(),
  description: z.string().optional(),
});

export const ProjectTrackerUpdateRequestSchema = z.object({
  type: z.literal("project.tracker.update.request"),
  requestId: z.string(),
  projectId: z.string(),
  trackerId: z.string(),
  title: z.string().trim().min(1).optional(),
  status: z.enum(["open", "in_progress"]).optional(),
  priority: TrackerPrioritySchema.optional(),
});

export const ProjectTrackerCloseRequestSchema = z.object({
  type: z.literal("project.tracker.close.request"),
  requestId: z.string(),
  projectId: z.string(),
  trackerId: z.string(),
  note: z.string().optional(),
});

export const ProjectTrackerReopenRequestSchema = z.object({
  type: z.literal("project.tracker.reopen.request"),
  requestId: z.string(),
  projectId: z.string(),
  trackerId: z.string(),
});

export const ProjectTrackerCancelRequestSchema = z.object({
  type: z.literal("project.tracker.cancel.request"),
  requestId: z.string(),
  projectId: z.string(),
  trackerId: z.string(),
  reason: z.string().optional(),
});

export const ProjectTrackerNoteAddRequestSchema = z.object({
  type: z.literal("project.tracker.note_add.request"),
  requestId: z.string(),
  projectId: z.string(),
  trackerId: z.string(),
  body: z.string().trim().min(1),
});

export const ProjectTrackerInitRequestSchema = z.object({
  type: z.literal("project.tracker.init.request"),
  requestId: z.string(),
  projectId: z.string(),
  prefix: z.string().trim().min(1).optional(),
});

export const ProjectTrackerListResponseSchema = z.object({
  type: z.literal("project.tracker.list.response"),
  payload: z.object({
    requestId: z.string(),
    projectId: z.string(),
    trackers: z.array(TrackerSummarySchema),
    hiddenCount: z.number().int().nonnegative(),
    error: z.string().nullable(),
    errorCode: TrackerErrorCodeSchema.nullable(),
  }),
});

export const ProjectTrackerShowResponseSchema = z.object({
  type: z.literal("project.tracker.show.response"),
  payload: z.object({
    requestId: z.string(),
    projectId: z.string(),
    tracker: TrackerDetailSchema.nullable(),
    error: z.string().nullable(),
    errorCode: TrackerErrorCodeSchema.nullable(),
  }),
});

const ProjectTrackerMutationPayloadSchema = z.object({
  requestId: z.string(),
  projectId: z.string(),
  tracker: TrackerSummarySchema.nullable(),
  error: z.string().nullable(),
  errorCode: TrackerErrorCodeSchema.nullable(),
});

export const ProjectTrackerCreateResponseSchema = z.object({
  type: z.literal("project.tracker.create.response"),
  payload: ProjectTrackerMutationPayloadSchema,
});

export const ProjectTrackerUpdateResponseSchema = z.object({
  type: z.literal("project.tracker.update.response"),
  payload: ProjectTrackerMutationPayloadSchema,
});

export const ProjectTrackerCloseResponseSchema = z.object({
  type: z.literal("project.tracker.close.response"),
  payload: ProjectTrackerMutationPayloadSchema,
});

export const ProjectTrackerReopenResponseSchema = z.object({
  type: z.literal("project.tracker.reopen.response"),
  payload: ProjectTrackerMutationPayloadSchema,
});

export const ProjectTrackerCancelResponseSchema = z.object({
  type: z.literal("project.tracker.cancel.response"),
  payload: ProjectTrackerMutationPayloadSchema,
});

export const ProjectTrackerNoteAddResponseSchema = z.object({
  type: z.literal("project.tracker.note_add.response"),
  payload: z.object({
    requestId: z.string(),
    projectId: z.string(),
    note: TrackerNoteSchema.nullable(),
    error: z.string().nullable(),
    errorCode: TrackerErrorCodeSchema.nullable(),
  }),
});

export const ProjectTrackerInitResponseSchema = z.object({
  type: z.literal("project.tracker.init.response"),
  payload: z.object({
    requestId: z.string(),
    projectId: z.string(),
    initialised: z.boolean(),
    error: z.string().nullable(),
    errorCode: TrackerErrorCodeSchema.nullable(),
  }),
});
