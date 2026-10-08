import type { TrackerPriority, TrackerType } from "@getpaseo/protocol/tracker/types";

export interface TrackerFormState {
  serverId: string | null;
  projectId: string | null;
  projectDisplay: string | null;
  title: string;
  trackerType: TrackerType;
  priority: TrackerPriority;
  parentId: string | null;
  parentDisplay: string | null;
  description: string;
  submitError: string | null;
  canSubmit: boolean;
}

export interface TrackerFormModel {
  getState(): TrackerFormState;
  subscribe(listener: () => void): () => void;
  setProject(serverId: string | null, projectId: string | null, display: string | null): void;
  setTitle(value: string): void;
  setTrackerType(value: TrackerType): void;
  setPriority(value: TrackerPriority): void;
  setParent(id: string | null, display: string | null): void;
  setDescription(value: string): void;
  setSubmitError(error: string | null): void;
  close(): void;
}

export interface TrackerFormSeed {
  serverId?: string | null;
  projectId?: string | null;
  projectDisplay?: string | null;
  parentId?: string | null;
  parentDisplay?: string | null;
}

function deriveCanSubmit(state: Omit<TrackerFormState, "canSubmit">): boolean {
  return state.title.trim().length > 0 && Boolean(state.serverId) && Boolean(state.projectId);
}

// Locked once a seed pre-selects a project (e.g. opened from a specific
// project's row). Left open ("choose a project" field rendered) when opened
// from an aggregated "all projects" view with no seed project.
export function openTrackerForm(seed: TrackerFormSeed = {}): TrackerFormModel {
  const listeners = new Set<() => void>();
  let state: TrackerFormState = {
    serverId: seed.serverId ?? null,
    projectId: seed.projectId ?? null,
    projectDisplay: seed.projectDisplay ?? null,
    title: "",
    trackerType: "task",
    priority: "P2",
    parentId: seed.parentId ?? null,
    parentDisplay: seed.parentDisplay ?? null,
    description: "",
    submitError: null,
    canSubmit: false,
  };

  function publish(next: Omit<TrackerFormState, "canSubmit">): void {
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
    setTrackerType: (value) => publish({ ...state, trackerType: value }),
    setPriority: (value) => publish({ ...state, priority: value }),
    setParent: (id, display) => publish({ ...state, parentId: id, parentDisplay: display }),
    setDescription: (value) => publish({ ...state, description: value }),
    setSubmitError: (error) => publish({ ...state, submitError: error }),
    close: () => listeners.clear(),
  };
}
