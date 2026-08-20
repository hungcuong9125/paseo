import { memo, useCallback, useState, type PropsWithChildren, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";
import { TrackerKanbanCard } from "@/components/tracker/tracker-kanban-card";
import { TrackerKanbanCardMenu } from "@/components/tracker/tracker-kanban-move-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import type { TrackerBoardCard, TrackerBoardLaneKey } from "@/tracker/tracker-board-model";
import type { TrackerHierarchy } from "@/tracker/tracker-hierarchy";
import type { TrackerTransition } from "@/tracker/tracker-transitions";

// Shared by the board (column header/segmented-control labels) and the move menu
// (per-transition labels) so a lane's i18n key is named in exactly one place.
export function laneTranslationKey(lane: TrackerBoardLaneKey): "open" | "inProgress" | "done" {
  return lane === "in_progress" ? "inProgress" : lane;
}

// Doc: "Done lane: incremental reveal — render at most 50 cards with a 'Show N
// more' footer." Open/In progress lanes are bounded by active work and render
// in full; only Done accumulates without limit.
const DONE_REVEAL_STEP = 50;

interface TrackerKanbanCardPressableProps {
  trackerId: string;
  pending: boolean;
  onCardPress: (trackerId: string) => void;
  testID?: string;
}

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
      style={[styles.cardWrapper, pending && styles.cardPending]}
      onPress={handlePress}
      disabled={pending}
      accessibilityRole="button"
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
  getProjectLabel?: (tracker: TrackerSummary) => string | null;
  isPending: (trackerId: string) => boolean;
  onTransition: (trackerId: string, transition: TrackerTransition) => void;
  /** Tapping a card body (not the move menu) — omit to render cards non-pressable. */
  onCardPress?: (trackerId: string) => void;
  style?: StyleProp<ViewStyle>;
}

export function TrackerKanbanColumn({
  lane,
  cards,
  hierarchy,
  getProjectLabel,
  isPending,
  onTransition,
  onCardPress,
  style,
}: TrackerKanbanColumnProps): ReactElement {
  const { t } = useTranslation();
  const [revealCount, setRevealCount] = useState(DONE_REVEAL_STEP);

  const visibleCards = lane === "done" ? cards.slice(0, revealCount) : cards;
  const remaining = lane === "done" ? Math.max(0, cards.length - revealCount) : 0;

  const handleShowMore = useCallback(() => setRevealCount((count) => count + DONE_REVEAL_STEP), []);

  return (
    <View style={[styles.column, style]} testID={`tracker-kanban-column-${lane}`}>
      <View style={styles.header}>
        <Text style={styles.headerLabel}>
          {t(`tracker.kanban.lane.${laneTranslationKey(lane)}`)}
        </Text>
        <StatusBadge label={String(cards.length)} variant="muted" />
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {cards.length === 0 ? (
          <Text style={styles.emptyText}>
            {t(`tracker.kanban.empty.${laneTranslationKey(lane)}`)}
          </Text>
        ) : (
          visibleCards.map((card) => {
            const tracker = card.tracker;
            const parent = tracker.parentId ? hierarchy.trackerMap.get(tracker.parentId) : null;
            const stats = hierarchy.descendantStats(tracker.id);
            const pending = isPending(tracker.id);
            const cardTestID = `tracker-kanban-card-${tracker.id}`;
            const cardBody = (
              <TrackerKanbanCard
                id={tracker.id}
                title={tracker.title}
                priority={tracker.priority}
                status={tracker.status}
                projectLabel={getProjectLabel?.(tracker) ?? null}
                parentTitle={parent?.title ?? null}
                childCount={stats.childCount}
                doneCount={stats.doneCount}
                claimedBy={tracker.claimedBy ?? null}
                testID={cardTestID}
              />
            );
            return (
              <TrackerKanbanCardMenu
                key={tracker.id}
                trackerId={tracker.id}
                trackerTitle={tracker.title}
                lane={lane}
                isPending={pending}
                onTransition={onTransition}
                testID={`${cardTestID}-move`}
              >
                {onCardPress ? (
                  <TrackerKanbanCardPressable
                    trackerId={tracker.id}
                    pending={pending}
                    onCardPress={onCardPress}
                    testID={`${cardTestID}-press`}
                  >
                    {cardBody}
                  </TrackerKanbanCardPressable>
                ) : (
                  <View style={[styles.cardWrapper, pending && styles.cardPending]}>
                    {cardBody}
                  </View>
                )}
              </TrackerKanbanCardMenu>
            );
          })
        )}
        {remaining > 0 ? (
          <Pressable
            style={styles.showMore}
            onPress={handleShowMore}
            accessibilityRole="button"
            testID={`tracker-kanban-column-${lane}-show-more`}
          >
            <Text style={styles.showMoreText}>
              {t("tracker.kanban.showMore", { count: Math.min(DONE_REVEAL_STEP, remaining) })}
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
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
  scroll: {
    flex: 1,
    minHeight: 0,
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
