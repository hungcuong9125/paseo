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
import { ChevronDown, LayoutGrid, ListChecks, Plus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { TrackerSummary, TrackerType } from "@getpaseo/protocol/tracker/types";
import { MenuHeader } from "@/components/headers/menu-header";
import { TrackerDetailSheet } from "@/components/tracker/tracker-detail-sheet";
import { TrackerFormSheet } from "@/components/tracker/tracker-form-sheet";
import { TrackerKanbanBoard } from "@/components/tracker/tracker-kanban-board";
import { TrackerPagination } from "@/components/tracker/tracker-pagination";
import { TrackerTable } from "@/components/tracker/tracker-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
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
import { useAggregatedTrackers } from "@/tracker/use-aggregated-trackers";
import {
  getTrackerStatCounts,
  matchesTrackerStatFilter,
  type TrackerStatCounts,
  type TrackerStatFilter,
} from "@/tracker/tracker-stats";
import {
  getTrackerPageCount,
  getTrackerPageSlice,
  TRACKER_PAGE_SIZE,
  type TrackerPageSize,
} from "@/tracker/tracker-pagination";
import type { TrackerTransition } from "@/tracker/tracker-transitions";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { resolveTrackerScreenBodyState, type TrackerScreenBodyState } from "./tracker-screen-state";

type StatFilter = TrackerStatFilter;
type ViewMode = "list" | "kanban";
// The Kanban type filter's domain: the real TrackerType union plus an "all"
// sentinel for the fourth toggle option. Board default is "task" (see
// docs/refactors/tracker-kanban-redesign.md, "Which types appear on the
// board") — filtering happens here, not inside buildTrackerBoard, which stays
// status-only per its own docstring.
type KanbanTypeFilter = TrackerType | "all";

const KANBAN_TYPE_FILTER_DEFS: ReadonlyArray<{ value: KanbanTypeFilter; labelKey: string }> = [
  { value: "task", labelKey: "tracker.kanban.type.tasks" },
  { value: "epic", labelKey: "tracker.kanban.type.epics" },
  { value: "initiative", labelKey: "tracker.kanban.type.initiatives" },
  { value: "all", labelKey: "tracker.kanban.type.all" },
];

// Extracted to keep the switch's branches out of TrackerScreenContent's own
// cyclomatic complexity — the one-transition-matrix rule lives in
// tracker-transitions.ts, this just dispatches to the matching RPC.
function callTrackerTransition(
  client: DaemonClient,
  aggregated: AggregatedTracker,
  transition: TrackerTransition,
): Promise<unknown> {
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
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
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
  // are visible. Sharing one state would open the board on a single Open lane.
  const [listStatFilter, setListStatFilter] = useState<StatFilter>("open");
  const [kanbanStatFilter, setKanbanStatFilter] = useState<StatFilter>("all");
  // Kanban-only: which tracker granularities appear on the board. Defaults to
  // "task" to preserve today's List-view default (mixing all three
  // granularities in one lane is what made the old hierarchy board unreadable).
  const [kanbanTypeFilter, setKanbanTypeFilter] = useState<KanbanTypeFilter>("task");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTracker, setSelectedTracker] = useState<AggregatedTracker | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<TrackerPageSize>(TRACKER_PAGE_SIZE);

  useEffect(() => {
    if (selectedProjectId && !projectInputs.some((p) => p.projectId === selectedProjectId)) {
      setSelectedProjectId(null);
      setCurrentPage(1);
    }
  }, [projectInputs, selectedProjectId]);

  // Always fetch every status: the filter row's counts (Done, etc.) need the
  // full set regardless of which bucket is active, which is applied
  // client-side below instead of round-tripping a second fetch.
  const { loadState, projectErrors, refetch } = useAggregatedTrackers({
    projects: projectInputs,
    all: true,
    enabled: hasAnyProject,
  });

  const allTrackers = loadState.status === "loaded" ? loadState.data : EMPTY_TRACKERS;
  const projectFilteredTrackers = useMemo(
    () =>
      selectedProjectId
        ? allTrackers.filter((tracker) => tracker.projectId === selectedProjectId)
        : allTrackers,
    [allTrackers, selectedProjectId],
  );
  // List-only: Kanban receives the project-filtered but not status-filtered set
  // (kanbanTrackers below) — see "Toolbar contract" in the redesign doc.
  const visibleTrackers = useMemo(
    () =>
      listStatFilter === "all"
        ? projectFilteredTrackers
        : projectFilteredTrackers.filter(
            (tracker) =>
              tracker.type !== "task" || matchesTrackerStatFilter(tracker, listStatFilter),
          ),
    [projectFilteredTrackers, listStatFilter],
  );
  // Type filter is applied here, before the board — buildTrackerBoard's own
  // partitioning stays status-only (see tracker-board-model.ts docstring).
  const kanbanTrackers = useMemo(
    () =>
      kanbanTypeFilter === "all"
        ? projectFilteredTrackers
        : projectFilteredTrackers.filter((tracker) => tracker.type === kanbanTypeFilter),
    [projectFilteredTrackers, kanbanTypeFilter],
  );
  const readyIds = useTrackerReadyIds({ viewMode, projects: projectInputs, selectedProjectId });
  const orderedTrackers = useMemo(
    () =>
      [...visibleTrackers].sort(
        (a, b) => a.projectId.localeCompare(b.projectId) || a.id.localeCompare(b.id),
      ),
    [visibleTrackers],
  );
  const totalPages = getTrackerPageCount(orderedTrackers.length, pageSize);
  const safeCurrentPage = Math.min(currentPage, totalPages);
  useEffect(() => {
    if (currentPage !== safeCurrentPage) {
      setCurrentPage(safeCurrentPage);
    }
  }, [currentPage, safeCurrentPage]);
  const paginatedTrackers = useMemo(
    () =>
      viewMode === "list"
        ? getTrackerPageSlice(orderedTrackers, safeCurrentPage, pageSize)
        : orderedTrackers,
    [orderedTrackers, pageSize, safeCurrentPage, viewMode],
  );

  // Kanban's statFilter projects lanes, it never filters the dataset, so its
  // emptiness is driven by the project-filtered set, not the List filter.
  const visibleTrackersCount = useMemo(
    () => (viewMode === "kanban" ? kanbanTrackers.length : visibleTrackers.length),
    [viewMode, kanbanTrackers, visibleTrackers],
  );
  const bodyState = resolveTrackerScreenBodyState({
    hasAnyProject,
    loadState,
    selectedProjectId: selectedProjectId ?? "all",
    projectErrors,
    visibleTrackersCount,
  });

  const selectedProject = selectedProjectId
    ? (projectInputs.find((p) => p.projectId === selectedProjectId) ?? null)
    : null;

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
    void initMutations.initTracker();
  }, [initMutations]);
  const handleRetry = useCallback(() => refetch(), [refetch]);
  const handleSelectProject = useCallback((projectId: string | null) => {
    setSelectedProjectId(projectId);
    setCurrentPage(1);
  }, []);
  const handleListStatFilterChange = useCallback((value: StatFilter) => {
    setListStatFilter(value);
    setCurrentPage(1);
  }, []);
  const handleKanbanStatFilterChange = useCallback((value: StatFilter) => {
    setKanbanStatFilter(value);
  }, []);
  const handleKanbanTypeFilterChange = useCallback((value: KanbanTypeFilter) => {
    setKanbanTypeFilter(value);
  }, []);
  const effectiveStatFilter = useMemo(
    () => (viewMode === "kanban" ? kanbanStatFilter : listStatFilter),
    [viewMode, kanbanStatFilter, listStatFilter],
  );
  const effectiveOnStatFilterChange = useMemo(
    () => (viewMode === "kanban" ? handleKanbanStatFilterChange : handleListStatFilterChange),
    [viewMode, handleKanbanStatFilterChange, handleListStatFilterChange],
  );
  const handlePageChange = useCallback((page: number) => setCurrentPage(page), []);
  const handlePageSizeChange = useCallback((nextPageSize: TrackerPageSize) => {
    setPageSize(nextPageSize);
    setCurrentPage(1);
  }, []);

  // The Kanban board renders a projection built from AggregatedTracker[] but
  // its own model (and onTransition callback) only knows the TrackerSummary/id
  // shape — the runtime objects in `kanbanTrackers` are still the exact
  // AggregatedTracker instances we passed in, so lookup-by-id recovers
  // serverId/projectId safely (see TrackerKanbanBoardProps contract).
  const kanbanTrackerById = useMemo(
    () => new Map(kanbanTrackers.map((tracker) => [tracker.id, tracker])),
    [kanbanTrackers],
  );
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
        await callTrackerTransition(client, aggregated, transition);
      } finally {
        void queryClient.invalidateQueries({ queryKey: trackerQueryBaseKey });
      }
    },
    [kanbanTrackerById, queryClient, t],
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

  return (
    <View style={styles.container}>
      <MenuHeader title="Tracker" />
      <TrackerScreenBody
        bodyState={bodyState}
        trackers={paginatedTrackers}
        parentTrackers={orderedTrackers}
        statsTrackers={projectFilteredTrackers}
        kanbanTrackers={kanbanTrackers}
        kanbanReadyIds={readyIds}
        showProjectLabel={selectedProjectId === null}
        projects={projectInputs}
        selectedProjectId={selectedProjectId}
        onSelectProject={handleSelectProject}
        statFilter={effectiveStatFilter}
        onStatFilterChange={effectiveOnStatFilterChange}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        kanbanTypeFilter={kanbanTypeFilter}
        onKanbanTypeFilterChange={handleKanbanTypeFilterChange}
        projectErrors={projectErrors}
        onOpenTracker={handleOpenTracker}
        onKanbanTransition={handleKanbanTransition}
        onKanbanTransitionError={handleKanbanTransitionError}
        onKanbanCardPress={handleKanbanCardPress}
        onCreate={handleOpenCreate}
        onOpenProject={handleOpenProject}
        onInitialise={handleInitialise}
        isInitialising={initMutations.isInitialising}
        onRetry={handleRetry}
        currentPage={safeCurrentPage}
        pageSize={pageSize}
        totalItems={orderedTrackers.length}
        totalPages={totalPages}
        onPageChange={handlePageChange}
        onPageSizeChange={handlePageSizeChange}
      />
      <TrackerFormSheet
        projects={projectInputs}
        visible={createOpen}
        onClose={handleCloseCreate}
        defaultServerId={selectedProject?.serverId ?? null}
        defaultProjectId={selectedProject?.projectId ?? null}
        defaultProjectDisplay={selectedProject?.projectName ?? null}
      />
      <TrackerDetailSheet
        serverId={selectedTracker?.serverId ?? ""}
        projectId={selectedTracker?.projectId ?? ""}
        visible={selectedTracker !== null}
        trackerId={selectedTracker?.id ?? null}
        onClose={handleCloseDetail}
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
  const triggerStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.priorityFilterTrigger,
      (isHovered || pressed) && styles.priorityFilterTriggerHovered,
    ],
    [isHovered],
  );
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const selectedStyle = selectedLevel ? priorityHelpColorStyle(selectedLevel.id) : styles.helpP0;
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
            <Text style={[styles.priorityFilterCount, selectedStyle]}>
              {counts[selectedLevel.filter]}
            </Text>
            <Text style={[styles.priorityFilterText, selectedStyle]}>{` ${selectedLevel.id}`}</Text>
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
        <ThemedChevronDown size={14} uniProps={mutedColorMapping} />
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

