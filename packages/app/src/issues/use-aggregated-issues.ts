import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";
import {
  fetchAggregatedIssues,
  issuesQueryBaseKey,
  type AggregatedIssue,
  type FetchAggregatedIssuesState,
  type IssueProjectError,
  type IssueProjectInput,
} from "@/issues/aggregated-issues";

export type {
  AggregatedIssue,
  IssueProjectError,
  IssueProjectInput,
} from "@/issues/aggregated-issues";

export type AggregateLoadState<T> =
  | { status: "connecting" }
  | { status: "loading" }
  | { status: "loaded"; data: T[] };

export interface UseAggregatedIssuesOptions {
  projects: readonly IssueProjectInput[];
  all: boolean;
  enabled?: boolean;
}

export interface UseAggregatedIssuesResult {
  loadState: AggregateLoadState<AggregatedIssue>;
  projectErrors: IssueProjectError[];
  refetch: () => void;
  isRefetching: boolean;
}

export function useAggregatedIssues({
  projects,
  all,
  enabled = true,
}: UseAggregatedIssuesOptions): UseAggregatedIssuesResult {
  const runtime = getHostRuntimeStore();
  const serverIds = useMemo(() => [...new Set(projects.map((p) => p.serverId))].sort(), [projects]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const connectionStatusKey = useMemo(
    () => serverIds.map((serverId) => connectionStatuses.get(serverId) ?? "connecting").join("|"),
    [connectionStatuses, serverIds],
  );
  const projectIds = useMemo(() => projects.map((p) => p.projectId).sort(), [projects]);

  const query = useFetchQuery<FetchAggregatedIssuesState>({
    queryKey: [...issuesQueryBaseKey, projectIds.join("|"), all, connectionStatusKey],
    queryFn: () => fetchAggregatedIssues({ projects, runtime, all }),
    enabled,
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  let loadState: AggregateLoadState<AggregatedIssue>;
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
