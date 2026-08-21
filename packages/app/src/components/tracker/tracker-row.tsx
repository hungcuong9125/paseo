import {
  CheckCircle2,
  MoreVertical,
  PlayCircle,
  RotateCcw,
  Trash2,
  XCircle,
} from "lucide-react-native";
import { useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TrackerStatusIcon, trackerStatusLabel } from "@/components/tracker/tracker-status-icon";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { formatTimeAgo } from "@/utils/time";

const ThemedPlayCircle = withUnistyles(PlayCircle);
const ThemedCheckCircle2 = withUnistyles(CheckCircle2);
const ThemedRotateCcw = withUnistyles(RotateCcw);
const ThemedXCircle = withUnistyles(XCircle);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedKebab = withUnistyles(MoreVertical);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const MENU_ICON_SIZE = 14;

export interface TrackerRowPending {
  start?: boolean;
  close?: boolean;
  reopen?: boolean;
  cancel?: boolean;
  delete?: boolean;
}

export interface TrackerRowActions {
  onPress: () => void;
  onStart: () => void;
  onClose: () => void;
  onReopen: () => void;
  onCancel: () => void;
  onDelete: () => void;
}

interface TrackerRowProps extends TrackerRowActions {
  tracker: TrackerSummary;
  /** Which project this row belongs to — rendered in the meta line only when
   * the caller is showing more than one project at once (aggregated view). */
  projectLabel?: string | null;
  /** Whether this tracker has any descendants (direct or nested) — decides
   * the delete item's label ("Remove" vs "Delete tree") and whether the
   * mutation needs `cascade`. Always false for tasks (leaves in ait). */
  hasChildren?: boolean;
  /** True while the caller's child-count data may still be an undercount —
   * disables the delete menu item rather than risk offering a non-cascaded
   * delete for something that actually has un-swept children. */
  deleteDisabled?: boolean;
  pending?: TrackerRowPending;
  isFirst: boolean;
}

// Priority severity scale — a monotonic heatmap so the metadata line reads at a
// glance: red (critical) → orange (high) → yellow (normal) → sky (low) → slate
// (nice-to-have). Cooler hues mean lower urgency.
function priorityColorStyle(priority: string) {
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

function statusTextColorStyle(status: TrackerSummary["status"]) {
  switch (status) {
    case "open":
      return styles.statusOpen;
    case "in_progress":
      return styles.statusInProgress;
    case "closed":
      return styles.statusClosed;
    case "cancelled":
      return styles.statusCancelled;
    default:
      return styles.statusDefault;
  }
}

export function TrackerRow({
  tracker,
  projectLabel = null,
  hasChildren = false,
  deleteDisabled = false,
  pending,
  isFirst,
  onPress,
  onStart,
  onClose,
  onReopen,
  onCancel,
  onDelete,
}: TrackerRowProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const showClosedAt = tracker.status === "closed" && Boolean(tracker.closedAt);

  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      settingsStyles.row,
      styles.row,
      !isFirst && settingsStyles.rowBorder,
      isHovered && !isCompact && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isFirst, isHovered, isCompact],
  );

  return (
    <View
      style={styles.rowContainer}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <Pressable
        style={rowStyle}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`Open tracker ${tracker.title}`}
        testID={`tracker-row-${tracker.id}`}
      >
        <View style={styles.main}>
          <View style={styles.statusIcon}>
            <TrackerStatusIcon status={tracker.status} />
          </View>
          <View style={styles.textGroup}>
            <Text
              style={[
                settingsStyles.rowTitle,
                tracker.status === "in_progress" && styles.titleRunning,
                tracker.status === "closed" && styles.titleClosed,
                tracker.status === "cancelled" && styles.titleCancelled,
              ]}
              numberOfLines={1}
            >
              {tracker.title}
            </Text>
            <Text style={settingsStyles.rowHint} numberOfLines={1}>
              <Text>{tracker.id}</Text>
              <Text>{" · "}</Text>
              <Text style={priorityColorStyle(tracker.priority)}>{tracker.priority}</Text>
              {projectLabel ? (
                <>
                  <Text>{" · "}</Text>
                  <Text>{projectLabel}</Text>
                </>
              ) : null}
            </Text>
            {tracker.createdAt ? (
              <Text style={styles.dates} numberOfLines={1}>
                {t("tracker.card.created", { time: formatTimeAgo(new Date(tracker.createdAt)) })}
                {showClosedAt && tracker.closedAt
                  ? ` · ${t("tracker.card.closed", { time: formatTimeAgo(new Date(tracker.closedAt)) })}`
                  : null}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.trailing}>
          <Text style={[styles.statusText, statusTextColorStyle(tracker.status)]}>
            {trackerStatusLabel(tracker.status)}
          </Text>
          <TrackerKebabMenu
            tracker={tracker}
            hasChildren={hasChildren}
            deleteDisabled={deleteDisabled}
            pending={pending}
            onStart={onStart}
            onClose={onClose}
            onReopen={onReopen}
            onCancel={onCancel}
            onDelete={onDelete}
          />
        </View>
      </Pressable>
    </View>
  );
}