function ProjectErrorsBanner({ errors }: { errors: TrackerProjectError[] }): ReactElement {
  return (
    <View style={styles.errorsBannerWrap}>
      <View style={styles.errorsBanner} testID="trackers-project-errors">
        {errors.map((error) => (
          <Text key={`${error.serverId}:${error.projectId}`} style={styles.errorsBannerText}>
            {`${error.projectName}: ${error.message}`}
          </Text>
        ))}
      </View>
    </View>
  );
}

function TrackerScreenBody({
  bodyState,
  trackers,
  parentTrackers,
  statsTrackers,
  kanbanTrackers,
  kanbanReadyIds,
  showProjectLabel,
  projects,
  selectedProjectId,
  onSelectProject,
  statFilter,
  onStatFilterChange,
  viewMode,
  onViewModeChange,
  kanbanTypeFilter,
  onKanbanTypeFilterChange,
  projectErrors,
  onOpenTracker,
  onKanbanTransition,
  onKanbanTransitionError,
  onKanbanCardPress,
  onCreate,
  onOpenProject,
  onInitialise,
  isInitialising,
  onRetry,
  currentPage,
  pageSize,
  totalItems,
  totalPages,
  onPageChange,
  onPageSizeChange,
}: {
  bodyState: TrackerScreenBodyState;
  trackers: AggregatedTracker[];
  parentTrackers: AggregatedTracker[];
  statsTrackers: AggregatedTracker[];
  kanbanTrackers: AggregatedTracker[];
  kanbanReadyIds: ReadonlySet<string>;
  showProjectLabel: boolean;
  projects: TrackerProjectInput[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  statFilter: StatFilter;
  onStatFilterChange: (value: StatFilter) => void;
  viewMode: ViewMode;
  onViewModeChange: (value: ViewMode) => void;
  kanbanTypeFilter: KanbanTypeFilter;
  onKanbanTypeFilterChange: (value: KanbanTypeFilter) => void;
  projectErrors: TrackerProjectError[];
  onOpenTracker: (tracker: AggregatedTracker) => void;
  onKanbanTransition: (trackerId: string, transition: TrackerTransition) => Promise<void>;
  onKanbanTransitionError: (trackerId: string, message: string) => void;
  onKanbanCardPress: (trackerId: string) => void;
  onCreate: () => void;
  onOpenProject: () => void;
  onInitialise: () => void;
  isInitialising: boolean;
  onRetry: () => void;
  currentPage: number;
  pageSize: TrackerPageSize;
  totalItems: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: TrackerPageSize) => void;
}): ReactElement | null {
  const listScrollRef = useRef<ScrollView>(null);
  const handlePageChange = useCallback(
    (page: number) => {
      onPageChange(page);
      listScrollRef.current?.scrollTo({ y: 0, animated: true });
    },
    [onPageChange],
  );
  const handlePageSizeChange = useCallback(
    (nextPageSize: TrackerPageSize) => {
      onPageSizeChange(nextPageSize);
      listScrollRef.current?.scrollTo({ y: 0, animated: true });
    },
    [onPageSizeChange],
  );
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
        <ScrollView
          ref={listScrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContentEmpty}
          showsVerticalScrollIndicator={false}
        >
          <TrackersToolbar
            statsTrackers={statsTrackers}
            projects={projects}
            selectedProjectId={selectedProjectId}
            onSelectProject={onSelectProject}
            statFilter={statFilter}
            onStatFilterChange={onStatFilterChange}
            viewMode={viewMode}
            onViewModeChange={onViewModeChange}
            kanbanTypeFilter={kanbanTypeFilter}
            onKanbanTypeFilterChange={onKanbanTypeFilterChange}
            onCreate={onCreate}
          />
          {projectErrors.length > 0 ? <ProjectErrorsBanner errors={projectErrors} /> : null}
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
          onViewModeChange={onViewModeChange}
          kanbanTypeFilter={kanbanTypeFilter}
          onKanbanTypeFilterChange={onKanbanTypeFilterChange}
          onCreate={onCreate}
        />
      );
      const errorsBanner =
        projectErrors.length > 0 ? <ProjectErrorsBanner errors={projectErrors} /> : null;

      if (viewMode === "kanban") {
        // Not nested in the outer vertical ScrollView: each TrackerKanbanColumn owns
        // its own vertical ScrollView and needs a bounded-height parent (flex: 1),
        // which a ScrollView's content container can't give a child.
        return (
          <View style={styles.kanbanContainer} testID="trackers-kanban">
            {toolbar}
            {errorsBanner}
            <TrackerKanbanBoard
              trackers={kanbanTrackers}
              filter={statFilter}
              readyIds={kanbanReadyIds}
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
          testID="trackers-list"
        >
          {toolbar}
          {errorsBanner}
          <TrackerTable
            trackers={trackers}
            parentTrackers={parentTrackers}
            showProjectLabel={showProjectLabel}
            onOpenTracker={onOpenTracker}
          />
          {totalItems > pageSize ? (
            <TrackerPagination
              currentPage={currentPage}
              pageSize={pageSize}
              totalItems={totalItems}
              totalPages={totalPages}
              onPageChange={handlePageChange}
              onPageSizeChange={handlePageSizeChange}
            />
          ) : null}
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
  const pillStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.statCard,
      (Boolean(isHovered) || pressed) && !active && styles.statCardHovered,
    ],
    [isHovered, active],
  );
  const showColor = active || isHovered;
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
      <Text style={[styles.statNumber, showColor && statNumberColorStyle(def.value)]}>
        {def.count}
      </Text>
      <Text style={[styles.statLabel, active && styles.statLabelActive]}>{def.label}</Text>
    </Pressable>
  );
}

