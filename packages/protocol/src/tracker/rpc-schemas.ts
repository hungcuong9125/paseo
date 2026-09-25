import { z } from "zod";
import {
  TrackerDetailSchema,
  TrackerNoteSchema,
  TrackerPrioritySchema,
  TrackerSortSchema,
  TrackerStatusSchema,
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

// Cursor pagination for the one-shot (non-live) tracker requests. The cursor is
// opaque to clients — internally it is currently a numeric offset serialised as
// a string, but nothing on the wire may assume that, so a real keyset cursor can
// replace it later without a protocol change.
export const TrackerPageRequestSchema = z.object({
  limit: z.number().int().positive().max(200),
  cursor: z.string().min(1).optional(),
});

export const TrackerPageInfoSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  // Rows matching the request's filters, from `ait list --limit`'s
  // `total_count`. Absent when the CLI binary predates pagination.
  totalCount: z.number().int().nonnegative().optional(),
});
export type TrackerPageInfo = z.infer<typeof TrackerPageInfoSchema>;

export const ProjectTrackerListRequestSchema = z.object({
  type: z.literal("project.tracker.list.request"),
  requestId: z.string(),
  projectId: z.string(),
  all: z.boolean().optional(),
  // Not `type`: that name is the message discriminator above. Follows
  // ProjectTrackerCreateRequestSchema's `trackerType` instead.
  status: TrackerStatusSchema.optional(),
  trackerType: TrackerTypeSchema.optional(),
  priority: TrackerPrioritySchema.optional(),
  sort: TrackerSortSchema.optional(),
  page: TrackerPageRequestSchema.optional(),
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
  description: z.string().trim().optional(),
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

// Permanent and unrecorded (mirrors `ait delete <id> --force [--cascade]`) —
// unlike cancel/close, this removes the row entirely rather than changing its
// status. `cascade` must be true when the tracker has children; `ait` itself
// refuses otherwise, so the client is expected to already know via
// tracker-hierarchy.ts's descendantStats before sending this.
export const ProjectTrackerDeleteRequestSchema = z.object({
  type: z.literal("project.tracker.delete.request"),
  requestId: z.string(),
  projectId: z.string(),
  trackerId: z.string(),
  cascade: z.boolean().optional(),
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

export const ProjectTrackerReadyRequestSchema = z.object({
  type: z.literal("project.tracker.ready.request"),
  requestId: z.string(),
  projectId: z.string(),
});

export const ProjectTrackerListResponseSchema = z.object({
  type: z.literal("project.tracker.list.response"),
  payload: z.object({
    requestId: z.string(),
    projectId: z.string(),
    trackers: z.array(TrackerSummarySchema),
    hiddenCount: z.number().int().nonnegative(),
    // Present only when the request carried `page`. Its absence means the
    // server served the complete, unpaginated result — not "no more pages".
    pageInfo: TrackerPageInfoSchema.optional(),
    error: z.string().nullable(),
    errorCode: TrackerErrorCodeSchema.nullable(),
  }),
});

// One-shot free-text search (`ait search`), always bounded by `page` — an
// unbounded search is exactly the fetch-everything problem pagination exists
// to fix. Never routed through the live sync manager; search has no
// subscription concept.
export const ProjectTrackerSearchRequestSchema = z.object({
  type: z.literal("project.tracker.search.request"),
  requestId: z.string(),
  projectId: z.string(),
  query: z.string().min(1),
  page: TrackerPageRequestSchema,
});

export const ProjectTrackerSearchResponseSchema = z.object({
  type: z.literal("project.tracker.search.response"),
  payload: z.object({
    requestId: z.string(),
    projectId: z.string(),
    trackers: z.array(TrackerSummarySchema),
    pageInfo: TrackerPageInfoSchema,
    error: z.string().nullable(),
    errorCode: TrackerErrorCodeSchema.nullable(),
  }),
});

export const ProjectTrackerSubscribeRequestSchema = z.object({
  type: z.literal("project.tracker.subscribe.request"),
  requestId: z.string(),
  projectId: z.string(),
  subscriptionId: z.string(),
  all: z.boolean().optional(),
});

export const ProjectTrackerUnsubscribeRequestSchema = z.object({
  // This request intentionally has no response: unsubscribe is an awaited server-side barrier.
  type: z.literal("project.tracker.unsubscribe.request"),
  requestId: z.string(),
  subscriptionId: z.string(),
});

const ProjectTrackerSnapshotPayloadSchema = z.object({
  subscriptionId: z.string(),
  projectId: z.string(),
  trackers: z.array(TrackerSummarySchema),
  hiddenCount: z.number().int().nonnegative(),
  epoch: z.number().int().positive(),
  generation: z.number().int().positive(),
  error: z.string().nullable(),
  errorCode: TrackerErrorCodeSchema.nullable(),
});

export const ProjectTrackerSubscribeResponseSchema = z.object({
  type: z.literal("project.tracker.subscribe.response"),
  payload: ProjectTrackerSnapshotPayloadSchema.extend({ requestId: z.string() }),
});

export const ProjectTrackerUpdatedSchema = z.object({
  type: z.literal("project.tracker.updated"),
  payload: ProjectTrackerSnapshotPayloadSchema,
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

export const ProjectTrackerDeleteResponseSchema = z.object({
  type: z.literal("project.tracker.delete.response"),
  payload: z.object({
    requestId: z.string(),
    projectId: z.string(),
    // The root id plus every cascaded descendant id, in the order `ait`
    // deleted them — null on failure (nothing was removed).
    deletedIds: z.array(z.string()).nullable(),
    error: z.string().nullable(),
    errorCode: TrackerErrorCodeSchema.nullable(),
  }),
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

export const ProjectTrackerReadyResponseSchema = z.object({
  type: z.literal("project.tracker.ready.response"),
  payload: z.object({
    requestId: z.string(),
    projectId: z.string(),
    readyIds: z.array(z.string()),
    error: z.string().nullable(),
    errorCode: TrackerErrorCodeSchema.nullable(),
  }),
});

const TrackerStatusCountsSchema = z.object({
  open: z.number().int().nonnegative(),
  in_progress: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
});

const TrackerPriorityCountsSchema = z.object({
  P0: z.number().int().nonnegative(),
  P1: z.number().int().nonnegative(),
  P2: z.number().int().nonnegative(),
  P3: z.number().int().nonnegative(),
  P4: z.number().int().nonnegative(),
});

const TrackerStatsBucketSchema = z.object({
  total: z.number().int().nonnegative(),
  byStatus: TrackerStatusCountsSchema,
  byPriority: TrackerPriorityCountsSchema,
});

export const TrackerStatsCountsSchema = z.object({
  all: TrackerStatsBucketSchema,
  task: TrackerStatsBucketSchema,
  epic: TrackerStatsBucketSchema,
  initiative: TrackerStatsBucketSchema,
});
export type TrackerStatsCounts = z.infer<typeof TrackerStatsCountsSchema>;

export const ProjectTrackerStatsRequestSchema = z.object({
  type: z.literal("project.tracker.stats.request"),
  requestId: z.string(),
  projectId: z.string(),
});

export const ProjectTrackerStatsResponseSchema = z.object({
  type: z.literal("project.tracker.stats.response"),
  payload: z.object({
    requestId: z.string(),
    projectId: z.string(),
    counts: TrackerStatsCountsSchema.nullable(),
    error: z.string().nullable(),
    errorCode: TrackerErrorCodeSchema.nullable(),
  }),
});
