import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TrackerStatsCounts } from "@getpaseo/protocol/tracker/rpc-schemas";
import {
  fetchTrackerStats,
  toTrackerProjectError,
  type TrackerProjectError,
  type TrackerProjectInput,
  type TrackerStatsRuntime,
} from "@/tracker/aggregated-trackers";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

type TrackerStatsBucket = TrackerStatsCounts["all"];

const STATS_TYPE_KEYS = ["all", "task", "epic", "initiative"] as const;

function emptyBucket(): TrackerStatsBucket {
  return {
    total: 0,
    byStatus: { open: 0, in_progress: 0, closed: 0, cancelled: 0 },
    byPriority: { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 },
  };
}

function addBucket(a: TrackerStatsBucket, b: TrackerStatsBucket): TrackerStatsBucket {
  return {
    total: a.total + b.total,
    byStatus: {
      open: a.byStatus.open + b.byStatus.open,
      in_progress: a.byStatus.in_progress + b.byStatus.in_progress,
      closed: a.byStatus.closed + b.byStatus.closed,
      cancelled: a.byStatus.cancelled + b.byStatus.cancelled,
    },
    byPriority: {
      P0: a.byPriority.P0 + b.byPriority.P0,
      P1: a.byPriority.P1 + b.byPriority.P1,
      P2: a.byPriority.P2 + b.byPriority.P2,
      P3: a.byPriority.P3 + b.byPriority.P3,
      P4: a.byPriority.P4 + b.byPriority.P4,
    },
  };
}

function sumTrackerStatsCounts(list: readonly TrackerStatsCounts[]): TrackerStatsCounts {
  const result = {
    all: emptyBucket(),
    task: emptyBucket(),
    epic: emptyBucket(),
    initiative: emptyBucket(),
  };
  for (const counts of list) {
    for (const key of STATS_TYPE_KEYS) {
      result[key] = addBucket(result[key], counts[key]);
    }
  }
  return result;
}

function projectKeyOf(project: TrackerProjectInput): string {
  return `${project.serverId}:${project.projectId}`;
}

export interface UseTrackerStatsOptions {
  projects: readonly TrackerProjectInput[];
  selectedProjectId: string | null;
  enabled: boolean;
}

export interface UseTrackerStatsResult {
  /** Summed across the projects that reported. A project that's offline,
   * lacks `aitTrackerStats`, or errors contributes nothing and is treated as
   * absent — one broken project no longer blanks every pill (pas-2KY5X.14).
   * `null` only while loading, or when a single *selected* project is the
   * whole scope and it didn't report: there the scope has exactly one
   * project, so a gap there really is "no data", not a partial total. */
  counts: TrackerStatsCounts | null;
  isLoading: boolean;
  /** One request per in-scope project already went out to fetch `counts` —
   * a project whose stats RPC fails (cli_missing, uninitialised, ...)
   * surfaces here, the same tolerance `fetchTrackerPage` uses. An offline
   * project, or one whose host doesn't advertise `aitTrackerStats`,
   * contributes neither an error nor a count — that gap is a capability or
   * connectivity fact, not a project-level failure worth a banner for. */
  projectErrors: TrackerProjectError[];
  refetch: () => void;
}

/**
 * Exact server-computed tracker counts for the toolbar stat pills — the
 * counterpart to useTrackerProjectData's per-status page loading, which only
 * ever holds the trackers actually paged in. `server_info.features.
 * aitTrackerStats` is read here and nowhere else in the app; every other
 * consumer just renders whatever `counts` this hook returns.
 */
