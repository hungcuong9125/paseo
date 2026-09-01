import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TrackerPriority, TrackerStatus } from "@getpaseo/protocol/tracker/types";
import { StatusBadge } from "@/components/ui/status-badge";
import { TrackerStatusIcon } from "@/components/tracker/tracker-status-icon";
import { formatTimeAgo } from "@/utils/time";

export interface TrackerKanbanCardProps {
  id: string;
  title: string;
  priority: TrackerPriority;
  status: TrackerStatus;
  /** Rendered as a chip only when passed — relevant in multi-project (aggregated) context. */
  projectLabel?: string | null;
  childCount?: number;
  doneCount?: number;
  createdAt?: string | null;
  /** Readiness is unknown while the readiness query is loading. */
  isBlocked?: boolean;
  testID?: string;
}

// Same severity scale as tracker-row.tsx's List rows: red (critical) → orange → yellow → sky →
// slate (nice-to-have). Kept as a local switch (not a shared import) because each file's colors
// are theme-bound inside its own StyleSheet.create factory — see docs/unistyles.md.
function priorityColorStyle(priority: TrackerPriority) {
  switch (priority) {
    case "P0":
      return styles.prioP0;
    case "P1":
      return styles.prioP1;
    case "P2":
      return styles.prioP2;
    case "P3":
      return styles.prioP3;
    default:
      return styles.prioP4;
  }
}

export function TrackerKanbanCard({
  id,
  title,
  priority,
  status,
  projectLabel = null,
  childCount,
  doneCount,
  createdAt = null,
  isBlocked = false,
  testID,
}: TrackerKanbanCardProps): ReactElement {
  const { t } = useTranslation();
  const hasChildren = childCount !== undefined && childCount > 0;

  return (
    <View style={styles.card} testID={testID ?? `tracker-kanban-card-${id}`}>
      <View style={styles.metaRow}>
        <TrackerStatusIcon status={status} size={11} />
        <Text style={styles.meta} numberOfLines={1}>
          {id}
          {" · "}
          <Text style={priorityColorStyle(priority)}>{priority}</Text>
          {hasChildren ? (
            <Text>
              {` · ${t("tracker.card.childProgress", { done: doneCount ?? 0, count: childCount })}`}
            </Text>
          ) : null}
        </Text>
      </View>
      <Text style={styles.title} numberOfLines={2}>
        {title}
      </Text>
      {projectLabel || createdAt || isBlocked ? (
        <View style={styles.footerRow}>
          {/* Content-sized, not stretched — a bare child of this row would
              otherwise default to cross-axis stretch. Rendered even when
              empty so createdAt still lands on the right via space-between. */}
          <View style={styles.projectChipWrap}>
            {projectLabel ? <StatusBadge label={projectLabel} variant="muted" size="sm" /> : null}
            {isBlocked ? (
              <StatusBadge label={t("tracker.kanban.blocked")} variant="error" size="sm" />
            ) : null}
          </View>
          {createdAt ? (
            <Text style={styles.dates} numberOfLines={1}>
              {t("tracker.card.created", { time: formatTimeAgo(new Date(createdAt)) })}
            </Text>
          ) : null}
        </View>
      ) : null}
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
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  meta: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
  },
  dates: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundExtraMuted,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  projectChipWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    alignSelf: "flex-start",
  },
  prioP0: {
    color: theme.colors.palette.red[600],
  },
  prioP1: {
    color: theme.colors.palette.orange[600],
  },
  prioP2: {
    color: theme.colors.palette.yellow[600],
  },
  prioP3: {
    color: theme.colors.palette.sky[600],
  },
  prioP4: {
    color: theme.colors.palette.slate[400],
  },
}));
