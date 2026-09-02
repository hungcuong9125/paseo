import { useCallback, useMemo, useReducer, useRef, useState, type ReactElement } from "react";
import { ScrollView, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";
import {
  laneTranslationKey,
  TrackerKanbanColumn,
} from "@/components/tracker/tracker-kanban-column";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  buildTrackerBoard,
  type TrackerBoardFilter,
  type TrackerBoardLaneKey,
} from "@/tracker/tracker-board-model";
import { buildTrackerHierarchy } from "@/tracker/tracker-hierarchy";
import { createPendingTrackerSet, type TrackerTransition } from "@/tracker/tracker-transitions";

// Narrowest a lane may be squeezed to before the board gives up on fitting
// them all and starts scrolling instead. COLUMN_GAP/COLUMN_ROW_INSET mirror
// the `columns`/`columnsContent` styles below and are only used to work out
// whether that squeeze is possible.
const COLUMN_MIN_WIDTH = 280;
const COLUMN_SCROLL_WIDTH = 320;
const COLUMN_GAP = 12;
const COLUMN_ROW_INSET = 24;

export interface TrackerKanbanBoardProps {
  /**
   * Width this board has to lay lanes out in, measured by the caller. Passed in
   * rather than measured here because this component only mounts once tracker
   * data has loaded: measuring at that point would render one frame at the
   * wrong lane width and then visibly reflow. The caller's container is on
   * screen from the start, so its width is already known by then. Omit and the
   * board falls back to fixed-width scrolling lanes.
   */
  availableWidth?: number | null;
  /** Project-filtered but NOT status-filtered — the board partitions by status itself. */
  trackers: readonly TrackerSummary[];
  /**
   * True until the first page of tracker data lands. The board is chrome, not
   * data: its lanes, their names and their widths are fixed by `filter` alone,
   * so it renders in full from the first frame and only the card stacks swap
   * to skeletons. Never gate mounting this component on loading — that is what
   * makes the whole board pop into place and reflow the screen around it.
   */
  isLoading?: boolean;
  /** Projects the board onto a subset of lanes; see buildTrackerBoard's filter contract. */
  filter: TrackerBoardFilter;
  /**
   * Ids of unblocked trackers, from `project.tracker.ready`. An open tracker
   * whose id is absent renders a Blocked badge when this set is available.
   * Omit while loading or when the server doesn't advertise the capability.
   */
  readyIds?: ReadonlySet<string> | null;
  laneTotals: Partial<Record<TrackerBoardLaneKey, number | null>>;
  laneHasMore: Partial<Record<TrackerBoardLaneKey, boolean>>;
  laneLoadingMore: Partial<Record<TrackerBoardLaneKey, boolean>>;
  onLoadMore: (lane: TrackerBoardLaneKey) => void;
  /**
   * Mutation entry point. The board never mutates `trackers` locally (no optimistic
   * move) — it marks the card pending, awaits this, then clears pending on either
   * outcome. The caller is responsible for the real RPC and for refreshing `trackers`
   * from the authoritative snapshot on success.
   */
  onTransition: (trackerId: string, transition: TrackerTransition) => Promise<void>;
  /** Called with a translated message when `onTransition` rejects, for the caller's toast. */
  onTransitionError?: (trackerId: string, message: string) => void;
  /** Opens the caller's edit sheet for a card — omit to hide the kebab menu's Edit entry. */
  onEdit?: (trackerId: string) => void;
  /**
   * Performs the actual delete — same pending/error contract as `onTransition`. Omit to
   * hide the kebab menu's Remove/Delete tree entry entirely.
   */
  onDelete?: (trackerId: string) => Promise<void>;
  /** Called with a translated message when `onDelete` rejects, for the caller's toast. */
  onDeleteError?: (trackerId: string, message: string) => void;
  /**
   * Resolves whether a tracker has descendants from the caller's own (unfiltered)
   * hierarchy, for the delete item's confirm copy and cascade flag. Falls back to
   * this board's own hierarchy (built from the type-filtered `trackers` prop) when
   * omitted, which can undercount while a type filter hides a tracker's children.
   */
  getHasChildren?: (trackerId: string) => boolean;
  /** Resolved per-card only in multi-project (aggregated) contexts; omit for single-project boards. */
  getProjectLabel?: (tracker: TrackerSummary) => string | null;
  /** Tapping a card body (not the move menu) — omit to render cards non-pressable. */
  onCardPress?: (trackerId: string) => void;
  testID?: string;
}

