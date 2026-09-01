import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { TrackerRpcError } from "@getpaseo/client/internal/daemon-client";
import type { TrackerErrorCode, TrackerStatsCounts } from "@getpaseo/protocol/tracker/rpc-schemas";
import type {
  TrackerPriority,
  TrackerSort,
  TrackerStatus,
  TrackerSummary,
  TrackerType,
} from "@getpaseo/protocol/tracker/types";
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
  /** From ProjectDescriptor.aitInitialized (pas-2KY5X.28). `false` means the
   * daemon checked `.ait/ait.db` and it doesn't exist — callers should
   * exclude this project from any fetch/count rather than pay for an RPC
   * that can only fail. `undefined` means "unknown" (old daemon, or a
   * workspace-derived legacy descriptor with no wire answer) and must NOT be
   * treated as false — that's exactly today's pre-.28 behavior: include the
   * project, let a real request discover the failure. */
  aitInitialized?: boolean;
  /** From ProjectDescriptor.projectRootPath — carried here so a gated-out
   * project's bell row can build its `cd <dir> && ait init` copy command
   * directly, without ever having sent a request whose error message it
   * could otherwise regex-parse. */
  projectRootPath: string;
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
  /** Only set for an error synthesized from a gate (aitInitialized === false,
   * pas-2KY5X.28), so the bell row can build its copy command directly
   * instead of regex-parsing `message`. An error surfaced from a real failed
   * RPC leaves this unset — the regex path is still how those get a
   * directory, since the RPC layer that catches them doesn't have this. */
  projectRootPath?: string;
}

export interface TrackersRuntimeSnapshot {
  connectionStatus: string;
}

export interface TrackersRuntime {
  getClient(
    serverId: string,
  ): Pick<DaemonClient, "trackerList" | "trackerSearch" | "getLastServerInfoMessage"> | null;
  getSnapshot(serverId: string): TrackersRuntimeSnapshot | null | undefined;
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
 * unblocked tracker ids into one flat Set. An offline host, a server that
 * doesn't advertise `aitTrackerReady` yet, or a project whose RPC fails makes
 * the result unknown rather than treating every tracker from that project as
 * blocked. Per tracker-board-model.ts's `readyIds` contract, an id in the
 * result only matters for a tracker whose status is already "open".
 */
export async function fetchTrackerReadyIds(
  input: FetchTrackerReadyIdsInput,
): Promise<ReadonlySet<string> | null> {
  const readyIds = new Set<string>();
  let isComplete = true;

  await Promise.all(
    input.projects.map(async (project) => {
      const snapshot = input.runtime.getSnapshot(project.serverId);
      const isOnline = snapshot?.connectionStatus === "online";
      const client = input.runtime.getClient(project.serverId);
      if (!client || !isOnline) {
        isComplete = false;
        return;
      }
      if (client.getLastServerInfoMessage()?.features?.aitTrackerReady !== true) {
        isComplete = false;
        return;
      }
      try {
        const result = await client.trackerReady({ projectId: project.projectId });
        for (const id of result.readyIds) {
          readyIds.add(id);
        }
      } catch {
        isComplete = false;
      }
    }),
  );

  return isComplete ? readyIds : null;
}

/** Cursor pagination envelope from a paginated tracker response. `null` means
 * the server served the complete result without pagination (old CLI binary on
 * the daemon host, or an old daemon) — callers must treat that as "everything
 * is here, no more pages", which is different from `hasMore: false`. */
export interface TrackerPageInfo {
  hasMore: boolean;
  nextCursor: string | null;
  /** Rows matching the request's filters, from the daemon's `total_count`.
   * Absent when the CLI binary predates pagination. */
  totalCount?: number;
}

export interface FetchTrackerPageInput {
  project: TrackerProjectInput;
  runtime: TrackersRuntime;
  status?: TrackerStatus;
  type?: TrackerType;
  priority?: TrackerPriority;
  /** Server-side order (`server_info.features.aitTrackerSort` gates whether
   * the daemon's `ait` actually understands it — pas-2KY5X.15/.20). Omitted
   * entirely rather than sent-and-ignored when the capability is absent, so
   * an old daemon never has to reject an unknown flag. */
  sort?: TrackerSort;
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
 * empty page (same skip as fetchTrackerPage); RPC failures throw so the
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
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.sort !== undefined ? { sort: input.sort } : {}),
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

export interface TrackerStatsRuntime {
  getClient(
    serverId: string,
  ): Pick<DaemonClient, "trackerStats" | "getLastServerInfoMessage"> | null;
  getSnapshot(serverId: string): TrackersRuntimeSnapshot | null | undefined;
}

export interface FetchTrackerStatsInput {
  project: TrackerProjectInput;
  runtime: TrackerStatsRuntime;
}

export interface FetchTrackerStatsResult {
  counts: TrackerStatsCounts | null;
}

/**
 * One project's `project.tracker.stats` fetch — the counts-only counterpart
 * to fetchTrackerPage. Offline/no-client contributes nothing (`counts:
 * null`), same skip as fetchTrackerPage. An RPC failure throws so the
 * caller's fan-out can convert it into a per-project error, same as
 * fetchTrackerPage/searchTrackerPage.
 */
export async function fetchTrackerStats(
  input: FetchTrackerStatsInput,
): Promise<FetchTrackerStatsResult> {
  const snapshot = input.runtime.getSnapshot(input.project.serverId);
  const client = input.runtime.getClient(input.project.serverId);
  if (!client || snapshot?.connectionStatus !== "online") {
    return { counts: null };
  }
  const result = await client.trackerStats({ projectId: input.project.projectId });
  if (result.error) {
    throw new TrackerRpcError(result.errorCode ?? "unknown", result.error);
  }
  return { counts: result.counts };
}

/** Same per-project error mapping fetchTrackerPage uses for its fan-out,
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