const startLeading = <ThemedPlayCircle size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const closeLeading = <ThemedCheckCircle2 size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const reopenLeading = <ThemedRotateCcw size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const cancelLeading = <ThemedXCircle size={MENU_ICON_SIZE} uniProps={destructiveColorMapping} />;
const deleteLeading = <ThemedTrash2 size={MENU_ICON_SIZE} uniProps={destructiveColorMapping} />;

function renderKebabTriggerIcon({ hovered }: { hovered?: boolean }): ReactElement {
  return (
    <ThemedKebab
      size={MENU_ICON_SIZE}
      uniProps={hovered ? foregroundColorMapping : mutedColorMapping}
    />
  );
}

function TrackerKebabMenu({
  tracker,
  hasChildren = false,
  deleteDisabled = false,
  pending,
  onStart,
  onClose,
  onReopen,
  onCancel,
  onDelete,
}: Pick<
  TrackerRowProps,
  | "tracker"
  | "hasChildren"
  | "deleteDisabled"
  | "pending"
  | "onStart"
  | "onClose"
  | "onReopen"
  | "onCancel"
  | "onDelete"
>): ReactElement {
  const isOpenOrInProgress = tracker.status === "open" || tracker.status === "in_progress";
  // Tasks are always leaves in ait, so hasChildren is only ever true for an
  // epic/initiative — "Delete tree" is the short, explicit word for "this
  // also removes every child", matching the plain "Remove" a childless item
  // (task or empty epic/initiative) gets.
  const deleteLabel = hasChildren ? "Delete tree" : "Remove";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={kebabTriggerStyle}
        accessibilityRole={isNative ? "button" : undefined}
        accessibilityLabel="Tracker actions"
        testID={`tracker-kebab-${tracker.id}`}
      >
        {renderKebabTriggerIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={200}>
        {tracker.status === "open" ? (
          <DropdownMenuItem
            leading={startLeading}
            status={pending?.start ? "pending" : "idle"}
            pendingLabel="Starting..."
            onSelect={onStart}
            testID={`tracker-menu-start-${tracker.id}`}
          >
            Start
          </DropdownMenuItem>
        ) : null}
        {isOpenOrInProgress ? (
          <DropdownMenuItem
            leading={closeLeading}
            status={pending?.close ? "pending" : "idle"}
            pendingLabel="Closing..."
            onSelect={onClose}
            testID={`tracker-menu-close-${tracker.id}`}
          >
            Close
          </DropdownMenuItem>
        ) : null}
        {!isOpenOrInProgress ? (
          <DropdownMenuItem
            leading={reopenLeading}
            status={pending?.reopen ? "pending" : "idle"}
            pendingLabel="Reopening..."
            onSelect={onReopen}
            testID={`tracker-menu-reopen-${tracker.id}`}
          >
            Reopen
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        {isOpenOrInProgress ? (
          <DropdownMenuItem
            leading={cancelLeading}
            destructive
            status={pending?.cancel ? "pending" : "idle"}
            pendingLabel="Cancelling..."
            onSelect={onCancel}
            testID={`tracker-menu-cancel-${tracker.id}`}
          >
            Cancel
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          leading={deleteLeading}
          destructive
          disabled={deleteDisabled}
          status={pending?.delete ? "pending" : "idle"}
          pendingLabel="Deleting..."
          onSelect={onDelete}
          testID={`tracker-menu-delete-${tracker.id}`}
        >
          {deleteLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function kebabTriggerStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.kebabTrigger, hovered && styles.kebabTriggerHovered];
}

const styles = StyleSheet.create((theme) => ({
  rowContainer: {
    position: "relative",
  },
  row: {
    gap: theme.spacing[3],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  main: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  statusIcon: {
    justifyContent: "center",
  },
  // Same three-way treatment as TaskListRow: running text goes full
  // foreground (it's the thing happening now); closed/cancelled go muted
  // and struck through; open keeps the row's own default title colour.
  titleRunning: {
    color: theme.colors.foreground,
  },
  titleClosed: {
    color: theme.colors.foregroundExtraMuted,
    textDecorationLine: "line-through",
  },
  titleCancelled: {
    color: theme.colors.statusDanger,
    textDecorationLine: "line-through",
  },
  textGroup: {
    flex: 1,
    minWidth: 0,
  },
  dates: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
    marginTop: theme.spacing[1],
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  statusDefault: {
    color: theme.colors.foregroundMuted,
  },
  statusOpen: {
    color: theme.colors.palette.blue[600],
  },
  statusInProgress: {
    color: theme.colors.palette.amber[700],
  },
  statusClosed: {
    color: theme.colors.palette.green[600],
  },
  statusCancelled: {
    color: theme.colors.foregroundMuted,
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
  kebabTrigger: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  kebabTriggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