// "Ready" (unblocked) is intentionally omitted: it needs dependency/blocker
// data that `ait list` doesn't return per-row, only `ait show <id>` does — a
// dedicated ready-count RPC is follow-up work.
function StatFilterRow({
  trackers,
  statFilter,
  onStatFilterChange,
}: {
  trackers: AggregatedTracker[];
  statFilter: StatFilter;
  onStatFilterChange: (value: StatFilter) => void;
}): ReactElement {
  const counts = getTrackerStatCounts(trackers);

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
          {index === 1 ? (
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
  onViewModeChange,
  kanbanTypeFilter,
  onKanbanTypeFilterChange,
  onCreate,
}: {
  statsTrackers: AggregatedTracker[];
  projects: TrackerProjectInput[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  statFilter: StatFilter;
  onStatFilterChange: (value: StatFilter) => void;
  viewMode: ViewMode;
  onViewModeChange: (value: ViewMode) => void;
  kanbanTypeFilter: KanbanTypeFilter;
  onKanbanTypeFilterChange: (value: KanbanTypeFilter) => void;
  onCreate: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const typeFilterOptions: SegmentedControlOption<KanbanTypeFilter>[] = useMemo(
    () =>
      KANBAN_TYPE_FILTER_DEFS.map((def) => ({
        value: def.value,
        label: t(def.labelKey),
        testID: `trackers-kanban-type-filter-${def.value}`,
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
        />
      </View>
      <View style={styles.toolbarActions}>
        {viewMode === "kanban" ? (
          <SegmentedControl
            options={typeFilterOptions}
            value={kanbanTypeFilter}
            onValueChange={onKanbanTypeFilterChange}
            size="sm"
            testID="trackers-kanban-type-filter"
          />
        ) : null}
        <SegmentedControl
          options={viewModeOptions}
          value={viewMode}
          onValueChange={onViewModeChange}
          size="sm"
          hideLabels
          testID="trackers-view-mode"
        />
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
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
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
  statDivider: {
    width: 1,
    height: 15,
    backgroundColor: theme.colors.border,
    opacity: theme.opacity[50],
    marginHorizontal: theme.spacing[1],
  },
  // No background/border at rest — same bare-pill idiom as the workspace
  // tab row's inactive tabs. Hover uses the same surface2 wash as row hover
  // (see TrackerRow / agent-list.tsx); selected only changes text colour.
  statCard: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[1.5],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  statCardHovered: {
    backgroundColor: theme.colors.surface2,
  },
  statNumber: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
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
    borderRadius: theme.borderRadius.md,
  },
  priorityFilterText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.5,
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
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  priorityFilterCountHovered: {
    color: theme.colors.palette.red[600],
  },
  priorityFilterTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  statLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  statLabelActive: {
    color: theme.colors.foreground,
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
  scrollContentEmpty: {
    flexGrow: 1,
  },
  errorsBannerWrap: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingBottom: theme.spacing[2],
  },
  errorsBanner: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  errorsBannerText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
}));
