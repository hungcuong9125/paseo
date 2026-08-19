import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { TrackerRpcError } from "@getpaseo/client/internal/daemon-client";
import type { TrackerErrorCode } from "@getpaseo/protocol/tracker/rpc-schemas";
import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";
import { toErrorMessage } from "@/utils/error-messages";

export const trackerQueryBaseKey = ["trackers"] as const;

/** A project known to the current host, regardless of whether it has an open
 * workspace — this is the whole point: Trackers/Tracker data lives at a
 * project's root (`.ait/ait.db`), not at a specific workspace directory. */
export interface TrackerProjectInput {
  serverId: string;
  serverName: string;
  projectId: string;
  projectName: string;
}

/** One tracker tagged with the project (and host) it came from, so a flat
 * aggregated list can render a per-row project label and scope mutations
 * without the caller having to track "current project" separately. */
export interface AggregatedTracker extends TrackerSummary {
  serverId: string;
  serverName: string;
  projectId: string;
  projectName: string;
}

export interface TrackerProjectError {
  serverId: string;
  serverName: string;
  projectId: string;
  projectName: string;
  message: string;
  code: TrackerErrorCode;
}

export interface TrackersRuntimeSnapshot {
  connectionStatus: string;
}

export interface TrackersRuntime {
  getClient(serverId: string): Pick<DaemonClient, "trackerList"> | null;
  getSnapshot(serverId: string): TrackersRuntimeSnapshot | null | undefined;
}

export interface FetchAggregatedTrackersConnectingResult {
  status: "connecting";
}

export interface FetchAggregatedTrackersResult {
  status: "loaded";
  data: AggregatedTracker[];
  projectErrors: TrackerProjectError[];
}

export type FetchAggregatedTrackersState =
  | FetchAggregatedTrackersConnectingResult
  | FetchAggregatedTrackersResult;

export interface FetchAggregatedTrackersInput {
  projects: readonly TrackerProjectInput[];
  runtime: TrackersRuntime;
  all: boolean;
}

/**
 * Fetch trackers across every known project (no shared database — each project
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
export async function fetchAggregatedTrackers(
  input: FetchAggregatedTrackersInput,
): Promise<FetchAggregatedTrackersState> {
  const hasSettlingProject = input.projects.some((project) =>
    isTrackersConnectionSettling(input.runtime.getSnapshot(project.serverId)),
  );
  const hasAskableProject = input.projects.some((project) => {
    const snapshot = input.runtime.getSnapshot(project.serverId);
    return snapshot?.connectionStatus === "online" && input.runtime.getClient(project.serverId);
  });

  if (!hasAskableProject && hasSettlingProject) {
    return { status: "connecting" };
  }

  const trackers: AggregatedTracker[] = [];
  const projectErrors: TrackerProjectError[] = [];

  await Promise.all(
    input.projects.map(async (project) => {
      const snapshot = input.runtime.getSnapshot(project.serverId);
      const isOnline = snapshot?.connectionStatus === "online";
      const client = input.runtime.getClient(project.serverId);
      if (!client || !isOnline) {
        return;
      }
      try {
        const result = await client.trackerList({ projectId: project.projectId, all: input.all });
        for (const tracker of result.trackers) {
          trackers.push({
            ...tracker,
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
          code: error instanceof TrackerRpcError ? error.code : "unknown",
        });
      }
    }),
  );

  if (trackers.length === 0 && projectErrors.length === 0 && hasSettlingProject) {
    return { status: "connecting" };
  }

  return { status: "loaded", data: trackers, projectErrors };
}

function isTrackersConnectionSettling(
  snapshot: TrackersRuntimeSnapshot | null | undefined,
): boolean {
  if (!snapshot) {
    return true;
  }
  return snapshot.connectionStatus === "connecting" || snapshot.connectionStatus === "idle";
}
