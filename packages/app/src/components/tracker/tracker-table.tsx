import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TrackerStatus } from "@getpaseo/protocol/tracker/types";
import { TrackerRow, type TrackerRowPending } from "@/components/tracker/tracker-row";
import type { AggregatedTracker } from "@/tracker/aggregated-trackers";
import { useTrackerMutations } from "@/tracker/use-tracker-mutations";
import { settingsStyles } from "@/styles/settings";

interface TrackerTableProps {
  trackers: AggregatedTracker[];
  showProjectLabel: boolean;
  onOpenTracker: (tracker: AggregatedTracker) => void;
}

// The four real statuses, in the order they read top-to-bottom in the List view.
// Unlike the Kanban board, List does NOT split `open` into Ready/Backlog (that
// split is Kanban-derived `readyIds` data List never fetches); each status gets
// exactly one section. Section copy is its own `tracker.list.section.*` set,
// naming-aligned with the Kanban lane labels (Todo/In progress/Done/Cancelled)
// even though List never shows a Backlog section.
const LIST_SECTIONS: ReadonlyArray<{ status: TrackerStatus; labelKey: string }> = [
  { status: "open", labelKey: "tracker.list.section.open" },
  { status: "in_progress", labelKey: "tracker.list.section.inProgress" },
  { status: "closed", labelKey: "tracker.list.section.done" },
  { status: "cancelled", labelKey: "tracker.list.section.cancelled" },
];

// Mirrors the Kanban board's Done-lane reveal: a long status section renders at
// most REVEAL_STEP rows with a "Show N more" control that reveals more *within
// that section only*. One reveal count per section (not shared), so paging one
// section never disturbs the others. Grouping happens over the full set passed
// in (no flat pagination), so the per-section membership/count is always the
// true total for that status.
const REVEAL_STEP = 50;

const INITIAL_REVEAL: Readonly<Record<TrackerStatus, number>> = {
  open: REVEAL_STEP,
  in_progress: REVEAL_STEP,
  closed: REVEAL_STEP,
  cancelled: REVEAL_STEP,
};

/**
 * The trackers list, grouped into one section per real `TrackerStatus` (Open,
 * In progress, Done, Cancelled). Within a section the rows keep the same
 * hierarchical ordering `orderedTrackers` already produces (projectId then id)
 * — grouping only buckets the existing sorted list, it does not re-sort. Rows
 * carry their own `serverId`/`projectId` (from the aggregated fetch), so this
 * table works identically whether it's showing one project or every project.
 */
