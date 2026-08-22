import type {
  AggregateLoadState,
  AggregatedTracker,
  TrackerProjectError,
} from "@/tracker/use-aggregated-trackers";

export type TrackerScreenBodyState =
  | { kind: "no-projects" }
  | { kind: "loading" }
  | { kind: "cli-missing" }
  | { kind: "uninitialised" }
  | { kind: "load-error"; message: string }
  | { kind: "empty" }
  | { kind: "content" };

export interface ResolveTrackerScreenBodyStateInput {
  hasAnyProject: boolean;
  /** True while the host's project list is still being fetched. Without it an
   * empty list reads as "this user has no projects" during the first seconds
   * of every cold load, and the screen shows a call-to-action it then replaces
   * with the whole tracker. */
  isProjectListLoading: boolean;
  loadState: AggregateLoadState<AggregatedTracker>;
  selectedProjectId: string | "all";
  projectErrors: TrackerProjectError[];
  visibleTrackersCount: number;
}

/**
 * Selecting one specific project surfaces its own failure as a full-screen
 * state (e.g. an actionable "Initialize tracker" button) because that IS the
 * whole screen for that project. In "all projects" mode a per-project failure
 * is a banner instead (rendered by the screen alongside empty/content) — the
 * rest of the board still renders from whatever projects succeeded.
 */
export function resolveTrackerScreenBodyState(
  input: ResolveTrackerScreenBodyStateInput,
): TrackerScreenBodyState {
  if (!input.hasAnyProject) {
    return input.isProjectListLoading ? { kind: "loading" } : { kind: "no-projects" };
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
  if (input.visibleTrackersCount === 0) {
    return { kind: "empty" };
  }
  return { kind: "content" };
}
