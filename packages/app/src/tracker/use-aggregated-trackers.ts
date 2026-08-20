import { useMemo } from "react";
import { skipToken } from "@tanstack/react-query";
import { useFetchQuery, useReplicaQueries } from "@/data/query";
import { trackerPushRoute } from "@/data/push-router";
import { getHostRuntimeStore, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";
import {
  fetchAggregatedTrackers,
  trackerQueryBaseKey,
  type AggregatedTracker,
  type FetchAggregatedTrackersState,
  type TrackerProjectError,
  type TrackerProjectInput,
} from "@/tracker/aggregated-trackers";
import type { TrackerErrorCode } from "@getpaseo/protocol/tracker/rpc-schemas";
import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";

export type {
  AggregatedTracker,
  TrackerProjectError,
  TrackerProjectInput,
} from "@/tracker/aggregated-trackers";

export type AggregateLoadState<T> =
  | { status: "connecting" }
  | { status: "loading" }
  | { status: "loaded"; data: T[] };

export interface UseAggregatedTrackersOptions {
  projects: readonly TrackerProjectInput[];
  all: boolean;
  enabled?: boolean;
}

export interface UseAggregatedTrackersResult {
  loadState: AggregateLoadState<AggregatedTracker>;
  projectErrors: TrackerProjectError[];
  refetch: () => void;
  isRefetching: boolean;
}

export function useAggregatedTrackers({
  projects,
  all,
  enabled = true,
}: UseAggregatedTrackersOptions): UseAggregatedTrackersResult {
  const runtime = getHostRuntimeStore();
  const serverIds = useMemo(() => [...new Set(projects.map((p) => p.serverId))].sort(), [projects]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectionStatusKey = useMemo(
    () => serverIds.map((serverId) => connectionStatuses.get(serverId) ?? "connecting").join("|"),
    [connectionStatuses, serverIds],
  );
  const projectIds = useMemo(() => projects.map((p) => p.projectId).sort(), [projects]);

  const liveEnabled = useMemo(
    () =>
      projects.length > 0 &&
      projects.every((project) => {
        const client = runtime.getSnapshot(project.serverId)?.client;
        return (
          connectionStatuses.get(project.serverId) === "online" &&
          client?.getLastServerInfoMessage()?.features?.aitTrackerLive === true
        );
      }),
    [connectionStatuses, projects, runtime],
  );
  const subscriptionIds = useMemo(() => {
    const next = new Map<string, string>();
    for (const project of projects) {
      next.set(`${project.serverId}:${project.projectId}:${all}`, crypto.randomUUID());
    }
    return next;
  }, [all, projects]);

  interface LiveSnapshot {
    subscriptionId: string;
    projectId: string;
    trackers: TrackerSummary[];
    hiddenCount: number;
    epoch: number;
    generation: number;
    error: string | null;
    errorCode: TrackerErrorCode | null;
  }
  const liveQueries = useReplicaQueries(
    projects.map((project) => {
      const subscriptionId = subscriptionIds.get(
        `${project.serverId}:${project.projectId}:${all}`,
      )!;
      return {
        queryKey: [...trackerQueryBaseKey, project.serverId, project.projectId, all] as const,
        queryFn: liveEnabled ? skipToken : skipToken,
        enabled: enabled && liveEnabled,
        staleTime: Infinity,
        gcTime: Infinity,
        meta: {
          serverData: trackerPushRoute({
            enabled: enabled && liveEnabled,
            serverId: project.serverId,
            projectId: project.projectId,
            all,
            subscriptionId,
          }),
        },
        pushEvent: "project.tracker.updated",
      };
    }),
  );

  const aggregateQuery = useFetchQuery<FetchAggregatedTrackersState>({
    queryKey: [...trackerQueryBaseKey, projectIds.join("|"), all, connectionStatusKey],
    queryFn: () => fetchAggregatedTrackers({ projects, runtime, all }),
    enabled: enabled && !liveEnabled,
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  if (liveEnabled) {
    const trackers: AggregatedTracker[] = [];
    const projectErrors: TrackerProjectError[] = [];
    for (let index = 0; index < projects.length; index += 1) {
      const project = projects[index]!;
      const snapshot = liveQueries[index]?.data as LiveSnapshot | undefined;
      if (!snapshot) continue;
      for (const tracker of snapshot.trackers) {
        trackers.push({ ...tracker, ...project });
      }
      if (snapshot.error && snapshot.errorCode) {
        projectErrors.push({ ...project, message: snapshot.error, code: snapshot.errorCode });
      }
    }
    const isLoading = liveQueries.some((liveQuery) => liveQuery.isPending);
    const liveRefetch = () => {
      for (const project of projects) {
        void runtime.getSnapshot(project.serverId)?.client?.trackerList({
          projectId: project.projectId,
          all,
        });
      }
    };
    return {
      loadState: isLoading ? { status: "loading" } : { status: "loaded", data: trackers },
      projectErrors,
      refetch: liveRefetch,
      isRefetching: liveQueries.some((liveQuery) => liveQuery.isFetching),
    };
  }

  let loadState: AggregateLoadState<AggregatedTracker>;
  if (aggregateQuery.data?.status === "connecting") {
    loadState = { status: "connecting" };
  } else if (aggregateQuery.data?.status === "loaded") {
    loadState = { status: "loaded", data: aggregateQuery.data.data };
  } else {
    loadState = { status: "loading" };
  }

  return {
    loadState,
    projectErrors:
      aggregateQuery.data?.status === "loaded" ? aggregateQuery.data.projectErrors : [],
    refetch: () => {
      void aggregateQuery.refetch();
    },
    isRefetching: aggregateQuery.isRefetching,
  };
}
