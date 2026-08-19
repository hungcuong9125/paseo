import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";
import { describe, expect, it } from "vitest";
import { buildKanbanBoard } from "./kanban-grouping";

function tracker({
  id,
  ...overrides
}: Partial<TrackerSummary> & Pick<TrackerSummary, "id">): TrackerSummary {
  return {
    id,
    title: id,
    type: "task",
    status: "open",
    priority: "P2",
    parentId: null,
    ...overrides,
  };
}

describe("buildKanbanBoard", () => {
  it("builds a flat epic column with children ordered by priority then id", () => {
    const epic = tracker({ id: "proj-E", title: "Editor", type: "epic", priority: "P1" });
    const model = buildKanbanBoard([
      tracker({ id: "proj-E.2", parentId: epic.id, priority: "P2" }),
      epic,
      tracker({ id: "proj-E.3", parentId: epic.id, priority: "P0" }),
      tracker({ id: "proj-E.1", parentId: epic.id, priority: "P2" }),
    ]);

    expect(model.activeColumns).toHaveLength(1);
    expect(model.activeColumns[0]).toMatchObject({
      kind: "epic",
      id: epic.id,
      title: "Editor",
      completed: false,
      childCount: 3,
      doneCount: 0,
      subColumns: [],
    });
    expect(
      model.activeColumns[0]?.children.map(({ tracker: child, depth }) => [child.id, depth]),
    ).toEqual([
      ["proj-E.3", 0],
      ["proj-E.1", 0],
      ["proj-E.2", 0],
    ]);
    expect(model.completedColumns).toEqual([]);
    expect(model.allClear).toBe(false);
  });

  it("splits a nested epic into General and direct-child sub-columns", () => {
    const epic = tracker({ id: "proj-E", title: "Editor", type: "epic" });
    const group = tracker({ id: "proj-E.2", title: "Keyboard", parentId: epic.id });
    const model = buildKanbanBoard([
      epic,
      group,
      tracker({ id: "proj-E.1", title: "Loose task", parentId: epic.id, priority: "P0" }),
      tracker({ id: "proj-E.2.2", parentId: group.id, priority: "P2" }),
      tracker({
        id: "proj-E.2.1",
        parentId: group.id,
        priority: "P1",
        status: "closed",
      }),
      tracker({ id: "proj-E.2.1.1", parentId: "proj-E.2.1", priority: "P0" }),
    ]);

    const column = model.activeColumns[0];
    expect(column?.children).toEqual([]);
    expect(column?.subColumns.map(({ title }) => title)).toEqual(["General", "Keyboard"]);
    expect(column?.subColumns[0]?.children.map(({ tracker: child }) => child.id)).toEqual([
      "proj-E.1",
    ]);
    expect(
      column?.subColumns[1]?.children.map(({ tracker: child, depth, childCount, doneCount }) => [
        child.id,
        depth,
        childCount,
        doneCount,
      ]),
    ).toEqual([
      ["proj-E.2.1", 0, 1, 0],
      ["proj-E.2.1.1", 1, 0, 0],
      ["proj-E.2.2", 0, 0, 0],
    ]);
    expect(column).toMatchObject({ childCount: 5, doneCount: 1, completed: false });
  });

  it("groups epics under initiatives and marks completed initiative sections quiet", () => {
    const activeInitiative = tracker({
      id: "proj-I1",
      title: "Active initiative",
      type: "initiative",
      priority: "P0",
    });
    const quietInitiative = tracker({
      id: "proj-I2",
      title: "Quiet initiative",
      type: "initiative",
    });
    const emptyInitiative = tracker({
      id: "proj-I3",
      title: "Fresh initiative",
      type: "initiative",
      priority: "P3",
    });
    const activeEpic = tracker({
      id: "proj-E1",
      title: "Active epic",
      type: "epic",
      parentId: activeInitiative.id,
    });
    const completedEpic = tracker({
      id: "proj-E2",
      title: "Completed epic",
      type: "epic",
      parentId: activeInitiative.id,
      status: "closed",
    });
    const quietEpic = tracker({
      id: "proj-E3",
      title: "Quiet epic",
      type: "epic",
      parentId: quietInitiative.id,
      status: "cancelled",
    });

    const model = buildKanbanBoard([
      activeInitiative,
      quietInitiative,
      emptyInitiative,
      completedEpic,
      activeEpic,
      quietEpic,
    ]);

    expect(model.activeColumns).toEqual([]);
    expect(model.completedColumns).toEqual([]);
    expect(model.initiativeSections).toHaveLength(3);
    expect(model.initiativeSections[0]).toMatchObject({
      initiative: { id: activeInitiative.id },
      quiet: false,
      activeColumns: [{ id: activeEpic.id }],
      completedColumns: [{ id: completedEpic.id }],
    });
    expect(model.initiativeSections[1]).toMatchObject({
      initiative: { id: quietInitiative.id },
      quiet: true,
      activeColumns: [],
      completedColumns: [{ id: quietEpic.id }],
    });
    expect(model.initiativeSections[2]).toMatchObject({
      initiative: { id: emptyInitiative.id },
      quiet: false,
      activeColumns: [],
      completedColumns: [],
    });
    expect(model.allClear).toBe(false);
  });

  it("adds orphan task trees to an appended Standalone column", () => {
    const epic = tracker({ id: "proj-E", type: "epic", priority: "P0" });
    const epicTask = tracker({ id: "proj-E.1", parentId: epic.id });
    const standaloneRoot = tracker({ id: "proj-T", priority: "P2" });
    const standaloneChild = tracker({
      id: "proj-T.1",
      parentId: standaloneRoot.id,
      priority: "P0",
      status: "cancelled",
    });
    const missingParent = tracker({ id: "proj-O", parentId: "missing", priority: "P0" });

    const model = buildKanbanBoard([
      epic,
      epicTask,
      tracker({ id: "proj-E.1.1", parentId: epicTask.id }),
      standaloneRoot,
      standaloneChild,
      missingParent,
    ]);

    expect(model.standalone).toMatchObject({
      kind: "standalone",
      title: "Standalone",
      childCount: 3,
      doneCount: 1,
    });
    expect(
      model.standalone?.children.map(({ tracker: child, depth }) => [child.id, depth]),
    ).toEqual([
      ["proj-O", 0],
      ["proj-T", 0],
      ["proj-T.1", 1],
    ]);
    expect(model.activeColumns.map(({ id }) => id)).toEqual([epic.id, "standalone"]);
  });

  it("demotes an epic when all of its descendant tasks are done", () => {
    const epic = tracker({ id: "proj-E", title: "Release", type: "epic" });
    const model = buildKanbanBoard([
      epic,
      tracker({ id: "proj-E.1", parentId: epic.id, status: "closed" }),
      tracker({ id: "proj-E.2", parentId: epic.id, status: "cancelled" }),
    ]);

    expect(model.activeColumns).toEqual([]);
    expect(model.completedColumns).toHaveLength(1);
    expect(model.completedColumns[0]).toMatchObject({
      id: epic.id,
      completed: true,
      childCount: 2,
      doneCount: 2,
    });
  });

  it("reports all clear only for a non-empty board with no active work", () => {
    const completedEpic = tracker({ id: "proj-E", type: "epic", status: "closed" });

    expect(buildKanbanBoard([completedEpic]).allClear).toBe(true);
    expect(buildKanbanBoard([])).toMatchObject({ allClear: false, empty: true });
  });

  it("bounds malformed ancestor cycles and keeps their tasks standalone", () => {
    const first = tracker({ id: "proj-T1", parentId: "proj-T2", priority: "P0" });
    const second = tracker({ id: "proj-T2", parentId: "proj-T1", priority: "P1" });

    const model = buildKanbanBoard([second, first]);

    expect(model.standalone?.children.map(({ tracker: child }) => child.id)).toEqual([
      first.id,
      second.id,
    ]);
  });
});
