import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TrackerStatus } from "@getpaseo/protocol/tracker/types";
import { TrackerRow, type TrackerRowPending } from "@/components/tracker/tracker-row";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIsMobileBreakpoint } from "@/constants/layout";
import type { AggregatedTracker } from "@/tracker/aggregated-trackers";
import { compareByCreatedNewest, type TrackerHierarchy } from "@/tracker/tracker-hierarchy";
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
export const REVEAL_STEP_DESKTOP = 30;
export const REVEAL_STEP_COMPACT = 20;

// useIsMobileBreakpoint (xs only), not useIsCompactFormFactor (xs + sm) — the
// design's line is mobile (xs) at REVEAL_STEP_COMPACT, tablet and desktop
// (sm and up) at REVEAL_STEP_DESKTOP, and useIsCompactFormFactor answers a
// different question ("does this fit a single-panel shell") that put a
// tablet or narrow desktop window on the mobile-sized step (pas-2KY5X.22).
export function useTrackerPageStep(): number {
  const isMobile = useIsMobileBreakpoint();
  return isMobile ? REVEAL_STEP_COMPACT : REVEAL_STEP_DESKTOP;
}

/**
 * The trackers list, grouped into one section per real `TrackerStatus` (Open,
 * In progress, Done, Cancelled). The sectioned variant buckets `trackers` by
 * status AS RECEIVED, with no re-sort of its own (pas-2KY5X.37): the shared
 * data hook already hands it newest-first, position-stable order within each
 * status, and a fresh global sort here would re-introduce exactly the "later
 * page overtakes an already-shown row" defect that hook fix removed. The
 * `flat` (search) variant is different — `sortedTrackers` re-sorts on every
 * change, since search's own hook isn't proven position-stable the same way.
 * Rows carry their own `serverId`/`projectId` (from the aggregated fetch), so
 * this table works identically whether it's showing one project or every
 * project.
 *
 * Renders exactly what the shared project-data hook has paged in so far: one
 * server-side page per status, extended by this table's own per-section "Show
 * N more" (`onLoadMore`), never a client-side slice of a larger in-memory set.
 * Search mode (`variant="flat"`) pages the whole result set at once instead,
 * via `onLoadMoreAll` — search results are small and bounded, with no
 * per-status split to page independently.
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

  // `flat` (search) only: newest-first by the same shared key the data hook
  // merges with and the Kanban lanes order by (compareByCreatedNewest) — not
  // projectId then id, which sorted by project name and left the oldest
  // project's rows sitting at the top (pas-2KY5X.29). use-tracker-search.ts
  // isn't proven position-stable the way the browse hook is (pas-2KY5X.37),
  // so this variant keeps re-deriving a fresh sort on every change rather
  // than trusting incoming order.
  const sortedTrackers = useMemo(() => [...trackers].sort(compareByCreatedNewest), [trackers]);

  // `sections` (browse) only: bucket `trackers` BY STATUS DIRECTLY, without
  // an intervening global re-sort (pas-2KY5X.37's sibling defect at this
  // layer). `trackers` already arrives newest-first within each status —
  // use-tracker-project-data's k-way merge appends its already-correct
  // window, and mergePage resorts each status's own array — so bucketing
  // preserves that order instead of re-deriving it. Re-sorting the WHOLE
  // list here, the way this used to, undid the hook's own fix: a same-tied
  // row arriving on a later page ranks by `id` in a full re-sort with no
  // relationship to fetch order, so it could jump above an already-shown
  // tied row — exactly the row movement the hook's own append-only merge
  // exists to prevent. A section with zero items is hidden entirely (see
  // below) — this is how a toolbar status filter removes the other sections
  // from view.
  const trackersByStatus = useMemo(() => {
    const buckets = new Map<TrackerStatus, AggregatedTracker[]>();
    for (const section of LIST_SECTIONS) {
      buckets.set(section.status, []);
    }
    for (const tracker of trackers) {
      const bucket = buckets.get(tracker.status);
      if (bucket) {
        bucket.push(tracker);
      }
    }
    return buckets;
  }, [trackers]);

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
