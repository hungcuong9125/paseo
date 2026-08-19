import { z } from "zod";

// Mirrors the `ait` CLI's own domain model (see the `ait` skill contract). Paseo does not persist
// this data — the daemon shells out to `ait` with the workspace's cwd, and `.ait/ait.db` in that
// directory is the source of truth.

export const IssueTypeSchema = z.enum(["initiative", "epic", "task"]);
export type IssueType = z.infer<typeof IssueTypeSchema>;

export const IssueStatusSchema = z.enum(["open", "in_progress", "closed", "cancelled"]);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

export const IssuePrioritySchema = z.enum(["P0", "P1", "P2", "P3", "P4"]);
export type IssuePriority = z.infer<typeof IssuePrioritySchema>;

// The slim shape `ait list` returns by default: enough for a row.
export const IssueSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  type: IssueTypeSchema,
  status: IssueStatusSchema,
  priority: IssuePrioritySchema,
  parentId: z.string().nullable(),
});
export type IssueSummary = z.infer<typeof IssueSummarySchema>;

export const IssueNoteSchema = z.object({
  id: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
export type IssueNote = z.infer<typeof IssueNoteSchema>;

// The `--long` shape `ait show` returns: full record plus children/blockers/notes.
export const IssueDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: IssueTypeSchema,
  status: IssueStatusSchema,
  priority: IssuePrioritySchema,
  parentId: z.string().nullable(),
  description: z.string().nullable(),
  claimedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  children: z.array(IssueSummarySchema),
  blockedBy: z.array(IssueSummarySchema),
  notes: z.array(IssueNoteSchema),
});
export type IssueDetail = z.infer<typeof IssueDetailSchema>;

export interface CreateIssueInput {
  title: string;
  issueType?: IssueType;
  priority?: IssuePriority;
  parentId?: string;
  description?: string;
}

export interface UpdateIssueInput {
  title?: string;
  status?: "open" | "in_progress";
  priority?: IssuePriority;
}
