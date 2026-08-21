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
  /** The summary already on hand from the row/card that opened this sheet —
   * lets the sheet render title/status/priority immediately instead of a
   * spinner, while the full record (children/blockedBy/notes/description)
   * loads in behind it. Omit when there's nothing to seed with. */
  initialSummary?: TrackerSummary | null;
  /** Fires with the mutation's own response after Start/Close/Reopen/Cancel
   * succeeds — the caller patches its shared data hook in place so the view
   * behind this sheet reflects the change without a re-fetch. */
  onMutated?: (tracker: TrackerSummary) => void;
}

type DetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; tracker: TrackerDetail };

// The fields `ait show` adds beyond a summary row are unknown until the real
// fetch resolves — description/children/blockedBy/notes stay empty in the
// placeholder and fill in once `load()`'s background fetch completes.
function placeholderDetailFromSummary(summary: TrackerSummary): TrackerDetail {
  return {
    id: summary.id,
    title: summary.title,
    type: summary.type,
    status: summary.status,
    priority: summary.priority,
    parentId: summary.parentId,
    description: null,
    claimedBy: summary.claimedBy ?? null,
    createdAt: summary.createdAt ?? "",
    updatedAt: summary.updatedAt ?? "",
    closedAt: summary.closedAt ?? null,
    children: [],
    blockedBy: [],
    notes: [],
  };
}

export function TrackerDetailSheet({
  serverId,
  projectId,
  visible,
  trackerId,
  onClose,
  initialSummary,
  onMutated,
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
      initialSummary={initialSummary ?? null}
      onMutated={onMutated}
    />
  );
}

function OpenTrackerDetailSheet({
  serverId,
  projectId,
  trackerId,
  onClose,
  initialSummary,
  onMutated,
}: {
  serverId: string;
  projectId: string;
  trackerId: string;
  onClose: () => void;
  initialSummary: TrackerSummary | null;
  onMutated?: (tracker: TrackerSummary) => void;
}): ReactElement {
  const client = useHostRuntimeClient(serverId);
  const [state, setState] = useState<DetailState>(() =>
    initialSummary
      ? { status: "loaded", tracker: placeholderDetailFromSummary(initialSummary) }
      : { status: "idle" },
  );
  const [noteBody, setNoteBody] = useState("");
  // The root tracker is history[0]; opening a child pushes its id, Back pops.
  // The sheet always shows history[history.length - 1].
  const [history, setHistory] = useState<string[]>([trackerId]);
  const activeTrackerId = history[history.length - 1] ?? trackerId;
  const mutations = useTrackerMutations({ serverId, projectId });

  const load = useCallback(async (): Promise<void> => {
    if (!client) {
      setState({ status: "error", error: "Host disconnected" });
      return;
    }
    // Only drop to the spinner state when there's nothing on screen yet —
    // once something is loaded (the seeded placeholder, a previous fetch, or
    // a sibling from history), a refresh happens behind it instead of
    // flashing a blank spinner over content the user can already see.
    setState((current) => (current.status === "loaded" ? current : { status: "loading" }));
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
    const summary = await mutations.updateTracker({
      trackerId: activeTrackerId,
      status: "in_progress",
    });
    onMutated?.(summary);
    await load();
  }, [activeTrackerId, load, mutations, onMutated]);

  const handleClose = useCallback(async (): Promise<void> => {
    const summary = await mutations.closeTracker({ trackerId: activeTrackerId });
    onMutated?.(summary);
    await load();
  }, [activeTrackerId, load, mutations, onMutated]);

  const handleReopen = useCallback(async (): Promise<void> => {
    const summary = await mutations.reopenTracker(activeTrackerId);
    onMutated?.(summary);
    await load();
  }, [activeTrackerId, load, mutations, onMutated]);

  const handleCancel = useCallback(async (): Promise<void> => {
    const summary = await mutations.cancelTracker({ trackerId: activeTrackerId });
    onMutated?.(summary);
    await load();
  }, [activeTrackerId, load, mutations, onMutated]);

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
    setHistory((current) => [...current, childId]);
  }, []);

  const handleBack = useCallback(() => {
    setHistory((current) => (current.length > 1 ? current.slice(0, -1) : current));
  }, []);

  const canGoBack = history.length > 1;

  const headerTitle = state.status === "loaded" ? state.tracker.id : "Loading…";
  const headerStatus = state.status === "loaded" ? state.tracker.status : null;
  const header = useMemo<SheetHeader>(
    () => ({
      title: headerTitle,
      leading: headerStatus ? <TrackerStatusIcon status={headerStatus} size={18} /> : null,
    }),
    [headerStatus, headerTitle],
  );
  const footer = useMemo(
    () => (canGoBack ? <TrackerDetailBackButton onBack={handleBack} /> : null),
    [canGoBack, handleBack],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      onDismiss={onClose}
      footer={footer}
      footerContainerStyle={styles.footerContainer}
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
  // `closedAt` is only ever set by `ait` for status `closed` — never for `cancelled`.
  const showClosedAt = tracker.status === "closed" && Boolean(tracker.closedAt);

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
      <Text style={styles.dates}>
        {`Created ${formatTimeAgo(new Date(tracker.createdAt))}`}
        {showClosedAt && tracker.closedAt
          ? ` · Closed ${formatTimeAgo(new Date(tracker.closedAt))}`
          : ""}
      </Text>

      {tracker.description ? <Text style={styles.description}>{tracker.description}</Text> : null}

      <TrackerDetailActions
        isOpenOrInProgress={isOpenOrInProgress}
        isOpen={tracker.status === "open"}
        onStart={onStart}
        onClose={onClose}
        onReopen={onReopen}
        onCancel={onCancel}
      />

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

function TrackerDetailBackButton({ onBack }: { onBack: () => void }): ReactElement {
  return (
    <View style={styles.backRow}>
      <Button
        variant="outline"
        size="sm"
        style={styles.backButton}
        onPress={onBack}
        testID="tracker-detail-back"
      >
        Back
      </Button>
    </View>
  );
}

function TrackerDetailActions({
  isOpenOrInProgress,
  isOpen,
  onStart,
  onClose,
  onReopen,
  onCancel,
}: {
  isOpenOrInProgress: boolean;
  isOpen: boolean;
  onStart: () => void;
  onClose: () => void;
  onReopen: () => void;
  onCancel: () => void;
}): ReactElement {
  return (
    <View style={styles.actionsRow}>
      {isOpen ? (
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
  dates: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
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
  footerContainer: {
    borderTopWidth: 0,
    paddingTop: 0,
  },
  backRow: {
    flex: 1,
  },
  backButton: {
    width: "100%",
    minHeight: 38,
  },
}));
