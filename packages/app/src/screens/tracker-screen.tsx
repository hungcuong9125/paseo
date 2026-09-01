import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type Animated,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
  type StyleProp,
  type TextStyle,
} from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Bell,
  Check,
  ChevronDown,
  Copy,
  LayoutGrid,
  ListChecks,
  ListFilter,
  Plus,
  RefreshCw,
  X,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { TrackerStatsCounts } from "@getpaseo/protocol/tracker/rpc-schemas";
import type {
  TrackerPriority,
  TrackerStatus,
  TrackerSummary,
  TrackerType,
} from "@getpaseo/protocol/tracker/types";
import { MenuHeader } from "@/components/headers/menu-header";
import { TrackerDetailSheet } from "@/components/tracker/tracker-detail-sheet";
import { TrackerEditSheet } from "@/components/tracker/tracker-edit-sheet";
import { TrackerFormSheet } from "@/components/tracker/tracker-form-sheet";
import { TrackerKanbanBoard } from "@/components/tracker/tracker-kanban-board";
import { TrackerListSkeleton } from "@/components/tracker/tracker-skeletons";
import { TrackerTable, useTrackerPageStep } from "@/components/tracker/tracker-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  type DropdownMenuTriggerState,
} from "@/components/ui/dropdown-menu";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SkeletonPulse, useSkeletonPulse } from "@/components/ui/skeleton";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { SearchField } from "@/components/ui/search-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { openExternalUrl } from "@/utils/open-external-url";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useProjects } from "@/hooks/use-projects";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { useHydratedWorkspaceServerIds } from "@/stores/session-store-hooks";
import {
  fetchTrackerReadyIds,
  trackerQueryBaseKey,
  type AggregatedTracker,
  type TrackerProjectError,
  type TrackerProjectInput,
} from "@/tracker/aggregated-trackers";
import { useTrackerMutations } from "@/tracker/use-tracker-mutations";
// Both List and Kanban read the same first page per section and page further
// only on an explicit loadMore. User mutations patch the loaded rows and the
// section totals in place; refreshes handle changes made outside Paseo.
import { useTrackerProjectData } from "@/tracker/use-tracker-project-data";
import { useTrackerStats } from "@/tracker/use-tracker-stats";
import { useTrackerSearch } from "@/tracker/use-tracker-search";
import { buildTrackerHierarchy, type TrackerHierarchy } from "@/tracker/tracker-hierarchy";
import type { TrackerBoardLaneKey } from "@/tracker/tracker-board-model";
import {
  listVisibleStatusesForFilter,
  matchesListStatFilter,
  type TrackerStatCounts,
  type TrackerStatFilter,
} from "@/tracker/tracker-stats";
import type { TrackerTransition } from "@/tracker/tracker-transitions";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { resolveTrackerScreenBodyState, type TrackerScreenBodyState } from "./tracker-screen-state";

type StatFilter = TrackerStatFilter;
type ViewMode = "list" | "kanban";
// The shared tracker-type filter's domain: the real TrackerType union plus an
// "all" sentinel for the fourth toggle option. One state drives BOTH the Kanban
// board's `kanbanTrackers` and the List view's `visibleTrackers` (see the
// task paseo-PQNMc.2 spec) — filtering happens here, not inside
// buildTrackerBoard, which stays status-only per its own docstring. Default is
// "all", for the same reason listStatFilter/kanbanStatFilter below default to
// "all": a project whose open work happens to be entirely epics/initiatives
// must show that on first load, not read as empty because the type filter
// silently narrowed to "task" underneath it (pas-2KY5X.52).
type TypeFilter = TrackerType | "all";

const TYPE_FILTER_DEFS: ReadonlyArray<{ value: TypeFilter; labelKey: string }> = [
  { value: "task", labelKey: "tracker.kanban.type.tasks" },
  { value: "epic", labelKey: "tracker.kanban.type.epics" },
  { value: "initiative", labelKey: "tracker.kanban.type.initiatives" },
  { value: "all", labelKey: "tracker.kanban.type.all" },
];

// sessionStorage, not the persisted app store: this remembers the choice for
// "reload this tab", not across app restarts or other tabs — closer to how a
// scroll position survives a reload than to a saved setting. Desktop/tablet
// only; compact always mounts on List regardless of what's stored (see the
// `isCompact` guards on both read and write below), so a phone session can
// never override the desktop tab's remembered view and vice versa.
const TRACKER_VIEW_MODE_STORAGE_KEY = "paseo:tracker:view-mode";

function readStoredViewMode(): ViewMode | null {
  if (!isWeb) {
    return null;
  }
  try {
    const stored = window.sessionStorage.getItem(TRACKER_VIEW_MODE_STORAGE_KEY);
    return stored === "list" || stored === "kanban" ? stored : null;
  } catch {
    // Private-browsing storage lockouts and similar — the in-memory state
    // still works for the rest of the session, it just won't survive reload.
    return null;
  }
}

function writeStoredViewMode(mode: ViewMode): void {
  if (!isWeb) {
    return;
  }
  try {
    window.sessionStorage.setItem(TRACKER_VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // See readStoredViewMode.
  }
}

// Mirrors sessions-screen.tsx's own search field/debounce — List-only (see
// the `viewMode === "list"` gate in TrackerSearchRow): Kanban's board already
// finds an item by scanning its column, and title+id substring search over a
// swimlane grouping is a different feature this doesn't attempt.
const TRACKER_SEARCH_DEBOUNCE_MS = 200;
const TRACKER_SEARCH_MIN_LENGTH = 3;

// Toolbar width, not a breakpoint: opening the sidebar takes ~320px off this
// row without changing the window breakpoint, so a breakpoint cannot tell
// whether the three toolbar groups fit on one line. Measured natural widths at
// the widest content (Kanban's six priority pills): project picker + pills 923,
// type filter + New item 381, plus the 12 gap and the row's 24 inset each side
// — 1364. Rounded up to leave the pills a little slack before they start
// scrolling.
const TOOLBAR_SINGLE_ROW_MIN_WIDTH = 1440;

// Width of a loading pill's count skeleton — the real count has no reserved
// column (it sizes to its own digits), but the placeholder has no digits to
// size to, so it needs an explicit width standing in for a plausible one.
const STAT_COUNT_WIDTH = 24;

// Below TRACKER_SEARCH_MIN_LENGTH, every keystroke would re-filter the full
// tracker set for a query too short to narrow anything useful — treat it as
// "not searching" instead. Trailing spaces count toward that length (and stay
// in the needle) rather than being trimmed away, so "v1 " (4 chars) narrows to
// the "v1" prefix instead of also matching "v10", "v123", etc. — only an
// all-whitespace query is treated as empty.

// Extracted purely to keep these `??` fallbacks out of TrackerScreenContent's
// own cyclomatic complexity count — no behavior change from inlining them.
function trackerFormDefaults(selectedProject: TrackerProjectInput | null): {
  serverId: string | null;
  projectId: string | null;
  projectName: string | null;
} {
  return {
    serverId: selectedProject?.serverId ?? null,
    projectId: selectedProject?.projectId ?? null,
    projectName: selectedProject?.projectName ?? null,
  };
}

function trackerDetailProps(selectedTracker: AggregatedTracker | null): {
  serverId: string;
  projectId: string;
  trackerId: string | null;
} {
  return {
    serverId: selectedTracker?.serverId ?? "",
    projectId: selectedTracker?.projectId ?? "",
    trackerId: selectedTracker?.id ?? null,
  };
}

function gateTrackerSearch(debounced: string): string {
  if (debounced.trim().length === 0) {
    return "";
  }
  return debounced.length >= TRACKER_SEARCH_MIN_LENGTH ? debounced : "";
}

// Extracted to keep the switch's branches out of TrackerScreenContent's own
// cyclomatic complexity — the one-transition-matrix rule lives in
// tracker-transitions.ts, this just dispatches to the matching RPC.
function callTrackerTransition(
  client: DaemonClient,
  aggregated: AggregatedTracker,
  transition: TrackerTransition,
): Promise<TrackerSummary> {
  switch (transition.kind) {
    case "update":
      return client.trackerUpdate({
        projectId: aggregated.projectId,
        trackerId: aggregated.id,
        status: transition.status,
      });
    case "close":
      return client.trackerClose({ projectId: aggregated.projectId, trackerId: aggregated.id });
    case "reopen":
      return client.trackerReopen({ projectId: aggregated.projectId, trackerId: aggregated.id });
    case "cancel":
      // `reason` is optional on trackerCancel and is not collected in this pass.
      return client.trackerCancel({ projectId: aggregated.projectId, trackerId: aggregated.id });
  }
}

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedListFilter = withUnistyles(ListFilter);
const ThemedBell = withUnistyles(Bell);
const ThemedCopy = withUnistyles(Copy);
const ThemedCheck = withUnistyles(Check);
const ThemedX = withUnistyles(X);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
// Red on hover in light mode reads as an alert; on dark it would nearly
// vanish against a near-black surface, so dark hover goes to plain
// foreground (white) instead — brighter than the muted grey at rest, same
// idea as the light-mode hover, without picking a colour that disappears.
function bellIconColor(theme: Theme, isHovered: boolean): string {
  if (!isHovered) {
    return theme.colors.foregroundMuted;
  }
  return theme.colorScheme === "dark" ? theme.colors.foreground : theme.colors.palette.red[600];
}
const inverseColorMapping = (theme: Theme) => ({ color: theme.colors.surface0 });
const STAT_FILTER_TO_PRIORITY: Readonly<Partial<Record<StatFilter, TrackerPriority>>> = {
  p0: "P0",
  p1: "P1",
  p2: "P2",
  p3: "P3",
  p4: "P4",
};

// The p0-p4 values are the only StatFilter members that name a dataset
// narrowing rather than a status/lane projection — see the priority-vs-status
// split documented on useTrackerListView below.
function isPriorityStatFilter(filter: StatFilter): boolean {
  return filter in STAT_FILTER_TO_PRIORITY;
}

// Only fetched in Kanban mode — List does not render readiness indicators. The
// fetch itself (fetchTrackerReadyIds) is per-project resilient: a project whose
// server predates `aitTrackerReady`, is offline, or errors makes readiness
// unknown, so those items stay in Open without a Blocked badge.
interface TrackerReadyQuery {
  ids: ReadonlySet<string> | null;
  refetch: () => void;
  isFetching: boolean;
}

function useTrackerReadyIds(options: {
  viewMode: ViewMode;
  projects: readonly TrackerProjectInput[];
  selectedProjectId: string | null;
}): TrackerReadyQuery {
  const relevantProjects = useMemo(
    () =>
      options.selectedProjectId
        ? options.projects.filter((project) => project.projectId === options.selectedProjectId)
        : options.projects,
    [options.projects, options.selectedProjectId],
  );
  const query = useFetchQuery<ReadonlySet<string> | null>({
    queryKey: [
      ...trackerQueryBaseKey,
      "ready",
      relevantProjects.map((project) => `${project.serverId}:${project.projectId}`).join("|"),
    ],
    queryFn: () =>
      fetchTrackerReadyIds({ projects: relevantProjects, runtime: getHostRuntimeStore() }),
    enabled: options.viewMode === "kanban" && relevantProjects.length > 0,
    dataShape: "value",
    staleTimeMs: 5_000,
  });
  const { refetch: refetchQuery } = query;
  const refetch = useCallback(() => {
    void refetchQuery();
  }, [refetchQuery]);
  return {
    ids: query.data ?? null,
    refetch,
    isFetching: query.isFetching,
  };
}

// List view's data source switch: browse mode reads `browseTrackers` — the
// same shared project-data array Kanban renders from, already scoped to the
// active type/priority filters server-side (see useTrackerProjectData's
// `type`/`priority` options in TrackerScreenContent); search mode always
// queries the server (project.tracker.search) and never filters what browse
// has loaded. Kanban never depends on isListSearch at all — only this hook
// (and TrackerTable's own rendering) branches on it.
function useTrackerListView(options: {
  hasAnyProject: boolean;
  viewMode: ViewMode;
  search: string;
  selectedProjectId: string | null;
  projects: TrackerProjectInput[];
  listStatFilter: StatFilter;
  browseTrackers: AggregatedTracker[];
}): {
  isListSearch: boolean;
  searchState: ReturnType<typeof useTrackerSearch>;
  listViewTrackers: AggregatedTracker[];
} {
  const isListSearch = options.viewMode === "list" && options.search.length > 0;
  const pageStep = useTrackerPageStep();
  const searchState = useTrackerSearch({
    projects: options.projects,
    selectedProjectId: options.selectedProjectId,
    query: options.search,
    enabled: options.hasAnyProject && options.viewMode === "list" && isListSearch,
    pageSize: pageStep,
  });
  // Search has no server-side status/priority filter (project.tracker.search
  // takes only a query), so it keeps the full client-side matchesListStatFilter
  // application. Browse is already priority-scoped server-side, so a priority
  // value here narrows nothing further — it would only re-confirm every row
  // still matches. A status value (open/in_progress/done/all) still applies:
  // it never truncates a section that stays visible, it only empties out
  // (hides) whole sections that don't match, which is section visibility, not
  // dataset selection — see docs/refactors/tracker-lazy-counts.md.
  const listViewTrackers = useMemo(() => {
    if (isListSearch) {
      return options.listStatFilter === "all"
        ? searchState.results
        : searchState.results.filter((tracker) =>
            matchesListStatFilter(tracker, options.listStatFilter),
          );
    }
    return options.listStatFilter === "all" || isPriorityStatFilter(options.listStatFilter)
      ? options.browseTrackers
      : options.browseTrackers.filter((tracker) =>
          matchesListStatFilter(tracker, options.listStatFilter),
        );
  }, [isListSearch, searchState.results, options.browseTrackers, options.listStatFilter]);
  return { isListSearch, searchState, listViewTrackers };
}

interface ContentWidth {
  ref: Ref<View>;
  /** Null only on native's very first frame; see the hook's docstring. */
  value: number | null;
  onLayout: (event: LayoutChangeEvent) => void;
}

/**
 * Width of the tracker screen's own content box, measured on the screen root
 * so it survives the List/Kanban switch (which re-parents and remounts the
 * toolbar) and so the Kanban board — which mounts later, once data lands —
 * never has to measure anything itself.
 *
 * It has to be measured rather than derived from a breakpoint: opening the
 * agent sidebar takes its width straight off this box without changing the
 * window breakpoint at all, so no media query can tell whether the toolbar's
 * three groups fit on one line.
 *
 * Two sources, deliberately. `onLayout` is the durable one — it also fires
 * when the sidebar is dragged or the window resized — but it lands one frame
 * after mount, so the first painted frame would see `null`, render the
 * stacked arrangement and then visibly snap to the single-row one. The layout
 * effect closes that gap on web: it runs after the DOM exists but before the
 * browser paints, so the first frame the user ever sees is already correct.
 * Native has no pre-paint measurement and needs none — every native form
 * factor is compact, where the arrangement is the same at any width.
 */
function useContentWidth(): ContentWidth {
  const ref = useRef<View>(null);
  const [value, setValue] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!isWeb) {
      return;
    }
    const node = ref.current as unknown as HTMLElement | null;
    const measured = node?.getBoundingClientRect?.().width;
    if (typeof measured === "number" && measured > 0) {
      setValue(measured);
    }
  }, []);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setValue(event.nativeEvent.layout.width);
  }, []);

  return { ref, value, onLayout };
}

