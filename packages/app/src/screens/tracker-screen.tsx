import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
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
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { TrackerSummary, TrackerType } from "@getpaseo/protocol/tracker/types";
import { MenuHeader } from "@/components/headers/menu-header";
import { TrackerDetailSheet } from "@/components/tracker/tracker-detail-sheet";
import { TrackerFormSheet } from "@/components/tracker/tracker-form-sheet";
import { TrackerKanbanBoard } from "@/components/tracker/tracker-kanban-board";
import { TrackerTable, useTrackerPageStep } from "@/components/tracker/tracker-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  type DropdownMenuTriggerState,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { SearchField } from "@/components/ui/search-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { openExternalUrl } from "@/utils/open-external-url";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useProjects } from "@/hooks/use-projects";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import {
  fetchTrackerReadyIds,
  trackerQueryBaseKey,
  type AggregatedTracker,
  type TrackerProjectError,
  type TrackerProjectInput,
} from "@/tracker/aggregated-trackers";
import { useTrackerMutations } from "@/tracker/use-tracker-mutations";
// This screen no longer subscribes to the live-push path (useAggregatedTrackers) —
// it drives both List and Kanban from useTrackerProjectData's progressive
// background sweep and reflects the user's own mutations via local patching.
import type { AggregateLoadState } from "@/tracker/use-aggregated-trackers";
import { useTrackerProjectData } from "@/tracker/use-tracker-project-data";
import { useTrackerSearch } from "@/tracker/use-tracker-search";
import { buildTrackerHierarchy, type TrackerHierarchy } from "@/tracker/tracker-hierarchy";
import {
  getTrackerStatCounts,
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
// "task" (preserves the board's original default; the List view inherits it).
type TypeFilter = TrackerType | "all";

const TYPE_FILTER_DEFS: ReadonlyArray<{ value: TypeFilter; labelKey: string }> = [
  { value: "task", labelKey: "tracker.kanban.type.tasks" },
  { value: "epic", labelKey: "tracker.kanban.type.epics" },
  { value: "initiative", labelKey: "tracker.kanban.type.initiatives" },
  { value: "all", labelKey: "tracker.kanban.type.all" },
];

// Mirrors sessions-screen.tsx's own search field/debounce — List-only (see
// the `viewMode === "list"` gate in TrackerSearchRow): Kanban's board already
// finds an item by scanning its column, and title+id substring search over a
// swimlane grouping is a different feature this doesn't attempt.
const TRACKER_SEARCH_DEBOUNCE_MS = 200;
const TRACKER_SEARCH_MIN_LENGTH = 3;

// Below TRACKER_SEARCH_MIN_LENGTH, every keystroke would re-filter the full
// tracker set for a query too short to narrow anything useful — treat it as
// "not searching" instead. Trailing spaces count toward that length (and stay
// in the needle) rather than being trimmed away, so "v1 " (4 chars) narrows to
// the "v1" prefix instead of also matching "v10", "v123", etc. — only an
// all-whitespace query is treated as empty.
// Extracted out of TrackerScreenContent to keep the branch out of its own
// cyclomatic complexity — List and Kanban now read the same shared
// project-data sweep, so there is exactly one loading source to resolve,
// regardless of view mode.
function resolveEffectiveLoadState(isLoading: boolean): AggregateLoadState<AggregatedTracker> {
  return isLoading ? { status: "loading" } : { status: "loaded", data: EMPTY_TRACKERS };
}

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
const EMPTY_TRACKERS: AggregatedTracker[] = [];
const EMPTY_READY_IDS: ReadonlySet<string> = new Set();

// Only fetched in Kanban mode — List never renders a Ready lane. The fetch
// itself (fetchTrackerReadyIds) is per-project resilient: a project whose
// server predates `aitTrackerReady`, is offline, or errors just contributes
// no ids, so that project's items stay in Open rather than blocking the fetch.
function useTrackerReadyIds(options: {
  viewMode: ViewMode;
  projects: readonly TrackerProjectInput[];
  selectedProjectId: string | null;
}): ReadonlySet<string> {
  const relevantProjects = useMemo(
    () =>
      options.selectedProjectId
        ? options.projects.filter((project) => project.projectId === options.selectedProjectId)
        : options.projects,
    [options.projects, options.selectedProjectId],
  );
  const query = useFetchQuery<ReadonlySet<string>>({
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
  return query.data ?? EMPTY_READY_IDS;
}

// List view's data source switch: browse mode reads `browseTrackers` — the
// same shared project-data array Kanban renders from, just filtered and
// bucketed differently; search mode always queries the server
// (project.tracker.search) and never filters what browse has loaded. Kanban
// never depends on isListSearch at all — only this hook (and TrackerTable's
// own rendering) branches on it.
function useTrackerListView(options: {
  hasAnyProject: boolean;
  viewMode: ViewMode;
  search: string;
  typeFilter: TypeFilter;
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
  // The toolbar's stat filter stays client-side for both sources. The type
  // filter only narrows the browse source — search has never applied it
  // client-side (a server-side search result set is already small and
  // specific; narrowing it further by type isn't part of this feature).
  const listViewTrackers = useMemo(() => {
    if (isListSearch) {
      return options.listStatFilter === "all"
        ? searchState.results
        : searchState.results.filter((tracker) =>
            matchesListStatFilter(tracker, options.listStatFilter),
          );
    }
    const typeFiltered =
      options.typeFilter === "all"
        ? options.browseTrackers
        : options.browseTrackers.filter((tracker) => tracker.type === options.typeFilter);
    return options.listStatFilter === "all"
      ? typeFiltered
      : typeFiltered.filter((tracker) => matchesListStatFilter(tracker, options.listStatFilter));
  }, [
    isListSearch,
    searchState.results,
    options.browseTrackers,
    options.typeFilter,
    options.listStatFilter,
  ]);
  return { isListSearch, searchState, listViewTrackers };
}

export function TrackerScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <TrackerScreenContent />;
}

function TrackerScreenContent(): ReactElement {
  const { projects: projectSummaries } = useProjects();
  const projectInputs = useMemo<TrackerProjectInput[]>(
    () =>
      projectSummaries.flatMap((project) =>
        project.hosts.map((host) => ({
          serverId: host.serverId,
          serverName: host.serverName,
          projectId: host.projectId,
          projectName: host.projectName,
        })),
      ),
    [projectSummaries],
  );
  const hasAnyProject = projectInputs.length > 0;

  // Two independent filter states rendered through the same toolbar control (see
  // docs/refactors/tracker-kanban-redesign.md, "Toolbar contract"): in List mode
  // statFilter filters the dataset; in Kanban mode it only projects which lanes
  // are visible. Both default to "all" so arriving at the screen shows
  // everything rather than a filtered subset that reads as "missing items".
  const [listStatFilter, setListStatFilter] = useState<StatFilter>("all");
  const [kanbanStatFilter, setKanbanStatFilter] = useState<StatFilter>("all");
  // Shared by BOTH views: which tracker granularities are included. Defaults to
  // "task" (preserves the board's original default; the List view inherits it).
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("task");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTracker, setSelectedTracker] = useState<AggregatedTracker | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const search = gateTrackerSearch(useDebouncedValue(searchInput, TRACKER_SEARCH_DEBOUNCE_MS));

  useEffect(() => {
    if (selectedProjectId && !projectInputs.some((p) => p.projectId === selectedProjectId)) {
      setSelectedProjectId(null);
    }
  }, [projectInputs, selectedProjectId]);

  // The single shared data source for both List and Kanban — always running
  // regardless of view mode or search, exactly like the old Kanban-only
  // aggregate fetch used to. Switching view mode only changes how this array
  // renders, never how it loads. Already scoped to `selectedProjectId`
  // internally (or every project when none is selected), so callers use
  // `projectData.trackers` directly, no separate project filter needed.
  const pageStep = useTrackerPageStep();
  const projectData = useTrackerProjectData({
    projects: projectInputs,
    selectedProjectId,
    all: true,
    enabled: hasAnyProject,
    pageSize: pageStep,
  });

  // Built from the full (unfiltered) project set project data returns — the
  // List row's delete action needs to know the *real* child count (any type,
  // any status), not just what the current type/status toolbar filter shows.
  const trackerHierarchy = useMemo(
    () => buildTrackerHierarchy(projectData.trackers),
    [projectData.trackers],
  );
  // Type filter is applied here, before the board — buildTrackerBoard's own
  // partitioning stays status-only (see tracker-board-model.ts docstring).
  const kanbanTrackers = useMemo(
    () =>
      typeFilter === "all"
        ? projectData.trackers
        : projectData.trackers.filter((tracker) => tracker.type === typeFilter),
    [projectData.trackers, typeFilter],
  );
  const readyIds = useTrackerReadyIds({ viewMode, projects: projectInputs, selectedProjectId });

  const { isListSearch, searchState, listViewTrackers } = useTrackerListView({
    hasAnyProject,
    viewMode,
    search,
    typeFilter,
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
  // List search follows the search hook's own loading state; everything else
  // (browse List and Kanban) follows the shared project-data sweep.
  const effectiveLoadState = useMemo(
    () => resolveEffectiveLoadState(isListSearch ? searchState.isLoading : projectData.isLoading),
    [isListSearch, searchState.isLoading, projectData.isLoading],
  );
  const bodyState = resolveTrackerScreenBodyState({
    hasAnyProject,
    loadState: effectiveLoadState,
    selectedProjectId: selectedProjectId ?? "all",
    projectErrors: projectData.projectErrors,
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
    // `ait init` doesn't return a tracker to patch in — a fresh sweep is the
    // only way to move this project out of its `uninitialised` error state.
    void initMutations.initTracker().then(() => projectData.refetch());
  }, [initMutations, projectData]);
  const handleRetry = useCallback(() => {
    projectData.refetch();
  }, [projectData]);
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
        projectData.patchTracker({ ...aggregated, ...summary });
      } finally {
        // Still relevant for the (react-query-backed) readyIds fetch, which
        // this hook doesn't own.
        void queryClient.invalidateQueries({ queryKey: trackerQueryBaseKey });
      }
    },
    [kanbanTrackerById, queryClient, t, projectData],
  );
  const handleKanbanTransitionError = useCallback(
    (_trackerId: string, message: string) => toast.error(message),
    [toast],
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
  const handleTrackerCreated = useCallback(
    (tracker: TrackerSummary, project: TrackerProjectInput) => {
      projectData.patchTracker({ ...tracker, ...project });
    },
    [projectData],
  );
  const handleDetailMutated = useCallback(
    (summary: TrackerSummary) => {
      if (!selectedTracker) {
        return;
      }
      projectData.patchTracker({ ...selectedTracker, ...summary });
    },
    [selectedTracker, projectData],
  );

  const headerRightContent = useMemo(
    () => (
      <>
        {projectData.projectErrors.length > 0 ? (
          <TrackerErrorsButton errors={projectData.projectErrors} />
        ) : null}
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
    [projectData.projectErrors, viewMode],
  );

  return (
    <View style={styles.container}>
      <MenuHeader title="Tracker" rightContent={headerRightContent} />
      <TrackerScreenBody
        bodyState={bodyState}
        trackers={listViewTrackers}
        trackerHierarchy={trackerHierarchy}
        statsTrackers={kanbanTrackers}
        kanbanTrackers={kanbanTrackers}
        kanbanReadyIds={readyIds}
        isComplete={projectData.isComplete}
        onTrackerPatched={projectData.patchTracker}
        onTrackersRemoved={projectData.removeTrackers}
        listVariant={isListSearch ? "flat" : "sections"}
        onLoadMoreAll={searchState.loadMore}
        hasMoreAll={searchState.hasMore}
        isLoadingMoreAll={searchState.isLoadingMore}
        showProjectLabel={selectedProjectId === null}
        projects={projectInputs}
        selectedProjectId={selectedProjectId}
        onSelectProject={handleSelectProject}
        statFilter={effectiveStatFilter}
        onStatFilterChange={effectiveOnStatFilterChange}
        viewMode={viewMode}
        typeFilter={typeFilter}
        onTypeFilterChange={handleTypeFilterChange}
        searchInput={searchInput}
        onSearchInputChange={setSearchInput}
        activeSearch={search}
        onOpenTracker={handleOpenTracker}
        onKanbanTransition={handleKanbanTransition}
        onKanbanTransitionError={handleKanbanTransitionError}
        onKanbanCardPress={handleKanbanCardPress}
        onCreate={handleOpenCreate}
        onOpenProject={handleOpenProject}
        onInitialise={handleInitialise}
        isInitialising={initMutations.isInitialising}
        onRetry={handleRetry}
      />
      <TrackerFormSheet
        projects={projectInputs}
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
  onSelectProject,
}: {
  projects: TrackerProjectInput[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
}): ReactElement {
  const selectedLabel = selectedProjectId
    ? (projects.find((p) => p.projectId === selectedProjectId)?.projectName ?? "All projects")
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
}: {
  counts: TrackerStatCounts;
  statFilter: StatFilter;
  onStatFilterChange: (value: StatFilter) => void;
}): ReactElement {
  const selectedLevel = PRIORITY_HELP_LEVELS.find((level) => level.filter === statFilter) ?? null;
  const [isHovered, setIsHovered] = useState(false);
  const priorityTotal = counts.p0 + counts.p1 + counts.p2 + counts.p3 + counts.p4;
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
            <Text style={[styles.priorityFilterCount, styles.priorityFilterCountActive]}>
              {counts[selectedLevel.filter]}
            </Text>
            <Text style={[styles.priorityFilterText, styles.priorityFilterTextActive]}>
              {` ${selectedLevel.id}`}
            </Text>
          </>
        ) : (
          <>
            <Text
              style={[styles.priorityFilterCount, isHovered && styles.priorityFilterCountHovered]}
            >
              {priorityTotal}
            </Text>
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
// only renders when there is something to show (see headerRightContent).
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
// Pressable, not Text. Default colour matches the surrounding sentence (not
// accent-tinted at rest); only hover picks up the accent colour + underline,
// so it reads as a highlighted word rather than a conspicuous button.
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
  const projectDir = extractProjectDir(error.message);
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
      <View style={styles.errorsBadge}>
        <Text style={styles.errorsBadgeText}>{count}</Text>
      </View>
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
  const renderTrigger = useCallback(
    (state: DropdownMenuTriggerState) => renderErrorsTrigger(state, errors.length),
    [errors.length],
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={styles.errorsButtonTrigger}
        testID="trackers-project-errors-trigger"
      >
        {renderTrigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={360}>
        <View style={styles.errorsMenuList} testID="trackers-project-errors">
          <View style={styles.errorsMenuTitleRow}>
            <Text style={styles.errorsMenuTitle}>{"Track your projects with "}</Text>
            <TrackerAitRepoLink />
          </View>
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
        </View>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TrackerScreenBody({
  bodyState,
  trackers,
  trackerHierarchy,
  statsTrackers,
  kanbanTrackers,
  kanbanReadyIds,
  isComplete,
  onTrackerPatched,
  onTrackersRemoved,
  listVariant,
  onLoadMoreAll,
  hasMoreAll,
  isLoadingMoreAll,
  showProjectLabel,
  projects,
  selectedProjectId,
  onSelectProject,
  statFilter,
  onStatFilterChange,
  viewMode,
  typeFilter,
  onTypeFilterChange,
  searchInput,
  onSearchInputChange,
  activeSearch,
  onOpenTracker,
  onKanbanTransition,
  onKanbanTransitionError,
  onKanbanCardPress,
  onCreate,
  onOpenProject,
  onInitialise,
  isInitialising,
  onRetry,
}: {
  bodyState: TrackerScreenBodyState;
  trackers: AggregatedTracker[];
  trackerHierarchy: TrackerHierarchy;
  statsTrackers: AggregatedTracker[];
  kanbanTrackers: AggregatedTracker[];
  kanbanReadyIds: ReadonlySet<string>;
  /** False while the shared project-data sweep still has sections in flight —
   * threaded to both TrackerKanbanBoard (lane counts, card badges) and
   * TrackerTable (gates the delete-confirmation path). */
  isComplete: boolean;
  onTrackerPatched: (tracker: AggregatedTracker) => void;
  onTrackersRemoved: (ids: string[]) => void;
  listVariant: "sections" | "flat";
  onLoadMoreAll: () => void;
  hasMoreAll: boolean;
  isLoadingMoreAll: boolean;
  showProjectLabel: boolean;
  projects: TrackerProjectInput[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  statFilter: StatFilter;
  onStatFilterChange: (value: StatFilter) => void;
  viewMode: ViewMode;
  typeFilter: TypeFilter;
  onTypeFilterChange: (value: TypeFilter) => void;
  searchInput: string;
  activeSearch: string;
  onSearchInputChange: (value: string) => void;
  onOpenTracker: (tracker: AggregatedTracker) => void;
  onKanbanTransition: (trackerId: string, transition: TrackerTransition) => Promise<void>;
  onKanbanTransitionError: (trackerId: string, message: string) => void;
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

  switch (bodyState.kind) {
    case "no-projects":
      return (
        <View style={styles.centered}>
          <Text style={styles.message}>Open a project to see its tracker</Text>
          <Button variant="outline" onPress={onOpenProject} testID="trackers-open-project">
            Open project
          </Button>
        </View>
      );
    case "loading":
      return (
        <View style={styles.centered}>
          <LoadingSpinner size="large" color={styles.spinner.color} />
        </View>
      );
    case "cli-missing":
      return (
        <View style={styles.centered}>
          <Text style={styles.message}>Install the ait CLI on this host to track work here</Text>
        </View>
      );
    case "uninitialised":
      return (
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
    case "load-error":
      return (
        <View style={styles.centered}>
          <Text style={styles.message}>{bodyState.message}</Text>
          <Button variant="ghost" onPress={onRetry} testID="trackers-retry">
            Try again
          </Button>
        </View>
      );
    case "empty":
      return (
        // Same contentContainerStyle/stickyHeaderIndices as the "content" list
        // case below — the search input lives at the same child index in both,
        // and a structural mismatch here (e.g. sticky-wrapping only one of the
        // two) makes react-native-web remount the subtree instead of patching
        // it, which drops keyboard focus from the field mid-search.
        <ScrollView
          ref={listScrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          stickyHeaderIndices={[0]}
        >
          <TrackersToolbar
            statsTrackers={statsTrackers}
            projects={projects}
            selectedProjectId={selectedProjectId}
            onSelectProject={onSelectProject}
            statFilter={statFilter}
            onStatFilterChange={onStatFilterChange}
            viewMode={viewMode}
            typeFilter={typeFilter}
            onTypeFilterChange={onTypeFilterChange}
            onCreate={onCreate}
          />
          <TrackerSearchRow
            viewMode={viewMode}
            value={searchInput}
            onChangeText={onSearchInputChange}
          />
          {activeSearch.length > 0 ? (
            <View style={styles.centered} testID="trackers-empty">
              <ListChecks size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
              <Text style={styles.emptyTitle}>No results for &quot;{activeSearch}&quot;</Text>
            </View>
          ) : (
            <View style={styles.centered} testID="trackers-empty">
              <ListChecks size={styles.emptyIcon.width} color={styles.emptyIcon.color} />
              <Text style={styles.emptyTitle}>Nothing tracked yet</Text>
              <Button
                variant="outline"
                leftIcon={Plus}
                onPress={onCreate}
                testID="trackers-empty-new"
              >
                New item
              </Button>
            </View>
          )}
        </ScrollView>
      );
    case "content": {
      const toolbar = (
        <TrackersToolbar
          statsTrackers={statsTrackers}
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={onSelectProject}
          statFilter={statFilter}
          onStatFilterChange={onStatFilterChange}
          viewMode={viewMode}
          typeFilter={typeFilter}
          onTypeFilterChange={onTypeFilterChange}
          onCreate={onCreate}
        />
      );

      if (viewMode === "kanban") {
        // Not nested in the outer vertical ScrollView: each TrackerKanbanColumn owns
        // its own vertical ScrollView and needs a bounded-height parent (flex: 1),
        // which a ScrollView's content container can't give a child.
        return (
          <View style={styles.kanbanContainer} testID="trackers-kanban">
            {toolbar}
            <TrackerKanbanBoard
              trackers={kanbanTrackers}
              filter={statFilter}
              readyIds={kanbanReadyIds}
              isComplete={isComplete}
              onTransition={onKanbanTransition}
              onTransitionError={onKanbanTransitionError}
              getProjectLabel={getKanbanProjectLabel}
              onCardPress={onKanbanCardPress}
            />
          </View>
        );
      }

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
          <TrackerTable
            trackers={trackers}
            showProjectLabel={showProjectLabel}
            onOpenTracker={onOpenTracker}
            hierarchy={trackerHierarchy}
            isComplete={isComplete}
            onTrackerPatched={onTrackerPatched}
            onTrackersRemoved={onTrackersRemoved}
            variant={listVariant}
            onLoadMoreAll={onLoadMoreAll}
            hasMoreAll={hasMoreAll}
            isLoadingMoreAll={isLoadingMoreAll}
          />
        </ScrollView>
      );
    }
  }
}

interface StatFilterPillDef {
  value: StatFilter;
  label: string;
  count: number;
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
  active,
  onSelect,
}: {
  def: StatFilterPillDef;
  active: boolean;
  onSelect: (value: StatFilter) => void;
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
      <Text
        style={[
          styles.statNumber,
          active ? styles.statNumberActive : showSemanticColor && statNumberColorStyle(def.value),
        ]}
      >
        {def.count}
      </Text>
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
}: {
  def: KanbanPriorityButtonDef;
  count: number;
  active: boolean;
  onSelect: (value: StatFilter) => void;
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
      <Text style={[styles.statNumber, active && styles.statNumberActive]}>{count}</Text>
      <Text style={[styles.statLabel, active && styles.statLabelActive]}>{def.label}</Text>
    </Pressable>
  );
}

function KanbanPriorityFilterRow({
  counts,
  statFilter,
  onStatFilterChange,
}: {
  counts: TrackerStatCounts;
  statFilter: StatFilter;
  onStatFilterChange: (value: StatFilter) => void;
}): ReactElement {
  return (
    <View style={styles.kanbanPriorityRow}>
      {KANBAN_PRIORITY_BUTTONS.map((def) => (
        <KanbanPriorityFilterButton
          key={def.filter}
          def={def}
          count={counts[def.filter]}
          active={statFilter === def.filter}
          onSelect={onStatFilterChange}
        />
      ))}
    </View>
  );
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
  trackers,
  statFilter,
  onStatFilterChange,
  viewMode,
  isCompact,
}: {
  trackers: AggregatedTracker[];
  statFilter: StatFilter;
  onStatFilterChange: (value: StatFilter) => void;
  viewMode: ViewMode;
  isCompact: boolean;
}): ReactElement | null {
  const counts = getTrackerStatCounts(trackers);

  // Compact width folds the priority filter into TrackerFilterMenu (the
  // toolbar's overflow trigger) instead of rendering it inline — Kanban's
  // priority-buttons row is the whole of this component in that mode, so
  // there's nothing left to show here at all.
  if (viewMode === "kanban") {
    return isCompact ? null : (
      <KanbanPriorityFilterRow
        counts={counts}
        statFilter={statFilter}
        onStatFilterChange={onStatFilterChange}
      />
    );
  }

  const defs: StatFilterPillDef[] = [
    { value: "open", label: "Open", count: counts.open },
    { value: "in_progress", label: "In Progress", count: counts.inProgress },
    { value: "done", label: "Done", count: counts.done },
    { value: "all", label: "All", count: counts.all },
  ];

  return (
    <View style={styles.statsRow}>
      {defs.map((def, index) => (
        <Fragment key={def.value}>
          {index > 0 ? <View style={styles.statDivider} /> : null}
          <StatFilterPillView
            def={def}
            active={statFilter === def.value}
            onSelect={onStatFilterChange}
          />
          {index === 2 && !isCompact ? (
            <>
              <View style={styles.statDivider} />
              <PriorityFilterDropdown
                counts={counts}
                statFilter={statFilter}
                onStatFilterChange={onStatFilterChange}
              />
            </>
          ) : null}
        </Fragment>
      ))}
    </View>
  );
}

function TrackersToolbar({
  statsTrackers,
  projects,
  selectedProjectId,
  onSelectProject,
  statFilter,
  onStatFilterChange,
  viewMode,
  typeFilter,
  onTypeFilterChange,
  onCreate,
}: {
  statsTrackers: AggregatedTracker[];
  projects: TrackerProjectInput[];
  selectedProjectId: string | null;
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
  return (
    <View style={styles.toolbar}>
      <View style={styles.toolbarMain}>
        {projects.length > 1 ? (
          <ProjectPicker
            projects={projects}
            selectedProjectId={selectedProjectId}
            onSelectProject={onSelectProject}
          />
        ) : null}
        <StatFilterRow
          trackers={statsTrackers}
          statFilter={statFilter}
          onStatFilterChange={onStatFilterChange}
          viewMode={viewMode}
          isCompact={isCompact}
        />
      </View>
      <View style={styles.toolbarActions}>
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
        <Button
          variant="outline"
          leftIcon={Plus}
          onPress={onCreate}
          size="sm"
          testID="trackers-new"
        >
          New item
        </Button>
      </View>
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
  // Same padding tokens as sessions-screen.tsx's filterContainer — rendered
  // inside the scrollable content, below the sticky toolbar and above
  // TrackerTable, so it scrolls away with the list instead of staying pinned.
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  // Sticky header (List view's ScrollView passes stickyHeaderIndices={[0]}) —
  // needs its own opaque background and bottom border so scrolled rows don't
  // show through or blend into it once it's pinned to the top.
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  toolbarMain: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    flexShrink: 1,
  },
  toolbarActions: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    gap: theme.spacing[2],
  },
  statsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  // Wider than statsRow's gap — with no dividers between these buttons (unlike
  // the List pills), they need more breathing room to read as separate buttons.
  kanbanPriorityRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  statDivider: {
    width: 1,
    height: 15,
    backgroundColor: theme.colors.border,
    opacity: theme.opacity[50],
    marginHorizontal: theme.spacing[1],
  },
  // Same pill geometry as the Tasks/Epics/Initiatives SegmentedControl
  // (full-radius, surface2 hover, solid foreground when active — see
  // segmented-control.tsx's segment/segmentHover/segmentSelected).
  statCard: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[1.5],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
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
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
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
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  priorityFilterTextActive: {
    color: theme.colors.surface0,
  },
  priorityFilterLevel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    width: theme.spacing[3],
  },
  priorityFilterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  priorityFilterDesc: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    minWidth: 0,
  },
  priorityFilterCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
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
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.5,
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
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: theme.spacing[6],
  },
  errorsButtonTrigger: {
    position: "relative",
    padding: theme.spacing[1.5],
    marginRight: theme.spacing[2],
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
  errorsMenuTitleRow: {
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
  },
  errorsMenuLinkHovered: {
    color: theme.colors.accent,
  },
  errorsMenuDescription: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
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
    fontSize: theme.fontSize.xs,
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
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
  },
}));
