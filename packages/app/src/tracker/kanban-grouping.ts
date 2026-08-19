import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";

const MAX_TREE_DEPTH = 32;

export interface KanbanItem {
  tracker: TrackerSummary;
  depth: number;
  hasChildren: boolean;
  childCount: number;
  doneCount: number;
}

export interface KanbanSubColumn {
  id: string;
  title: string;
  groupTracker: TrackerSummary | null;
  children: KanbanItem[];
}

export interface KanbanEpicColumn {
  kind: "epic";
  id: string;
  title: string;
  tracker: TrackerSummary;
  children: KanbanItem[];
  subColumns: KanbanSubColumn[];
  completed: boolean;
  childCount: number;
  doneCount: number;
}

export interface KanbanStandaloneColumn {
  kind: "standalone";
  id: "standalone";
  title: "Standalone";
  tracker: null;
  children: KanbanItem[];
  subColumns: [];
  completed: false;
  childCount: number;
  doneCount: number;
}

export type KanbanColumn = KanbanEpicColumn | KanbanStandaloneColumn;

export interface KanbanInitiativeSection {
  initiative: TrackerSummary;
  activeColumns: KanbanEpicColumn[];
  completedColumns: KanbanEpicColumn[];
  quiet: boolean;
}

export interface KanbanBoardModel {
  initiativeSections: KanbanInitiativeSection[];
  activeColumns: KanbanColumn[];
  completedColumns: KanbanEpicColumn[];
  standalone: KanbanStandaloneColumn | null;
  allClear: boolean;
  empty: boolean;
}

function isDone(tracker: TrackerSummary): boolean {
  return tracker.status === "closed" || tracker.status === "cancelled";
}

function compareTrackers(left: TrackerSummary, right: TrackerSummary): number {
  return left.priority.localeCompare(right.priority) || left.id.localeCompare(right.id);
}