/**
 * The status-lane Kanban board: four columns (Todo, In progress, Done, Cancelled)
 * built from tracker-board-model.ts, tracker-kanban-card.tsx, and tracker-transitions.ts.
 *
 * Desktop renders every lane `buildTrackerBoard` makes visible, side by side, each
 * with one vertical ScrollView. Compact renders exactly one lane at a time, chosen by
 * a local segmented control — the single-lane case of the same `TrackerBoard`, not a
 * second layout path.
 */
export function TrackerKanbanBoard({
  availableWidth = null,
  trackers,
  isLoading = false,
  filter,
  readyIds = null,
  laneTotals,
  laneHasMore,
  laneLoadingMore,
  onLoadMore,
  onTransition,
  onTransitionError,
  onEdit,
  onDelete,
  onDeleteError,
  getHasChildren,
  getProjectLabel,
  onCardPress,
  testID = "tracker-kanban-board",
}: TrackerKanbanBoardProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();

  const board = useMemo(
    () => buildTrackerBoard(trackers, filter, readyIds),
    [trackers, filter, readyIds],
  );
  const hierarchy = useMemo(() => buildTrackerHierarchy([...trackers]), [trackers]);

  const pendingSetRef = useRef(createPendingTrackerSet());
  const [, forceRender] = useReducer((count: number) => count + 1, 0);

  const handleTransition = useCallback(
    (trackerId: string, transition: TrackerTransition) => {
      const pendingSet = pendingSetRef.current;
      pendingSet.markPending(trackerId);
      forceRender();
      onTransition(trackerId, transition)
        .catch(() => {
          const tracker = hierarchy.trackerMap.get(trackerId);
          onTransitionError?.(
            trackerId,
            t("tracker.kanban.error.transitionFailed", { title: tracker?.title ?? trackerId }),
          );
        })
        .finally(() => {
          pendingSet.clearPending(trackerId);
          forceRender();
        });
    },
    [onTransition, onTransitionError, t, hierarchy],
  );

  // Same pending/error dance as handleTransition — the "Remove"/"Delete tree" item
  // has already confirmed by the time this runs, so a rejection here is a real
  // failure (e.g. `ait` refusing a non-cascaded delete), not a cancellation.
  const handleDelete = useCallback(
    (trackerId: string) => {
      if (!onDelete) {
        return;
      }
      const pendingSet = pendingSetRef.current;
      pendingSet.markPending(trackerId);
      forceRender();
      onDelete(trackerId)
        .catch(() => {
          const tracker = hierarchy.trackerMap.get(trackerId);
          onDeleteError?.(
            trackerId,
            t("tracker.kanban.error.deleteFailed", { title: tracker?.title ?? trackerId }),
          );
        })
        .finally(() => {
          pendingSet.clearPending(trackerId);
          forceRender();
        });
    },
    [onDelete, onDeleteError, t, hierarchy],
  );

  const isPending = useCallback(
    (trackerId: string) => pendingSetRef.current.isPending(trackerId),
    [],
  );

  const [selectedLane, setSelectedLane] = useState<TrackerBoardLaneKey | null>(null);
  const effectiveLane =
    selectedLane && board.visibleLanes.includes(selectedLane)
      ? selectedLane
      : (board.visibleLanes[0] ?? "open");

  const lanesToRender = isCompact ? [effectiveLane] : board.visibleLanes;

  // Inside a horizontal ScrollView the content box grows to fit its children,
  // so flex columns there would never shrink — they'd just extend the scroll
  // range. The choice therefore has to be made before rendering: if every lane
  // fits at its minimum width, drop the scroller entirely and let the columns
  // divide the space; only fall back to fixed-width scrolling columns when
  // they genuinely don't fit.
  const laneCount = lanesToRender.length;
  const widthNeeded =
    laneCount * COLUMN_MIN_WIDTH + (laneCount - 1) * COLUMN_GAP + COLUMN_ROW_INSET * 2;
  const lanesFit = availableWidth != null && availableWidth >= widthNeeded;
  const scrolls = !isCompact && !lanesFit;

  const columnStyle = resolveColumnStyle({ isCompact, scrolls });
  const columnList = lanesToRender.map((lane, laneIndex) => {
    return (
      <TrackerKanbanColumn
        key={lane}
        lane={lane}
        laneIndex={laneIndex}
        isLoading={isLoading}
        cards={board[lane]}
        hierarchy={hierarchy}
        laneTotal={laneTotals?.[lane]}
        laneHasMore={laneHasMore?.[lane]}
        laneLoadingMore={laneLoadingMore?.[lane]}
        onLoadMore={onLoadMore}
        getProjectLabel={getProjectLabel}
        isPending={isPending}
        onTransition={handleTransition}
        onEdit={onEdit}
        onDelete={onDelete ? handleDelete : undefined}
        getHasChildren={getHasChildren}
        onCardPress={onCardPress}
        style={columnStyle}
      />
    );
  });

  return (
    <View style={styles.board} testID={testID}>
      {isCompact && board.visibleLanes.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.laneSelectorScroll}
          contentContainerStyle={styles.laneSelectorScrollContent}
        >
          <SegmentedControl
            options={board.visibleLanes.map((lane) => ({
              value: lane,
              label: t(`tracker.kanban.lane.${laneTranslationKey(lane)}`),
              testID: `${testID}-lane-selector-${lane}`,
            }))}
            value={effectiveLane}
            onValueChange={setSelectedLane}
            size="sm"
            testID={`${testID}-lane-selector`}
          />
        </ScrollView>
      ) : null}
      {scrolls ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.columnsScroll}
          contentContainerStyle={styles.columnsContent}
        >
          {columnList}
        </ScrollView>
      ) : (
        <View style={styles.columns}>{columnList}</View>
      )}
    </View>
  );
}

