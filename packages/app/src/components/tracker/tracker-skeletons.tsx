import type { ReactElement } from "react";
import { Animated, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SkeletonPulse, useSkeletonPulse } from "@/components/ui/skeleton";
import { settingsStyles } from "@/styles/settings";

// Placeholder counts, not a guess at the real data: enough rows to fill the
// first screen so the region the trackers land in is already the right size,
// and varied per lane/section so the board doesn't read as a grid.
const KANBAN_CARDS_PER_LANE: readonly number[] = [3, 4, 2, 4, 2];
const LIST_SECTION_ROWS: readonly number[] = [4, 3, 3];

// Stable keys for placeholder blocks, which have no data to key on.
const KANBAN_CARD_KEYS: readonly (readonly string[])[] = KANBAN_CARDS_PER_LANE.map((count, lane) =>
  Array.from({ length: count }, (_, card) => `tracker-skeleton-lane-${lane}-card-${card}`),
);
const LIST_SECTION_KEYS: readonly string[] = LIST_SECTION_ROWS.map(
  (_, section) => `tracker-skeleton-section-${section}`,
);
const LIST_ROW_KEYS: readonly (readonly string[])[] = LIST_SECTION_ROWS.map((count, section) =>
  Array.from({ length: count }, (_, row) => `tracker-skeleton-section-${section}-row-${row}`),
);

/**
 * Stands in for one `TrackerKanbanCard`. Box geometry (padding, radius,
 * border, gap) is duplicated from that component on purpose — the skeleton's
 * whole job is to occupy the same space, so it has to change when the card
 * does. Keep the two in sync.
 */
function KanbanCardSkeleton({ pulse }: { pulse: Animated.Value }): ReactElement {
  return (
    <View style={styles.card}>
      <View style={styles.cardMetaRow}>
        <SkeletonPulse pulse={pulse} style={styles.cardStatusDot} />
        <SkeletonPulse pulse={pulse} style={styles.cardMeta} />
      </View>
      <SkeletonPulse pulse={pulse} style={styles.cardTitle} />
      <SkeletonPulse pulse={pulse} style={styles.cardTitleShort} />
    </View>
  );
}

/**
 * The card stack inside one Kanban lane while its data is in flight. The lane
 * itself — column, header, name, scroll container — is NOT part of this: those
 * are static chrome and TrackerKanbanColumn renders them from the first frame,
 * loaded or not.
 */
export function TrackerKanbanLaneSkeleton({
  laneIndex,
  pulse,
}: {
  laneIndex: number;
  /** Owned by the lane, which outlives its own skeleton — see `useSkeletonPulse`. */
  pulse: Animated.Value;
}): ReactElement {
  const keys = KANBAN_CARD_KEYS[laneIndex % KANBAN_CARD_KEYS.length] ?? [];
  return (
    <>
      {keys.map((key) => (
        <KanbanCardSkeleton key={key} pulse={pulse} />
      ))}
    </>
  );
}

function ListRowSkeleton({ pulse, isFirst }: { pulse: Animated.Value; isFirst: boolean }) {
  return (
    <View style={[settingsStyles.row, !isFirst && settingsStyles.rowBorder, styles.listRow]}>
      <SkeletonPulse pulse={pulse} style={styles.listRowIcon} />
      <View style={styles.listRowText}>
        <SkeletonPulse pulse={pulse} style={styles.listRowTitle} />
        <SkeletonPulse pulse={pulse} style={styles.listRowMeta} />
      </View>
      <SkeletonPulse pulse={pulse} style={styles.listRowStatus} />
    </View>
  );
}

/**
 * Stands in for `TrackerTable`, matching its section/card/row geometry so the
 * list doesn't resize when the real rows replace it.
 */
export function TrackerListSkeleton(): ReactElement {
  const pulse = useSkeletonPulse();
  return (
    <View style={styles.listContent} testID="tracker-list-skeleton">
      {LIST_SECTION_KEYS.map((sectionKey, sectionIndex) => (
        <View key={sectionKey} style={styles.listSection}>
          <View style={styles.listSectionHeader}>
            <SkeletonPulse pulse={pulse} style={styles.listSectionTitle} />
            <SkeletonPulse pulse={pulse} style={styles.listSectionCount} />
          </View>
          <View style={settingsStyles.card}>
            {LIST_ROW_KEYS[sectionIndex]?.map((rowKey, rowIndex) => (
              <ListRowSkeleton key={rowKey} pulse={pulse} isFirst={rowIndex === 0} />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  cardMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  cardStatusDot: {
    width: 11,
    height: 11,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  cardMeta: {
    width: "55%",
    height: 10,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
  },
  cardTitle: {
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
  },
  cardTitleShort: {
    width: "70%",
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
  },
  listContent: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  listSection: {
    marginBottom: theme.spacing[6],
  },
  listSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  listSectionTitle: {
    width: 92,
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
  },
  listSectionCount: {
    width: 20,
    height: 10,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
  },
  // settingsStyles.row is space-between; the tracker row's own content is a
  // left cluster plus a trailing status, so the skeleton needs the same gap
  // treatment its middle column relies on.
  listRow: {
    gap: theme.spacing[3],
  },
  listRowIcon: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  listRowText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  listRowTitle: {
    width: "60%",
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
  },
  listRowMeta: {
    width: "35%",
    height: 10,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
  },
  listRowStatus: {
    width: 56,
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
  },
}));