export function TrackerScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <TrackerScreenContent isFocused={isFocused} />;
}

function TrackerScreenContent({ isFocused }: { isFocused: boolean }): ReactElement {
  const { projects: projectSummaries } = useProjects();
  // "No projects" is a call to action, not a loading state, so it must not be
  // shown until every host has actually delivered its project list.
  // useProjects()'s own isLoading tracks the *agent* directory, which lands
  // before the workspace/project one — reading it here flashed "Open a project"
  // over the whole screen for a few hundred milliseconds on every cold load.
  //
  // An empty host list counts as loading too, not as "no projects": startup
  // routing sends a genuinely host-less app to the welcome route (see
  // resolveHostRuntimeBootstrapDecision), so this screen only ever sees it
  // while the registry is still filling in.
  const hosts = useHosts();
  const hostIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const hydratedHostIds = useHydratedWorkspaceServerIds(hostIds);
  const isProjectListLoading = hostIds.length === 0 || hydratedHostIds.length < hostIds.length;
  const projectInputs = useMemo<TrackerProjectInput[]>(
    () =>
      projectSummaries.flatMap((project) =>
        project.hosts.map((host) => ({
          serverId: host.serverId,
          serverName: host.serverName,
          projectId: host.projectId,
          projectName: host.projectName,
          aitInitialized: host.aitInitialized,
          projectRootPath: host.repoRoot,
        })),
      ),
    [projectSummaries],
  );
  // Every project whose descriptor has affirmatively said "no .ait/ait.db"
  // (aitInitialized === false) — undefined stays in, since that means
  // "unknown" (an old daemon, or a workspace-derived legacy descriptor with
  // no wire answer), not "excluded" (pas-2KY5X.28). This is what actually
  // drives the tracker fetch/count below: gating it out here, before any
  // request goes out, is the whole point of the feature — a project with no
  // database was previously only discovered as unusable by attempting (and
  // paying for) a real RPC and having it fail.
  const initializedProjectInputs = useMemo(
    () => projectInputs.filter((project) => project.aitInitialized !== false),
    [projectInputs],
  );
  const hasAnyProject = projectInputs.length > 0;

  // Two independent filter states rendered through the same toolbar control (see
  // docs/refactors/tracker-kanban-redesign.md, "Toolbar contract"): in List mode
  // statFilter filters the dataset; in Kanban mode it only projects which lanes
  // are visible. Both default to "all" so arriving at the screen shows
  // everything rather than a filtered subset that reads as "missing items".
  const [listStatFilter, setListStatFilter] = useState<StatFilter>("all");
  const [kanbanStatFilter, setKanbanStatFilter] = useState<StatFilter>("all");
  // Shared by BOTH views: which tracker granularities are included. Defaults
  // to "all", matching listStatFilter/kanbanStatFilter above — see the
  // TypeFilter comment for why (pas-2KY5X.52).
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  // Desktop/tablet defaults to Kanban and remembers the last choice across a
  // reload (sessionStorage — see readStoredViewMode); compact always mounts on
  // List and never reads or writes that memory, so switching view on a phone
  // can't clobber what a desktop tab remembers, or vice versa.
  const isCompact = useIsCompactFormFactor();
  const [viewMode, setViewModeState] = useState<ViewMode>(() =>
    isCompact ? "list" : (readStoredViewMode() ?? "kanban"),
  );
  const setViewMode = useCallback(
    (next: ViewMode) => {
      setViewModeState(next);
      if (!isCompact) {
        writeStoredViewMode(next);
      }
    },
    [isCompact],
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTracker, setSelectedTracker] = useState<AggregatedTracker | null>(null);
  // One shared edit target for BOTH views — the List row kebab and the Kanban
  // card kebab both set this; TrackerEditSheet renders from it.
  const [editingTracker, setEditingTracker] = useState<AggregatedTracker | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const search = gateTrackerSearch(useDebouncedValue(searchInput, TRACKER_SEARCH_DEBOUNCE_MS));

  useEffect(() => {
    if (selectedProjectId && !projectInputs.some((p) => p.projectId === selectedProjectId)) {
      setSelectedProjectId(null);
    }
  }, [projectInputs, selectedProjectId]);

  // Priority narrows the fetch for both views. Kanban's buildTrackerBoard
  // already drops non-matching cards client-side (tracker-board-model.ts),
  // so sending the same priority server-side produces the identical card
  // set — cheaper, and it makes laneTotals (built from sectionTotals) match
  // what each lane actually renders instead of an all-priority overcount
  // (pas-2KY5X.10). Status stays List-only below: Kanban's own status filter
  // (kanbanStatFilter) only projects which lanes are visible, it never
  // narrows the dataset, so pushing it would drop cards other lanes need.
  const priorityOption = useMemo(
    () => STAT_FILTER_TO_PRIORITY[viewMode === "list" ? listStatFilter : kanbanStatFilter],
    [viewMode, listStatFilter, kanbanStatFilter],
  );
  // Which sections to keep loaded. Kanban always needs all four — it renders
  // all four lanes from this one shared fetch. List with a priority filter
  // also needs all four (priority spans every status). Only a status-shaped
  // List filter (open/in_progress/done) narrows this to the exactly one
  // section it shows — `undefined` here means "all four", matching the
  // hook's own default, so this stays `undefined` for every other case
  // instead of an equivalent-but-different four-element array.
  const sectionsOption = useMemo(
    () =>
      viewMode === "list" && !isPriorityStatFilter(listStatFilter) && listStatFilter !== "all"
        ? listVisibleStatusesForFilter(listStatFilter)
        : undefined,
    [viewMode, listStatFilter],
  );
  // The single shared data source for both List and Kanban — always running
  // regardless of view mode or search. Switching view mode only changes how
  // this array renders, never how it loads. Scoped internally to
  // `selectedProjectId`, `typeFilter`, the List priority filter, and which
  // status sections `sectionsOption` asks for.
  //
  // `trackers` still needs the List status filter applied on top of it:
  // narrowing `sectionsOption` stops the hook fetching a section, but it
  // deliberately keeps sections it already loaded rather than discarding
  // them, so a section can outlive the filter that asked for it.
  // One page step for the whole screen: what a section fetches, what the
  // "Show N more" label promises, and what search pages by. In All-projects
  // mode this is a shared budget across every relevant project — a k-way
  // merge over each project's newest-first stream, gated on
  // `server_info.features.aitTrackerSort` — rather than a page per project.
  const browsePageSize = useTrackerPageStep();
  const projectData = useTrackerProjectData({
    projects: initializedProjectInputs,
    selectedProjectId,
    all: true,
    enabled: hasAnyProject,
    pageSize: browsePageSize,
    type: typeFilter === "all" ? undefined : typeFilter,
    priority: priorityOption,
    sections: sectionsOption,
  });
  // Exact server-computed counts for the toolbar stat pills — a separate
  // fetch from projectData because it has to stay unfiltered by
  // listStatFilter/kanbanStatFilter (the pills show every bucket at once) and
  // report every tracker type at once (one bucket per type), which the
  // paginated `projectData.trackers` array can't do once type is scoped into
  // its own fetch. Scoped to initializedProjectInputs, not projectInputs
  // (pas-2KY5X.28): a project the descriptor already says has no `.ait/ait.db`
  // gets excluded before ever costing a stats RPC round-trip, which used to
  // be the only way this hook discovered "uninitialised" at all.
  const stats = useTrackerStats({
    projects: initializedProjectInputs,
    selectedProjectId,
    enabled: hasAnyProject,
  });

  // The header bell reports "which projects in this workspace need `ait
  // init`" — a workspace-wide fact, unrelated to which project the toolbar
  // picker has narrowed the List/Kanban data to, or to the type/priority
  // filters. `stats.projectErrors` is scoped to the picker (by design, so a
  // wrong project doesn't pay for fetching data nobody's viewing), so it goes
  // silent on every project except whichever one is currently selected. A
  // second, unscoped-ish stats call keeps the bell honest for the rest — but
  // it excludes whatever project `stats` above already selected, since that
  // one's errors already surface in `stats.projectErrors`; fetching it again
  // here was a wasted duplicate request every mount with a project selected
  // (pas-2KY5X.8). "All projects" mode needs no separate bell fetch at all:
  // `stats` is already unscoped there, so this stays disabled and
  // `bellProjectErrors` reads `stats.projectErrors` directly.
  const isProjectFiltered = selectedProjectId !== null;
  // Scoped to initializedProjectInputs like `stats` above — a gated-out
  // project has nothing left to discover here via an RPC (its bell row comes
  // from gatedProjectErrors below instead), so probing it would just be
  // another wasted request (pas-2KY5X.28).
  const bellProjects = useMemo(
    () => initializedProjectInputs.filter((project) => project.projectId !== selectedProjectId),
    [initializedProjectInputs, selectedProjectId],
  );
  const bellStats = useTrackerStats({
    projects: bellProjects,
    selectedProjectId: null,
    enabled: hasAnyProject && isProjectFiltered,
  });
  // Second source of bell rows (pas-2KY5X.28): a project the descriptor
  // already says has no `.ait/ait.db` never gets requested, so it can never
  // surface through stats/bellStats' RPC-failure path above — this
  // synthesizes the identical TrackerProjectError shape TrackerErrorRow
  // already renders, straight from the descriptor. Always included
  // (independent of isProjectFiltered) since aitInitialized is a fact about
  // the project, not about what the toolbar picker currently has selected —
  // the same "workspace-wide" posture the comment above already established
  // for this list. projectRootPath is attached directly, so the row's copy
  // command doesn't need to regex-parse anything (there is no RPC error
  // message to parse from).
  const gatedProjectErrors = useMemo<TrackerProjectError[]>(
    () =>
      projectInputs
        .filter((project) => project.aitInitialized === false)
        .map((project) => ({
          serverId: project.serverId,
          serverName: project.serverName,
          projectId: project.projectId,
          projectName: project.projectName,
          message: `no ait database at ${project.projectRootPath}/.ait/ait.db — run 'ait init' first`,
          code: "uninitialised",
          projectRootPath: project.projectRootPath,
        })),
    [projectInputs],
  );
  const bellProjectErrors = useMemo(
    () => [
      ...gatedProjectErrors,
      ...(isProjectFiltered
        ? [...stats.projectErrors, ...bellStats.projectErrors]
        : stats.projectErrors),
    ],
    [gatedProjectErrors, isProjectFiltered, stats.projectErrors, bellStats.projectErrors],
  );

  // The picker offers only projects the bell hasn't flagged as erroring —
  // the same signal pas-2KY5X.14 already treats as "no usable data" for that
  // project, reused here instead of a second, driftable check (pas-2KY5X.17).
  // A project that's merely offline or whose host lacks `aitTrackerStats`
  // contributes neither an error nor a count (useTrackerStats' own
  // distinction), so it stays listed — only an active failure hides it.
  // "Active failure" now has two sources, not one (pas-2KY5X.28):
  // bellProjectErrors folds in both a real RPC failure (no database, cli
  // missing, ... — the pre-.28 path, for whatever still needs a live request
  // to discover: an old daemon, or a failure `aitInitialized` doesn't cover)
  // and the descriptor-derived gatedProjectErrors (aitInitialized === false,
  // known upfront, no request involved). This filter doesn't need to change
  // to account for that — it was always "whatever bellProjectErrors says",
  // and that set just grew a second contributor. What DID change: this no
  // longer merely trims what the picker offers while `projectInputs` drives
  // every fetch underneath it unfiltered — `projectData`/`stats` above now
  // fetch off `initializedProjectInputs`, which already excludes gated-out
  // projects before any request goes out; this filter's remaining job is
  // narrowing further, for whatever fails for a reason `aitInitialized`
  // doesn't capture. pickerProjectInputs stays its own thing rather than
  // becoming an alias of initializedProjectInputs: its scope is broader
  // (every active-failure reason, not just "no database"), and conflating
  // them would silently drop a project whose *other* kind of failure this
  // filter still needs to catch.
  const pickerProjectInputs = useMemo(() => {
    if (bellProjectErrors.length === 0) {
      return projectInputs;
    }
    const erroredKeys = new Set(
      bellProjectErrors.map((error) => `${error.serverId}:${error.projectId}`),
    );
    return projectInputs.filter(
      (project) => !erroredKeys.has(`${project.serverId}:${project.projectId}`),
    );
  }, [projectInputs, bellProjectErrors]);

  // Built from the full (unfiltered-by-status) project set project data
  // returns — the List row's delete action needs to know the *real* child
  // count (any status), and is only a fallback now: both TrackerTable and
  // TrackerKanbanBoard/Card prefer each tracker's own server-computed
  // `childCount`/`doneCount` and fall back to this hierarchy only when those
  // are undefined (an old daemon that predates the feature).
  const trackerHierarchy = useMemo(
    () => buildTrackerHierarchy(projectData.trackers),
    [projectData.trackers],
  );
  // Type filtering now happens server-side via projectData's `type` option
  // above — this is the same array, kept under its own name purely for
  // readability at the Kanban call sites below.
  const kanbanTrackers = projectData.trackers;
  const {
    ids: readyIds,
    refetch: refetchReady,
    isFetching: isReadyFetching,
  } = useTrackerReadyIds({
    viewMode,
    projects: projectInputs,
    selectedProjectId,
  });

  const { isListSearch, searchState, listViewTrackers } = useTrackerListView({
    hasAnyProject,
    viewMode,
    search,
    selectedProjectId,
    projects: projectInputs,
    listStatFilter,
    browseTrackers: projectData.trackers,
  });

  // Kanban's statFilter projects lanes, it never filters the dataset, so its
  // emptiness is driven by the project-filtered set, not the List filter.
  const visibleTrackersCount = useMemo(
    () => (viewMode === "kanban" ? kanbanTrackers.length : listViewTrackers.length),
    [viewMode, kanbanTrackers, listViewTrackers],
  );
  // gatedProjectErrors first: a project excluded from initializedProjectInputs
  // never reaches projectData (that's the whole point of the gate), so it can
  // never surface through projectData.projectErrors — without this, a still-
  // selected gated project silently falls through to the generic "empty"
  // state instead of the actionable "Initialize tracker" CTA (pas-2KY5X.28).
  // Also the source of truth for "is any project's data actually wrong right
  // now" — in all-projects mode resolveTrackerScreenBodyState never turns
  // this into a full-screen state (a per-project failure there is a banner
  // instead, rendered elsewhere), so hasFilteredOutTrackers below has to
  // check it directly: without that, a project whose list RPC failed while
  // its stats RPC happened to succeed would read as "filtered", not "broken"
  // (pas-2KY5X.52).
  const allProjectErrors = useMemo(
    () => [...gatedProjectErrors, ...projectData.projectErrors],
    [gatedProjectErrors, projectData.projectErrors],
  );
  // Search's own loading routes through isSearchLoading below, not here — it
  // would otherwise unmount the search row on every keystroke.
  const bodyState = resolveTrackerScreenBodyState({
    hasAnyProject,
    isProjectListLoading,
    isLoading: isListSearch ? false : projectData.isLoading,
    selectedProjectId: selectedProjectId ?? "all",
    projectErrors: allProjectErrors,
    visibleTrackersCount,
  });

  const selectedProject = selectedProjectId
    ? (projectInputs.find((p) => p.projectId === selectedProjectId) ?? null)
    : null;
  const formDefaults = trackerFormDefaults(selectedProject);
  const detailProps = trackerDetailProps(selectedTracker);

  const initMutations = useTrackerMutations({
    serverId: selectedProject?.serverId ?? "",
    projectId: selectedProjectId ?? "",
  });

  const openProjectPicker = useOpenAddProject();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation();

  // The toolbar's stat pills are a separate fetch (`stats`) from the
  // paginated `projectData` array, so every local mutation that patches or
  // removes a tracker in `projectData` has to refresh `stats` too — otherwise
  // the pills stay stale (e.g. still counting a just-closed item as open)
  // until the next unrelated re-fetch.
  const patchTrackerAndRefreshStats = useCallback(
    (updated: AggregatedTracker) => {
      projectData.patchTracker(updated);
      stats.refetch();
    },
    [projectData, stats],
  );
  const removeTrackersAndRefreshStats = useCallback(
    (ids: string[]) => {
      projectData.removeTrackers(ids);
      stats.refetch();
    },
    [projectData, stats],
  );

  const handleOpenTracker = useCallback(
    (tracker: AggregatedTracker) => setSelectedTracker(tracker),
    [],
  );
  const handleCloseDetail = useCallback(() => setSelectedTracker(null), []);
  const handleOpenCreate = useCallback(() => setCreateOpen(true), []);
  const handleCloseCreate = useCallback(() => setCreateOpen(false), []);
  const handleOpenProject = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);
  const handleInitialise = useCallback(() => {
    // `ait init` doesn't return a tracker to patch in — a fresh first-page
    // load is the only way to move this project out of its `uninitialised`
    // error state.
    void initMutations.initTracker().then(() => {
      projectData.refetch();
      stats.refetch();
      return undefined;
    });
  }, [initMutations, projectData, stats]);
  const handleRetry = useCallback(() => {
    projectData.refetch();
    stats.refetch();
  }, [projectData, stats]);
  const handleRefresh = useCallback(() => {
    projectData.refetch();
    stats.refetch();
    if (viewMode === "kanban") {
      refetchReady();
    }
  }, [projectData, refetchReady, stats, viewMode]);
  const isRefreshing = projectData.isLoading || stats.isLoading || isReadyFetching;

  useEffect(() => {
    if (!isFocused) {
      return;
    }
    const interval = setInterval(handleRefresh, 45_000);
    return () => clearInterval(interval);
  }, [handleRefresh, isFocused]);
  const handleSelectProject = useCallback((projectId: string | null) => {
    setSelectedProjectId(projectId);
  }, []);
  const handleListStatFilterChange = useCallback((value: StatFilter) => {
    setListStatFilter(value);
  }, []);
  const handleKanbanStatFilterChange = useCallback((value: StatFilter) => {
    setKanbanStatFilter(value);
  }, []);
  const handleTypeFilterChange = useCallback((value: TypeFilter) => {
    setTypeFilter(value);
  }, []);
  // One recovery action for "the active filters hid everything the project
  // has" (pas-2KY5X.52): resets every filter that can narrow the fetch, in
  // both views at once, so the same button works regardless of which view
  // is on screen when the user reaches for it.
  const handleClearFilters = useCallback(() => {
    setTypeFilter("all");
    setListStatFilter("all");
    setKanbanStatFilter("all");
  }, []);
  const effectiveStatFilter = useMemo(
    () => (viewMode === "kanban" ? kanbanStatFilter : listStatFilter),
    [viewMode, kanbanStatFilter, listStatFilter],
  );
  const effectiveOnStatFilterChange = useMemo(
    () => (viewMode === "kanban" ? handleKanbanStatFilterChange : handleListStatFilterChange),
    [viewMode, handleKanbanStatFilterChange, handleListStatFilterChange],
  );
  // The Kanban board renders a projection built from AggregatedTracker[] but
  // its own model (and onTransition callback) only knows the TrackerSummary/id
  // shape — the runtime objects in `kanbanTrackers` are still the exact
  // AggregatedTracker instances we passed in, so lookup-by-id recovers
  // serverId/projectId safely (see TrackerKanbanBoardProps contract).
  const kanbanTrackerById = useMemo(
    () => new Map(kanbanTrackers.map((tracker) => [tracker.id, tracker])),
    [kanbanTrackers],
  );
  // Prefers the tracker's own server-computed childCount (accurate over the
  // full subtree, even for a tracker whose descendants aren't loaded on this
  // page) and only falls back to the locally-built hierarchy — which can only
  // ever see whatever pages happened to load — when an old daemon predates
  // the feature and leaves childCount undefined.
  const resolveHasChildren = useCallback(
    (aggregated: Pick<AggregatedTracker, "id" | "childCount">): boolean =>
      aggregated.childCount !== undefined
        ? aggregated.childCount > 0
        : trackerHierarchy.descendantStats(aggregated.id).childCount > 0,
    [trackerHierarchy],
  );
  // `laneForTracker` in tracker-board-model.ts maps `closed -> "done"` and
  // `cancelled -> "cancelled"` as two separate lanes — the Done column renders
  // closed items only, so its total is `closed` alone; summing in cancelled here
  // would double-count every cancelled tracker across the board (pas-2KY5X.2).
  // `in_progress` and `cancelled` map straight across.
  const laneTotals = useMemo<Partial<Record<TrackerBoardLaneKey, number | null>>>(() => {
    const { open, closed, cancelled, in_progress: inProgress } = projectData.sectionTotals;
    return { open, in_progress: inProgress, done: closed, cancelled };
  }, [projectData.sectionTotals]);
  const laneHasMore = useMemo<Partial<Record<TrackerBoardLaneKey, boolean>>>(() => {
    const { closed, cancelled, in_progress: inProgress, open } = projectData.sectionHasMore;
    return { open, in_progress: inProgress, done: closed, cancelled };
  }, [projectData.sectionHasMore]);
  const laneLoadingMore = useMemo<Partial<Record<TrackerBoardLaneKey, boolean>>>(() => {
    const { closed, cancelled, in_progress: inProgress, open } = projectData.sectionLoadingMore;
    return { open, in_progress: inProgress, done: closed, cancelled };
  }, [projectData.sectionLoadingMore]);
  // Every lane maps onto exactly one status section.
  const handleKanbanLoadMore = useCallback(
    (lane: TrackerBoardLaneKey) => {
      switch (lane) {
        case "open":
          projectData.loadMore("open");
          return;
        case "in_progress":
          projectData.loadMore("in_progress");
          return;
        case "done":
          projectData.loadMore("closed");
          return;
        case "cancelled":
          projectData.loadMore("cancelled");
          return;
      }
    },
    [projectData],
  );
  // The transition's own response IS the authoritative snapshot the board used
  // to rely on a caller-side refresh to pick up — patched in directly instead
  // of re-fetching or waiting on a live-push re-render.
  const handleKanbanTransition = useCallback(
    async (trackerId: string, transition: TrackerTransition): Promise<void> => {
      try {
        const aggregated = kanbanTrackerById.get(trackerId);
        if (!aggregated) {
          throw new Error(`Unknown tracker: ${trackerId}`);
        }
        const client = useSessionStore.getState().sessions[aggregated.serverId]?.client;
        if (!client) {
          throw new Error(t("common.errors.daemonClientUnavailable"));
        }
        const summary = await callTrackerTransition(client, aggregated, transition);
        patchTrackerAndRefreshStats({ ...aggregated, ...summary });
      } finally {
        // Still relevant for the (react-query-backed) readyIds fetch, which
        // this hook doesn't own.
        void queryClient.invalidateQueries({ queryKey: trackerQueryBaseKey });
      }
    },
    [kanbanTrackerById, queryClient, t, patchTrackerAndRefreshStats],
  );
  const handleKanbanTransitionError = useCallback(
    (_trackerId: string, message: string) => toast.error(message),
    [toast],
  );
  // Cascade mirrors the List row's identical rule: `ait` itself refuses a
  // non-cascaded delete of a tracker with descendants. `resolveHasChildren`
  // prefers the tracker's own server-computed childCount — accurate for the
  // real full subtree, not just whatever a type filter left loaded — falling
  // back to `trackerHierarchy` (built from the full unfiltered project set)
  // only when that daemon predates the feature, so this agrees with whatever
  // "Remove"/"Delete tree" copy the card's own confirm dialog showed.
  const handleKanbanDelete = useCallback(
    async (trackerId: string): Promise<void> => {
      try {
        const aggregated = kanbanTrackerById.get(trackerId);
        if (!aggregated) {
          throw new Error(`Unknown tracker: ${trackerId}`);
        }
        const client = useSessionStore.getState().sessions[aggregated.serverId]?.client;
        if (!client) {
          throw new Error(t("common.errors.daemonClientUnavailable"));
        }
        const hasChildren = resolveHasChildren(aggregated);
        const removedIds = await client.trackerDelete({
          projectId: aggregated.projectId,
          trackerId: aggregated.id,
          cascade: hasChildren,
        });
        removeTrackersAndRefreshStats(removedIds);
      } finally {
        void queryClient.invalidateQueries({ queryKey: trackerQueryBaseKey });
      }
    },
    [kanbanTrackerById, resolveHasChildren, t, removeTrackersAndRefreshStats, queryClient],
  );
  const handleKanbanDeleteError = useCallback(
    (_trackerId: string, message: string) => toast.error(message),
    [toast],
  );
  const getKanbanHasChildren = useCallback(
    (trackerId: string) => {
      const aggregated = kanbanTrackerById.get(trackerId);
      return aggregated ? resolveHasChildren(aggregated) : false;
    },
    [kanbanTrackerById, resolveHasChildren],
  );
  const handleKanbanCardPress = useCallback(
    (trackerId: string) => {
      const aggregated = kanbanTrackerById.get(trackerId);
      if (aggregated) {
        setSelectedTracker(aggregated);
      }
    },
    [kanbanTrackerById],
  );
  const handleOpenEdit = useCallback(
    (tracker: AggregatedTracker) => setEditingTracker(tracker),
    [],
  );
  const handleCloseEdit = useCallback(() => setEditingTracker(null), []);
  const handleKanbanEdit = useCallback(
    (trackerId: string) => {
      const aggregated = kanbanTrackerById.get(trackerId);
      if (aggregated) {
        setEditingTracker(aggregated);
      }
    },
    [kanbanTrackerById],
  );
  const handleTrackerCreated = useCallback(
    (tracker: TrackerSummary, project: TrackerProjectInput) => {
      patchTrackerAndRefreshStats({ ...tracker, ...project });
    },
    [patchTrackerAndRefreshStats],
  );
  const handleDetailMutated = useCallback(
    (summary: TrackerSummary) => {
      if (!selectedTracker) {
        return;
      }
      patchTrackerAndRefreshStats({ ...selectedTracker, ...summary });
    },
    [selectedTracker, patchTrackerAndRefreshStats],
  );
  const contentWidth = useContentWidth();
  // Same patch mechanism as the row/detail mutation paths — merges the fresh
  // summary into the aggregated instance already in the shared data hook.
  const handleEditUpdated = useCallback(
    (summary: TrackerSummary) => {
      if (!editingTracker) {
        return;
      }
      patchTrackerAndRefreshStats({ ...editingTracker, ...summary });
      setEditingTracker(null);
    },
    [editingTracker, patchTrackerAndRefreshStats],
  );

  const headerRightContent = useMemo(
    () => (
      <>
        <TrackerErrorsButton errors={bellProjectErrors} />
        <Button
          variant="ghost"
          size="xs"
          leftIcon={RefreshCw}
          loading={isRefreshing}
          onPress={handleRefresh}
          accessibilityLabel={t("tracker.kanban.refresh")}
          testID="trackers-refresh"
        />
        <SegmentedControl
          options={viewModeOptions}
          value={viewMode}
          onValueChange={setViewMode}
          size="sm"
          hideLabels
          testID="trackers-view-mode"
        />
      </>
    ),
    [bellProjectErrors, handleRefresh, isRefreshing, setViewMode, t, viewMode],
  );

  return (
    <View style={styles.container} ref={contentWidth.ref} onLayout={contentWidth.onLayout}>
      <MenuHeader title="Tracker" rightContent={headerRightContent} />
      <TrackerScreenBody
        contentWidth={contentWidth.value}
        bodyState={bodyState}
        trackers={listViewTrackers}
        trackerHierarchy={trackerHierarchy}
        statsCounts={stats.counts}
        statsLoading={stats.isLoading}
        hasProjectErrors={allProjectErrors.length > 0}
        kanbanTrackers={kanbanTrackers}
        kanbanReadyIds={readyIds}
        laneTotals={laneTotals}
        laneHasMore={laneHasMore}
        laneLoadingMore={laneLoadingMore}
        onKanbanLoadMore={handleKanbanLoadMore}
        sectionTotals={projectData.sectionTotals}
        sectionHasMore={projectData.sectionHasMore}
        sectionLoadingMore={projectData.sectionLoadingMore}
        onLoadMore={projectData.loadMore}
        onTrackerPatched={patchTrackerAndRefreshStats}
        onEditTracker={handleOpenEdit}
        onTrackersRemoved={removeTrackersAndRefreshStats}
        listVariant={isListSearch ? "flat" : "sections"}
        onLoadMoreAll={searchState.loadMore}
        hasMoreAll={searchState.hasMore}
        isLoadingMoreAll={searchState.isLoadingMore}
        isSearchLoading={isListSearch && searchState.isLoading}
        showProjectLabel={selectedProjectId === null}
        projects={pickerProjectInputs}
        selectedProjectId={selectedProjectId}
        selectedProjectName={selectedProject?.projectName ?? null}
        onSelectProject={handleSelectProject}
        statFilter={effectiveStatFilter}
        onStatFilterChange={effectiveOnStatFilterChange}
        viewMode={viewMode}
        typeFilter={typeFilter}
        onTypeFilterChange={handleTypeFilterChange}
        onClearFilters={handleClearFilters}
        searchInput={searchInput}
        onSearchInputChange={setSearchInput}
        activeSearch={search}
        onOpenTracker={handleOpenTracker}
        onKanbanTransition={handleKanbanTransition}
        onKanbanTransitionError={handleKanbanTransitionError}
        onKanbanEdit={handleKanbanEdit}
        onKanbanDelete={handleKanbanDelete}
        onKanbanDeleteError={handleKanbanDeleteError}
        getKanbanHasChildren={getKanbanHasChildren}
        onKanbanCardPress={handleKanbanCardPress}
        onCreate={handleOpenCreate}
        onOpenProject={handleOpenProject}
        onInitialise={handleInitialise}
        isInitialising={initMutations.isInitialising}
        onRetry={handleRetry}
      />
      <TrackerFormSheet
        projects={initializedProjectInputs}
        visible={createOpen}
        onClose={handleCloseCreate}
        onCreated={handleTrackerCreated}
        defaultServerId={formDefaults.serverId}
        defaultProjectId={formDefaults.projectId}
        defaultProjectDisplay={formDefaults.projectName}
      />
      <TrackerDetailSheet
        serverId={detailProps.serverId}
        projectId={detailProps.projectId}
        visible={selectedTracker !== null}
        trackerId={detailProps.trackerId}
        onClose={handleCloseDetail}
        initialSummary={selectedTracker}
        onMutated={handleDetailMutated}
      />
      <TrackerEditSheet
        tracker={editingTracker}
        visible={editingTracker !== null}
        onClose={handleCloseEdit}
        onUpdated={handleEditUpdated}
      />
    </View>
  );
}