function resolveColumnStyle({
  isCompact,
  scrolls,
}: {
  isCompact: boolean;
  scrolls: boolean;
}): StyleProp<ViewStyle> {
  if (isCompact) {
    return styles.columnFull;
  }
  return scrolls ? styles.columnFixed : styles.columnFlex;
}

const styles = StyleSheet.create((theme) => ({
  board: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[2],
  },
  // flexGrow/flexShrink: 0 keeps this ScrollView pinned to its content height —
  // as a flex child of `board` (a column flex:1 container) it would otherwise
  // stretch to fill the remaining vertical space instead of hugging the pills.
  laneSelectorScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  laneSelectorScrollContent: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
  },
  // Compact only: a plain View wrapping the single visible lane.
  columns: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
    gap: theme.spacing[3],
    // Matches the toolbar's own paddingHorizontal above (tracker-screen.tsx's
    // `toolbar` style) — neither `kanbanContainer` nor `scrollContent` apply any
    // horizontal inset, so without this the board content sits flush against
    // the screen edge while everything above it is properly indented.
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingBottom: theme.spacing[4],
  },
  columnsScroll: {
    flex: 1,
    minHeight: 0,
  },
  // Non-compact: the horizontal ScrollView's contentContainerStyle. minHeight
  // "100%" (not flex:1 — a content container isn't itself a flex item of a
  // sized parent) stretches the row to the scroller's full height so each
  // fixed-width column's own vertical ScrollView still fills it.
  columnsContent: {
    flexDirection: "row",
    minHeight: "100%",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingBottom: theme.spacing[4],
  },
  // Fixed rather than flexed — columns keep a readable, consistent width and
  // the row scrolls horizontally instead of squeezing every lane to fit.
  // flexBasis must be explicit "auto": `column`'s base `flex: 1` resolves to
  // flexBasis 0%, and flexBasis (once not "auto") wins over `width` entirely
  // — the un-overridden 0% from the base style collapsed every column to 0
  // width even with `width: 320` set here.
  // flexBasis must be spelled "auto": the shorthand `flex: 0` resolves it to
  // 0%, and a definite flex-basis beats `width` outright, which collapsed every
  // column to zero.
  columnFixed: {
    width: COLUMN_SCROLL_WIDTH,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: "auto",
    minHeight: 0,
  },
  // Used when every lane fits: they share the row evenly instead of running
  // past the right edge at a fixed width.
  columnFlex: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  columnFull: {
    flex: 1,
    minHeight: 0,
    width: "100%",
  },
}));
