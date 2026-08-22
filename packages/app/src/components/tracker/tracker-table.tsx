import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TrackerStatus } from "@getpaseo/protocol/tracker/types";
import { TrackerRow, type TrackerRowPending } from "@/components/tracker/tracker-row";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { AggregatedTracker } from "@/tracker/aggregated-trackers";
import type { TrackerHierarchy } from "@/tracker/tracker-hierarchy";
import { useTrackerMutations } from "@/tracker/use-tracker-mutations";
import { confirmDialog } from "@/utils/confirm-dialog";
import { settingsStyles } from "@/styles/settings";

export interface TrackerTableBaseProps {
  trackers: AggregatedTracker[];
  showProjectLabel: boolean;
  onOpenTracker: (tracker: AggregatedTracker) => void;
  /** Built from the full (unfiltered) project set, not `trackers` above — a
   * type/status filter must never hide a real child and make a parent look
   * deletable when `ait delete` would actually refuse it. */
  hierarchy: TrackerHierarchy;
  /** Called with the mutation's own response tracker after a row action
   * (start/close/reopen/cancel) succeeds — the caller patches its shared
   * data hook in place instead of this table re-fetching anything. */
  onTrackerPatched?: (tracker: AggregatedTracker) => void;
  /** Called when the row kebab menu's Edit entry picks a tracker — opens the
   * caller's edit sheet. No mutation happens until that sheet submits. */
  onEditTracker?: (tracker: AggregatedTracker) => void;
  /** Called with the ids `ait` actually removed after a row delete succeeds. */
  onTrackersRemoved?: (ids: string[]) => void;
}

export type TrackerTableProps = TrackerTableBaseProps &
  (
    | {
        variant?: "sections";
        sectionTotals: Partial<Record<TrackerStatus, number | null>>;
        sectionHasMore: Partial<Record<TrackerStatus, boolean>>;
        sectionLoadingMore: Partial<Record<TrackerStatus, boolean>>;
        onLoadMore: (status: TrackerStatus) => void;
        hasMoreAll?: never;
        onLoadMoreAll?: never;
        isLoadingMoreAll?: never;
      }
    | {
        variant: "flat";
        sectionTotals?: never;
        sectionHasMore?: never;
        sectionLoadingMore?: never;
        onLoadMore?: never;
        hasMoreAll?: boolean;
        onLoadMoreAll?: () => void;
        isLoadingMoreAll?: boolean;
      }
  );

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

// Page size for the server-side pagination hooks that feed this table — the
// same sizing convention the old client-side reveal used (50 desktop / 20
// compact), now applied at the RPC boundary instead of as an in-memory slice.
export const REVEAL_STEP_DESKTOP = 50;
export const REVEAL_STEP_COMPACT = 20;

export function useTrackerPageStep(): number {
  const isCompact = useIsCompactFormFactor();
  return isCompact ? REVEAL_STEP_COMPACT : REVEAL_STEP_DESKTOP;
}

/**
 * The trackers list, grouped into one section per real `TrackerStatus` (Open,
 * In progress, Done, Cancelled). Within a section the rows keep the same
 * hierarchical ordering `orderedTrackers` already produces (projectId then id)
 * — grouping only buckets the existing sorted list, it does not re-sort. Rows
 * carry their own `serverId`/`projectId` (from the aggregated fetch), so this
 * table works identically whether it's showing one project or every project.
 *
 * Renders exactly what the shared project-data hook has loaded so far — the
 * background sweep (see use-tracker-project-data.ts) keeps growing it with no
 * client-side slicing or manual "load more" in browse mode. Search mode
 * (`variant="flat"`) is the one exception: search result sets are small and
 * bounded, so it keeps its own whole-result-set "Load more" via `onLoadMoreAll`.
 */
