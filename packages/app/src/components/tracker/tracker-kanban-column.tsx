import {
  memo,
  useCallback,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
} from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";
import { TrackerKanbanCard } from "@/components/tracker/tracker-kanban-card";
import { TrackerKanbanCardMenu } from "@/components/tracker/tracker-kanban-move-menu";
import { TrackerKanbanLaneSkeleton } from "@/components/tracker/tracker-skeletons";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SkeletonPulse, useSkeletonPulse } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { isNative } from "@/constants/platform";
import { useTrackerPageStep } from "@/components/tracker/tracker-table";
import type { TrackerBoardCard, TrackerBoardLaneKey } from "@/tracker/tracker-board-model";
import type { TrackerHierarchy } from "@/tracker/tracker-hierarchy";
import type { TrackerLane, TrackerTransition } from "@/tracker/tracker-transitions";

// Shared by the board (column header/segmented-control labels) and the move menu
// (per-transition labels) so a lane's i18n key is named in exactly one place.
export function laneTranslationKey(
  lane: TrackerBoardLaneKey,
): "ready" | "open" | "inProgress" | "done" | "cancelled" {
  return lane === "in_progress" ? "inProgress" : lane;
}

// tracker-transitions.ts's TrackerLane stays open|in_progress|done — Ready is
// never itself a status to transition into, only a display split of "open".
// A card shown in the Ready lane still transitions like an Open one.
function transitionLaneFor(lane: TrackerBoardLaneKey): TrackerLane {
  return lane === "ready" ? "open" : lane;
}

interface TrackerKanbanCardPressableProps {
  trackerId: string;
  pending: boolean;
  onCardPress: (trackerId: string) => void;
  testID?: string;
}

// Web only. On native, TrackerKanbanCardMenu wraps the card body in ContextMenuTrigger
// (a Pressable with onLongPress for the move menu) — nesting a second Pressable in there
// for tap-to-open would leave two Pressables racing over the same touch responder, so
// native forwards onCardPress into TrackerKanbanCardMenu's own onPress (see its
// docstring). Web's TrackerKanbanCardMenu renders `children` with no outer Pressable at
// all, so this wrapper is the only one covering the card there — no conflict.
//
// Its own `onPress` is memoized per trackerId instead of allocating a closure
// inline in the column's card list — see TrackerKanbanMoveItem's identical
// rationale in tracker-kanban-move-menu.tsx.
const TrackerKanbanCardPressable = memo(function TrackerKanbanCardPressable({
  children,
  trackerId,
  pending,
  onCardPress,
  testID,
}: PropsWithChildren<TrackerKanbanCardPressableProps>): ReactElement {
  const handlePress = useCallback(() => onCardPress(trackerId), [onCardPress, trackerId]);
  return (
    <Pressable
      disabled={pending}
      onPress={handlePress}
      style={[styles.cardWrapper, pending && styles.cardPending]}
      testID={testID}
    >
      {children}
    </Pressable>
  );
});

