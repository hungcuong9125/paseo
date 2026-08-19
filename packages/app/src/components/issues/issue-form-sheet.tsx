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
import type { IssuePriority, IssueSummary, IssueType } from "@getpaseo/protocol/issues/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import type { IssueProjectInput } from "@/issues/aggregated-issues";
import { useIssueFormModel } from "@/issues/use-issue-form-model";
import { useIssueMutations } from "@/issues/use-issue-mutations";
import { toErrorMessage } from "@/utils/error-messages";

export interface IssueFormSheetProps {
  projects: IssueProjectInput[];
  visible: boolean;
  onClose: () => void;
  onCreated?: (issue: IssueSummary) => void;
  defaultServerId?: string | null;
  defaultProjectId?: string | null;
  defaultProjectDisplay?: string | null;
  defaultParentId?: string | null;
  defaultParentDisplay?: string | null;
}

const TYPE_OPTIONS: { value: IssueType; label: string; testID: string }[] = [
  { value: "task", label: "Task", testID: "issue-form-type-task" },
  { value: "epic", label: "Epic", testID: "issue-form-type-epic" },
  { value: "initiative", label: "Initiative", testID: "issue-form-type-initiative" },
];

const PRIORITY_OPTIONS: { value: IssuePriority; label: string; testID: string }[] = [
  { value: "P0", label: "P0", testID: "issue-form-priority-p0" },
  { value: "P1", label: "P1", testID: "issue-form-priority-p1" },
  { value: "P2", label: "P2", testID: "issue-form-priority-p2" },
  { value: "P3", label: "P3", testID: "issue-form-priority-p3" },
  { value: "P4", label: "P4", testID: "issue-form-priority-p4" },
];

function projectOptionKey(serverId: string, projectId: string): string {
  return `${serverId}::${projectId}`;
}

// Two-level mount so the sheet's exit animation keeps rendering the form that was open
// when the parent flipped `visible` to false, instead of unmounting mid-animation.
export function IssueFormSheet(props: IssueFormSheetProps): ReactElement | null {
  const [renderedProps, setRenderedProps] = useState<IssueFormSheetProps | null>(() =>
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
    <OpenIssueFormSheet
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

function OpenIssueFormSheet({
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
}: IssueFormSheetProps & { onDismiss: () => void }): ReactElement {
  const model = useIssueFormModel({
    serverId: defaultServerId,
    projectId: defaultProjectId,
    projectDisplay: defaultProjectDisplay,
    parentId: defaultParentId,
    parentDisplay: defaultParentDisplay,
  });
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const { createIssue, isCreating } = useIssueMutations({
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
      const issue = await createIssue({
        title: state.title.trim(),
        issueType: state.issueType,
        priority: state.priority,
        parentId: state.parentId ?? undefined,
        description: state.description.trim() || undefined,
      });
      onCreated?.(issue);
      onClose();
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
    }
  }, [canSubmit, createIssue, model, onClose, onCreated, state]);

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
          testID="issue-form-submit"
        >
          Create
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
      testID="issue-form-sheet"
    >
      <ProjectField
        locked={projectLocked}
        lockedDisplay={state.projectDisplay}
        value={selectedProjectValue}
        selectedDisplay={selectedProjectDisplay}
        options={projectOptions}
        onChange={handleProjectChange}
      />
      <Field label="Title" testID="issue-form-title">
        <FormTextInput
          value={state.title}
          onChangeText={model.setTitle}
          placeholder="What needs doing?"
          autoFocus
        />
      </Field>
      <Field label="Type" testID="issue-form-type">
        <SegmentedControl
          value={state.issueType}
          onValueChange={model.setIssueType}
          options={TYPE_OPTIONS}
        />
      </Field>
      <Field label="Priority" testID="issue-form-priority">
        <SegmentedControl
          value={state.priority}
          onValueChange={model.setPriority}
          options={PRIORITY_OPTIONS}
        />
      </Field>
      {state.parentDisplay ? (
        <Field label="Parent" testID="issue-form-parent">
          <Text style={styles.parentValue}>{state.parentDisplay}</Text>
        </Field>
      ) : null}
      <Field label="Description" testID="issue-form-description">
        <FormTextInput
          value={state.description}
          onChangeText={model.setDescription}
          placeholder="Optional details"
          multiline
        />
      </Field>
      {state.submitError ? (
        <Text style={styles.errorText} testID="issue-form-error">
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
      <Field label="Project" testID="issue-form-project-locked">
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
      testID="issue-form-project"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
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