export function useTrackerStats(options: UseTrackerStatsOptions): UseTrackerStatsResult {
  const runtime: TrackerStatsRuntime = getHostRuntimeStore();

  const relevantProjects = useMemo(
    () =>
      options.selectedProjectId
        ? options.projects.filter((project) => project.projectId === options.selectedProjectId)
        : options.projects,
    [options.projects, options.selectedProjectId],
  );

  const scopeKey = useMemo(
    () =>
      [
        options.enabled ? "1" : "0",
        options.selectedProjectId ?? "all",
        ...relevantProjects.map(projectKeyOf).sort(),
      ].join("|"),
    [options.enabled, options.selectedProjectId, relevantProjects],
  );

  // `client.getLastServerInfoMessage()` below is an imperative snapshot — safe
  // to read only inside a callback that itself re-runs when the thing it
  // reads changes. This selector is that trigger: `useSessionStore` is
  // reactive, so a project whose host connects (or whose `server_info`
  // arrives) after mount changes this string and re-runs `runFetch`, instead
  // of freezing `counts` at whatever the very first, possibly-too-early read
  // saw.
  const featureSupportKey = useSessionStore((state) =>
    relevantProjects
      .map(
        (project) =>
          `${project.serverId}:${
            state.sessions[project.serverId]?.serverInfo?.features?.aitTrackerStats === true
          }`,
      )
      .join("|"),
  );

  const [counts, setCounts] = useState<TrackerStatsCounts | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [projectErrors, setProjectErrors] = useState<TrackerProjectError[]>([]);
  const loadSeqRef = useRef(0);

  const runFetch = useCallback(async (): Promise<void> => {
    const seq = ++loadSeqRef.current;
    if (!options.enabled) {
      setCounts(null);
      setProjectErrors([]);
      setIsLoading(false);
      return;
    }
    if (relevantProjects.length === 0) {
      // Vacuously "every in-scope project reported" — an empty scope is a
      // real zero, not a gap, mirroring useTrackerProjectData's sectionTotals.
      setCounts(sumTrackerStatsCounts([]));
      setProjectErrors([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const perProject = await Promise.all(
      relevantProjects.map(async (project) => {
        const client = runtime.getClient(project.serverId);
        // A host too old to advertise aitTrackerStats can't serve any of
        // this feature — gate once, here (docs/protocol-compatibility.md),
        // and contribute nothing. Not an old-daemon error: that daemon was
        // never going to answer regardless of what's wrong with its tracker.
        if (!client || client.getLastServerInfoMessage()?.features?.aitTrackerStats !== true) {
          return { project, counts: null, error: null as unknown };
        }
        try {
          const result = await fetchTrackerStats({ project, runtime });
          return { project, counts: result.counts, error: null as unknown };
        } catch (error) {
          // Same tolerance fetchTrackerPage uses — an RPC failure (cli_missing,
          // uninitialised, ...) is exactly the case the bell exists to surface.
          return { project, counts: null, error };
        }
      }),
    );
    if (seq !== loadSeqRef.current) {
      return;
    }
    const countsList = perProject.map((entry) => entry.counts);
    const reportedCounts = countsList.filter((c): c is TrackerStatsCounts => c !== null);
    // "All projects": sum whoever reported, skip the rest — a project that
    // errors or lacks the capability is absent, not a poison (pas-2KY5X.14).
    // A single *selected* project is still all-or-nothing: with exactly one
    // project in scope, that project failing means there's genuinely no
    // data, so pills stay blank instead of showing a misleading zero.
    let nextCounts: TrackerStatsCounts | null;
    if (options.selectedProjectId === null) {
      nextCounts = sumTrackerStatsCounts(reportedCounts);
    } else {
      nextCounts =
        reportedCounts.length === countsList.length ? sumTrackerStatsCounts(reportedCounts) : null;
    }
    setCounts(nextCounts);
    setProjectErrors(
      perProject
        .filter((entry) => entry.error !== null)
        .map((entry) => toTrackerProjectError(entry.project, entry.error)),
    );
    setIsLoading(false);
    // scopeKey covers every option this closure reads; featureSupportKey is
    // the reactive trigger for the imperative getLastServerInfoMessage()
    // reads inside the Promise.all above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, featureSupportKey, runtime]);

  useEffect(() => {
    void runFetch();
  }, [runFetch]);

  const refetch = useCallback(() => {
    void runFetch();
  }, [runFetch]);

  return { counts, isLoading, projectErrors, refetch };
}
