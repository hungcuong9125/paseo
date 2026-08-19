import type {
  AggregateLoadState,
  AggregatedIssue,
  IssueProjectError,
} from "@/issues/use-aggregated-issues";

export type IssuesScreenBodyState =
  | { kind: "no-projects" }
  | { kind: "loading" }
  | { kind: "cli-missing" }
  | { kind: "uninitialised" }
  | { kind: "load-error"; message: string }
  | { kind: "empty" }
  | { kind: "content" };

export interface ResolveIssuesScreenBodyStateInput {
  hasAnyProject: boolean;
  loadState: AggregateLoadState<AggregatedIssue>;
  selectedProjectId: string | "all";
  projectErrors: IssueProjectError[];
  visibleIssuesCount: number;
}

/**
 * Selecting one specific project surfaces its own failure as a full-screen
 * state (e.g. an actionable "Initialize tracker" button) because that IS the
 * whole screen for that project. In "all projects" mode a per-project failure
 * is a banner instead (rendered by the screen alongside empty/content) — the
 * rest of the board still renders from whatever projects succeeded.
 */
export function resolveIssuesScreenBodyState(
  input: ResolveIssuesScreenBodyStateInput,
): IssuesScreenBodyState {
  if (!input.hasAnyProject) {
    return { kind: "no-projects" };
  }
  if (input.loadState.status === "connecting" || input.loadState.status === "loading") {
    return { kind: "loading" };
  }
  if (input.selectedProjectId !== "all") {
    const projectError = input.projectErrors.find(
      (error) => error.projectId === input.selectedProjectId,
    );
    if (projectError) {
      if (projectError.code === "cli_missing") {
        return { kind: "cli-missing" };
      }
      if (projectError.code === "uninitialised") {
        return { kind: "uninitialised" };
      }
      return { kind: "load-error", message: projectError.message };
    }
  }
  if (input.visibleIssuesCount === 0) {
    return { kind: "empty" };
  }
  return { kind: "content" };
}
