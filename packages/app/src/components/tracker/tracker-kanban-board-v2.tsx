import { useCallback, useMemo, useReducer, useRef, useState, type ReactElement } from "react";
import { View } from "react-native";
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

export interface TrackerKanbanBoardProps {
  /** Project-filtered but NOT status-filtered — the board partitions by status itself. */
  trackers: readonly TrackerSummary[];
  /** Projects the board onto a subset of lanes; see buildTrackerBoard's filter contract. */
  filter: TrackerBoardFilter;
  /**
   * Mutation entry point. The board never mutates `trackers` locally (no optimistic
   * move) — it marks the card pending, awaits this, then clears pending on either
   * outcome. The caller is responsible for the real RPC and for refreshing `trackers`
   * from the authoritative snapshot on success.
   */
  onTransition: (trackerId: string, transition: TrackerTransition) => Promise<void>;
  /** Called with a translated message when `onTransition` rejects, for the caller's toast. */
  onTransitionError?: (trackerId: string, message: string) => void;
  /** Resolved per-card only in multi-project (aggregated) contexts; omit for single-project boards. */
  getProjectLabel?: (tracker: TrackerSummary) => string | null;
  testID?: string;
}

/**
 * The status-lane Kanban board: three columns (Open, In progress, Done) built from
 * tracker-board-model.ts, tracker-kanban-card.tsx, and tracker-transitions.ts.
 *
 * Desktop renders every lane `buildTrackerBoard` makes visible, side by side, each
 * with one vertical ScrollView. Compact renders exactly one lane at a time, chosen by
 * a local segmented control — the single-lane case of the same `TrackerBoard`, not a
 * second layout path.
 *
 * Still unmounted: nothing wires this into tracker-screen.tsx yet (a separate,
 * later step owns that).
 */
export function TrackerKanbanBoard({
  trackers,
  filter,
  onTransition,
  onTransitionError,
  getProjectLabel,
  testID = "tracker-kanban-board",
}: TrackerKanbanBoardProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();

  const board = useMemo(() => buildTrackerBoard(trackers, filter), [trackers, filter]);
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

  return (
    <View style={styles.board} testID={testID}>
      {isCompact && board.visibleLanes.length > 1 ? (
        <SegmentedControl
          options={board.visibleLanes.map((lane) => ({
            value: lane,
            label: t(`tracker.kanban.lane.${laneTranslationKey(lane)}`),
            testID: `${testID}-lane-selector-${lane}`,
          }))}
          value={effectiveLane}
          onValueChange={setSelectedLane}
          style={styles.laneSelector}
          testID={`${testID}-lane-selector`}
        />
      ) : null}
      <View style={styles.columns}>
        {lanesToRender.map((lane) => (
          <TrackerKanbanColumn
            key={lane}
            lane={lane}
            cards={board[lane]}
            hierarchy={hierarchy}
            getProjectLabel={getProjectLabel}
            isPending={isPending}
            onTransition={handleTransition}
            style={isCompact ? styles.columnFull : styles.columnFlex}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  board: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[2],
  },
  laneSelector: {
    alignSelf: "flex-start",
  },
  columns: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  columnFlex: {
    flex: 1,
    minHeight: 0,
  },
  columnFull: {
    flex: 1,
    minHeight: 0,
    width: "100%",
  },
}));
