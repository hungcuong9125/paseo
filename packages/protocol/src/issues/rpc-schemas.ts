import { z } from "zod";
import {
  IssueDetailSchema,
  IssueNoteSchema,
  IssuePrioritySchema,
  IssueSummarySchema,
  IssueTypeSchema,
} from "./types.js";

// Structured classification of an `ait` CLI failure, mirrored from the CLI's own
// `{ error: { code, message } }` stderr envelope so the client can render a distinct
// empty state (e.g. "install ait" vs "initialise tracker") without string-matching.
export const IssuesErrorCodeSchema = z.enum([
  "cli_missing",
  "uninitialised",
  "not_found",
  "conflict",
  "validation",
  "confirmation",
  "usage",
  "unknown",
]);
export type IssuesErrorCode = z.infer<typeof IssuesErrorCodeSchema>;

// Scoped by projectId, not workspaceId: `.ait/ait.db` is a property of a project's
// root directory (see the `ait` skill contract — "the database lives at .ait/ait.db
// in the git root"), and a project can be browsed/aggregated even when it has no
// open workspace. The server resolves projectId -> rootPath via the project
// registry; the client never sends a raw filesystem path.

export const ProjectIssuesListRequestSchema = z.object({
  type: z.literal("project.issues.list.request"),
  requestId: z.string(),
  projectId: z.string(),
  all: z.boolean().optional(),
});

export const ProjectIssuesShowRequestSchema = z.object({
  type: z.literal("project.issues.show.request"),
  requestId: z.string(),
  projectId: z.string(),
  issueId: z.string(),
});

export const ProjectIssuesCreateRequestSchema = z.object({
  type: z.literal("project.issues.create.request"),
  requestId: z.string(),
  projectId: z.string(),
  title: z.string().trim().min(1),
  issueType: IssueTypeSchema.optional(),
  priority: IssuePrioritySchema.optional(),
  parentId: z.string().trim().min(1).optional(),
  description: z.string().optional(),
});

export const ProjectIssuesUpdateRequestSchema = z.object({
  type: z.literal("project.issues.update.request"),
  requestId: z.string(),
  projectId: z.string(),
  issueId: z.string(),
  title: z.string().trim().min(1).optional(),
  status: z.enum(["open", "in_progress"]).optional(),
  priority: IssuePrioritySchema.optional(),
});

export const ProjectIssuesCloseRequestSchema = z.object({
  type: z.literal("project.issues.close.request"),
  requestId: z.string(),
  projectId: z.string(),
  issueId: z.string(),
  note: z.string().optional(),
});

export const ProjectIssuesReopenRequestSchema = z.object({
  type: z.literal("project.issues.reopen.request"),
  requestId: z.string(),
  projectId: z.string(),
  issueId: z.string(),
});

export const ProjectIssuesCancelRequestSchema = z.object({
  type: z.literal("project.issues.cancel.request"),
  requestId: z.string(),
  projectId: z.string(),
  issueId: z.string(),
  reason: z.string().optional(),
});

export const ProjectIssuesNoteAddRequestSchema = z.object({
  type: z.literal("project.issues.note_add.request"),
  requestId: z.string(),
  projectId: z.string(),
  issueId: z.string(),
  body: z.string().trim().min(1),
});

export const ProjectIssuesInitRequestSchema = z.object({
  type: z.literal("project.issues.init.request"),
  requestId: z.string(),
  projectId: z.string(),
  prefix: z.string().trim().min(1).optional(),
});

export const ProjectIssuesListResponseSchema = z.object({
  type: z.literal("project.issues.list.response"),
  payload: z.object({
    requestId: z.string(),
    projectId: z.string(),
    issues: z.array(IssueSummarySchema),
    hiddenCount: z.number().int().nonnegative(),
    error: z.string().nullable(),
    errorCode: IssuesErrorCodeSchema.nullable(),
  }),
});

export const ProjectIssuesShowResponseSchema = z.object({
  type: z.literal("project.issues.show.response"),
  payload: z.object({
    requestId: z.string(),
    projectId: z.string(),
    issue: IssueDetailSchema.nullable(),
    error: z.string().nullable(),
    errorCode: IssuesErrorCodeSchema.nullable(),
  }),
});

const ProjectIssueMutationPayloadSchema = z.object({
  requestId: z.string(),
  projectId: z.string(),
  issue: IssueSummarySchema.nullable(),
  error: z.string().nullable(),
  errorCode: IssuesErrorCodeSchema.nullable(),
});

export const ProjectIssuesCreateResponseSchema = z.object({
  type: z.literal("project.issues.create.response"),
  payload: ProjectIssueMutationPayloadSchema,
});

export const ProjectIssuesUpdateResponseSchema = z.object({
  type: z.literal("project.issues.update.response"),
  payload: ProjectIssueMutationPayloadSchema,
});

export const ProjectIssuesCloseResponseSchema = z.object({
  type: z.literal("project.issues.close.response"),
  payload: ProjectIssueMutationPayloadSchema,
});

export const ProjectIssuesReopenResponseSchema = z.object({
  type: z.literal("project.issues.reopen.response"),
  payload: ProjectIssueMutationPayloadSchema,
});

export const ProjectIssuesCancelResponseSchema = z.object({
  type: z.literal("project.issues.cancel.response"),
  payload: ProjectIssueMutationPayloadSchema,
});

export const ProjectIssuesNoteAddResponseSchema = z.object({
  type: z.literal("project.issues.note_add.response"),
  payload: z.object({
    requestId: z.string(),
    projectId: z.string(),
    note: IssueNoteSchema.nullable(),
    error: z.string().nullable(),
    errorCode: IssuesErrorCodeSchema.nullable(),
  }),
});

export const ProjectIssuesInitResponseSchema = z.object({
  type: z.literal("project.issues.init.response"),
  payload: z.object({
    requestId: z.string(),
    projectId: z.string(),
    initialised: z.boolean(),
    error: z.string().nullable(),
    errorCode: IssuesErrorCodeSchema.nullable(),
  }),
});
