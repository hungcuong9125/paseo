import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  TrackerPriority,
  TrackerSummary,
  TrackerType,
} from "@getpaseo/protocol/tracker/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import type { TrackerProjectInput } from "@/tracker/aggregated-trackers";
import { useTrackerFormModel } from "@/tracker/use-tracker-form-model";
import { useTrackerMutations } from "@/tracker/use-tracker-mutations";
import { toErrorMessage } from "@/utils/error-messages";

export interface TrackerFormSheetProps {
  projects: TrackerProjectInput[];
  visible: boolean;
  onClose: () => void;
  /** Fires with the created tracker and the project it was actually created
   * under — the project field the form settled on, which may differ from
   * `defaultProjectId` when the picker is unlocked. */
  onCreated?: (tracker: TrackerSummary, project: TrackerProjectInput) => void;
  defaultServerId?: string | null;
  defaultProjectId?: string | null;
  defaultProjectDisplay?: string | null;
  defaultParentId?: string | null;
  defaultParentDisplay?: string | null;
}

const TYPE_OPTIONS: { value: TrackerType; label: string; testID: string }[] = [
  { value: "task", label: "Task", testID: "tracker-form-type-task" },
  { value: "epic", label: "Epic", testID: "tracker-form-type-epic" },
  { value: "initiative", label: "Initiative", testID: "tracker-form-type-initiative" },
];

const PRIORITY_OPTIONS: { value: TrackerPriority; label: string; testID: string }[] = [
  { value: "P0", label: "P0", testID: "tracker-form-priority-p0" },
  { value: "P1", label: "P1", testID: "tracker-form-priority-p1" },
  { value: "P2", label: "P2", testID: "tracker-form-priority-p2" },
  { value: "P3", label: "P3", testID: "tracker-form-priority-p3" },
  { value: "P4", label: "P4", testID: "tracker-form-priority-p4" },
];

function projectOptionKey(serverId: string, projectId: string): string {
  return `${serverId}::${projectId}`;
}