export function TrackerTable(props: TrackerTableProps): ReactElement {
  const {
    trackers,
    showProjectLabel,
    onOpenTracker,
    hierarchy,
    onTrackerPatched,
    onEditTracker,
    onTrackersRemoved,
  } = props;
  const { t } = useTranslation();
  const revealStep = useTrackerPageStep();

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

  if (props.variant === "flat") {
    const { hasMoreAll, onLoadMoreAll, isLoadingMoreAll } = props;
    return (
      <View style={styles.listContent} testID="tracker-table">
        <View style={settingsStyles.card}>
          {sortedTrackers.map((tracker, index) => {
            const hasChildren =
              tracker.childCount !== undefined
                ? tracker.childCount > 0
                : hierarchy.descendantStats(tracker.id).childCount > 0;
            return (
              <TrackerTableRow
                key={`${tracker.serverId}:${tracker.projectId}:${tracker.id}`}
                tracker={tracker}
                projectLabel={showProjectLabel ? tracker.projectName : null}
                isFirst={index === 0}
                onOpenTracker={onOpenTracker}
                hasChildren={hasChildren}
                onTrackerPatched={onTrackerPatched}
                onEdit={onEditTracker}
                onTrackersRemoved={onTrackersRemoved}
              />
            );
          })}
        </View>
        {hasMoreAll && onLoadMoreAll ? (
          <Pressable
            style={styles.showMore}
            onPress={onLoadMoreAll}
            accessibilityRole="button"
            accessibilityLabel={t("tracker.list.loadMore")}
            testID="tracker-table-load-more-all"
          >
            {isLoadingMoreAll ? (
              <LoadingSpinner size="small" color={styles.showMoreText.color} />
            ) : (
              <Text style={styles.showMoreText}>{t("tracker.list.loadMore")}</Text>
            )}
          </Pressable>
        ) : null}
      </View>
    );
  }

  const { sectionTotals, sectionHasMore, sectionLoadingMore, onLoadMore } = props;

  // Bucket the already-sorted list by status, preserving the sorted order within
  // each section. A section with zero items is hidden entirely (see below) —
  // this is how a toolbar status filter removes the other sections from view.
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
        const total = sectionTotals[section.status];
        const sectionCount = total ?? items.length;
        const hasMore = sectionHasMore[section.status] ?? false;
        const loadingMore = sectionLoadingMore[section.status] ?? false;
        const showCount =
          total != null ? Math.max(0, Math.min(revealStep, total - items.length)) : revealStep;
        return (
          <View
            key={section.status}
            style={styles.section}
            testID={`tracker-table-section-${section.status}`}
          >
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{t(section.labelKey)}</Text>
              <Text style={styles.sectionCount}>{sectionCount}</Text>
            </View>
            <View style={settingsStyles.card}>
              {items.map((tracker, index) => {
                const hasChildren =
                  tracker.childCount !== undefined
                    ? tracker.childCount > 0
                    : hierarchy.descendantStats(tracker.id).childCount > 0;
                return (
                  <TrackerTableRow
                    key={`${tracker.serverId}:${tracker.projectId}:${tracker.id}`}
                    tracker={tracker}
                    projectLabel={showProjectLabel ? tracker.projectName : null}
                    isFirst={index === 0}
                    onOpenTracker={onOpenTracker}
                    hasChildren={hasChildren}
                    onTrackerPatched={onTrackerPatched}
                    onEdit={onEditTracker}
                    onTrackersRemoved={onTrackersRemoved}
                  />
                );
              })}
            </View>
            {hasMore ? (
              <TrackerTableShowMore
                status={section.status}
                label={t("tracker.list.showMore", { count: showCount })}
                loading={loadingMore}
                onLoadMore={onLoadMore}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const TrackerTableShowMore = memo(function TrackerTableShowMore({
  status,
  label,
  loading,
  onLoadMore,
}: {
  status: TrackerStatus;
  label: string;
  loading: boolean;
  onLoadMore: (status: TrackerStatus) => void;
}): ReactElement {
  const handlePress = useCallback(() => onLoadMore(status), [onLoadMore, status]);
  return (
    <Pressable
      style={styles.showMore}
      onPress={handlePress}
      accessibilityRole="button"
      testID={`tracker-table-section-${status}-show-more`}
    >
      {loading ? (
        <LoadingSpinner size="small" color={styles.showMoreText.color} />
      ) : (
        <Text style={styles.showMoreText}>{label}</Text>
      )}
    </Pressable>
  );
});

const NO_PENDING: TrackerRowPending = {};

function TrackerTableRow({
  tracker,
  projectLabel,
  isFirst,
  onOpenTracker,
  hasChildren,
  onTrackerPatched,
  onEdit,
  onTrackersRemoved,
}: {
  tracker: AggregatedTracker;
  projectLabel: string | null;
  isFirst: boolean;
  onOpenTracker: (tracker: AggregatedTracker) => void;
  hasChildren: boolean;
  onTrackerPatched?: (tracker: AggregatedTracker) => void;
  onEdit?: (tracker: AggregatedTracker) => void;
  onTrackersRemoved?: (ids: string[]) => void;
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

  // No mutation here — Edit only opens the caller's sheet; the update fires
  // from that sheet's own submit.
  const handleEdit = useCallback(() => {
    onEdit?.(tracker);
  }, [onEdit, tracker]);

  const handleStart = useCallback(() => {
    void runAction("start", async () => {
      const summary = await mutations.updateTracker({
        trackerId: tracker.id,
        status: "in_progress",
      });
      onTrackerPatched?.({ ...tracker, ...summary });
    });
  }, [runAction, mutations, tracker, onTrackerPatched]);

  const handleClose = useCallback(() => {
    void runAction("close", async () => {
      const summary = await mutations.closeTracker({ trackerId: tracker.id });
      onTrackerPatched?.({ ...tracker, ...summary });
    });
  }, [runAction, mutations, tracker, onTrackerPatched]);

  const handleReopen = useCallback(() => {
    void runAction("reopen", async () => {
      const summary = await mutations.reopenTracker(tracker.id);
      onTrackerPatched?.({ ...tracker, ...summary });
    });
  }, [runAction, mutations, tracker, onTrackerPatched]);

  const handleCancel = useCallback(() => {
    void runAction("cancel", async () => {
      const summary = await mutations.cancelTracker({ trackerId: tracker.id });
      onTrackerPatched?.({ ...tracker, ...summary });
    });
  }, [runAction, mutations, tracker, onTrackerPatched]);

  // Permanent and unrecorded — confirm before sending it, same as file/folder
  // deletion elsewhere in the app. `cascade` mirrors `hasChildren`: `ait`
  // itself refuses a non-cascaded delete of a tracker with descendants.
  // Blocked while tracker.childCount is undefined to avoid accidental cascade.
  const handleDelete = useCallback(() => {
    if (tracker.childCount === undefined) {
      return;
    }
    void (async () => {
      const confirmed = await confirmDialog({
        title: hasChildren ? "Delete tree?" : "Remove item?",
        message: hasChildren
          ? `"${tracker.title}" and all of its children will be permanently deleted. This can't be undone.`
          : `"${tracker.title}" will be permanently deleted. This can't be undone.`,
        confirmLabel: hasChildren ? "Delete tree" : "Remove",
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      await runAction("delete", async () => {
        const removedIds = await mutations.deleteTracker({
          trackerId: tracker.id,
          cascade: hasChildren,
        });
        onTrackersRemoved?.(removedIds);
      });
    })();
  }, [
    runAction,
    mutations,
    tracker.id,
    tracker.title,
    tracker.childCount,
    hasChildren,
    onTrackersRemoved,
  ]);

  return (
    <TrackerRow
      tracker={tracker}
      projectLabel={projectLabel}
      hasChildren={hasChildren}
      deleteDisabled={tracker.childCount === undefined}
      isFirst={isFirst}
      pending={pending}
      onPress={handlePress}
      onEdit={handleEdit}
      onStart={handleStart}
      onClose={handleClose}
      onReopen={handleReopen}
      onCancel={handleCancel}
      onDelete={handleDelete}
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
