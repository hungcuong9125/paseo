import { Fragment, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
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
import { ChevronDown, LayoutGrid, ListChecks, Plus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";
import { MenuHeader } from "@/components/headers/menu-header";
import { TrackerDetailSheet } from "@/components/tracker/tracker-detail-sheet";
import { TrackerFormSheet } from "@/components/tracker/tracker-form-sheet";
import { TrackerKanbanBoard } from "@/components/tracker/tracker-kanban-board";
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
import {
  trackerQueryBaseKey,
  type AggregatedTracker,
  type TrackerProjectError,
  type TrackerProjectInput,
} from "@/tracker/aggregated-trackers";
import { useTrackerMutations } from "@/tracker/use-tracker-mutations";
import { useAggregatedTrackers } from "@/tracker/use-aggregated-trackers";
import { getTrackerStatCounts, type TrackerStatCounts } from "@/tracker/tracker-stats";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { resolveTrackerScreenBodyState, type TrackerScreenBodyState } from "./tracker-screen-state";

type StatFilter = "open" | "in_progress" | "p0" | "done" | "all";
type ViewMode = "list" | "kanban";

const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const EMPTY_ISSUES: AggregatedTracker[] = [];

// Containers (epic/initiative) always pass so Kanban still has something to
// group under even when every task inside is filtered out; only task leaves
// are actually filtered by status/priority.
function matchesStatFilter(tracker: AggregatedTracker, filter: StatFilter): boolean {
  switch (filter) {
    case "open":
      return tracker.status === "open";
    case "in_progress":
      return tracker.status === "in_progress";
    case "p0":
      return (
        tracker.priority === "P0" && (tracker.status === "open" || tracker.status === "in_progress")
      );
    case "done":
      return tracker.status === "closed" || tracker.status === "cancelled";
    case "all":
      return true;
  }
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

  const [statFilter, setStatFilter] = useState<StatFilter>("open");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTracker, setSelectedTracker] = useState<AggregatedTracker | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (selectedProjectId && !projectInputs.some((p) => p.projectId === selectedProjectId)) {
      setSelectedProjectId(null);
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

  const allTrackers = loadState.status === "loaded" ? loadState.data : EMPTY_ISSUES;
  const projectFilteredTrackers = useMemo(
    () =>
      selectedProjectId
        ? allTrackers.filter((tracker) => tracker.projectId === selectedProjectId)
        : allTrackers,
    [allTrackers, selectedProjectId],
  );
  const visibleTrackers = useMemo(
    () =>
      statFilter === "all"
        ? projectFilteredTrackers
        : projectFilteredTrackers.filter(
            (tracker) => tracker.type !== "task" || matchesStatFilter(tracker, statFilter),
          ),
    [projectFilteredTrackers, statFilter],
  );

  const bodyState = resolveTrackerScreenBodyState({
    hasAnyProject,
    loadState,
    selectedProjectId: selectedProjectId ?? "all",
    projectErrors,
    visibleTrackersCount: visibleTrackers.length,
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

  // The Kanban board renders a projection built from AggregatedTracker[] but
  // its own model (and action callbacks) only knows the TrackerSummary shape —
  // the runtime objects are still the exact AggregatedTracker instances we
  // passed in, so this cast is safe (see TrackerKanbanBoardProps contract).
  const runKanbanAction = useCallback(
    (
      tracker: TrackerSummary,
      action: (client: DaemonClient, aggregated: AggregatedTracker) => Promise<unknown>,
    ) => {
      const aggregated = tracker as AggregatedTracker;
      const client = useSessionStore.getState().sessions[aggregated.serverId]?.client;
      if (!client) {
        return;
      }
      void action(client, aggregated).finally(() => {
        void queryClient.invalidateQueries({ queryKey: trackerQueryBaseKey });
      });
    },
    [queryClient],
  );
  const handleKanbanOpenTracker = useCallback(
    (tracker: TrackerSummary) => setSelectedTracker(tracker as AggregatedTracker),
    [],
  );
  const handleKanbanStart = useCallback(
    (tracker: TrackerSummary) =>
      runKanbanAction(tracker, (client, aggregated) =>
        client.trackerUpdate({
          projectId: aggregated.projectId,
          trackerId: aggregated.id,
          status: "in_progress",
        }),
      ),
    [runKanbanAction],
  );
  const handleKanbanClose = useCallback(
    (tracker: TrackerSummary) =>
      runKanbanAction(tracker, (client, aggregated) =>
        client.trackerClose({ projectId: aggregated.projectId, trackerId: aggregated.id }),
      ),
    [runKanbanAction],
  );
  const handleKanbanReopen = useCallback(
    (tracker: TrackerSummary) =>
      runKanbanAction(tracker, (client, aggregated) =>
        client.trackerReopen({ projectId: aggregated.projectId, trackerId: aggregated.id }),
      ),
    [runKanbanAction],
  );
  const handleKanbanCancel = useCallback(
    (tracker: TrackerSummary) =>
      runKanbanAction(tracker, (client, aggregated) =>
        client.trackerCancel({ projectId: aggregated.projectId, trackerId: aggregated.id }),
      ),
    [runKanbanAction],
  );

  return (
    <View style={styles.container}>
      <MenuHeader title="Tracker" />
      <TrackerScreenBody
        bodyState={bodyState}
        trackers={visibleTrackers}
        statsTrackers={projectFilteredTrackers}
        showProjectLabel={selectedProjectId === null}
        projects={projectInputs}
        selectedProjectId={selectedProjectId}
        onSelectProject={setSelectedProjectId}
        statFilter={statFilter}
        onStatFilterChange={setStatFilter}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        projectErrors={projectErrors}
        onOpenTracker={handleOpenTracker}
        onKanbanOpenTracker={handleKanbanOpenTracker}
        onKanbanStart={handleKanbanStart}
        onKanbanClose={handleKanbanClose}
        onKanbanReopen={handleKanbanReopen}
        onKanbanCancel={handleKanbanCancel}
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

function PriorityFilterItem({
  level,
  selected,
  onSelect,
}: {
  level: { id: string; desc: string };
  selected: boolean;
  onSelect: (id: string) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(level.id), [onSelect, level.id]);
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

// UI-only priority filter mockup. The trigger text and `selected` state make it
// look interactive, but selection is NOT wired to any filtering (per request:
// build the UI/UX, not the functionality).
function PriorityFilterDropdown({ counts }: { counts: TrackerStatCounts }): ReactElement {
  const [selected, setSelected] = useState<string | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const priorityTotal = counts.p0 + counts.p1 + counts.p2 + counts.p3 + counts.p4;
  const handleSelectAll = useCallback(() => setSelected(null), [setSelected]);
  const handleSelectLevel = useCallback((id: string) => setSelected(id), [setSelected]);
  const triggerStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.priorityFilterTrigger,
      (isHovered || pressed) && styles.priorityFilterTriggerHovered,
    ],
    [isHovered],
  );
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const selectedStyle = selected != null ? priorityHelpColorStyle(selected) : styles.helpP0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={triggerStyle}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
        testID="trackers-priority-filter-trigger"
      >
        {selected != null ? (
          <>
            <Text style={[styles.priorityFilterCount, selectedStyle]}>
              {counts[selected.toLowerCase() as keyof TrackerStatCounts] as number}
            </Text>
            <Text style={[styles.priorityFilterText, selectedStyle]}> {selected}</Text>
          </>
        ) : (
          <>
            <Text style={[styles.priorityFilterCount, styles.helpP0]}>{priorityTotal}</Text>
            <Text style={styles.priorityFilterText}>{" PRIORITY"}</Text>
          </>
        )}
        <ThemedChevronDown size={14} uniProps={mutedColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" width={240}>
        <DropdownMenuItem selected={selected === null} onSelect={handleSelectAll}>
          All priorities
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {PRIORITY_HELP_LEVELS.map((level) => (
          <PriorityFilterItem
            key={level.id}
            level={level}
            selected={selected === level.id}
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
  statsTrackers,
  showProjectLabel,
  projects,
  selectedProjectId,
  onSelectProject,
  statFilter,
  onStatFilterChange,
  viewMode,
  onViewModeChange,
  projectErrors,
  onOpenTracker,
  onKanbanOpenTracker,
  onKanbanStart,
  onKanbanClose,
  onKanbanReopen,
  onKanbanCancel,
  onCreate,
  onOpenProject,
  onInitialise,
  isInitialising,
  onRetry,
}: {
  bodyState: TrackerScreenBodyState;
  trackers: AggregatedTracker[];
  statsTrackers: AggregatedTracker[];
  showProjectLabel: boolean;
  projects: TrackerProjectInput[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string | null) => void;
  statFilter: StatFilter;
  onStatFilterChange: (value: StatFilter) => void;
  viewMode: ViewMode;
  onViewModeChange: (value: ViewMode) => void;
  projectErrors: TrackerProjectError[];
  onOpenTracker: (tracker: AggregatedTracker) => void;
  onKanbanOpenTracker: (tracker: TrackerSummary) => void;
  onKanbanStart: (tracker: TrackerSummary) => void;
  onKanbanClose: (tracker: TrackerSummary) => void;
  onKanbanReopen: (tracker: TrackerSummary) => void;
  onKanbanCancel: (tracker: TrackerSummary) => void;
  onCreate: () => void;
  onOpenProject: () => void;
  onInitialise: () => void;
  isInitialising: boolean;
  onRetry: () => void;
}): ReactElement | null {
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
          onCreate={onCreate}
        />
      );
      const errorsBanner =
        projectErrors.length > 0 ? <ProjectErrorsBanner errors={projectErrors} /> : null;

      if (viewMode === "kanban") {
        // Not nested in the outer vertical ScrollView: TrackerKanbanBoard owns its own
        // horizontal ScrollView and needs a bounded-height parent (flex: 1), which a
        // ScrollView's content container can't give a child.
        return (
          <View style={styles.kanbanContainer} testID="trackers-kanban">
            {toolbar}
            {errorsBanner}
            <TrackerKanbanBoard
              trackers={trackers}
              onOpenTracker={onKanbanOpenTracker}
              onStart={onKanbanStart}
              onClose={onKanbanClose}
              onReopen={onKanbanReopen}
              onCancel={onKanbanCancel}
            />
          </View>
        );
      }

      return (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          testID="trackers-list"
        >
          {toolbar}
          {errorsBanner}
          <TrackerTable
            trackers={trackers}
            showProjectLabel={showProjectLabel}
            onOpenTracker={onOpenTracker}
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
const PRIORITY_HELP_LEVELS: ReadonlyArray<{ id: string; desc: string }> = [
  { id: "P0", desc: "Critical — urgent, severe" },
  { id: "P1", desc: "High priority" },
  { id: "P2", desc: "Normal — default level" },
  { id: "P3", desc: "Low priority" },
  { id: "P4", desc: "Nice to have — optional" },
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
              <PriorityFilterDropdown counts={counts} />
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
  onCreate: () => void;
}): ReactElement {
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
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.bold,
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