// Two-level mount so the sheet's exit animation keeps rendering the form that was open
// when the parent flipped `visible` to false, instead of unmounting mid-animation.
export function TrackerFormSheet(props: TrackerFormSheetProps): ReactElement | null {
  const [renderedProps, setRenderedProps] = useState<TrackerFormSheetProps | null>(() =>
    props.visible ? props : null,
  );
  const [sheetVisible, setSheetVisible] = useState(props.visible);
  const livePropsRef = useRef(props);
  const closeRequestedRef = useRef(false);
  livePropsRef.current = props;

  useEffect(() => {
    if (props.visible) {
      if (closeRequestedRef.current) {
        return;
      }
      setRenderedProps(props);
      setSheetVisible(true);
      return;
    }
    if (renderedProps) {
      setSheetVisible(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible]);

  const requestClose = useCallback(() => {
    closeRequestedRef.current = true;
    setSheetVisible(false);
  }, []);

  const handleDismiss = useCallback(() => {
    const dismissedProps = livePropsRef.current;
    closeRequestedRef.current = false;
    setRenderedProps(null);
    setSheetVisible(false);
    if (dismissedProps.visible) {
      dismissedProps.onClose();
    }
  }, []);

  if (!renderedProps) {
    return null;
  }

  return (
    <OpenTrackerFormSheet
      key={
        renderedProps.defaultProjectId
          ? `${renderedProps.defaultServerId}:${renderedProps.defaultProjectId}:${renderedProps.defaultParentId ?? "root"}`
          : "unscoped"
      }
      {...renderedProps}
      visible={sheetVisible}
      onClose={requestClose}
      onDismiss={handleDismiss}
    />
  );
}

function OpenTrackerFormSheet({
  projects,
  visible,
  onClose,
  onDismiss,
  onCreated,
  defaultServerId,
  defaultProjectId,
  defaultProjectDisplay,
  defaultParentId,
  defaultParentDisplay,
}: TrackerFormSheetProps & { onDismiss: () => void }): ReactElement {
  const model = useTrackerFormModel({
    serverId: defaultServerId,
    projectId: defaultProjectId,
    projectDisplay: defaultProjectDisplay,
    parentId: defaultParentId,
    parentDisplay: defaultParentDisplay,
  });
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const { createTracker, isCreating } = useTrackerMutations({
    serverId: state.serverId ?? "",
    projectId: state.projectId ?? "",
  });

  const projectLocked = Boolean(defaultProjectId);
  const projectOptions = useMemo(
    () =>
      projects.map((project) => ({
        id: projectOptionKey(project.serverId, project.projectId),
        value: projectOptionKey(project.serverId, project.projectId),
        label: project.projectName,
        description: project.serverName,
      })),
    [projects],
  );
  const selectedProjectValue =
    state.serverId && state.projectId ? projectOptionKey(state.serverId, state.projectId) : null;
  const selectedProjectDisplay = useMemo(
    () => (state.projectDisplay ? { label: state.projectDisplay } : null),
    [state.projectDisplay],
  );
  const handleProjectChange = useCallback(
    (value: string) => {
      const project = projects.find((p) => projectOptionKey(p.serverId, p.projectId) === value);
      if (project) {
        model.setProject(project.serverId, project.projectId, project.projectName);
      }
    },
    [model, projects],
  );

  const canSubmit = state.canSubmit && !isCreating;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }
    model.setSubmitError(null);
    try {
      const tracker = await createTracker({
        title: state.title.trim(),
        trackerType: state.trackerType,
        priority: state.priority,
        parentId: state.parentId ?? undefined,
        description: state.description.trim() || undefined,
      });
      const project = projects.find(
        (candidate) =>
          candidate.serverId === state.serverId && candidate.projectId === state.projectId,
      );
      if (project) {
        onCreated?.(tracker, project);
      }
      onClose();
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
    }
  }, [canSubmit, createTracker, model, onClose, onCreated, projects, state]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const header = useMemo<SheetHeader>(() => ({ title: "New item" }), []);

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={isCreating}
        >
          Cancel
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSubmitPress}
          disabled={!canSubmit}
          loading={isCreating}
          testID="tracker-form-submit"
        >
          Create item
        </Button>
      </View>
    ),
    [canSubmit, handleSubmitPress, isCreating, onClose],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      footer={footer}
      testID="tracker-form-sheet"
    >
      <ProjectField
        locked={projectLocked}
        lockedDisplay={state.projectDisplay}
        value={selectedProjectValue}
        selectedDisplay={selectedProjectDisplay}
        options={projectOptions}
        onChange={handleProjectChange}
      />
      <Field label="Title" testID="tracker-form-title">
        <FormTextInput
          initialValue={state.title}
          onChangeText={model.setTitle}
          placeholder="What needs doing?"
          autoFocus
        />
      </Field>
      <Field label="Type" testID="tracker-form-type">
        <SegmentedControl
          value={state.trackerType}
          onValueChange={model.setTrackerType}
          options={TYPE_OPTIONS}
        />
      </Field>
      <Field label="Priority" testID="tracker-form-priority">
        <SegmentedControl
          value={state.priority}
          onValueChange={model.setPriority}
          options={PRIORITY_OPTIONS}
        />
      </Field>
      {state.parentDisplay ? (
        <Field label="Parent" testID="tracker-form-parent">
          <Text style={styles.parentValue}>{state.parentDisplay}</Text>
        </Field>
      ) : null}
      <Field label="Description" testID="tracker-form-description">
        <FormTextInput
          initialValue={state.description}
          onChangeText={model.setDescription}
          placeholder="Optional details"
          multiline
        />
      </Field>
      {state.submitError ? (
        <Text style={styles.errorText} testID="tracker-form-error">
          {state.submitError}
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

function ProjectField({
  locked,
  lockedDisplay,
  value,
  selectedDisplay,
  options,
  onChange,
}: {
  locked: boolean;
  lockedDisplay: string | null;
  value: string | null;
  selectedDisplay: SelectFieldDisplay | null;
  options: SelectFieldOption<string>[];
  onChange: (value: string) => void;
}): ReactElement | null {
  if (locked) {
    if (!lockedDisplay) {
      return null;
    }
    return (
      <Field label="Project" testID="tracker-form-project-locked">
        <Text style={styles.parentValue}>{lockedDisplay}</Text>
      </Field>
    );
  }
  return (
    <SelectField
      label="Project"
      value={value}
      selectedDisplay={selectedDisplay}
      options={options}
      onChange={onChange}
      placeholder="Choose a project"
      emptyText="No projects available"
      testID="tracker-form-project"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  footerButton: {
    flex: 1,
  },
  parentValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));
