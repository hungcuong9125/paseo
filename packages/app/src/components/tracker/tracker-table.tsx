import { useCallback, useMemo, useState, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { TrackerRow, type TrackerRowPending } from "@/components/tracker/tracker-row";
import type { AggregatedTracker } from "@/tracker/aggregated-trackers";
import { useTrackerMutations } from "@/tracker/use-tracker-mutations";
import { settingsStyles } from "@/styles/settings";

interface TrackerTableProps {
  trackers: AggregatedTracker[];
  parentTrackers: AggregatedTracker[];
  showProjectLabel: boolean;
  onOpenTracker: (tracker: AggregatedTracker) => void;
}

/**
 * The trackers list: a single settings-style card of rows sorted by hierarchical
 * ID within each project, so an epic and its children cluster together the way
 * `ait`'s own IDs already encode the tree (`proj-abc`, `proj-abc.1`, `proj-abc.1.1`).
 * Rows carry their own `serverId`/`projectId` (from the aggregated fetch), so this
 * table works identically whether it's showing one project or every project.
 */
export function TrackerTable({
  trackers,
  parentTrackers,
  showProjectLabel,
  onOpenTracker,
}: TrackerTableProps): ReactElement {
  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const tracker of parentTrackers) {
      map.set(`${tracker.projectId}:${tracker.id}`, tracker.title);
    }
    return map;
  }, [parentTrackers]);

  const sortedTrackers = useMemo(
    () =>
      [...trackers].sort(
        (a, b) => a.projectId.localeCompare(b.projectId) || a.id.localeCompare(b.id),
      ),
    [trackers],
  );

  return (
    <View style={styles.listContent} testID="tracker-table">
      <View style={settingsStyles.card}>
        {sortedTrackers.map((tracker, index) => (
          <TrackerTableRow
            key={`${tracker.serverId}:${tracker.projectId}:${tracker.id}`}
            tracker={tracker}
            parentTitle={
              tracker.parentId
                ? (titleById.get(`${tracker.projectId}:${tracker.parentId}`) ?? null)
                : null
            }
            projectLabel={showProjectLabel ? tracker.projectName : null}
            isFirst={index === 0}
            onOpenTracker={onOpenTracker}
          />
        ))}
      </View>
    </View>
  );
}

const NO_PENDING: TrackerRowPending = {};

function TrackerTableRow({
  tracker,
  parentTitle,
  projectLabel,
  isFirst,
  onOpenTracker,
}: {
  tracker: AggregatedTracker;
  parentTitle: string | null;
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
      parentTitle={parentTitle}
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
}));