export function TrackerTable({
  trackers,
  showProjectLabel,
  onOpenTracker,
}: TrackerTableProps): ReactElement {
  const { t } = useTranslation();
  const [revealCounts, setRevealCounts] = useState<Record<TrackerStatus, number>>(() => ({
    ...INITIAL_REVEAL,
  }));

  const sortedTrackers = useMemo(
    () =>
      [...trackers].sort(
        (a, b) => a.projectId.localeCompare(b.projectId) || a.id.localeCompare(b.id),
      ),
    [trackers],
  );

  // Bucket the already-sorted list by status, preserving the sorted order within
  // each section. A section with zero items is hidden entirely (see below) —
  // this is how a toolbar status filter removes the other sections from view.
  const trackersByStatus = useMemo(() => {
    const buckets = new Map<TrackerStatus, AggregatedTracker[]>();
    for (const section of LIST_SECTIONS) {
      buckets.set(section.status, []);
    }
    for (const tracker of sortedTrackers) {
      const bucket = buckets.get(tracker.status);
      if (bucket) {
        bucket.push(tracker);
      }
    }
    return buckets;
  }, [sortedTrackers]);

  const handleShowMore = useCallback((status: TrackerStatus) => {
    setRevealCounts((current) => ({
      ...current,
      [status]: current[status] + REVEAL_STEP,
    }));
  }, []);

  // Pre-bind one stable handler per section so the Pressable's onPress prop is
  // not a fresh closure on every render (mirrors the Kanban column's pattern).
  const sectionShowMore = useMemo(
    () =>
      Object.fromEntries(
        LIST_SECTIONS.map((section) => [section.status, () => handleShowMore(section.status)]),
      ) as Record<TrackerStatus, () => void>,
    [handleShowMore],
  );

  return (
    <View style={styles.listContent} testID="tracker-table">
      {LIST_SECTIONS.map((section) => {
        const items = trackersByStatus.get(section.status) ?? [];
        // A status the toolbar filter excludes ends up with zero items here — hide
        // that section entirely rather than showing an empty "0" header, so picking
        // "In progress" doesn't leave Todo/Done/Cancelled visible with nothing in them.
        if (items.length === 0) {
          return null;
        }
        const revealed = items.slice(0, revealCounts[section.status]);
        const remaining = Math.max(0, items.length - revealed.length);
        return (
          <View
            key={section.status}
            style={styles.section}
            testID={`tracker-table-section-${section.status}`}
          >
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{t(section.labelKey)}</Text>
              <Text style={styles.sectionCount}>{items.length}</Text>
            </View>
            <View style={settingsStyles.card}>
              {revealed.map((tracker, index) => (
                <TrackerTableRow
                  key={`${tracker.serverId}:${tracker.projectId}:${tracker.id}`}
                  tracker={tracker}
                  projectLabel={showProjectLabel ? tracker.projectName : null}
                  isFirst={index === 0}
                  onOpenTracker={onOpenTracker}
                />
              ))}
            </View>
            {remaining > 0 ? (
              <Pressable
                style={styles.showMore}
                onPress={sectionShowMore[section.status]}
                accessibilityRole="button"
                accessibilityLabel={t("tracker.list.showMore", {
                  count: Math.min(REVEAL_STEP, remaining),
                })}
                testID={`tracker-table-section-${section.status}-show-more`}
              >
                <Text style={styles.showMoreText}>
                  {t("tracker.list.showMore", { count: Math.min(REVEAL_STEP, remaining) })}
                </Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const NO_PENDING: TrackerRowPending = {};

function TrackerTableRow({
  tracker,
  projectLabel,
  isFirst,
  onOpenTracker,
}: {
  tracker: AggregatedTracker;
  projectLabel: string | null;
  isFirst: boolean;
  onOpenTracker: (tracker: AggregatedTracker) => void;
}): ReactElement {
  const mutations = useTrackerMutations({
    serverId: tracker.serverId,
    projectId: tracker.projectId,
  });
  const [pending, setPending] = useState<TrackerRowPending>(NO_PENDING);

  const runAction = useCallback(
    async (key: keyof TrackerRowPending, action: () => Promise<unknown>): Promise<void> => {
      setPending((current) => ({ ...current, [key]: true }));
      try {
        await action();
      } catch {
        // Mutations invalidate and re-fetch on settle; per-row toasts are out of scope for v1.
      } finally {
        setPending((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }
    },
    [],
  );

  const handlePress = useCallback(() => onOpenTracker(tracker), [onOpenTracker, tracker]);

  const handleStart = useCallback(() => {
    void runAction("start", () =>
      mutations.updateTracker({ trackerId: tracker.id, status: "in_progress" }),
    );
  }, [runAction, mutations, tracker.id]);

  const handleClose = useCallback(() => {
    void runAction("close", () => mutations.closeTracker({ trackerId: tracker.id }));
  }, [runAction, mutations, tracker.id]);

  const handleReopen = useCallback(() => {
    void runAction("reopen", () => mutations.reopenTracker(tracker.id));
  }, [runAction, mutations, tracker.id]);

  const handleCancel = useCallback(() => {
    void runAction("cancel", () => mutations.cancelTracker({ trackerId: tracker.id }));
  }, [runAction, mutations, tracker.id]);

  return (
    <TrackerRow
      tracker={tracker}
      projectLabel={projectLabel}
      isFirst={isFirst}
      pending={pending}
      onPress={handlePress}
      onStart={handleStart}
      onClose={handleClose}
      onReopen={handleReopen}
      onCancel={handleCancel}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  listContent: {
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  section: {
    marginBottom: theme.spacing[6],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  sectionCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  showMore: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[1],
  },
  showMoreText: {
    color: theme.colors.palette.blue[600],
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
}));
