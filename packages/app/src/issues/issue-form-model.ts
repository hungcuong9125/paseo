import type { IssuePriority, IssueType } from "@getpaseo/protocol/issues/types";

export interface IssueFormState {
  serverId: string | null;
  projectId: string | null;
  projectDisplay: string | null;
  title: string;
  issueType: IssueType;
  priority: IssuePriority;
  parentId: string | null;
  parentDisplay: string | null;
  description: string;
  submitError: string | null;
  canSubmit: boolean;
}

export interface IssueFormModel {
  getState(): IssueFormState;
  subscribe(listener: () => void): () => void;
  setProject(serverId: string | null, projectId: string | null, display: string | null): void;
  setTitle(value: string): void;
  setIssueType(value: IssueType): void;
  setPriority(value: IssuePriority): void;
  setParent(id: string | null, display: string | null): void;
  setDescription(value: string): void;
  setSubmitError(error: string | null): void;
  close(): void;
}

export interface IssueFormSeed {
  serverId?: string | null;
  projectId?: string | null;
  projectDisplay?: string | null;
  parentId?: string | null;
  parentDisplay?: string | null;
}

function deriveCanSubmit(state: Omit<IssueFormState, "canSubmit">): boolean {
  return state.title.trim().length > 0 && Boolean(state.serverId) && Boolean(state.projectId);
}

// Locked once a seed pre-selects a project (e.g. opened from a specific
// project's row). Left open ("choose a project" field rendered) when opened
// from an aggregated "all projects" view with no seed project.
export function openIssueForm(seed: IssueFormSeed = {}): IssueFormModel {
  const listeners = new Set<() => void>();
  let state: IssueFormState = {
    serverId: seed.serverId ?? null,
    projectId: seed.projectId ?? null,
    projectDisplay: seed.projectDisplay ?? null,
    title: "",
    issueType: "task",
    priority: "P2",
    parentId: seed.parentId ?? null,
    parentDisplay: seed.parentDisplay ?? null,
    description: "",
    submitError: null,
    canSubmit: false,
  };

  function publish(next: Omit<IssueFormState, "canSubmit">): void {
    state = { ...next, canSubmit: deriveCanSubmit(next) };
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setProject: (serverId, projectId, display) =>
      publish({
        ...state,
        serverId,
        projectId,
        projectDisplay: display,
        // Changing project invalidates any parent picked under the old project.
        parentId: null,
        parentDisplay: null,
      }),
    setTitle: (value) => publish({ ...state, title: value, submitError: null }),
    setIssueType: (value) => publish({ ...state, issueType: value }),
    setPriority: (value) => publish({ ...state, priority: value }),
    setParent: (id, display) => publish({ ...state, parentId: id, parentDisplay: display }),
    setDescription: (value) => publish({ ...state, description: value }),
    setSubmitError: (error) => publish({ ...state, submitError: error }),
    close: () => listeners.clear(),
  };
}