// Rendered right above TrackerTable, below the (sticky) toolbar — it scrolls
// away with the table content instead of staying pinned or floating above
// the toolbar. Sizing matches sessions-screen.tsx's filterContainer (same
// padding tokens) so the two screens' search rows read as one convention.
function TrackerSearchRow({
  viewMode,
  value,
  onChangeText,
}: {
  viewMode: ViewMode;
  value: string;
  onChangeText: (value: string) => void;
}): ReactElement | null {
  if (viewMode !== "list") {
    return null;
  }
  return (
    <View style={styles.searchRow}>
      <SearchField
        value={value}
        onChangeText={onChangeText}
        placeholder="Search title or ID"
        clearAccessibilityLabel="Clear search"
        testID="trackers-search-input"
        clearTestID="trackers-search-clear"
      />
    </View>
  );
}

function ProjectPicker({
  projects,
  selectedProjectId,
  selectedProjectName,
  onSelectProject,
}: {
  projects: TrackerProjectInput[];
  selectedProjectId: string | null;
  /** Falls back here, not straight to "All projects", when `selectedProjectId`
   * isn't in `projects` — that list is already filtered down to what the
   * picker offers (pas-2KY5X.17/.28: an erroring or gated-out project drops
   * out of it), so a project that's *still selected* despite failing that
   * filter would otherwise read as if nothing were selected at all, even
   * though the body below is showing that exact project's own state. */
  selectedProjectName: string | null;
  onSelectProject: (projectId: string | null) => void;
}): ReactElement {
  const selectedLabel = selectedProjectId
    ? (projects.find((p) => p.projectId === selectedProjectId)?.projectName ??
      selectedProjectName ??
      "All projects")
    : "All projects";
  const handleSelectAll = useCallback(() => onSelectProject(null), [onSelectProject]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={styles.projectPickerTrigger}
        testID="trackers-project-picker-trigger"
      >
        <Text style={styles.projectPickerText} numberOfLines={1}>
          {selectedLabel}
        </Text>
        <ThemedChevronDown size={14} uniProps={mutedColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" width={240}>
        <DropdownMenuItem
          selected={selectedProjectId === null}
          onSelect={handleSelectAll}
          testID="trackers-project-picker-all"
        >
          All projects
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {projects.map((project) => (
          <ProjectPickerItem
            key={project.projectId}
            project={project}
            selected={selectedProjectId === project.projectId}
            onSelectProject={onSelectProject}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectPickerItem({
  project,
  selected,
  onSelectProject,
}: {
  project: TrackerProjectInput;
  selected: boolean;
  onSelectProject: (projectId: string | null) => void;
}): ReactElement {
  const handleSelect = useCallback(
    () => onSelectProject(project.projectId),
    [onSelectProject, project.projectId],
  );
  return (
    <DropdownMenuItem
      selected={selected}
      onSelect={handleSelect}
      testID={`trackers-project-picker-${project.projectId}`}
    >
      {project.projectName}
    </DropdownMenuItem>
  );
}

type PriorityStatFilter = Extract<StatFilter, "p0" | "p1" | "p2" | "p3" | "p4">;

interface PriorityFilterLevel {
  id: string;
  filter: PriorityStatFilter;
  desc: string;
}

function PriorityFilterItem({
  level,
  selected,
  onSelect,
}: {
  level: PriorityFilterLevel;
  selected: boolean;
  onSelect: (filter: PriorityStatFilter) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(level.filter), [onSelect, level.filter]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      <View style={styles.priorityFilterRow}>
        <Text style={[styles.priorityFilterLevel, priorityHelpColorStyle(level.id)]}>
          {level.id}
        </Text>
        <Text style={styles.priorityFilterDesc}>{level.desc}</Text>
      </View>
    </DropdownMenuItem>
  );
}

function PriorityFilterDropdown({
  counts,
  statFilter,
  onStatFilterChange,
  pulse,
}: {
  counts: TrackerStatCounts | null;
  statFilter: StatFilter;
  onStatFilterChange: (value: StatFilter) => void;
  pulse: Animated.Value;
}): ReactElement {
  const selectedLevel = PRIORITY_HELP_LEVELS.find((level) => level.filter === statFilter) ?? null;
  const [isHovered, setIsHovered] = useState(false);
  const priorityTotal = counts ? counts.p0 + counts.p1 + counts.p2 + counts.p3 + counts.p4 : null;
  const handleSelectAll = useCallback(() => onStatFilterChange("all"), [onStatFilterChange]);
  const handleSelectLevel = useCallback(
    (filter: PriorityStatFilter) => onStatFilterChange(filter),
    [onStatFilterChange],
  );
  const isActive = selectedLevel != null;
  const triggerStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.priorityFilterTrigger,
      isActive
        ? styles.priorityFilterTriggerActive
        : (isHovered || pressed) && styles.priorityFilterTriggerHovered,
    ],
    [isHovered, isActive],
  );
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={triggerStyle}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
        testID="trackers-priority-filter-trigger"
      >
        {selectedLevel != null ? (
          <>
            <StatCount
              count={counts ? counts[selectedLevel.filter] : null}
              active
              pulse={pulse}
              style={[styles.priorityFilterCount, styles.priorityFilterCountActive]}
            />
            <Text style={[styles.priorityFilterText, styles.priorityFilterTextActive]}>
              {` ${selectedLevel.id}`}
            </Text>
          </>
        ) : (
          <>
            <StatCount
              count={priorityTotal}
              active={false}
              pulse={pulse}
              style={[styles.priorityFilterCount, isHovered && styles.priorityFilterCountHovered]}
            />
            <Text style={styles.priorityFilterText}>{" PRIORITY"}</Text>
          </>
        )}
        <ThemedChevronDown
          size={14}
          uniProps={isActive ? inverseColorMapping : mutedColorMapping}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" width={240}>
        <DropdownMenuItem selected={selectedLevel === null} onSelect={handleSelectAll}>
          All priorities
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {PRIORITY_HELP_LEVELS.map((level) => (
          <PriorityFilterItem
            key={level.id}
            level={level}
            selected={selectedLevel?.filter === level.filter}
            onSelect={handleSelectLevel}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TypeFilterMenuItem({
  value,
  label,
  selected,
  onSelect,
}: {
  value: TypeFilter;
  label: string;
  selected: boolean;
  onSelect: (value: TypeFilter) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <DropdownMenuItem
      selected={selected}
      onSelect={handleSelect}
      testID={`trackers-filter-menu-type-${value}`}
    >
      {label}
    </DropdownMenuItem>
  );
}

// Compact-width replacement for the type SegmentedControl (trackers-type-filter)
// and PriorityFilterDropdown/KanbanPriorityFilterRow — both collapsed into one
// overflow trigger so the toolbar stays a single row below the `md` breakpoint
// (see useIsCompactFormFactor in @/constants/layout). Desktop keeps the
// always-visible controls; this is compact-only.
function TrackerFilterMenu({
  typeFilter,
  onTypeFilterChange,
  statFilter,
  onStatFilterChange,
}: {
  typeFilter: TypeFilter;
  onTypeFilterChange: (value: TypeFilter) => void;
  statFilter: StatFilter;
  onStatFilterChange: (value: StatFilter) => void;
}): ReactElement {
  const { t } = useTranslation();
  const selectedLevel = PRIORITY_HELP_LEVELS.find((level) => level.filter === statFilter) ?? null;
  const typeLabel =
    t(TYPE_FILTER_DEFS.find((def) => def.value === typeFilter)?.labelKey ?? "") || "Filters";
  const handleSelectAllPriority = useCallback(
    () => onStatFilterChange("all"),
    [onStatFilterChange],
  );
  const handleSelectLevel = useCallback(
    (filter: PriorityStatFilter) => onStatFilterChange(filter),
    [onStatFilterChange],
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={styles.projectPickerTrigger}
        testID="trackers-filter-menu-trigger"
      >
        <ThemedListFilter size={14} uniProps={mutedColorMapping} />
        <Text style={styles.projectPickerText} numberOfLines={1}>
          {selectedLevel ? `${typeLabel} · ${selectedLevel.id}` : typeLabel}
        </Text>
        <ThemedChevronDown size={14} uniProps={mutedColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" width={240}>
        {TYPE_FILTER_DEFS.map((def) => (
          <TypeFilterMenuItem
            key={def.value}
            value={def.value}
            label={t(def.labelKey)}
            selected={typeFilter === def.value}
            onSelect={onTypeFilterChange}
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          selected={selectedLevel === null}
          onSelect={handleSelectAllPriority}
          testID="trackers-filter-menu-priority-all"
        >
          All priorities
        </DropdownMenuItem>
        {PRIORITY_HELP_LEVELS.map((level) => (
          <PriorityFilterItem
            key={level.id}
            level={level}
            selected={selectedLevel?.filter === level.filter}
            onSelect={handleSelectLevel}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Errors move into a header popover instead of an inline content banner —
// most projects don't run `ait`, so a permanent "no ait database" strip in
// the content area would be the common case, not the exception. The trigger
// itself always renders, error or not — it doubles as the discovery path for
// `ait` on a project that has never used it (see TrackerErrorsButton). Only
// the count badge is conditional (see TrackerErrorsBellIcon).
// ait-cli-service's raw message is "no ait database at <dir>/.ait/ait.db —
// run 'ait init' first" — the full absolute path is noise the user doesn't
// need to read, but it is the only place the project's directory shows up,
// so it's still worth extracting for the copyable `cd` command below.
const AIT_DB_PATH_PATTERN = /no ait database at (.+)\/\.ait\/ait\.db/;
const AIT_REPO_URL = "https://github.com/hungcuong9125/agent-issue-tracker";

function handleOpenAitRepo(): void {
  void openExternalUrl(AIT_REPO_URL);
}

// A row (not a nested Text) — Text only reliably accepts Text/Image children
// cross-platform, and hover props (onHoverIn/onHoverOut) only exist on
// Pressable, not Text. Underlined at rest so it reads as a link inside the
// sentence rather than plain emphasis; only the colour is hover-only, picking
// up the accent tint.
function TrackerAitRepoLink(): ReactElement {
  const [isHovered, setIsHovered] = useState(false);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  return (
    <Pressable
      onPress={handleOpenAitRepo}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      accessibilityRole="link"
      testID="trackers-project-errors-ait-link"
    >
      <Text style={[styles.errorsMenuLink, isHovered && styles.errorsMenuLinkHovered]}>
        Agent Issue Tracker
      </Text>
    </Pressable>
  );
}

function extractProjectDir(message: string): string | null {
  return AIT_DB_PATH_PATTERN.exec(message)?.[1] ?? null;
}

function TrackerErrorRow({ error }: { error: TrackerProjectError }): ReactElement {
  // A gate-derived error (pas-2KY5X.28) carries projectRootPath directly —
  // no RPC error message to regex-parse, since no request was ever sent.
  // The regex stays the fallback for everything else: an old daemon that
  // predates aitProjectInitStatus, or a project that fails for some other
  // reason after passing the gate (cli_missing, a transient RPC error, ...).
  const projectDir = error.projectRootPath ?? extractProjectDir(error.message);
  const command = projectDir ? `cd "${projectDir}" && ait init` : "ait init";
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    },
    [],
  );

  const handleCopy = useCallback(() => {
    void copyToClipboard(command);
    setCopied(true);
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
  }, [command]);

  return (
    <View style={styles.errorsRow}>
      <View style={styles.errorsRowBullet} />
      <View style={styles.errorsRowBody}>
        <Text style={styles.errorsRowText}>
          {"No ait database in project "}
          <Text style={styles.errorsRowEmphasis}>{error.projectName}</Text>
        </Text>
        <Pressable
          style={styles.errorsCopyRow}
          onPress={handleCopy}
          accessibilityRole="button"
          testID={`trackers-project-errors-copy-${error.serverId}:${error.projectId}`}
        >
          <Text style={styles.errorsCopyCommand} numberOfLines={1}>
            {command}
          </Text>
          {copied ? (
            <ThemedCheck size={12} uniProps={mutedColorMapping} />
          ) : (
            <ThemedCopy size={12} uniProps={mutedColorMapping} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

function TrackerErrorsBellIcon({
  active,
  count,
}: {
  active: boolean;
  count: number;
}): ReactElement {
  const bellColorMapping = useCallback(
    (theme: Theme) => ({ color: bellIconColor(theme, active) }),
    [active],
  );
  return (
    <>
      <ThemedBell size={20} uniProps={bellColorMapping} />
      {count > 0 ? (
        <View style={styles.errorsBadge}>
          <Text style={styles.errorsBadgeText}>{count}</Text>
        </View>
      ) : null}
    </>
  );
}

function renderErrorsTrigger(state: DropdownMenuTriggerState, count: number): ReactElement {
  // `open` (the popover stayed open after a click) counts as active too, not
  // just live hover/press — the user asked for the icon to stay in its
  // "activated" colour for as long as the menu is open, not just flash
  // during the press itself.
  return (
    <TrackerErrorsBellIcon active={state.hovered || state.pressed || state.open} count={count} />
  );
}

function TrackerErrorsButton({ errors }: { errors: TrackerProjectError[] }): ReactElement {
  const [open, setOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerBoxRef = useRef<View>(null);
  const wasInsideRef = useRef(false);
  const isCompact = useIsCompactFormFactor();

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const cancelHoverClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const scheduleHoverClose = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    cancelHoverClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, 260);
  }, [cancelHoverClose]);

  // Tracks pointer coords against the trigger's rect instead of
  // onPointerEnter/Leave, which flap on the bell's active-color repaint.
  useEffect(() => {
    if (!isWeb || isCompact) return;
    function handlePointerMove(event: PointerEvent): void {
      const node = triggerBoxRef.current as unknown as Element | null;
      const rect = node?.getBoundingClientRect?.();
      if (!rect) return;
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (inside === wasInsideRef.current) return;
      wasInsideRef.current = inside;
      if (inside) {
        clearTimers();
        setOpen(true);
      } else {
        scheduleHoverClose();
      }
    }
    document.addEventListener("pointermove", handlePointerMove);
    return () => document.removeEventListener("pointermove", handlePointerMove);
  }, [isCompact, clearTimers, scheduleHoverClose]);

  const renderTrigger = useCallback(
    (state: DropdownMenuTriggerState) => renderErrorsTrigger(state, errors.length),
    [errors.length],
  );
  const handleClose = useCallback(() => setOpen(false), []);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen} compactMode="sheet">
      <View ref={triggerBoxRef}>
        <DropdownMenuTrigger
          style={styles.errorsButtonTrigger}
          testID="trackers-project-errors-trigger"
        >
          {renderTrigger}
        </DropdownMenuTrigger>
      </View>
      <DropdownMenuContent
        align="end"
        width={360}
        scrollable
        onPointerEnter={cancelHoverClose}
        onPointerLeave={scheduleHoverClose}
      >
        <View style={styles.errorsMenuList} testID="trackers-project-errors">
          <View style={styles.errorsMenuHeaderRow}>
            <View style={styles.errorsMenuTitleRow}>
              <Text style={styles.errorsMenuTitle}>{"Track your projects with "}</Text>
              <TrackerAitRepoLink />
            </View>
            {isCompact ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={8}
                style={styles.errorsCloseButton}
                onPress={handleClose}
                testID="trackers-project-errors-close"
              >
                <ThemedX size={18} uniProps={mutedColorMapping} />
              </Pressable>
            ) : null}
          </View>
          {errors.length > 0 ? (
            <>
              <Text style={styles.errorsMenuDescription}>
                These projects don&apos;t have one set up yet. Run{" "}
                <Text style={styles.errorsRowEmphasis}>ait init</Text> in each to enable it.
              </Text>
              <View style={styles.errorsMenuDescriptionDivider} />
              {errors.map((error, index) => (
                <Fragment key={`${error.serverId}:${error.projectId}`}>
                  {index > 0 ? <View style={styles.errorsMenuDivider} /> : null}
                  <TrackerErrorRow error={error} />
                </Fragment>
              ))}
            </>
          ) : (
            <Text style={styles.errorsMenuDescription}>
              Every project here already has one set up.
            </Text>
          )}
        </View>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TrackerScreenBody({
  contentWidth,
  bodyState,
  trackers,
  trackerHierarchy,
  statsCounts,
  statsLoading,
  hasProjectErrors,
  kanbanTrackers,
  kanbanReadyIds,
  laneTotals,
  laneHasMore,
  laneLoadingMore,
  onKanbanLoadMore,
  sectionTotals,
  sectionHasMore,
  sectionLoadingMore,
  onLoadMore,
  onTrackerPatched,
  onEditTracker,
  onTrackersRemoved,
  listVariant,
  onLoadMoreAll,
  hasMoreAll,
  isLoadingMoreAll,
  isSearchLoading,
  showProjectLabel,
  projects,
  selectedProjectId,
  selectedProjectName,
  onSelectProject,
  statFilter,
  onStatFilterChange,
  viewMode,
  typeFilter,
  onTypeFilterChange,
  onClearFilters,
  searchInput,
  onSearchInputChange,
  activeSearch,
  onOpenTracker,
  onKanbanTransition,
  onKanbanTransitionError,
  onKanbanEdit,
  onKanbanDelete,
  onKanbanDeleteError,
  getKanbanHasChildren,
  onKanbanCardPress,
  onCreate,
  onOpenProject,
  onInitialise,
  isInitialising,
  onRetry,
}: {
  /** Width available to the toolbar and the Kanban board, measured on the
   * screen container. Null only for the very first frame after mount, which
   * is long before either of them renders anything width-dependent. */
  contentWidth: number | null;
  bodyState: TrackerScreenBodyState;
  trackers: AggregatedTracker[];
  trackerHierarchy: TrackerHierarchy;
  /** Exact server-computed counts for the toolbar stat pills — `null` while
   * loading or when the host lacks `aitTrackerStats`. */
  statsCounts: TrackerStatsCounts | null;
  statsLoading: boolean;
  /** Whether any in-scope project currently has a data error — a failed
   * `project.tracker.list` in all-projects mode never becomes `blocked`
   * below (that's a banner elsewhere, the rest of the board still renders),
   * so hasFilteredOutTrackers has to be told about it directly instead of
   * inferring "broken" from "empty" (pas-2KY5X.52). */
  hasProjectErrors: boolean;
  kanbanTrackers: AggregatedTracker[];
  kanbanReadyIds: ReadonlySet<string> | null;
  laneTotals: Partial<Record<TrackerBoardLaneKey, number | null>>;
  laneHasMore: Partial<Record<TrackerBoardLaneKey, boolean>>;
  laneLoadingMore: Partial<Record<TrackerBoardLaneKey, boolean>>;
  onKanbanLoadMore: (lane: TrackerBoardLaneKey) => void;
  sectionTotals: Record<TrackerStatus, number | null>;
  sectionHasMore: Record<TrackerStatus, boolean>;
  sectionLoadingMore: Record<TrackerStatus, boolean>;
  onLoadMore: (status: TrackerStatus) => void;
  onTrackerPatched: (tracker: AggregatedTracker) => void;
  onEditTracker: (tracker: AggregatedTracker) => void;
  onTrackersRemoved: (ids: string[]) => void;
  listVariant: "sections" | "flat";
  onLoadMoreAll: () => void;
  hasMoreAll: boolean;
  isLoadingMoreAll: boolean;
  /** True while a search query is in flight — gates the "No results" copy in
   * the "empty" body state so a still-loading search doesn't flash a wrong
   * answer before its own results land. */
  isSearchLoading: boolean;
  showProjectLabel: boolean;
  projects: TrackerProjectInput[];
  selectedProjectId: string | null;
  /** The selected project's own name, looked up from the unfiltered project
   * list — not `projects` above, which is picker-filtered (pas-2KY5X.17/.28)
   * and may not contain the selection at all (an already-selected project
   * that starts erroring, or gets gated by aitInitialized === false, drops
   * out of the picker's own list but stays selected). Lets the toolbar keep
   * showing the real project name instead of silently reading as "All
   * projects" while the body still renders that project's own state. */
  selectedProjectName: string | null;
  onSelectProject: (projectId: string | null) => void;
  statFilter: StatFilter;
  onStatFilterChange: (value: StatFilter) => void;
  viewMode: ViewMode;
  typeFilter: TypeFilter;
  onTypeFilterChange: (value: TypeFilter) => void;
  /** Resets typeFilter and both views' statFilter to "all" — the one action
   * offered when the active filters hid every tracker the project has
   * (pas-2KY5X.52). */
  onClearFilters: () => void;
  searchInput: string;
  activeSearch: string;
  onSearchInputChange: (value: string) => void;
  onOpenTracker: (tracker: AggregatedTracker) => void;
  onKanbanTransition: (trackerId: string, transition: TrackerTransition) => Promise<void>;
  onKanbanTransitionError: (trackerId: string, message: string) => void;
  onKanbanEdit: (trackerId: string) => void;
  onKanbanDelete: (trackerId: string) => Promise<void>;
  onKanbanDeleteError: (trackerId: string, message: string) => void;
  getKanbanHasChildren: (trackerId: string) => boolean;
  onKanbanCardPress: (trackerId: string) => void;
  onCreate: () => void;
  onOpenProject: () => void;
  onInitialise: () => void;
  isInitialising: boolean;
  onRetry: () => void;
}): ReactElement | null {
  const listScrollRef = useRef<ScrollView>(null);
  // Board trackers are the exact AggregatedTracker instances passed down as
  // kanbanTrackers, so this cast mirrors the same safe pattern used to recover
  // serverId/projectId in TrackerScreenContent.
  const getKanbanProjectLabel = useCallback(
    (tracker: TrackerSummary): string | null =>
      showProjectLabel ? ((tracker as AggregatedTracker).projectName ?? null) : null,
    [showProjectLabel],
  );

  // The frame is not part of the data state machine. The toolbar, the search
  // field and — in Kanban — the lanes themselves are chrome: their size and
  // position follow from the view mode and the measured width, never from what
  // the server returned. They render on the first frame and stay put; only the
  // data region below swaps between skeleton, message and content. Mount any of
  // them behind a load state instead and the entire screen re-lays-out the
  // moment data lands, which is what a spinner-then-everything screen does.
  if (bodyState.kind === "no-projects") {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>Open a project to see its tracker</Text>
        <Button variant="outline" onPress={onOpenProject} testID="trackers-open-project">
          Open project
        </Button>
      </View>
    );
  }

  const isLoading = bodyState.kind === "loading";
  const visibleCount = viewMode === "kanban" ? kanbanTrackers.length : trackers.length;
  // statsCounts is never narrowed by typeFilter/statFilter — unlike trackers
  // and kanbanTrackers, it always reports the project's real total, so a
  // nonzero total while nothing is visible CAN mean the active filters hid
  // everything the project has (pas-2KY5X.52). It can also mean the two
  // numbers are simply not comparable right now, which is not evidence of
  // filtering and must not render as if it were:
  //  - statsLoading: a mutation (e.g. deleting the last visible tracker)
  //    empties `trackers`/`kanbanTrackers` synchronously but only kicks off
  //    stats.refetch() — statsCounts stays the pre-mutation total until that
  //    resolves, a stale-vs-fresh mismatch, not a filtered one.
  //  - hasProjectErrors: in all-projects mode a per-project list-RPC failure
  //    never becomes `blocked` (see the comment on `blocked` above), so the
  //    visible set can be wrong for a reason that has nothing to do with any
  //    filter while statsCounts (a different RPC) still succeeded.
  // Both leave the two numbers looking like a mismatch for reasons other
  // than filtering, so both suppress the claim rather than let it disagree
  // silently. Search also takes priority over this: TrackerListEmptyState's
  // "No results for ..." already explains that case.
  const hasFilteredOutTrackers =
    !isLoading &&
    !statsLoading &&
    !hasProjectErrors &&
    activeSearch.length === 0 &&
    statsCounts !== null &&
    statsCounts.all.total > 0 &&
    visibleCount === 0;

  const toolbar = (
    <TrackersToolbar
      contentWidth={contentWidth}
      statsCounts={statsCounts}
      statsLoading={statsLoading}
      projects={projects}
      selectedProjectId={selectedProjectId}
      selectedProjectName={selectedProjectName}
      onSelectProject={onSelectProject}
      statFilter={statFilter}
      onStatFilterChange={onStatFilterChange}
      viewMode={viewMode}
      typeFilter={typeFilter}
      onTypeFilterChange={onTypeFilterChange}
      onCreate={onCreate}
    />
  );

  // Selecting one project surfaces its own failure in place of the data region
  // rather than in place of the screen — the toolbar above stays usable, so the
  // project picker is still there to switch away with.
  let blocked: ReactNode = null;
  if (bodyState.kind === "cli-missing") {
    blocked = (
      <View style={styles.centered}>
        <Text style={styles.message}>Install the ait CLI on this host to track work here</Text>
      </View>
    );
  } else if (bodyState.kind === "uninitialised") {
    blocked = (
      <View style={styles.centered}>
        <Text style={styles.message}>This project doesn&apos;t have a tracker yet</Text>
        <Button
          variant="outline"
          onPress={onInitialise}
          loading={isInitialising}
          testID="trackers-initialise"
        >
          Initialize tracker
        </Button>
      </View>
    );
  } else if (bodyState.kind === "load-error") {
    blocked = (
      <View style={styles.centered}>
        <Text style={styles.message}>{bodyState.message}</Text>
        <Button variant="ghost" onPress={onRetry} testID="trackers-retry">
          Try again
        </Button>
      </View>
    );
  }

  if (viewMode === "kanban") {
    // Not nested in the outer vertical ScrollView: each TrackerKanbanColumn owns
    // its own vertical ScrollView and needs a bounded-height parent (flex: 1),
    // which a ScrollView's content container can't give a child.
    //
    // No "empty" branch here on purpose — a board with genuinely nothing in
    // it is four empty lanes, not a replacement screen, and swapping the
    // lanes out for a centred message would move the toolbar every time a
    // filter matched nothing. hasFilteredOutTrackers is a different case: the
    // project isn't empty, the active filters just hid everything it has
    // (pas-2KY5X.52) — that gets a banner ABOVE the still-mounted lanes
    // instead, so the toolbar and lane layout stay put.
    return (
      <View style={styles.kanbanContainer} testID="trackers-kanban">
        {toolbar}
        {blocked ?? (
          <>
            {hasFilteredOutTrackers ? (
              <TrackerFilteredEmptyBanner onClearFilters={onClearFilters} />
            ) : null}
            <TrackerKanbanBoard
              availableWidth={contentWidth}
              isLoading={isLoading}
              trackers={kanbanTrackers}
              filter={statFilter}
              readyIds={kanbanReadyIds}
              laneTotals={laneTotals}
              laneHasMore={laneHasMore}
              laneLoadingMore={laneLoadingMore}
              onLoadMore={onKanbanLoadMore}
              onTransition={onKanbanTransition}
              onTransitionError={onKanbanTransitionError}
              onEdit={onKanbanEdit}
              onDelete={onKanbanDelete}
              onDeleteError={onKanbanDeleteError}
              getHasChildren={getKanbanHasChildren}
              getProjectLabel={getKanbanProjectLabel}
              onCardPress={onKanbanCardPress}
            />
          </>
        )}
      </View>
    );
  }

  let listBody: ReactNode;
  if (blocked) {
    listBody = blocked;
  } else if (isLoading) {
    listBody = <TrackerListSkeleton />;
  } else if (bodyState.kind === "empty") {
    listBody = hasFilteredOutTrackers ? (
      <TrackerFilteredEmptyBanner onClearFilters={onClearFilters} />
    ) : (
      <TrackerListEmptyState
        activeSearch={activeSearch}
        isSearchLoading={isSearchLoading}
        onCreate={onCreate}
      />
    );
  } else if (listVariant === "sections") {
    listBody = (
      <TrackerTable
        variant="sections"
        trackers={trackers}
        showProjectLabel={showProjectLabel}
        onOpenTracker={onOpenTracker}
        hierarchy={trackerHierarchy}
        onTrackerPatched={onTrackerPatched}
        onEditTracker={onEditTracker}
        onTrackersRemoved={onTrackersRemoved}
        sectionTotals={sectionTotals}
        sectionHasMore={sectionHasMore}
        sectionLoadingMore={sectionLoadingMore}
        onLoadMore={onLoadMore}
      />
    );
  } else {
    listBody = (
      <TrackerTable
        variant="flat"
        trackers={trackers}
        showProjectLabel={showProjectLabel}
        onOpenTracker={onOpenTracker}
        hierarchy={trackerHierarchy}
        onTrackerPatched={onTrackerPatched}
        onEditTracker={onEditTracker}
        onTrackersRemoved={onTrackersRemoved}
        onLoadMoreAll={onLoadMoreAll}
        hasMoreAll={hasMoreAll}
        isLoadingMoreAll={isLoadingMoreAll}
      />
    );
  }

  // One ScrollView for every list state, with the toolbar and the search field
  // always at child index 0 and 1. That is not a style choice: swapping which
  // subtree wraps the search field makes react-native-web remount it instead of
  // patching it, and the field loses keyboard focus mid-search. Keep the data
  // region as the only thing that varies here.
  return (
    <ScrollView
      ref={listScrollRef}
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
      stickyHeaderIndices={[0]}
      testID="trackers-list"
    >
      {toolbar}
      <TrackerSearchRow
        viewMode={viewMode}
        value={searchInput}
        onChangeText={onSearchInputChange}
      />
      {listBody}
    </ScrollView>
  );
}

// Shared by both views (pas-2KY5X.52): the active type/priority/status
// filters hid every tracker the project has. Rendered as a page-level
// <Alert> per docs/design.md §11 ("recoverable errors that need a small
// visible block on the page"), not a full-screen replacement — Kanban keeps
// its lanes mounted below this, and List has nothing else to show in its
// place.
function TrackerFilteredEmptyBanner({
  onClearFilters,
}: {
  onClearFilters: () => void;
}): ReactElement {
  return (
    <View style={styles.filterEmptyBanner} testID="trackers-filtered-empty">
      <Alert
        variant="info"
        title="No items match your filters"
        description="This project has items outside the current type or priority filter."
      >
        <Button
          variant="outline"
          size="sm"
          onPress={onClearFilters}
          testID="trackers-clear-filters"
        >
          Clear filters
        </Button>
      </Alert>
    </View>
  );
}

function TrackerListEmptyState({
  activeSearch,
  isSearchLoading,
  onCreate,
}: {
  activeSearch: string;
  isSearchLoading: boolean;
  onCreate: () => void;
}): ReactElement {
  if (activeSearch.length > 0) {
    return (
      <View style={styles.centered} testID="trackers-empty">
        {isSearchLoading ? (
          <LoadingSpinner size="large" color={styles.spinner.color} />
        ) : (
          <>
            <ListChecks size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
            <Text style={styles.emptyTitle}>No results for &quot;{activeSearch}&quot;</Text>
          </>
        )}
      </View>
    );
  }
  return (
    <View style={styles.centered} testID="trackers-empty">
      <ListChecks size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
      <Text style={styles.emptyTitle}>Nothing tracked yet</Text>
      <Button variant="outline" leftIcon={Plus} onPress={onCreate} testID="trackers-empty-new">
        New item
      </Button>
    </View>
  );
}

interface StatFilterPillDef {
  value: StatFilter;
  label: string;
  /** Which total this pill shows. The definition is static — only the number
   * it resolves to has to wait for data. */
  countKey: keyof TrackerStatCounts;
}

const LIST_STAT_PILLS: readonly StatFilterPillDef[] = [
  { value: "open", label: "Open", countKey: "open" },
  { value: "in_progress", label: "In Progress", countKey: "inProgress" },
  { value: "done", label: "Done", countKey: "done" },
  { value: "all", label: "All", countKey: "all" },
];

/**
 * The count half of a filter pill. Reserves a fixed, right-aligned column so
 * the label beside it never moves: these numbers arrive late, keep climbing
 * through the background sweep, and sit in a row that is centred on tablet —
 * every digit that changed the pill's width would shift the whole row.
 */
function StatCount({
  count,
  active,
  pulse,
  style,
}: {
  count: number | null;
  /** The pill is filled solid, so the placeholder needs the inverse fill to
   * stay visible on it. */
  active: boolean;
  pulse: Animated.Value;
  style: StyleProp<TextStyle>;
}): ReactElement {
  if (count === null) {
    return (
      <SkeletonPulse
        pulse={pulse}
        style={[styles.statNumberSkeleton, active && styles.statNumberSkeletonActive]}
      />
    );
  }
  return <Text style={style}>{count}</Text>;
}

// Hover/active colours for the count, locked to the same status palette used by
// the tracker-row status labels (blue / amber / red / green). "all" stays neutral.
function statNumberColorStyle(value: StatFilter): StyleProp<TextStyle> {
  switch (value) {
    case "open":
      return styles.statColorOpen;
    case "in_progress":
      return styles.statColorInProgress;
    case "p0":
      return styles.statColorP0;
    case "done":
      return styles.statColorDone;
    default:
      return styles.statColorAll;
  }
}

// Priority levels shown in the `?` help popover, mirroring the severity colours
// used in the tracker-row metadata. `colorStyle` resolves the per-level colour.
const PRIORITY_HELP_LEVELS: ReadonlyArray<PriorityFilterLevel> = [
  { id: "P0", filter: "p0", desc: "Critical — urgent, severe" },
  { id: "P1", filter: "p1", desc: "High priority" },
  { id: "P2", filter: "p2", desc: "Normal — default level" },
  { id: "P3", filter: "p3", desc: "Low priority" },
  { id: "P4", filter: "p4", desc: "Nice to have — optional" },
];

function priorityHelpColorStyle(id: string): StyleProp<TextStyle> {
  switch (id) {
    case "P0":
      return styles.helpP0;
    case "P1":
      return styles.helpP1;
    case "P2":
      return styles.helpP2;
    case "P3":
      return styles.helpP3;
    default:
      return styles.helpP4;
  }
}

function StatFilterPillView({
  def,
  count,
  active,
  onSelect,
  pulse,
}: {
  def: StatFilterPillDef;
  count: number | null;
  active: boolean;
  onSelect: (value: StatFilter) => void;
  pulse: Animated.Value;
}): ReactElement {
  const [isHovered, setIsHovered] = useState(false);
  const handlePress = useCallback(() => onSelect(def.value), [onSelect, def.value]);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  // Same pill geometry and hover/active treatment as the Tasks/Epics/Initiatives
  // SegmentedControl: a solid theme.colors.foreground pill when active, the same
  // surface2 hover wash otherwise (see segmented-control.tsx's segmentSelected /
  // segmentHover). The per-status semantic hue (statColorOpen etc.) only applies
  // at rest/hover — an active pill is a solid fill, so it uses the inverse
  // (surface0) text colour instead, matching labelSelected there.
  const pillStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.statCard,
      active ? styles.statCardActive : (Boolean(isHovered) || pressed) && styles.statCardHovered,
    ],
    [isHovered, active],
  );
  const showSemanticColor = !active && isHovered;
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  return (
    <Pressable
      style={pillStyle}
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={`Filter: ${def.label}`}
      testID={`trackers-stat-${def.value}`}
    >
      <StatCount
        count={count}
        active={active}
        pulse={pulse}
        style={[
          styles.statNumber,
          active ? styles.statNumberActive : showSemanticColor && statNumberColorStyle(def.value),
        ]}
      />
      <Text style={[styles.statLabel, active && styles.statLabelActive]}>{def.label}</Text>
    </Pressable>
  );
}

type KanbanPriorityFilter = Extract<StatFilter, "p0" | "p1" | "p2" | "p3" | "p4" | "all">;

interface KanbanPriorityButtonDef {
  filter: KanbanPriorityFilter;
  label: string;
}

// Buttons instead of a dropdown: the whole point of the priority filter on a
// board you're already looking at is to see every level at a glance and pick
// one in a single tap, not open a menu to find out what the levels even are.
const KANBAN_PRIORITY_BUTTONS: readonly KanbanPriorityButtonDef[] = [
  { filter: "p0", label: "Critical" },
  { filter: "p1", label: "High priority" },
  { filter: "p2", label: "Normal" },
  { filter: "p3", label: "Low priority" },
  { filter: "p4", label: "Nice to have" },
  { filter: "all", label: "All" },
];

function KanbanPriorityFilterButton({
  def,
  count,
  active,
  onSelect,
  pulse,
}: {
  def: KanbanPriorityButtonDef;
  count: number | null;
  active: boolean;
  onSelect: (value: StatFilter) => void;
  pulse: Animated.Value;
}): ReactElement {
  const [isHovered, setIsHovered] = useState(false);
  const handlePress = useCallback(() => onSelect(def.filter), [onSelect, def.filter]);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  // Same pill geometry/active treatment as StatFilterPillView, count digit included.
  const pillStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.statCard,
      active ? styles.statCardActive : (Boolean(isHovered) || pressed) && styles.statCardHovered,
    ],
    [isHovered, active],
  );
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  return (
    <Pressable
      style={pillStyle}
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={`Filter: ${def.label}`}
      testID={`trackers-kanban-priority-${def.filter}`}
    >
      <StatCount
        count={count}
        active={active}
        pulse={pulse}
        style={[styles.statNumber, active && styles.statNumberActive]}
      />
      <Text style={[styles.statLabel, active && styles.statLabelActive]}>{def.label}</Text>
    </Pressable>
  );
}

// No wrapper row of its own — StatFilterRow's inner row already is one, and
// nesting a second identical flex row inside it only left a container whose
// gap did nothing.
function KanbanPriorityFilterRow({
  counts,
  statFilter,
  onStatFilterChange,
  pulse,
}: {
  counts: TrackerStatCounts | null;
  statFilter: StatFilter;
  onStatFilterChange: (value: StatFilter) => void;
  pulse: Animated.Value;
}): ReactElement {
  return (
    <>
      {KANBAN_PRIORITY_BUTTONS.map((def) => (
        <KanbanPriorityFilterButton
          key={def.filter}
          def={def}
          count={counts ? counts[def.filter] : null}
          active={statFilter === def.filter}
          onSelect={onStatFilterChange}
          pulse={pulse}
        />
      ))}
    </>
  );
}

// The toolbar pill components (StatFilterPillView, KanbanPriorityFilterButton,
// PriorityFilterDropdown) predate server-side stats and speak the flat
// TrackerStatCounts shape — converting TrackerStatsCounts's per-type bucket
// into that shape here keeps all of them unchanged rather than threading the
// nested byStatus/byPriority shape through every leaf.
//
// `done` is `closed` alone, matching tracker-stats.ts's
// listVisibleStatusesForFilter("done") (["closed"], not cancelled) and the
// List section header's own `sectionTotals.closed` — the same "Done means
// closed, cancelled is its own bucket" convention the Kanban Done lane
// already settled on (pas-2KY5X.2). Summing cancelled in here was the actual
// bug behind pas-2KY5X.18: the pill's own number disagreed with what
// selecting it would show, on top of disagreeing with the section header
// right below it.
function toLegacyStatCounts(bucket: TrackerStatsCounts["all"]): TrackerStatCounts {
  return {
    open: bucket.byStatus.open,
    inProgress: bucket.byStatus.in_progress,
    p0: bucket.byPriority.P0,
    p1: bucket.byPriority.P1,
    p2: bucket.byPriority.P2,
    p3: bucket.byPriority.P3,
    p4: bucket.byPriority.P4,
    done: bucket.byStatus.closed,
    all: bucket.total,
  };
}

// "Ready" (unblocked) is intentionally omitted: it needs dependency/blocker
// data that `ait list` doesn't return per-row, only `ait show <id>` does — a
// dedicated ready-count RPC is follow-up work.
//
// Kanban only gets the Priority buttons, not the Open/In Progress/Done pills.
// Those pills used to project the board down to whichever lanes matched,
// which left a single lane stretched full-width with a lot of empty space —
// Kanban already shows every status as its own column, so filtering by status
// there is redundant. Priority stays, but dims non-matching cards in place
// (buildTrackerBoard's isDimmed) instead of hiding lanes.
function StatFilterRow({
  counts,
  isLoading,
  statFilter,
  onStatFilterChange,
  viewMode,
  isCompact,
  placement,
  centered,
}: {
  /** Already picked for the current type filter and converted from
   * TrackerStatsCounts's per-type bucket — see toLegacyStatCounts. `null`
   * while loading or when the host lacks `aitTrackerStats`. */
  counts: TrackerStatCounts | null;
  /** Drives the skeleton pulse animation. The labels are static and never
   * wait for data — only the numbers do, and `counts === null` alone already
   * renders every number as a placeholder regardless of this flag. */
  isLoading: boolean;
  statFilter: StatFilter;
  onStatFilterChange: (value: StatFilter) => void;
  viewMode: ViewMode;
  isCompact: boolean;
  /** "inline" sits inside a toolbar row that already applies the horizontal
   * inset and the vertical rhythm; "stacked" is a full-bleed row of its own
   * and supplies both itself. */
  placement: "inline" | "stacked";
  /** Centers the pills within the row when they don't fill it. */
  centered: boolean;
}): ReactElement | null {
  const pulse = useSkeletonPulse(isLoading);
  const isStacked = placement === "stacked";
  // The stacked row's own margins live here rather than on a wrapper View —
  // this component already renders a ScrollView, and it returns null in the
  // compact Kanban case, where a wrapper would have left its margins behind as
  // an empty gap.
  const scrollStyle = [styles.statsRowScroll, isStacked && styles.statsRowStacked];
  // Inset on the content container rather than the ScrollView so the pills can
  // scroll all the way to the screen edge instead of stopping at the inset.
  const contentStyle = [styles.statsRowScrollContent, isStacked && styles.statsRowContentInset];
  // Centering is `margin: auto` on an inner row, not justifyContent on the
  // scroll content: auto margins collapse to 0 once the content overflows,
  // whereas centered justification would push the first pill past the
  // scroller's left edge where it can't be scrolled back into view.
  const innerStyle = [styles.statsRowInner, centered && styles.statsRowInnerCentered];

  // Compact width folds the priority filter into TrackerFilterMenu (the
  // toolbar's overflow trigger) instead of rendering it inline — Kanban's
  // priority-buttons row is the whole of this component in that mode, so
  // there's nothing left to show here at all.
  if (viewMode === "kanban" && isCompact) {
    return null;
  }

  const body =
    viewMode === "kanban" ? (
      <KanbanPriorityFilterRow
        counts={counts}
        statFilter={statFilter}
        onStatFilterChange={onStatFilterChange}
        pulse={pulse}
      />
    ) : (
      LIST_STAT_PILLS.map((def, index) => (
        <Fragment key={def.value}>
          <StatFilterPillView
            def={def}
            count={counts ? counts[def.countKey] : null}
            active={statFilter === def.value}
            onSelect={onStatFilterChange}
            pulse={pulse}
          />
          {index === 2 && !isCompact ? (
            <PriorityFilterDropdown
              counts={counts}
              statFilter={statFilter}
              onStatFilterChange={onStatFilterChange}
              pulse={pulse}
            />
          ) : null}
        </Fragment>
      ))
    );

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={scrollStyle}
      contentContainerStyle={contentStyle}
    >
      <View style={innerStyle}>{body}</View>
    </ScrollView>
  );
}

function TrackersToolbar({
  contentWidth,
  statsCounts,
  statsLoading,
  projects,
  selectedProjectId,
  selectedProjectName,
  onSelectProject,
  statFilter,
  onStatFilterChange,
  viewMode,
  typeFilter,
  onTypeFilterChange,
  onCreate,
}: {
  /** Measured content width; see `useContentWidth`. Null only on native's
   * first frame, where every form factor is compact and lands on the stacked
   * arrangement anyway. */
  contentWidth: number | null;
  /** Exact server-computed counts for the toolbar stat pills — already
   * fetched unfiltered by listStatFilter/kanbanStatFilter; the pill for the
   * current type filter is picked from its per-type bucket below. */
  statsCounts: TrackerStatsCounts | null;
  statsLoading: boolean;
  projects: TrackerProjectInput[];
  selectedProjectId: string | null;
  /** See ProjectPicker's own doc comment on this same field. */
  selectedProjectName: string | null;
  onSelectProject: (projectId: string | null) => void;
  statFilter: StatFilter;
  onStatFilterChange: (value: StatFilter) => void;
  viewMode: ViewMode;
  typeFilter: TypeFilter;
  onTypeFilterChange: (value: TypeFilter) => void;
  onCreate: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const typeFilterOptions: SegmentedControlOption<TypeFilter>[] = useMemo(
    () =>
      TYPE_FILTER_DEFS.map((def) => ({
        value: def.value,
        label: t(def.labelKey),
        testID: `trackers-type-filter-${def.value}`,
      })),
    [t],
  );

  // Three groups, built once and independently of where they end up. Each
  // arrangement below only places them — nothing about a group's own content
  // depends on the arrangement, which is what stops a fix for one form factor
  // from rearranging another.
  //
  // Group 1: which project.
  const projectGroup =
    projects.length > 1 ? (
      <ProjectPicker
        projects={projects}
        selectedProjectId={selectedProjectId}
        selectedProjectName={selectedProjectName}
        onSelectProject={onSelectProject}
      />
    ) : null;

  // Group 2: which granularity, plus the create action. Compact folds the
  // granularity toggle (and the priority filter) into one overflow menu.
  const typeGroup = (
    <>
      {isCompact ? (
        <TrackerFilterMenu
          typeFilter={typeFilter}
          onTypeFilterChange={onTypeFilterChange}
          statFilter={statFilter}
          onStatFilterChange={onStatFilterChange}
        />
      ) : (
        <SegmentedControl
          options={typeFilterOptions}
          value={typeFilter}
          onValueChange={onTypeFilterChange}
          size="sm"
          testID="trackers-type-filter"
        />
      )}
      <Button variant="outline" leftIcon={Plus} onPress={onCreate} size="sm" testID="trackers-new">
        New item
      </Button>
    </>
  );

  // Group 3: which status or priority. The bucket matching the current type
  // filter is what TrackerStatsCounts's per-type split exists for — picking
  // it here (rather than in StatFilterRow) keeps that component's prop
  // surface a plain, already-resolved TrackerStatCounts.
  const isSingleRow = contentWidth != null && contentWidth >= TOOLBAR_SINGLE_ROW_MIN_WIDTH;
  const statsBucket = statsCounts ? statsCounts[typeFilter] : null;
  const statsGroup = (
    <StatFilterRow
      counts={statsBucket ? toLegacyStatCounts(statsBucket) : null}
      isLoading={statsLoading}
      statFilter={statFilter}
      onStatFilterChange={onStatFilterChange}
      viewMode={viewMode}
      isCompact={isCompact}
      placement={isSingleRow ? "inline" : "stacked"}
      centered={!isSingleRow && !isCompact}
    />
  );

  // Desktop, one row: groups 1 and 3 left, group 2 right.
  if (isSingleRow) {
    return (
      <View style={[styles.toolbar, styles.toolbarBordered]}>
        <View style={[styles.toolbarRow, styles.toolbarRowSingle]}>
          <View style={styles.rowLeft}>
            {projectGroup}
            {statsGroup}
          </View>
          <View style={styles.rowTrailing}>{typeGroup}</View>
        </View>
      </View>
    );
  }

  // Tablet and mobile, two rows: group 1 left and group 2 right on the first,
  // group 3 full-bleed on its own below. The two differ only in what the
  // groups render (dropdown vs. segmented control, keyed off isCompact inside
  // typeGroup) and in the bottom border, which mobile drops — at that width it
  // lands directly on the search field or the Kanban lane pills and reads as a
  // stray line rather than a section break.
  return (
    <View style={[styles.toolbar, !isCompact && styles.toolbarBordered]}>
      <View style={styles.toolbarRow}>
        {projectGroup}
        <View style={styles.rowTrailing}>{typeGroup}</View>
      </View>
      {statsGroup}
    </View>
  );
}

function renderListIcon({ color, size }: { color: string; size: number }): ReactElement {
  return <ListChecks color={color} size={size} />;
}

function renderKanbanIcon({ color, size }: { color: string; size: number }): ReactElement {
  return <LayoutGrid color={color} size={size} />;
}

const viewModeOptions: SegmentedControlOption<ViewMode>[] = [
  { value: "list", label: "List", icon: renderListIcon, testID: "trackers-view-list" },
  { value: "kanban", label: "Kanban", icon: renderKanbanIcon, testID: "trackers-view-kanban" },
];

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[4],
    padding: theme.spacing[6],
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  emptyIcon: {
    color: theme.colors.foregroundMuted,
    width: theme.iconSize.lg,
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  // Same horizontal rhythm as toolbarRow/searchRow below — kanbanContainer
  // carries no padding of its own, and inside the List ScrollView this sits
  // where TrackerTable's own row padding would otherwise start.
  filterEmptyBanner: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingVertical: theme.spacing[4],
  },
  // Same padding tokens as sessions-screen.tsx's filterContainer — rendered
  // inside the scrollable content, below the sticky toolbar and above
  // TrackerTable, so it scrolls away with the list instead of staying pinned.
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: { xs: 0, sm: 0, md: theme.spacing[4] },
    paddingBottom: theme.spacing[2],
  },
  // No flexWrap: a group that doesn't fit scrolls or shrinks in place. Wrapping
  // would silently move a group to a line the layout never asked for, which is
  // how this toolbar previously ended up rearranging itself at widths nobody
  // tested.
  toolbarRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  // Desktop has no second row to supply the bottom spacing.
  toolbarRowSingle: {
    paddingBottom: theme.spacing[4],
  },
  // Wraps every row of the toolbar as one opaque block, border on the outside
  // so it sits after the last row. List's ScrollView passes
  // stickyHeaderIndices={[0]}, so this doubles as the sticky block's own
  // boundary there; Kanban isn't in a ScrollView (the board owns its own
  // scrolling) but still wants the same visual break before its lane
  // headers/columns — `kanbanContainer`'s gap keeps the border off them.
  toolbar: {
    backgroundColor: theme.colors.surface0,
  },
  // Tablet/desktop only — on mobile this sits right above the Kanban
  // lane-selector pills (or a search field) with barely any room, reading as
  // a stray line instead of a real section break.
  toolbarBordered: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  // The single-row arrangement's left slot: the project picker plus the stat
  // pills. It is the only slot allowed to shrink, because the pills are a
  // horizontal ScrollView and can give width back by scrolling — minWidth: 0
  // is what permits shrinking below content width at all. A slot whose own
  // children can't shrink (React Native defaults flexShrink to 0) would
  // overflow its box and overlap the next slot instead.
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
    flexShrink: 1,
    minWidth: 0,
  },
  // Pinned right by its own auto margin rather than by the row's
  // justifyContent: with a single project there is no left slot at all, and
  // space-between would leave this group stranded on the left.
  rowTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
    flexShrink: 0,
    marginLeft: "auto",
  },
  // flexGrow: 0 keeps it pinned to its content height as a column flex child;
  // flexShrink/minWidth let it give up width and scroll when it's a row child.
  statsRowScroll: {
    flexGrow: 0,
    flexShrink: 1,
    minWidth: 0,
  },
  // Vertical rhythm for the stacked placement, where this row is a sibling of
  // `toolbarRow` rather than a child of it.
  statsRowStacked: {
    marginTop: theme.spacing[4],
    marginBottom: theme.spacing[4],
  },
  // flexGrow: 1 gives the content container the scroller's full width when the
  // pills are narrower than it, which is what the inner row's auto margins
  // need in order to have any free space to centre within.
  statsRowScrollContent: {
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  // Matches `toolbarRow`'s inset, for the stacked placement where this row is
  // full-bleed instead of nested inside that padded row.
  statsRowContentInset: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
  },
  // Same gap for List and Kanban — the pills read as one group either way.
  // 10 doesn't land on the spacing scale (6 or 12 are the neighbours); a
  // plain literal, same as STAT_COUNT_WIDTH above.
  statsRowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  statsRowInnerCentered: {
    marginHorizontal: "auto",
  },
  // Same pill geometry as the Tasks/Epics/Initiatives SegmentedControl
  // (full-radius, surface2 hover, solid foreground when active — see
  // segmented-control.tsx's segment/segmentHover/segmentSelected).
  statCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minHeight: 28,
    paddingVertical: 0,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.full,
  },
  statCardHovered: {
    backgroundColor: theme.colors.surface2,
  },
  statCardActive: {
    backgroundColor: theme.colors.foreground,
  },
  statNumber: {
    color: theme.colors.foregroundMuted,
    // Matches segmentedLabelSm's fontSize.sm — same reasoning as statCard's
    // minHeight above.
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  statNumberSkeleton: {
    width: STAT_COUNT_WIDTH,
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
  },
  statNumberSkeletonActive: {
    backgroundColor: theme.colors.surface0,
  },
  // Inverse text on the solid active pill — matches SegmentedControl's
  // labelSelected (theme.colors.surface0), overriding the per-status hue.
  statNumberActive: {
    color: theme.colors.surface0,
  },
  statColorOpen: {
    color: theme.colors.palette.blue[600],
  },
  statColorInProgress: {
    color: theme.colors.palette.amber[700],
  },
  statColorP0: {
    color: theme.colors.palette.red[600],
  },
  statColorDone: {
    color: theme.colors.palette.green[600],
  },
  statColorAll: {
    color: theme.colors.foreground,
  },
  helpP0: {
    color: theme.colors.palette.red[600],
  },
  helpP1: {
    color: theme.colors.palette.orange[600],
  },
  helpP2: {
    color: theme.colors.palette.yellow[600],
  },
  helpP3: {
    color: theme.colors.palette.sky[600],
  },
  helpP4: {
    color: theme.colors.palette.slate[400],
  },
  priorityFilterTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
  },
  priorityFilterText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  priorityFilterTextActive: {
    color: theme.colors.surface0,
  },
  priorityFilterLevel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    width: theme.spacing[3],
  },
  priorityFilterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  priorityFilterDesc: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    minWidth: 0,
  },
  priorityFilterCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  priorityFilterCountHovered: {
    color: theme.colors.palette.red[600],
  },
  priorityFilterCountActive: {
    color: theme.colors.surface0,
  },
  priorityFilterTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  priorityFilterTriggerActive: {
    backgroundColor: theme.colors.foreground,
  },
  statLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  statLabelActive: {
    color: theme.colors.surface0,
    fontWeight: theme.fontWeight.medium,
  },
  projectPickerTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    maxWidth: 220,
  },
  projectPickerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  kanbanContainer: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[4],
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: theme.spacing[6],
  },
  errorsButtonTrigger: {
    position: "relative",
    padding: theme.spacing[1.5],
    borderRadius: theme.borderRadius.full,
  },
  // Small count badge pinned to the trigger's top-right corner — a fixed
  // size/offset overlay rather than a flex sibling, so it reads as a
  // notification dot instead of pushing the icon around.
  errorsBadge: {
    position: "absolute",
    top: 0,
    right: 0,
    minWidth: 14,
    height: 14,
    paddingHorizontal: 3,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.red[600],
    alignItems: "center",
    justifyContent: "center",
  },
  // Always white, not theme.colors.surface0 — the badge's red fill is a
  // static palette colour in both themes, so the count needs a fixed
  // contrast colour rather than one that flips with the surface token.
  errorsBadgeText: {
    color: "#ffffff",
    fontSize: 9,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 12,
  },
  // Checklist rows — no per-row card/border, just a hairline divider between
  // entries (the popover surface itself is already the outer boundary).
  errorsMenuList: {
    padding: theme.spacing[3],
  },
  errorsMenuDivider: {
    height: 1,
    backgroundColor: theme.colors.border,
    opacity: theme.opacity[50],
    marginVertical: theme.spacing[2],
  },
  // Heavier than errorsMenuDivider (full opacity, more margin) — marks the
  // boundary between the description and the actual list of errors, so the
  // two don't read as one continuous block.
  errorsMenuDescriptionDivider: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing[3],
  },
  errorsMenuHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  errorsCloseButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  errorsMenuTitleRow: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "baseline",
  },
  errorsMenuTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 20,
  },
  // Default matches errorsMenuTitle exactly (no accent tint at rest) — only
  // the hover state below picks up colour + underline.
  errorsMenuLink: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 20,
    textDecorationLine: "underline",
  },
  errorsMenuLinkHovered: {
    color: theme.colors.accent,
  },
  errorsMenuDescription: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    marginTop: theme.spacing[1],
  },
  errorsRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  // A filled dot instead of a "•" glyph so it sits reliably centered on the
  // text's first line regardless of font metrics — nudged down by half a
  // line to land mid-line rather than at the cap height.
  errorsRowBullet: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
    marginTop: 6,
  },
  errorsRowBody: {
    flex: 1,
    gap: theme.spacing[1.5],
  },
  errorsRowText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  // Red in light mode; in dark mode red-on-dark reads as an alarm rather
  // than a highlight, so it switches to green instead — not a "something is
  // broken" hue. green[600] (used for "Closed" against a lighter row
  // background) reads muddy against this popover's much darker surface, so
  // this uses green[500], a step lighter, for the same contrast the row
  // color gets elsewhere.
  errorsRowEmphasis: {
    color:
      theme.colorScheme === "dark"
        ? theme.colors.palette.green[500]
        : theme.colors.palette.red[600],
    fontWeight: theme.fontWeight.medium,
  },
  errorsCopyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.surface3,
    backgroundColor: theme.colors.surface2,
  },
  errorsCopyCommand: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
}));
