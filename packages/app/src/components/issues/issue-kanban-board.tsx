import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Layers,
  MoreVertical,
  PlayCircle,
  RotateCcw,
  XCircle,
} from "lucide-react-native";
import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { IssueSummary } from "@getpaseo/protocol/issues/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { IssueStatusIcon, issueStatusLabel } from "@/components/issues/issue-status-icon";
import { isNative } from "@/constants/platform";
import {
  buildKanbanBoard,
  type KanbanColumn,
  type KanbanEpicColumn,
  type KanbanInitiativeSection,
  type KanbanItem,
} from "@/issues/kanban-grouping";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const COLUMN_WIDTH = 264;
const COMPLETED_STRIP_WIDTH = 88;
const MENU_ICON_SIZE = 14;

const ThemedCheckCircle = withUnistyles(CheckCircle2);
const ThemedLayers = withUnistyles(Layers);
const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedColumns = withUnistyles(Columns3);
const ThemedKebab = withUnistyles(MoreVertical);
const ThemedPlayCircle = withUnistyles(PlayCircle);
const ThemedRotateCcw = withUnistyles(RotateCcw);
const ThemedXCircle = withUnistyles(XCircle);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const successColorMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const startLeading = <ThemedPlayCircle size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const closeLeading = <ThemedCheckCircle size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const reopenLeading = <ThemedRotateCcw size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const cancelLeading = <ThemedXCircle size={MENU_ICON_SIZE} uniProps={destructiveColorMapping} />;

export interface IssueKanbanBoardProps {
  issues: IssueSummary[];
  onOpenIssue: (issue: IssueSummary) => void;
  onStart: (issue: IssueSummary) => void;
  onClose: (issue: IssueSummary) => void;
  onReopen: (issue: IssueSummary) => void;
  onCancel: (issue: IssueSummary) => void;
}

interface IssueActions {
  onOpenIssue: IssueKanbanBoardProps["onOpenIssue"];
  onStart: IssueKanbanBoardProps["onStart"];
  onClose: IssueKanbanBoardProps["onClose"];
  onReopen: IssueKanbanBoardProps["onReopen"];
  onCancel: IssueKanbanBoardProps["onCancel"];
}

export function IssueKanbanBoard({
  issues,
  onOpenIssue,
  onStart,
  onClose,
  onReopen,
  onCancel,
}: IssueKanbanBoardProps): ReactElement {
  const model = useMemo(() => buildKanbanBoard(issues), [issues]);
  const [expandedCompletedId, setExpandedCompletedId] = useState<string | null>(null);
  const [expandedQuietInitiativeId, setExpandedQuietInitiativeId] = useState<string | null>(null);
  const actions = useMemo<IssueActions>(
    () => ({ onOpenIssue, onStart, onClose, onReopen, onCancel }),
    [onOpenIssue, onStart, onClose, onReopen, onCancel],
  );

  const scrollRef = useRef<ScrollView>(null);
  const scrollOffsetRef = useRef(0);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollButtons = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    scrollOffsetRef.current = contentOffset.x;
    setCanScrollLeft(contentOffset.x > 4);
    setCanScrollRight(contentOffset.x + layoutMeasurement.width < contentSize.width - 4);
  }, []);
  const handleContentSizeChange = useCallback((contentWidth: number, _height: number) => {
    setCanScrollRight(contentWidth > scrollOffsetRef.current);
  }, []);
  const scrollBy = useCallback((delta: number) => {
    scrollRef.current?.scrollTo({ x: scrollOffsetRef.current + delta, animated: true });
  }, []);
  const scrollLeft = useCallback(() => scrollBy(-COLUMN_WIDTH - 16), [scrollBy]);
  const scrollRight = useCallback(() => scrollBy(COLUMN_WIDTH + 16), [scrollBy]);
  const handleLayout = useCallback(() => scrollRef.current?.flashScrollIndicators(), []);

  const toggleCompleted = useCallback((columnId: string) => {
    setExpandedCompletedId((current) => (current === columnId ? null : columnId));
  }, []);
  const toggleQuietInitiative = useCallback((initiativeId: string) => {
    setExpandedQuietInitiativeId((current) => (current === initiativeId ? null : initiativeId));
  }, []);

  if (model.empty) {
    return <BoardState kind="empty" title="No issues yet" />;
  }

  if (model.allClear) {
    return <BoardState kind="all-clear" title="All clear" description="Every epic is complete" />;
  }

  return (
    <View style={styles.boardWrap}>
      <ScrollView
        ref={scrollRef}
        horizontal
        style={styles.scroll}
        contentContainerStyle={styles.scrollContentContainer}
        showsHorizontalScrollIndicator
        keyboardShouldPersistTaps="handled"
        onScroll={updateScrollButtons}
        onContentSizeChange={handleContentSizeChange}
        onLayout={handleLayout}
        scrollEventThrottle={32}
        testID="issue-kanban-board"
      >
        <View style={styles.boardTrack}>
          {model.initiativeSections.map((section) =>
            section.quiet && expandedQuietInitiativeId !== section.initiative.id ? (
              <QuietInitiativeStrip
                key={section.initiative.id}
                section={section}
                onExpand={toggleQuietInitiative}
              />
            ) : (
              <InitiativeSection
                key={section.initiative.id}
                section={section}
                expandedCompletedId={expandedCompletedId}
                actions={actions}
                onToggleCompleted={toggleCompleted}
                onCollapse={section.quiet ? toggleQuietInitiative : undefined}
              />
            ),
          )}
          {model.activeColumns.map((column) => (
            <KanbanColumnView key={column.id} column={column} actions={actions} />
          ))}
          {model.completedColumns.length > 0 ? (
            <CompletedRail
              columns={model.completedColumns}
              expandedColumnId={expandedCompletedId}
              actions={actions}
              onToggle={toggleCompleted}
            />
          ) : null}
        </View>
      </ScrollView>
      {canScrollLeft ? (
        <Pressable
          style={[styles.navButton, styles.navButtonLeft]}
          onPress={scrollLeft}
          accessibilityRole="button"
          accessibilityLabel="Scroll board left"
          testID="issue-kanban-scroll-left"
        >
          <ThemedChevronLeft size={18} uniProps={foregroundColorMapping} />
        </Pressable>
      ) : null}
      {canScrollRight ? (
        <Pressable
          style={[styles.navButton, styles.navButtonRight]}
          onPress={scrollRight}
          accessibilityRole="button"
          accessibilityLabel="Scroll board right"
          testID="issue-kanban-scroll-right"
        >
          <ThemedChevronRight size={18} uniProps={foregroundColorMapping} />
        </Pressable>
      ) : null}
    </View>
  );
}