export function buildKanbanBoard(trackers: TrackerSummary[]): KanbanBoardModel {
  const trackerMap = new Map(trackers.map((tracker) => [tracker.id, tracker]));
  const childrenOf = new Map<string, TrackerSummary[]>();
  for (const tracker of trackers) {
    if (!tracker.parentId) {
      continue;
    }
    const children = childrenOf.get(tracker.parentId) ?? [];
    children.push(tracker);
    childrenOf.set(tracker.parentId, children);
  }
  for (const children of childrenOf.values()) {
    children.sort(compareTrackers);
  }

  const descendantStats = (parentId: string, ancestors = new Set<string>(), depth = 0) => {
    if (depth >= MAX_TREE_DEPTH || ancestors.has(parentId)) {
      return { childCount: 0, doneCount: 0 };
    }
    const nextAncestors = new Set(ancestors).add(parentId);
    let childCount = 0;
    let doneCount = 0;
    for (const child of childrenOf.get(parentId) ?? []) {
      childCount += 1;
      doneCount += isDone(child) ? 1 : 0;
      const nested = descendantStats(child.id, nextAncestors, depth + 1);
      childCount += nested.childCount;
      doneCount += nested.doneCount;
    }
    return { childCount, doneCount };
  };

  const flatten = (
    roots: TrackerSummary[],
    startDepth = 0,
    ancestors = new Set<string>(),
  ): KanbanItem[] => {
    const result: KanbanItem[] = [];
    const visit = (current: TrackerSummary, depth: number, path: Set<string>) => {
      if (depth - startDepth >= MAX_TREE_DEPTH || path.has(current.id)) {
        return;
      }
      const stats = descendantStats(current.id, path);
      result.push({
        tracker: current,
        depth,
        hasChildren: stats.childCount > 0,
        ...stats,
      });
      const nextPath = new Set(path).add(current.id);
      for (const child of childrenOf.get(current.id) ?? []) {
        visit(child, depth + 1, nextPath);
      }
    };
    for (const root of [...roots].sort(compareTrackers)) {
      visit(root, startDepth, ancestors);
    }
    return result;
  };

  const columns = trackers
    .filter((tracker) => tracker.type === "epic")
    .sort(compareTrackers)
    .map<KanbanEpicColumn>((epic) => {
      const directChildren = childrenOf.get(epic.id) ?? [];
      const allChildren = flatten(directChildren);
      const taskChildren = allChildren.filter(({ tracker }) => tracker.type === "task");
      const doneCount = taskChildren.filter(({ tracker }) => isDone(tracker)).length;
      const hasSubGroups = directChildren.some(
        (child) => (childrenOf.get(child.id)?.length ?? 0) > 0,
      );
      const subColumns: KanbanSubColumn[] = [];
      let children = allChildren;

      if (hasSubGroups) {
        children = [];
        const generalChildren = directChildren.filter(
          (child) => (childrenOf.get(child.id)?.length ?? 0) === 0,
        );
        if (generalChildren.length > 0) {
          subColumns.push({
            id: `${epic.id}:general`,
            title: "General",
            groupTracker: null,
            children: flatten(generalChildren),
          });
        }
        for (const group of directChildren) {
          const groupChildren = childrenOf.get(group.id) ?? [];
          if (groupChildren.length === 0) {
            continue;
          }
          subColumns.push({
            id: group.id,
            title: group.title,
            groupTracker: group,
            children: flatten(groupChildren),
          });
        }
      }

      return {
        kind: "epic",
        id: epic.id,
        title: epic.title,
        tracker: epic,
        children,
        subColumns,
        completed: isDone(epic) || (taskChildren.length > 0 && doneCount === taskChildren.length),
        childCount: taskChildren.length,
        doneCount,
      };
    });
  const columnByEpicId = new Map(columns.map((column) => [column.id, column]));
  const initiatives = trackers
    .filter((tracker) => tracker.type === "initiative")
    .sort(compareTrackers);
  const initiativeIds = new Set(initiatives.map((initiative) => initiative.id));
  const initiativeSections = initiatives.map<KanbanInitiativeSection>((initiative) => {
    const initiativeColumns = (childrenOf.get(initiative.id) ?? [])
      .filter((tracker) => tracker.type === "epic")
      .map((epic) => columnByEpicId.get(epic.id))
      .filter((column): column is KanbanEpicColumn => column !== undefined);
    const activeColumns = initiativeColumns.filter((column) => !column.completed);
    const completedColumns = initiativeColumns.filter((column) => column.completed);
    return {
      initiative,
      activeColumns,
      completedColumns,
      quiet:
        isDone(initiative) ||
        (initiativeColumns.length > 0 && completedColumns.length === initiativeColumns.length),
    };
  });
  const topLevelColumns = columns.filter(
    (column) => !column.tracker.parentId || !initiativeIds.has(column.tracker.parentId),
  );
  const activeColumns: KanbanColumn[] = topLevelColumns.filter((column) => !column.completed);
  const completedColumns = topLevelColumns.filter((column) => column.completed);
  const hasEpicAncestor = (task: TrackerSummary): boolean => {
    let parentId = task.parentId;
    const seen = new Set<string>();
    for (let depth = 0; parentId && depth < MAX_TREE_DEPTH; depth += 1) {
      if (seen.has(parentId)) {
        return false;
      }
      seen.add(parentId);
      const parent = trackerMap.get(parentId);
      if (!parent) {
        return false;
      }
      if (parent.type === "epic") {
        return true;
      }
      parentId = parent.parentId;
    }
    return false;
  };
  const standaloneTrackers = trackers
    .filter((tracker) => tracker.type === "task" && !hasEpicAncestor(tracker))
    .sort(compareTrackers);
  const standaloneIds = new Set(standaloneTrackers.map((tracker) => tracker.id));
  const standaloneItems: KanbanItem[] = [];
  const displayedStandaloneIds = new Set<string>();
  const visitStandalone = (current: TrackerSummary, depth: number, path: Set<string>) => {
    if (depth >= MAX_TREE_DEPTH || path.has(current.id) || displayedStandaloneIds.has(current.id)) {
      return;
    }
    displayedStandaloneIds.add(current.id);
    const stats = descendantStats(current.id, path);
    standaloneItems.push({
      tracker: current,
      depth,
      hasChildren: stats.childCount > 0,
      ...stats,
    });
    const nextPath = new Set(path).add(current.id);
    for (const child of childrenOf.get(current.id) ?? []) {
      if (standaloneIds.has(child.id)) {
        visitStandalone(child, depth + 1, nextPath);
      }
    }
  };
  const standaloneRoots = standaloneTrackers.filter(
    (tracker) => !tracker.parentId || !standaloneIds.has(tracker.parentId),
  );
  for (const root of standaloneRoots) {
    visitStandalone(root, 0, new Set());
  }
  for (const remaining of standaloneTrackers) {
    visitStandalone(remaining, 0, new Set());
  }
  const standalone: KanbanStandaloneColumn | null =
    standaloneItems.length > 0
      ? {
          kind: "standalone",
          id: "standalone",
          title: "Standalone",
          tracker: null,
          children: standaloneItems,
          subColumns: [],
          completed: false,
          childCount: standaloneItems.length,
          doneCount: standaloneItems.filter(({ tracker }) => isDone(tracker)).length,
        }
      : null;
  if (standalone) {
    activeColumns.push(standalone);
  }
  const hasActiveInitiativeColumn = initiativeSections.some(
    (section) => section.activeColumns.length > 0,
  );
  const hasVisibleEmptyInitiative = initiativeSections.some(
    (section) =>
      !section.quiet && section.activeColumns.length === 0 && section.completedColumns.length === 0,
  );

  return {
    initiativeSections,
    activeColumns,
    completedColumns,
    standalone,
    allClear:
      (columns.length > 0 || initiatives.length > 0) &&
      activeColumns.length === 0 &&
      standalone === null &&
      !hasActiveInitiativeColumn &&
      !hasVisibleEmptyInitiative,
    empty: trackers.length === 0,
  };
}
