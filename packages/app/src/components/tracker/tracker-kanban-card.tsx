import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TrackerPriority, TrackerStatus } from "@getpaseo/protocol/tracker/types";
import { StatusBadge } from "@/components/ui/status-badge";

export interface TrackerKanbanCardProps {
  id: string;
  title: string;
  priority: TrackerPriority;
  status: TrackerStatus;
  /** Rendered as a chip only when passed — relevant in multi-project (aggregated) context. */
  projectLabel?: string | null;
  /** Resolved by the caller via the hierarchy helper; the hierarchy signal a status board would otherwise lose. */
  parentTitle?: string | null;
  childCount?: number;
  doneCount?: number;
  claimedBy?: string | null;
  testID?: string;
}

export function TrackerKanbanCard({
  id,
  title,
  priority,
  status,
  projectLabel = null,
  parentTitle = null,
  childCount,
  doneCount,
  claimedBy = null,
  testID,
}: TrackerKanbanCardProps): ReactElement {
  const { t } = useTranslation();
  const isCancelled = status === "cancelled";
  const hasChildren = typeof childCount === "number" && childCount > 0;

  return (
    <View style={styles.card} testID={testID ?? `tracker-kanban-card-${id}`}>
      <View style={styles.metaRow}>
        <Text style={styles.meta} numberOfLines={1}>
          {id}
          {" · "}
          {priority}
        </Text>
        {projectLabel ? <StatusBadge label={projectLabel} variant="muted" /> : null}
      </View>
      <Text style={styles.title} numberOfLines={2}>
        {title}
      </Text>
      {parentTitle ? (
        <Text style={styles.parentTitle} numberOfLines={1}>
          {parentTitle}
        </Text>
      ) : null}
      {hasChildren ? (
        <Text style={styles.childProgress}>
          {t("tracker.card.childProgress", { done: doneCount ?? 0, count: childCount })}
        </Text>
      ) : null}
      {claimedBy ? (
        <Text style={styles.claimedBy} numberOfLines={1}>
          {t("tracker.card.claimedBy", { name: claimedBy })}
        </Text>
      ) : null}
      {isCancelled ? <StatusBadge label={t("tracker.card.cancelled")} variant="error" /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  meta: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  parentTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  childProgress: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  claimedBy: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
}));