function BoardState({
  kind,
  title,
  description,
}: {
  kind: "empty" | "all-clear";
  title: string;
  description?: string;
}): ReactElement {
  return (
    <View style={styles.state}>
      {kind === "empty" ? (
        <ThemedColumns size={styles.stateIcon.width} uniProps={mutedColorMapping} />
      ) : (
        <ThemedCheckCircle size={styles.stateIcon.width} uniProps={successColorMapping} />
      )}
      <Text style={styles.stateTitle}>{title}</Text>
      {description ? <Text style={styles.stateDescription}>{description}</Text> : null}
    </View>
  );
}

function InitiativeSection({
  section,
  expandedCompletedId,
  actions,
  onToggleCompleted,
  onCollapse,
}: {
  section: KanbanInitiativeSection;
  expandedCompletedId: string | null;
  actions: IssueActions;
  onToggleCompleted: (columnId: string) => void;
  onCollapse?: (initiativeId: string) => void;
}): ReactElement {
  const handleOpen = useCallback(
    () => actions.onOpenIssue(section.initiative),
    [actions, section.initiative],
  );
  const handleCollapse = useCallback(() => {
    onCollapse?.(section.initiative.id);
  }, [onCollapse, section.initiative.id]);

  return (
    <View style={[styles.initiativeSection, section.quiet && styles.quietExpandedSection]}>
      <View style={styles.initiativeHeader}>
        <Pressable
          style={initiativeTitleStyle}
          onPress={handleOpen}
          accessibilityRole="button"
          accessibilityLabel={`Open initiative ${section.initiative.title}`}
        >
          <Text style={styles.initiativeTitle} numberOfLines={1}>
            {section.initiative.title}
          </Text>
          <Text style={styles.initiativeMeta}>
            {section.activeColumns.length} active / {section.completedColumns.length} completed
          </Text>
        </Pressable>
        {onCollapse ? (
          <Pressable
            hitSlop={8}
            style={iconButtonStyle}
            onPress={handleCollapse}
            accessibilityRole="button"
            accessibilityLabel={`Collapse initiative ${section.initiative.title}`}
          >
            <ThemedChevronLeft size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.initiativeColumns}>
        {section.activeColumns.map((column) => (
          <KanbanColumnView key={column.id} column={column} actions={actions} />
        ))}
        {section.completedColumns.length > 0 ? (
          <CompletedRail
            columns={section.completedColumns}
            expandedColumnId={expandedCompletedId}
            actions={actions}
            onToggle={onToggleCompleted}
          />
        ) : null}
        {section.activeColumns.length === 0 && section.completedColumns.length === 0 ? (
          <View style={styles.initiativeEmpty}>
            <Text style={styles.emptyText}>No epics yet</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function QuietInitiativeStrip({
  section,
  onExpand,
}: {
  section: KanbanInitiativeSection;
  onExpand: (initiativeId: string) => void;
}): ReactElement {
  const handlePress = useCallback(
    () => onExpand(section.initiative.id),
    [onExpand, section.initiative.id],
  );
  return (
    <Pressable
      style={quietInitiativeStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`Expand completed initiative ${section.initiative.title}`}
      testID={`initiative-strip-${section.initiative.id}`}
    >
      <ThemedLayers size={16} uniProps={mutedColorMapping} />
      <Text style={styles.quietInitiativeTitle} numberOfLines={3}>
        {section.initiative.title}
      </Text>
      <StatusBadge label={`${section.completedColumns.length} done`} variant="muted" />
    </Pressable>
  );
}

function KanbanColumnView({
  column,
  actions,
}: {
  column: KanbanColumn;
  actions: IssueActions;
}): ReactElement {
  const hasRows = column.children.length > 0 || column.subColumns.length > 0;
  return (
    <View style={[settingsStyles.card, styles.column]} testID={`kanban-column-${column.id}`}>
      {column.kind === "epic" ? (
        <IssueEntry
          issue={column.issue}
          depth={0}
          hasChildren={column.childCount > 0}
          childCount={column.childCount}
          doneCount={column.doneCount}
          isFirst
          structural
          actions={actions}
        />
      ) : (
        <View style={styles.syntheticHeader}>
          <Text style={styles.structuralTitle} numberOfLines={1}>
            {column.title}
          </Text>
          <Text style={styles.progressText}>{column.childCount} tasks</Text>
        </View>
      )}
      {column.children.map((item) => (
        <IssueEntry key={item.issue.id} {...item} actions={actions} />
      ))}
      {column.subColumns.map((subColumn) => (
        <View key={subColumn.id}>
          {subColumn.groupIssue ? (
            <IssueEntry
              issue={subColumn.groupIssue}
              depth={0}
              hasChildren={subColumn.children.length > 0}
              childCount={subColumn.children.length}
              doneCount={subColumn.children.filter(({ issue }) => isDone(issue)).length}
              structural
              actions={actions}
            />
          ) : (
            <View style={[styles.subColumnLabel, settingsStyles.rowBorder]}>
              <Text style={styles.subColumnTitle}>{subColumn.title}</Text>
              <Text style={styles.progressText}>{subColumn.children.length}</Text>
            </View>
          )}
          {subColumn.children.map((item) => (
            <IssueEntry key={item.issue.id} {...item} actions={actions} />
          ))}
        </View>
      ))}
      {!hasRows ? (
        <View style={[styles.noTasks, settingsStyles.rowBorder]}>
          <Text style={styles.emptyText}>No tasks</Text>
        </View>
      ) : null}
    </View>
  );
}

function IssueEntry({
  issue,
  depth,
  hasChildren,
  childCount,
  doneCount,
  isFirst = false,
  structural = false,
  actions,
}: KanbanItem & {
  isFirst?: boolean;
  structural?: boolean;
  actions: IssueActions;
}): ReactElement {
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handlePress = useCallback(() => actions.onOpenIssue(issue), [actions, issue]);
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      settingsStyles.row,
      styles.issueRow,
      !isFirst && settingsStyles.rowBorder,
      isHovered && styles.issueRowHovered,
      pressed && styles.issueRowPressed,
    ],
    [isFirst, isHovered],
  );

  let content: ReactElement = (
    <View
      style={styles.issueRowContainer}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        style={rowStyle}
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={`Open issue ${issue.title}`}
        testID={`kanban-issue-${issue.id}`}
      >
        <View style={styles.issueStatusIcon}>
          <IssueStatusIcon status={issue.status} size={15} />
        </View>
        <View style={styles.issueMain}>
          <Text
            style={[
              settingsStyles.rowTitle,
              structural && styles.structuralTitle,
              issue.status === "in_progress" && styles.titleRunning,
              issue.status === "closed" && styles.titleClosed,
              issue.status === "cancelled" && styles.titleCancelled,
            ]}
            numberOfLines={1}
          >
            {issue.title}
          </Text>
          <View style={styles.issueMeta}>
            <Text style={styles.progressText}>{issueStatusLabel(issue.status)}</Text>
            <Text style={styles.priorityText}>{issue.priority}</Text>
            {hasChildren ? (
              <Text style={styles.progressText}>
                {doneCount} / {childCount}
              </Text>
            ) : null}
          </View>
        </View>
        <IssueActionsMenu issue={issue} actions={actions} />
      </Pressable>
    </View>
  );
  for (let level = 0; level < depth; level += 1) {
    content = <View style={styles.indent}>{content}</View>;
  }
  return content;
}

function IssueActionsMenu({
  issue,
  actions,
}: {
  issue: IssueSummary;
  actions: IssueActions;
}): ReactElement {
  const isOpenOrInProgress = issue.status === "open" || issue.status === "in_progress";
  const handleStart = useCallback(() => actions.onStart(issue), [actions, issue]);
  const handleClose = useCallback(() => actions.onClose(issue), [actions, issue]);
  const handleReopen = useCallback(() => actions.onReopen(issue), [actions, issue]);
  const handleCancel = useCallback(() => actions.onCancel(issue), [actions, issue]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={kebabTriggerStyle}
        accessibilityRole={isNative ? "button" : undefined}
        accessibilityLabel="Issue actions"
        testID={`kanban-issue-kebab-${issue.id}`}
      >
        {renderKebabTriggerIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={200}>
        {issue.status === "open" ? (
          <DropdownMenuItem leading={startLeading} onSelect={handleStart}>
            Start
          </DropdownMenuItem>
        ) : null}
        {isOpenOrInProgress ? (
          <DropdownMenuItem leading={closeLeading} onSelect={handleClose}>
            Close
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem leading={reopenLeading} onSelect={handleReopen}>
            Reopen
          </DropdownMenuItem>
        )}
        {isOpenOrInProgress ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem leading={cancelLeading} destructive onSelect={handleCancel}>
              Cancel
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CompletedRail({
  columns,
  expandedColumnId,
  actions,
  onToggle,
}: {
  columns: KanbanEpicColumn[];
  expandedColumnId: string | null;
  actions: IssueActions;
  onToggle: (columnId: string) => void;
}): ReactElement {
  return (
    <View style={styles.completedRail}>
      <Text style={styles.completedRailTitle}>Completed</Text>
      <View style={styles.completedRailItems}>
        {columns.map((column) => (
          <CompletedRailItem
            key={column.id}
            column={column}
            expanded={expandedColumnId === column.id}
            actions={actions}
            onToggle={onToggle}
          />
        ))}
      </View>
    </View>
  );
}

function CompletedRailItem({
  column,
  expanded,
  actions,
  onToggle,
}: {
  column: KanbanEpicColumn;
  expanded: boolean;
  actions: IssueActions;
  onToggle: (columnId: string) => void;
}): ReactElement {
  const handleToggle = useCallback(() => onToggle(column.id), [onToggle, column.id]);

  if (expanded) {
    return (
      <View style={styles.expandedCompletedColumn}>
        <Pressable
          hitSlop={8}
          style={collapseCompletedStyle}
          onPress={handleToggle}
          accessibilityRole="button"
          accessibilityLabel={`Collapse completed epic ${column.title}`}
        >
          <ThemedChevronLeft size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />
        </Pressable>
        <KanbanColumnView column={column} actions={actions} />
      </View>
    );
  }

  return (
    <Pressable
      style={completedStripStyle}
      onPress={handleToggle}
      accessibilityRole="button"
      accessibilityLabel={`Expand completed epic ${column.title}`}
      testID={`completed-epic-strip-${column.id}`}
    >
      <ThemedCheckCircle size={16} uniProps={successColorMapping} />
      <Text style={styles.completedStripTitle} numberOfLines={4}>
        {column.title}
      </Text>
      <StatusBadge label={`${column.doneCount}/${column.childCount}`} variant="muted" />
    </Pressable>
  );
}

function isDone(issue: IssueSummary): boolean {
  return issue.status === "closed" || issue.status === "cancelled";
}

function renderKebabTriggerIcon({ hovered }: { hovered?: boolean }): ReactElement {
  return (
    <ThemedKebab
      size={MENU_ICON_SIZE}
      uniProps={hovered ? foregroundColorMapping : mutedColorMapping}
    />
  );
}

function kebabTriggerStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebabTrigger, hovered && styles.kebabTriggerHovered];
}

function initiativeTitleStyle({ pressed }: PressableStateCallbackType) {
  return [styles.initiativeTitleButton, pressed && styles.headerPressed];
}

function iconButtonStyle({ hovered = false, pressed }: PressableStateCallbackType) {
  return [styles.iconButton, (hovered || pressed) && styles.iconButtonActive];
}

function quietInitiativeStyle({ pressed }: PressableStateCallbackType) {
  return [styles.quietInitiative, pressed && styles.stripPressed];
}

function completedStripStyle({ pressed }: PressableStateCallbackType) {
  return [styles.completedStrip, pressed && styles.stripPressed];
}

function collapseCompletedStyle({ hovered = false, pressed }: PressableStateCallbackType) {
  return [styles.collapseCompleted, (hovered || pressed) && styles.iconButtonActive];
}

const styles = StyleSheet.create((theme) => ({
  boardWrap: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  scroll: {
    flex: 1,
  },
  scrollContentContainer: {
    flexGrow: 1,
  },
  navButton: {
    position: "absolute",
    top: "50%",
    marginTop: -18,
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...theme.shadow.md,
  },
  navButtonLeft: {
    left: theme.spacing[2],
  },
  navButtonRight: {
    right: theme.spacing[2],
  },
  boardTrack: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[4],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingVertical: theme.spacing[4],
  },
  state: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[6],
  },
  stateIcon: {
    width: theme.iconSize.lg,
  },
  stateTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  stateDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  column: {
    width: COLUMN_WIDTH,
    flexShrink: 0,
    ...theme.shadow.sm,
  },
  syntheticHeader: {
    minHeight: theme.spacing[16],
    justifyContent: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  issueRowContainer: {
    position: "relative",
  },
  issueRow: {
    minHeight: theme.spacing[16],
    gap: theme.spacing[2],
  },
  issueRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  issueRowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  issueStatusIcon: {
    paddingTop: 2,
  },
  issueMain: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[2],
  },
  issueMeta: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  structuralTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  titleRunning: {
    color: theme.colors.foreground,
  },
  titleClosed: {
    color: theme.colors.foregroundExtraMuted,
    textDecorationLine: "line-through",
  },
  titleCancelled: {
    color: theme.colors.statusDanger,
    textDecorationLine: "line-through",
  },
  priorityText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  progressText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  indent: {
    paddingLeft: theme.spacing[3],
  },
  subColumnLabel: {
    minHeight: theme.spacing[12],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
  },
  subColumnTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  noTasks: {
    minHeight: theme.spacing[12],
    justifyContent: "center",
    paddingHorizontal: theme.spacing[4],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  kebabTrigger: {
    flexShrink: 0,
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  kebabTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  initiativeSection: {
    flexShrink: 0,
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  quietExpandedSection: {
    opacity: theme.opacity[50],
  },
  initiativeHeader: {
    minHeight: theme.spacing[12],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  initiativeTitleButton: {
    flex: 1,
    minWidth: COLUMN_WIDTH,
    borderRadius: theme.borderRadius.base,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1],
  },
  headerPressed: {
    backgroundColor: theme.colors.surface2,
  },
  initiativeTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  initiativeMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  initiativeColumns: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  initiativeEmpty: {
    width: COLUMN_WIDTH,
    minHeight: theme.spacing[20],
    alignItems: "center",
    justifyContent: "center",
  },
  quietInitiative: {
    width: COMPLETED_STRIP_WIDTH,
    minHeight: theme.spacing[32],
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    opacity: theme.opacity[50],
  },
  quietInitiativeTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  completedRail: {
    flexShrink: 0,
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  completedRailTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  completedRailItems: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  completedStrip: {
    width: COMPLETED_STRIP_WIDTH,
    minHeight: theme.spacing[32],
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    borderWidth: 1,
    borderColor: `${theme.colors.statusSuccess}33`,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  stripPressed: {
    backgroundColor: theme.colors.surface2,
  },
  completedStripTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  expandedCompletedColumn: {
    position: "relative",
    paddingTop: theme.spacing[6],
  },
  collapseCompleted: {
    position: "absolute",
    top: 0,
    right: 0,
    zIndex: 1,
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  iconButton: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
  },
  iconButtonActive: {
    backgroundColor: theme.colors.surface2,
  },
}));
