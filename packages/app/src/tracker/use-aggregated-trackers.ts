import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";
import {
  fetchAggregatedTrackers,
  trackerQueryBaseKey,
  type AggregatedTracker,
  type FetchAggregatedTrackersState,
  type TrackerProjectError,
  type TrackerProjectInput,
} from "@/tracker/aggregated-trackers";

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

  const query = useFetchQuery<FetchAggregatedTrackersState>({
    queryKey: [...trackerQueryBaseKey, projectIds.join("|"), all, connectionStatusKey],
    queryFn: () => fetchAggregatedTrackers({ projects, runtime, all }),
    enabled,
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  let loadState: AggregateLoadState<AggregatedTracker>;
  if (query.data?.status === "connecting") {
    loadState = { status: "connecting" };
  } else if (query.data?.status === "loaded") {
    loadState = { status: "loaded", data: query.data.data };
  } else {
    loadState = { status: "loading" };
  }

  return {
    loadState,
    projectErrors: query.data?.status === "loaded" ? query.data.projectErrors : [],
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
  };
}
