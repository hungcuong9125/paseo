import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TrackerDetail, TrackerSummary } from "@getpaseo/protocol/tracker/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { TrackerStatusIcon, trackerStatusLabel } from "@/components/tracker/tracker-status-icon";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useTrackerMutations } from "@/tracker/use-tracker-mutations";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { formatTimeAgo } from "@/utils/time";
import { toErrorMessage } from "@/utils/error-messages";

export interface TrackerDetailSheetProps {
  serverId: string;
  projectId: string;
  visible: boolean;
  trackerId: string | null;
  onClose: () => void;
}

type DetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; tracker: TrackerDetail };

export function TrackerDetailSheet({
  serverId,
  projectId,
  visible,
  trackerId,
  onClose,
}: TrackerDetailSheetProps): ReactElement | null {
  if (!visible || !trackerId) {
    return null;
  }
  return (
    <OpenTrackerDetailSheet
      key={trackerId}
      serverId={serverId}
      projectId={projectId}
      trackerId={trackerId}
      onClose={onClose}
    />
  );
}

function OpenTrackerDetailSheet({
  serverId,
  projectId,
  trackerId,
  onClose,
}: {
  serverId: string;
  projectId: string;
  trackerId: string;
  onClose: () => void;
}): ReactElement {
  const client = useHostRuntimeClient(serverId);
  const [state, setState] = useState<DetailState>({ status: "idle" });
  const [noteBody, setNoteBody] = useState("");
  const [activeTrackerId, setActiveTrackerId] = useState(trackerId);
  const mutations = useTrackerMutations({ serverId, projectId });

  const load = useCallback(async (): Promise<void> => {
    if (!client) {
      setState({ status: "error", error: "Host disconnected" });
      return;
    }
    setState({ status: "loading" });
    try {
      const tracker = await client.trackerShow({ projectId, trackerId: activeTrackerId });
      setState({ status: "loaded", tracker });
    } catch (error) {
      setState({ status: "error", error: toErrorMessage(error) });
    }
  }, [activeTrackerId, client, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleStart = useCallback(async (): Promise<void> => {
    await mutations.updateTracker({ trackerId: activeTrackerId, status: "in_progress" });
    await load();
  }, [activeTrackerId, load, mutations]);

  const handleClose = useCallback(async (): Promise<void> => {
    await mutations.closeTracker({ trackerId: activeTrackerId });
    await load();
  }, [activeTrackerId, load, mutations]);

  const handleReopen = useCallback(async (): Promise<void> => {
    await mutations.reopenTracker(activeTrackerId);
    await load();
  }, [activeTrackerId, load, mutations]);

  const handleCancel = useCallback(async (): Promise<void> => {
    await mutations.cancelTracker({ trackerId: activeTrackerId });
    await load();
  }, [activeTrackerId, load, mutations]);

  const handleAddNote = useCallback(async (): Promise<void> => {
    const body = noteBody.trim();
    if (!body) {
      return;
    }
    await mutations.addNote({ trackerId: activeTrackerId, body });
    setNoteBody("");
    await load();
  }, [activeTrackerId, load, mutations, noteBody]);

  const handleOpenChild = useCallback((childId: string) => {
    setActiveTrackerId(childId);
  }, []);

  const headerTitle = state.status === "loaded" ? state.tracker.id : "Loading…";
  const headerStatus = state.status === "loaded" ? state.tracker.status : null;
  const header = useMemo<SheetHeader>(
    () => ({
      title: headerTitle,
      leading: headerStatus ? <TrackerStatusIcon status={headerStatus} size={18} /> : null,
    }),
    [headerStatus, headerTitle],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      onDismiss={onClose}
      testID="tracker-detail-sheet"
    >
      {state.status === "loading" || state.status === "idle" ? (
        <View style={styles.centered}>
          <LoadingSpinner size="large" color={styles.spinner.color} />
        </View>
      ) : null}
      {state.status === "error" ? (
        <View style={styles.centered}>
          <Text style={styles.message}>{state.error}</Text>
          <Button variant="ghost" onPress={load} testID="tracker-detail-retry">
            Try again
          </Button>
        </View>
      ) : null}
      {state.status === "loaded" ? (
        <TrackerDetailContent
          tracker={state.tracker}
          noteBody={noteBody}
          onChangeNoteBody={setNoteBody}
          onStart={handleStart}
          onClose={handleClose}
          onReopen={handleReopen}
          onCancel={handleCancel}
          onOpenChild={handleOpenChild}
          onAddNote={handleAddNote}
          isAddingNote={mutations.isAddingNote}
        />
      ) : null}
    </AdaptiveModalSheet>
  );
}

function TrackerDetailContent({
  tracker,
  noteBody,
  onChangeNoteBody,
  onStart,
  onClose,
  onReopen,
  onCancel,
  onOpenChild,
  onAddNote,
  isAddingNote,
}: {
  tracker: TrackerDetail;
  noteBody: string;
  onChangeNoteBody: (value: string) => void;
  onStart: () => void;
  onClose: () => void;
  onReopen: () => void;
  onCancel: () => void;
  onOpenChild: (childId: string) => void;
  onAddNote: () => void;
  isAddingNote: boolean;
}): ReactElement {
  const isOpenOrInProgress = tracker.status === "open" || tracker.status === "in_progress";
  const hasNoteBody = noteBody.trim().length > 0;
  const notes = useMemo(
    () => [...tracker.notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [tracker.notes],
  );

  return (
    <View style={styles.content}>
      <Text
        style={[
          styles.title,
          tracker.status === "in_progress" && styles.titleRunning,
          tracker.status === "closed" && styles.titleClosed,
          tracker.status === "cancelled" && styles.titleCancelled,
        ]}
      >
        {tracker.title}
      </Text>
      <Text style={styles.meta}>
        {trackerStatusLabel(tracker.status)} · {tracker.type} · {tracker.priority}
        {tracker.claimedBy ? ` · claimed by ${tracker.claimedBy}` : ""}
      </Text>

      {tracker.description ? <Text style={styles.description}>{tracker.description}</Text> : null}

      <View style={styles.actionsRow}>
        {tracker.status === "open" ? (
          <Button
            variant="outline"
            size="sm"
            textStyle={styles.actionInProgress}
            hoverStyle={styles.actionInProgressHover}
            onPress={onStart}
            testID="tracker-detail-start"
          >
            Start
          </Button>
        ) : null}
        {isOpenOrInProgress ? (
          <Button
            variant="outline"
            size="sm"
            textStyle={styles.actionClosed}
            hoverStyle={styles.actionClosedHover}
            onPress={onClose}
            testID="tracker-detail-close"
          >
            Close
          </Button>
        ) : null}
        {!isOpenOrInProgress ? (
          <Button
            variant="outline"
            size="sm"
            textStyle={styles.actionOpen}
            hoverStyle={styles.actionOpenHover}
            onPress={onReopen}
            testID="tracker-detail-reopen"
          >
            Reopen
          </Button>
        ) : null}
        {isOpenOrInProgress ? (
          <Button
            variant="ghost"
            size="sm"
            textStyle={styles.actionCancel}
            hoverStyle={styles.actionCancelHover}
            onPress={onCancel}
            testID="tracker-detail-cancel"
          >
            Cancel
          </Button>
        ) : null}
      </View>

      {tracker.children.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Children</Text>
          {tracker.children.map((child) => (
            <ChildTrackerLink key={child.id} child={child} onPress={onOpenChild} />
          ))}
        </View>
      ) : null}

      {tracker.blockedBy.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Blocked by</Text>
          {tracker.blockedBy.map((blocker) => (
            <Text key={blocker.id} style={styles.listItem} numberOfLines={1}>
              {blocker.id} · {blocker.title}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notes</Text>
        {notes.length === 0 ? <Text style={styles.emptyNotes}>No notes yet.</Text> : null}
        {notes.map((note) => (
          <View key={note.id} style={styles.note}>
            <Text style={styles.noteBody}>{note.body}</Text>
            <Text style={styles.noteMeta}>{formatTimeAgo(new Date(note.createdAt))}</Text>
          </View>
        ))}
        <View style={styles.noteComposer}>
          <FormTextInput
            value={noteBody}
            onChangeText={onChangeNoteBody}
            placeholder="Add a note"
            multiline
            testID="tracker-detail-note-input"
          />
          <Button
            variant={hasNoteBody ? "default" : "outline"}
            style={[styles.noteButtonSize, hasNoteBody && styles.addNoteButton]}
            size="sm"
            onPress={onAddNote}
            disabled={!hasNoteBody || isAddingNote}
            loading={isAddingNote}
            testID="tracker-detail-add-note"
          >
            Add note
          </Button>
        </View>
      </View>
    </View>
  );
}

function ChildTrackerLink({
  child,
  onPress,
}: {
  child: TrackerSummary;
  onPress: (childId: string) => void;
}): ReactElement {
  const [hovered, setHovered] = useState(false);
  const handlePress = useCallback(() => onPress(child.id), [child.id, onPress]);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);

  return (
    <Pressable
      accessibilityLabel={`Open child ${child.id}`}
      accessibilityRole="button"
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      onPress={handlePress}
    >
      <View style={styles.childLinkRow}>
        <View style={styles.childLinkIcon}>
          <TrackerStatusIcon status={child.status} size={12} colorize />
        </View>
        <Text style={[styles.listItem, hovered && styles.listItemHovered]} numberOfLines={1}>
          {child.id} · {child.title}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[4],
    padding: theme.spacing[6],
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  content: {
    gap: theme.spacing[3],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  titleRowIcon: {
    paddingTop: 3,
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  // Matches the row/task-list treatment: the icon carries the "running" blue,
  // the title text just goes full-weight foreground (not muted, not tinted).
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
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  description: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  actionsRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  actionOpen: {
    color: theme.colors.palette.blue[600],
  },
  actionInProgress: {
    color: theme.colors.palette.blue[600],
  },
  actionClosed: {
    color: theme.colors.palette.green[600],
  },
  actionOpenHover: {
    borderColor: theme.colors.palette.blue[600],
    backgroundColor: theme.colors.surface2,
  },
  actionInProgressHover: {
    borderColor: theme.colors.palette.blue[600],
    backgroundColor: theme.colors.surface2,
  },
  actionClosedHover: {
    borderColor: theme.colors.palette.green[600],
    backgroundColor: theme.colors.surface2,
  },
  actionCancel: {
    color: theme.colors.statusDanger,
  },
  actionCancelHover: {
    backgroundColor: theme.colors.surface2,
  },
  section: {
    gap: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[3],
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
  },
  listItem: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flex: 1,
  },
  childLinkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  childLinkIcon: {
    marginTop: 3,
  },
  listItemHovered: {
    color: theme.colors.accent,
  },
  emptyNotes: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  note: {
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  noteComposer: {
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  addNoteButton: {
    backgroundColor: theme.colors.palette.green[600],
    borderColor: theme.colors.palette.green[600],
    borderWidth: 1,
  },
  noteButtonSize: {
    paddingVertical: theme.spacing[3],
  },
  noteBody: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  noteMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
