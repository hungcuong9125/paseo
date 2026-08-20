import { z } from "zod";

// Mirrors the `ait` CLI's own domain model (see the `ait` skill contract). Paseo does not persist
// this data — the daemon shells out to `ait` with the workspace's cwd, and `.ait/ait.db` in that
// directory is the source of truth.

export const TrackerTypeSchema = z.enum(["initiative", "epic", "task"]);
export type TrackerType = z.infer<typeof TrackerTypeSchema>;

export const TrackerStatusSchema = z.enum(["open", "in_progress", "closed", "cancelled"]);
export type TrackerStatus = z.infer<typeof TrackerStatusSchema>;

export const TrackerPrioritySchema = z.enum(["P0", "P1", "P2", "P3", "P4"]);
export type TrackerPriority = z.infer<typeof TrackerPrioritySchema>;

// The slim shape `ait list` returns by default: enough for a row.
export const TrackerSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  type: TrackerTypeSchema,
  status: TrackerStatusSchema,
  priority: TrackerPrioritySchema,
  parentId: z.string().nullable(),
  claimedBy: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  // Only ever set for `closed` — `ait` clears it on reopen and never sets it for `cancelled`.
  closedAt: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});
export type TrackerSummary = z.infer<typeof TrackerSummarySchema>;

export const TrackerNoteSchema = z.object({
  id: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
export type TrackerNote = z.infer<typeof TrackerNoteSchema>;

// The `--long` shape `ait show` returns: full record plus children/blockers/notes.
export const TrackerDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: TrackerTypeSchema,
  status: TrackerStatusSchema,
  priority: TrackerPrioritySchema,
  parentId: z.string().nullable(),
  description: z.string().nullable(),
  claimedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable().optional(),
  children: z.array(TrackerSummarySchema),
  blockedBy: z.array(TrackerSummarySchema),
  notes: z.array(TrackerNoteSchema),
});
export type TrackerDetail = z.infer<typeof TrackerDetailSchema>;

export interface CreateTrackerInput {
  title: string;
  trackerType?: TrackerType;
  priority?: TrackerPriority;
  parentId?: string;
  description?: string;
}

export interface UpdateTrackerInput {
  title?: string;
  status?: "open" | "in_progress";
  priority?: TrackerPriority;
}
