import { useCallback, useMemo, useState, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { IssueRow, type IssueRowPending } from "@/components/issues/issue-row";
import type { AggregatedIssue } from "@/issues/aggregated-issues";
import { useIssueMutations } from "@/issues/use-issue-mutations";
import { settingsStyles } from "@/styles/settings";

interface IssuesTableProps {
  issues: AggregatedIssue[];
  showProjectLabel: boolean;
  onOpenIssue: (issue: AggregatedIssue) => void;
}

/**
 * The issues list: a single settings-style card of rows sorted by hierarchical
 * ID within each project, so an epic and its children cluster together the way
 * `ait`'s own IDs already encode the tree (`proj-abc`, `proj-abc.1`, `proj-abc.1.1`).
 * Rows carry their own `serverId`/`projectId` (from the aggregated fetch), so this
 * table works identically whether it's showing one project or every project.
 */
export function IssuesTable({
  issues,
  showProjectLabel,
  onOpenIssue,
}: IssuesTableProps): ReactElement {
  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const issue of issues) {
      map.set(`${issue.projectId}:${issue.id}`, issue.title);
    }
    return map;
  }, [issues]);

  const sortedIssues = useMemo(
    () =>
      [...issues].sort(
        (a, b) => a.projectId.localeCompare(b.projectId) || a.id.localeCompare(b.id),
      ),
    [issues],
  );

  return (
    <View style={styles.listContent} testID="issues-table">
      <View style={settingsStyles.card}>
        {sortedIssues.map((issue, index) => (
          <IssuesTableRow
            key={`${issue.serverId}:${issue.projectId}:${issue.id}`}
            issue={issue}
            parentTitle={
              issue.parentId
                ? (titleById.get(`${issue.projectId}:${issue.parentId}`) ?? null)
                : null
            }
            projectLabel={showProjectLabel ? issue.projectName : null}
            isFirst={index === 0}
            onOpenIssue={onOpenIssue}
          />
        ))}
      </View>
    </View>
  );
}

const NO_PENDING: IssueRowPending = {};

function IssuesTableRow({
  issue,
  parentTitle,
  projectLabel,
  isFirst,
  onOpenIssue,
}: {
  issue: AggregatedIssue;
  parentTitle: string | null;
  projectLabel: string | null;
  isFirst: boolean;
  onOpenIssue: (issue: AggregatedIssue) => void;
}): ReactElement {
  const mutations = useIssueMutations({ serverId: issue.serverId, projectId: issue.projectId });
  const [pending, setPending] = useState<IssueRowPending>(NO_PENDING);

  const runAction = useCallback(
    async (key: keyof IssueRowPending, action: () => Promise<unknown>): Promise<void> => {
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

  const handlePress = useCallback(() => onOpenIssue(issue), [onOpenIssue, issue]);

  const handleStart = useCallback(() => {
    void runAction("start", () =>
      mutations.updateIssue({ issueId: issue.id, status: "in_progress" }),
    );
  }, [runAction, mutations, issue.id]);

  const handleClose = useCallback(() => {
    void runAction("close", () => mutations.closeIssue({ issueId: issue.id }));
  }, [runAction, mutations, issue.id]);

  const handleReopen = useCallback(() => {
    void runAction("reopen", () => mutations.reopenIssue(issue.id));
  }, [runAction, mutations, issue.id]);

  const handleCancel = useCallback(() => {
    void runAction("cancel", () => mutations.cancelIssue({ issueId: issue.id }));
  }, [runAction, mutations, issue.id]);

  return (
    <IssueRow
      issue={issue}
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
