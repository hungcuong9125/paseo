import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TrackerPriority, TrackerStatus } from "@getpaseo/protocol/tracker/types";
import { StatusBadge } from "@/components/ui/status-badge";
import { TrackerStatusIcon } from "@/components/tracker/tracker-status-icon";

export interface TrackerKanbanCardProps {
  id: string;
  title: string;
  priority: TrackerPriority;
  status: TrackerStatus;
  /** Rendered as a chip only when passed — relevant in multi-project (aggregated) context. */
  projectLabel?: string | null;
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
  childCount,
  doneCount,
  claimedBy = null,
  testID,
}: TrackerKanbanCardProps): ReactElement {
  const { t } = useTranslation();
  const hasChildren = typeof childCount === "number" && childCount > 0;

  return (
    <View style={styles.card} testID={testID ?? `tracker-kanban-card-${id}`}>
      <View style={styles.metaRow}>
        <TrackerStatusIcon status={status} size={14} />
        <Text style={styles.meta} numberOfLines={1}>
          {id}
          {" · "}
          {priority}
        </Text>
      </View>
      <Text style={styles.title} numberOfLines={2}>
        {title}
      </Text>
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
      {/* Content-sized, not stretched — a bare child of this column-flex View
          would otherwise default to cross-axis stretch (full card width). */}
      {projectLabel ? (
        <View style={styles.projectChipWrap}>
          <StatusBadge label={projectLabel} variant="muted" />
        </View>
      ) : null}
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
    gap: theme.spacing[1.5],
  },
  meta: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
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
  projectChipWrap: {
    alignSelf: "flex-start",
  },
}));
