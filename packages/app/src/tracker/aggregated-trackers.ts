import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { TrackerRpcError } from "@getpaseo/client/internal/daemon-client";
import type { TrackerErrorCode } from "@getpaseo/protocol/tracker/rpc-schemas";
import type { TrackerStatus, TrackerSummary, TrackerType } from "@getpaseo/protocol/tracker/types";
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
  getClient(serverId: string): Pick<DaemonClient, "trackerList" | "trackerSearch"> | null;
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

export interface TrackerReadyRuntime {
  getClient(
    serverId: string,
  ): Pick<DaemonClient, "trackerReady" | "getLastServerInfoMessage"> | null;
  getSnapshot(serverId: string): TrackersRuntimeSnapshot | null | undefined;
}

export interface FetchTrackerReadyIdsInput {
  projects: readonly TrackerProjectInput[];
  runtime: TrackerReadyRuntime;
}

/**
 * Fan out `project.tracker.ready` across every known project and merge the
 * unblocked tracker ids into one flat Set — same resilience posture as
 * fetchAggregatedTrackers: an offline host, a server that doesn't advertise
 * `aitTrackerReady` yet, or a project whose RPC fails all just contribute
 * nothing rather than failing the whole fetch. Per
 * docs/refactors/tracker-kanban-redesign.md and tracker-board-model.ts's
 * `readyIds` contract, an id in the result only matters for a tracker whose
 * status is already "open" — everything else ignores it.
 */
export async function fetchTrackerReadyIds(
  input: FetchTrackerReadyIdsInput,
): Promise<ReadonlySet<string>> {
  const readyIds = new Set<string>();

  await Promise.all(
    input.projects.map(async (project) => {
      const snapshot = input.runtime.getSnapshot(project.serverId);
      const isOnline = snapshot?.connectionStatus === "online";
      const client = input.runtime.getClient(project.serverId);
      if (!client || !isOnline) {
        return;
      }
      if (client.getLastServerInfoMessage()?.features?.aitTrackerReady !== true) {
        return;
      }
      try {
        const result = await client.trackerReady({ projectId: project.projectId });
        for (const id of result.readyIds) {
          readyIds.add(id);
        }
      } catch {
        // Silently skip, same as an offline host — that project's items just stay in Open.
      }
    }),
  );

  return readyIds;
}

/** Cursor pagination envelope from a paginated tracker response. `null` means
 * the server served the complete result without pagination (old CLI binary on
 * the daemon host, or an old daemon) — callers must treat that as "everything
 * is here, no more pages", which is different from `hasMore: false`. */
export interface TrackerPageInfo {
  hasMore: boolean;
  nextCursor: string | null;
}

export interface FetchTrackerPageInput {
  project: TrackerProjectInput;
  runtime: TrackersRuntime;
  status?: TrackerStatus;
  type?: TrackerType;
  all: boolean;
  limit: number;
  cursor?: string;
}

export interface TrackerPageResult {
  trackers: AggregatedTracker[];
  pageInfo: TrackerPageInfo | null;
}

function tagTracker(tracker: TrackerSummary, project: TrackerProjectInput): AggregatedTracker {
  return { ...tracker, ...project };
}

/**
 * One paginated browse page for ONE project — the List view's replacement for
 * the live full-snapshot subscription. Offline/no-client projects contribute an
 * empty page (same skip as fetchAggregatedTrackers); RPC failures throw so the
 * caller's fan-out can convert them into a per-project error.
 */
export async function fetchTrackerPage(input: FetchTrackerPageInput): Promise<TrackerPageResult> {
  const snapshot = input.runtime.getSnapshot(input.project.serverId);
  const client = input.runtime.getClient(input.project.serverId);
  if (!client || snapshot?.connectionStatus !== "online") {
    return { trackers: [], pageInfo: null };
  }
  const result = await client.trackerList({
    projectId: input.project.projectId,
    all: input.all,
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.type !== undefined ? { trackerType: input.type } : {}),
    page: { limit: input.limit, ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) },
  });
  return {
    trackers: result.trackers.map((tracker) => tagTracker(tracker, input.project)),
    pageInfo: result.pageInfo ?? null,
  };
}

export interface SearchTrackerPageInput {
  project: TrackerProjectInput;
  runtime: TrackersRuntime;
  query: string;
  limit: number;
  cursor?: string;
}

/**
 * One search page for ONE project. Always a real server-side query (`ait
 * search`) — never a filter over whatever the browse view has loaded, so items
 * beyond the currently loaded pages stay findable.
 */
export async function searchTrackerPage(
  input: SearchTrackerPageInput,
): Promise<{ trackers: AggregatedTracker[]; pageInfo: TrackerPageInfo }> {
  const snapshot = input.runtime.getSnapshot(input.project.serverId);
  const client = input.runtime.getClient(input.project.serverId);
  if (!client || snapshot?.connectionStatus !== "online") {
    return { trackers: [], pageInfo: { hasMore: false, nextCursor: null } };
  }
  const result = await client.trackerSearch({
    projectId: input.project.projectId,
    query: input.query,
    page: { limit: input.limit, ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) },
  });
  return {
    trackers: result.trackers.map((tracker) => tagTracker(tracker, input.project)),
    pageInfo: result.pageInfo,
  };
}

/** Same per-project error mapping fetchAggregatedTrackers uses for its fan-out,
 * extracted for the one-shot pagination hooks' identical tolerance pattern. */
export function toTrackerProjectError(
  project: TrackerProjectInput,
  error: unknown,
): TrackerProjectError {
  return {
    serverId: project.serverId,
    serverName: project.serverName,
    projectId: project.projectId,
    projectName: project.projectName,
    message: toErrorMessage(error),
    code: error instanceof TrackerRpcError ? error.code : "unknown",
  };
}