export interface TrackerKanbanColumnProps {
  lane: TrackerBoardLaneKey;
  cards: readonly TrackerBoardCard[];
  hierarchy: TrackerHierarchy;
  laneTotal?: number | null;
  laneHasMore?: boolean;
  laneLoadingMore?: boolean;
  onLoadMore?: (lane: TrackerBoardLaneKey) => void;
  getProjectLabel?: (tracker: TrackerSummary) => string | null;
  isPending: (trackerId: string) => boolean;
  onTransition: (trackerId: string, transition: TrackerTransition) => void;
  /** Opens the caller's edit sheet for a card — omit to hide the kebab menu's Edit entry. */
  onEdit?: (trackerId: string) => void;
  /** Performs the delete after the user confirms — omit to hide the kebab menu's
   * Remove/Delete tree entry. */
  onDelete?: (trackerId: string) => void;
  /** Resolves whether a tracker has descendants from the caller's own (unfiltered)
   * hierarchy — falls back to this column's own `hierarchy` prop when omitted. */
  getHasChildren?: (trackerId: string) => boolean;
  /** Tapping a card body (not the move menu) — omit to render cards non-pressable. */
  onCardPress?: (trackerId: string) => void;
  /** Position in the rendered lane row — only decides how many skeleton cards
   * this lane shows, so the placeholder board doesn't read as a uniform grid. */
  laneIndex?: number;
  /** True until the first page of tracker data lands. The lane's own chrome —
   * column, header, name, scroll container — renders either way; only the card
   * stack and the count badge swap to placeholders. */
  isLoading?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function TrackerKanbanColumn({
  lane,
  cards,
  hierarchy,
  laneTotal,
  laneHasMore = false,
  laneLoadingMore = false,
  onLoadMore,
  getProjectLabel,
  isPending,
  onTransition,
  onEdit,
  onDelete,
  getHasChildren,
  onCardPress,
  laneIndex = 0,
  isLoading = false,
  style,
}: TrackerKanbanColumnProps): ReactElement {
  const { t } = useTranslation();
  const pulse = useSkeletonPulse(isLoading);
  const revealStep = useTrackerPageStep();
  const transitionLane = transitionLaneFor(lane);

  const handleLoadMore = useCallback(() => {
    onLoadMore?.(lane);
  }, [onLoadMore, lane]);

  // Assigned rather than nested in JSX: three-way branches read as nested
  // ternaries there, which the lint rules reject outright.
  let laneBody: ReactNode;
  if (isLoading) {
    laneBody = <TrackerKanbanLaneSkeleton laneIndex={laneIndex} pulse={pulse} />;
  } else if (cards.length === 0) {
    laneBody = (
      <Text style={styles.emptyText}>{t(`tracker.kanban.empty.${laneTranslationKey(lane)}`)}</Text>
    );
  } else {
    laneBody = cards.map((card) => {
      const tracker = card.tracker;
      let childCount = tracker.childCount;
      if (childCount === undefined) {
        childCount = hierarchy.descendantStats(tracker.id).childCount;
      }
      let doneCount = tracker.doneCount;
      if (doneCount === undefined) {
        doneCount = hierarchy.descendantStats(tracker.id).doneCount;
      }
      let hasChildren = false;
      if (getHasChildren != null) {
        hasChildren = getHasChildren(tracker.id);
      } else if (tracker.childCount !== undefined) {
        hasChildren = tracker.childCount > 0;
      } else {
        hasChildren = hierarchy.descendantStats(tracker.id).childCount > 0;
      }
      const pending = isPending(tracker.id);
      const cardTestID = `tracker-kanban-card-${tracker.id}`;
      const cardBody = (
        <TrackerKanbanCard
          id={tracker.id}
          title={tracker.title}
          priority={tracker.priority}
          status={tracker.status}
          projectLabel={getProjectLabel?.(tracker) ?? null}
          childCount={childCount}
          doneCount={doneCount}
          createdAt={tracker.createdAt ?? null}
          testID={cardTestID}
        />
      );
      // Native: onCardPress rides ContextMenuTrigger's own onPress (see
      // TrackerKanbanCardMenu) — never a second Pressable nested inside it. Web has
      // no outer Pressable there, so TrackerKanbanCardPressable owns the tap.
      return (
        <TrackerKanbanCardMenu
          key={tracker.id}
          trackerId={tracker.id}
          trackerTitle={tracker.title}
          lane={transitionLane}
          isPending={pending}
          onTransition={onTransition}
          onEdit={onEdit}
          hasChildren={hasChildren}
          deleteDisabled={tracker.childCount === undefined}
          onDelete={onDelete}
          onCardPress={isNative ? onCardPress : undefined}
          testID={`${cardTestID}-move`}
        >
          {!isNative && onCardPress ? (
            <TrackerKanbanCardPressable
              trackerId={tracker.id}
              pending={pending}
              onCardPress={onCardPress}
              testID={`${cardTestID}-press`}
            >
              {cardBody}
            </TrackerKanbanCardPressable>
          ) : (
            <View style={[styles.cardWrapper, pending && styles.cardPending]}>{cardBody}</View>
          )}
        </TrackerKanbanCardMenu>
      );
    });
  }

  const badgeCount = laneTotal ?? cards.length;
  const showCount =
    laneTotal != null ? Math.max(0, Math.min(revealStep, laneTotal - cards.length)) : revealStep;

  return (
    <View style={[styles.column, style]} testID={`tracker-kanban-column-${lane}`}>
      <View style={styles.header}>
        <Text style={styles.headerLabel}>
          {t(`tracker.kanban.lane.${laneTranslationKey(lane)}`)}
        </Text>
        {isLoading ? (
          <SkeletonPulse pulse={pulse} style={styles.headerCountSkeleton} />
        ) : (
          <StatusBadge label={String(badgeCount)} variant="muted" />
        )}
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        testID={`tracker-kanban-column-${lane}-scroll`}
      >
        {laneBody}
      </ScrollView>
      {laneHasMore && onLoadMore ? (
        <View style={styles.footer} testID={`tracker-kanban-column-${lane}-footer`}>
          <Pressable
            style={styles.showMore}
            onPress={handleLoadMore}
            accessibilityRole="button"
            testID={`tracker-kanban-column-${lane}-show-more`}
          >
            {laneLoadingMore ? (
              <LoadingSpinner size="small" color={styles.showMoreText.color} />
            ) : (
              <Text style={styles.showMoreText}>
                {t("tracker.kanban.showMore", { count: showCount })}
              </Text>
            )}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  column: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[2],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  headerLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  // Sized to the StatusBadge it replaces (xs text + 3px vertical padding +
  // hairline border) so the header doesn't change height when the count lands.
  headerCountSkeleton: {
    width: 28,
    height: 22,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  // Pinned below the scrollable card area so loading more cards can't push it
  // down. flexShrink: 0 keeps the button's tap target from being squeezed;
  // rendered only when there is a "Show more" to show, so a lane with no more
  // cards collapses to zero height instead of reserving a blank footer next to
  // a sibling lane that does have a button.
  footer: {
    flexShrink: 0,
  },
  scrollContent: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[3],
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingVertical: theme.spacing[4],
    textAlign: "center",
  },
  cardWrapper: {
    position: "relative",
  },
  // Reduced opacity only per docs/design.md S14 — no colour change for disabled state.
  cardPending: {
    opacity: 0.5,
  },
  showMore: {
    alignItems: "center",
    paddingVertical: theme.spacing[3],
  },
  showMoreText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
}));
