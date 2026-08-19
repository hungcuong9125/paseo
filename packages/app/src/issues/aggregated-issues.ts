import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { IssuesRpcError } from "@getpaseo/client/internal/daemon-client";
import type { IssuesErrorCode } from "@getpaseo/protocol/issues/rpc-schemas";
import type { IssueSummary } from "@getpaseo/protocol/issues/types";
import { toErrorMessage } from "@/utils/error-messages";

export const issuesQueryBaseKey = ["issues"] as const;

/** A project known to the current host, regardless of whether it has an open
 * workspace — this is the whole point: Issues/Tracker data lives at a
 * project's root (`.ait/ait.db`), not at a specific workspace directory. */
export interface IssueProjectInput {
  serverId: string;
  serverName: string;
  projectId: string;
  projectName: string;
}

/** One issue tagged with the project (and host) it came from, so a flat
 * aggregated list can render a per-row project label and scope mutations
 * without the caller having to track "current project" separately. */
export interface AggregatedIssue extends IssueSummary {
  serverId: string;
  serverName: string;
  projectId: string;
  projectName: string;
}

export interface IssueProjectError {
  serverId: string;
  serverName: string;
  projectId: string;
  projectName: string;
  message: string;
  code: IssuesErrorCode;
}

export interface IssuesRuntimeSnapshot {
  connectionStatus: string;
}

export interface IssuesRuntime {
  getClient(serverId: string): Pick<DaemonClient, "issuesList"> | null;
  getSnapshot(serverId: string): IssuesRuntimeSnapshot | null | undefined;
}

export interface FetchAggregatedIssuesConnectingResult {
  status: "connecting";
}

export interface FetchAggregatedIssuesResult {
  status: "loaded";
  data: AggregatedIssue[];
  projectErrors: IssueProjectError[];
}

export type FetchAggregatedIssuesState =
  | FetchAggregatedIssuesConnectingResult
  | FetchAggregatedIssuesResult;

export interface FetchAggregatedIssuesInput {
  projects: readonly IssueProjectInput[];
  runtime: IssuesRuntime;
  all: boolean;
}

/**
 * Fetch issues across every known project (no shared database — each project
 * keeps its own `.ait/ait.db`, we just fan the same request out in parallel,
 * mirroring how `web-ait` itself polls each registered project independently)
 * and merge them into one flat, project-tagged list.
 *
 * A project whose host is offline is skipped. A connected project that fails
 * (missing CLI, uninitialised tracker, etc.) contributes a structured entry to
 * `projectErrors` — surfaced as a banner or a full-screen state depending on
 * whether the caller is viewing "all projects" or one specific project — while
 * every other project still renders. This never throws: a fully-failed fetch
 * still resolves to `{status:"loaded", data:[], projectErrors:[...]}` so the
 * caller can inspect exactly which project failed and why.
 */
export async function fetchAggregatedIssues(
  input: FetchAggregatedIssuesInput,
): Promise<FetchAggregatedIssuesState> {
  const hasSettlingProject = input.projects.some((project) =>
    isIssuesConnectionSettling(input.runtime.getSnapshot(project.serverId)),
  );
  const hasAskableProject = input.projects.some((project) => {
    const snapshot = input.runtime.getSnapshot(project.serverId);
    return snapshot?.connectionStatus === "online" && input.runtime.getClient(project.serverId);
  });

  if (!hasAskableProject && hasSettlingProject) {
    return { status: "connecting" };
  }

  const issues: AggregatedIssue[] = [];
  const projectErrors: IssueProjectError[] = [];

  await Promise.all(
    input.projects.map(async (project) => {
      const snapshot = input.runtime.getSnapshot(project.serverId);
      const isOnline = snapshot?.connectionStatus === "online";
      const client = input.runtime.getClient(project.serverId);
      if (!client || !isOnline) {
        return;
      }
      try {
        const result = await client.issuesList({ projectId: project.projectId, all: input.all });
        for (const issue of result.issues) {
          issues.push({
            ...issue,
            serverId: project.serverId,
            serverName: project.serverName,
            projectId: project.projectId,
            projectName: project.projectName,
          });
        }
      } catch (error) {
        projectErrors.push({
          serverId: project.serverId,
          serverName: project.serverName,
          projectId: project.projectId,
          projectName: project.projectName,
          message: toErrorMessage(error),
          code: error instanceof IssuesRpcError ? error.code : "unknown",
        });
      }
    }),
  );

  if (issues.length === 0 && projectErrors.length === 0 && hasSettlingProject) {
    return { status: "connecting" };
  }

  return { status: "loaded", data: issues, projectErrors };
}

function isIssuesConnectionSettling(snapshot: IssuesRuntimeSnapshot | null | undefined): boolean {
  if (!snapshot) {
    return true;
  }
  return snapshot.connectionStatus === "connecting" || snapshot.connectionStatus === "idle";
}
