import { access } from "node:fs/promises";
import { join } from "node:path";
import type { TrackerErrorCode, TrackerStatsCounts } from "@getpaseo/protocol/tracker/rpc-schemas";
import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";
import { AitCliError, type AitService } from "../services/ait-cli-service.js";
import {
  createFileObserver,
  type FileObserver,
  type FileObserverSubscription,
} from "./file-observer/index.js";
import { resolveAitRootPath } from "./ait-init-status.js";
import type { ProjectRegistry } from "./workspace-registry.js";

export interface TrackerSnapshot {
  trackers: TrackerSummary[];
  hiddenCount: number;
  epoch: number;
  generation: number;
  error: string | null;
  errorCode: TrackerErrorCode | null;
}

export interface TrackerSyncManagerOptions {
  aitService: AitService;
  projectRegistry: Pick<ProjectRegistry, "get">;
  fileObserver?: FileObserver;
  directoryExists?: (directory: string) => Promise<boolean>;
  aitDatabaseExists?: (rootPath: string) => Promise<boolean>;
  onAitInitializedChanged?: (projectId: string) => void | Promise<void>;
}

export type TrackerSnapshotListener = (snapshot: TrackerSnapshot, projectId: string) => void;

interface ProjectNotFoundError extends Error {
  readonly trackerErrorCode: "not_found";
}

const DEBOUNCE_MS = 150;
const MAX_DEBOUNCE_MS = 1_000;
const UNINITIALISED_PROBE_MS = 5_000;
const WATCH_RETRY_MS = 10_000;
export const MAX_TREE_DEPTH = 32;
// Keep one screen load's sequential project reads on the same watched snapshot,
// while bounding idle watcher lifetime for projects nobody is looking at.
export const TRACKER_ROOT_IDLE_TTL_MS = 5_000;

type TrackerStatsBucket = TrackerStatsCounts["all"];

function emptyTrackerStatsBucket(): TrackerStatsBucket {
  return {
    total: 0,
    byStatus: { open: 0, in_progress: 0, closed: 0, cancelled: 0 },
    byPriority: { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 },
  };
}

export function getTrackerStatsCounts(trackers: readonly TrackerSummary[]): TrackerStatsCounts {
  const counts: TrackerStatsCounts = {
    all: emptyTrackerStatsBucket(),
    task: emptyTrackerStatsBucket(),
    epic: emptyTrackerStatsBucket(),
    initiative: emptyTrackerStatsBucket(),
  };
  for (const tracker of trackers) {
    const buckets: Array<keyof TrackerStatsCounts> = ["all", tracker.type];
    for (const bucketName of buckets) {
      const bucket = counts[bucketName];
      bucket.total += 1;
      bucket.byStatus[tracker.status] += 1;
      bucket.byPriority[tracker.priority] += 1;
    }
  }
  return counts;
}

export function withTrackerSubtreeStats(
  trackers: readonly TrackerSummary[],
  snapshot: readonly TrackerSummary[] = trackers,
): TrackerSummary[] {
  const childrenOf = new Map<string, TrackerSummary[]>();
  for (const tracker of snapshot) {
    if (!tracker.parentId) continue;
    const children = childrenOf.get(tracker.parentId) ?? [];
    children.push(tracker);
    childrenOf.set(tracker.parentId, children);
  }

  const descendantStats = (
    parentId: string,
    ancestors: ReadonlySet<string> = new Set<string>(),
    depth = 0,
  ): { childCount: number; doneCount: number } => {
    if (depth >= MAX_TREE_DEPTH || ancestors.has(parentId)) {
      return { childCount: 0, doneCount: 0 };
    }
    const nextAncestors = new Set(ancestors).add(parentId);
    let childCount = 0;
    let doneCount = 0;
    for (const child of childrenOf.get(parentId) ?? []) {
      childCount += 1;
      doneCount += child.status === "closed" || child.status === "cancelled" ? 1 : 0;
      const nested = descendantStats(child.id, nextAncestors, depth + 1);
      childCount += nested.childCount;
      doneCount += nested.doneCount;
    }
    return { childCount, doneCount };
  };

  return trackers.map((tracker) => ({ ...tracker, ...descendantStats(tracker.id) }));
}

export class TrackerSyncManager {
  private readonly aitService: AitService;
  private readonly projectRegistry: Pick<ProjectRegistry, "get">;
  private readonly fileObserver: FileObserver;
  private readonly directoryExists: (directory: string) => Promise<boolean>;
  private readonly aitDatabaseExists: (rootPath: string) => Promise<boolean>;
  private readonly onAitInitializedChanged: ((projectId: string) => void | Promise<void>) | null;
  private readonly roots = new Map<string, AitRootWatch>();
  private readonly projectIdsByRoot = new Map<string, Set<string>>();
  private readonly globalProjectIdsByRoot = new Map<string, Set<string>>();
  private readonly idleDisposalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleDisposals = new Set<Promise<void>>();
  private nextEpoch = 1;

  constructor(options: TrackerSyncManagerOptions) {
    this.aitService = options.aitService;
    this.projectRegistry = options.projectRegistry;
    this.fileObserver = options.fileObserver ?? createFileObserver();
    this.directoryExists =
      options.directoryExists ??
      (async (directory) => {
        try {
          await access(directory);
          return true;
        } catch {
          return false;
        }
      });
    this.aitDatabaseExists =
      options.aitDatabaseExists ??
      (async (rootPath) => {
        try {
          await access(join(rootPath, ".ait", "ait.db"));
          return true;
        } catch {
          return false;
        }
      });
    this.onAitInitializedChanged = options.onAitInitializedChanged ?? null;
  }

  async watchProject(projectId: string): Promise<void> {
    const rootPath = await this.resolveRoot(projectId);
    const root = this.getOrCreateRoot(rootPath);
    this.addProjectId(rootPath, projectId);
    const projectIds = this.globalProjectIdsByRoot.get(rootPath) ?? new Set<string>();
    projectIds.add(projectId);
    this.globalProjectIdsByRoot.set(rootPath, projectIds);
    this.cancelIdleDisposal(rootPath);
    await root.start();
  }

  async unwatchProject(projectId: string): Promise<void> {
    for (const [rootPath, projectIds] of this.projectIdsByRoot) {
      if (!projectIds.delete(projectId)) continue;
      const globalProjectIds = this.globalProjectIdsByRoot.get(rootPath);
      globalProjectIds?.delete(projectId);
      if (globalProjectIds?.size === 0) this.globalProjectIdsByRoot.delete(rootPath);
      if (projectIds.size === 0) {
        this.projectIdsByRoot.delete(rootPath);
        const root = this.roots.get(rootPath);
        if (root) await this.maybeDisposeRoot(root);
      }
      return;
    }
  }

  async subscribe(input: {
    projectId: string;
    all?: boolean;
    subscriptionId: string;
    listener: TrackerSnapshotListener;
  }): Promise<TrackerSnapshot> {
    const rootPath = await this.resolveRoot(input.projectId);
    const root = this.getOrCreateRoot(rootPath);
    this.addProjectId(rootPath, input.projectId);
    this.cancelIdleDisposal(rootPath);
    const variant = root.getVariant(input.all === true, () => this.allocateEpoch());
    variant.addListener(input.subscriptionId, input.projectId, input.listener);
    try {
      await root.start();
      return variant.initialized ? variant.current : await variant.refresh(false);
    } catch (error) {
      variant.removeListener(input.subscriptionId);
      await this.maybeDisposeRoot(root);
      throw error;
    }
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    for (const root of this.roots.values()) {
      if (root.removeListener(subscriptionId)) {
        await this.maybeDisposeRoot(root);
        return;
      }
    }
  }

  async list(projectId: string, all = false): Promise<TrackerSnapshot> {
    const rootPath = await this.resolveRoot(projectId);
    const root = this.getOrCreateRoot(rootPath);
    this.addProjectId(rootPath, projectId);
    this.cancelIdleDisposal(rootPath);
    const variant = root.getVariant(all, () => this.allocateEpoch());
    try {
      await root.start();
      return variant.listenerCount > 0 || !variant.initialized
        ? await variant.refresh(variant.listenerCount > 0)
        : variant.current;
    } finally {
      if (variant.listenerCount === 0) {
        await this.maybeDisposeRoot(root);
      }
    }
  }

  async getSnapshot(projectId: string, all = true): Promise<TrackerSnapshot> {
    const rootPath = await this.resolveRoot(projectId);
    const root = this.getOrCreateRoot(rootPath);
    this.addProjectId(rootPath, projectId);
    this.cancelIdleDisposal(rootPath);
    const variant = root.getVariant(all, () => this.allocateEpoch());
    try {
      await root.start();
      return variant.initialized ? variant.current : await variant.refresh(false);
    } finally {
      if (variant.listenerCount === 0) {
        await this.maybeDisposeRoot(root);
      }
    }
  }

  async requestRefresh(rootPath: string): Promise<void> {
    const root = this.roots.get(await resolveAitRootPath(rootPath));
    if (root) {
      await root.refreshActiveVariants();
    }
  }

  async requestRefreshForProject(projectId: string): Promise<void> {
    const project = await this.projectRegistry.get(projectId);
    if (project) {
      await this.requestRefresh(project.rootPath);
    }
  }

  async close(): Promise<void> {
    const roots = [...this.roots.values()];
    const idleDisposals = [...this.idleDisposals];
    this.roots.clear();
    for (const timer of this.idleDisposalTimers.values()) {
      clearTimeout(timer);
    }
    this.idleDisposalTimers.clear();
    this.projectIdsByRoot.clear();
    this.globalProjectIdsByRoot.clear();
    await Promise.all([...roots.map((root) => root.close()), ...idleDisposals]);
    await this.fileObserver.close();
  }

  private allocateEpoch(): number {
    return this.nextEpoch++;
  }

  private async resolveRoot(projectId: string): Promise<string> {
    const project = await this.projectRegistry.get(projectId);
    if (!project || project.archivedAt) {
      const error = new Error(`Project not found: ${projectId}`) as ProjectNotFoundError;
      Object.defineProperty(error, "trackerErrorCode", { value: "not_found" });
      throw error;
    }
    return resolveAitRootPath(project.rootPath);
  }

  private getOrCreateRoot(rootPath: string): AitRootWatch {
    let root = this.roots.get(rootPath);
    if (!root) {
      root = new AitRootWatch(
        rootPath,
        this.fileObserver,
        this.aitService,
        this.directoryExists,
        this.aitDatabaseExists,
        () => this.notifyAitInitializationChanged(rootPath),
        () => {
          this.roots.delete(rootPath);
          this.projectIdsByRoot.delete(rootPath);
          this.globalProjectIdsByRoot.delete(rootPath);
        },
      );
      this.roots.set(rootPath, root);
    }
    return root;
  }

  private addProjectId(rootPath: string, projectId: string): void {
    const projectIds = this.projectIdsByRoot.get(rootPath) ?? new Set<string>();
    projectIds.add(projectId);
    this.projectIdsByRoot.set(rootPath, projectIds);
  }

  private async notifyAitInitializationChanged(rootPath: string): Promise<void> {
    if (!this.onAitInitializedChanged) return;
    await Promise.all(
      [...(this.projectIdsByRoot.get(rootPath) ?? [])].map((projectId) =>
        this.onAitInitializedChanged!(projectId),
      ),
    );
  }

  private async maybeDisposeRoot(root: AitRootWatch): Promise<void> {
    if (root.hasListeners || (this.globalProjectIdsByRoot.get(root.rootPath)?.size ?? 0) > 0) {
      this.cancelIdleDisposal(root.rootPath);
      return;
    }
    this.cancelIdleDisposal(root.rootPath);
    const timer = setTimeout(() => {
      this.idleDisposalTimers.delete(root.rootPath);
      if (
        root.hasListeners ||
        (this.globalProjectIdsByRoot.get(root.rootPath)?.size ?? 0) > 0 ||
        this.roots.get(root.rootPath) !== root
      ) {
        return;
      }
      this.roots.delete(root.rootPath);
      const disposal = root.close();
      this.idleDisposals.add(disposal);
      void disposal.then(
        () => this.idleDisposals.delete(disposal),
        () => this.idleDisposals.delete(disposal),
      );
    }, TRACKER_ROOT_IDLE_TTL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.idleDisposalTimers.set(root.rootPath, timer);
  }

  private cancelIdleDisposal(rootPath: string): void {
    const timer = this.idleDisposalTimers.get(rootPath);
    if (timer) {
      clearTimeout(timer);
      this.idleDisposalTimers.delete(rootPath);
    }
  }
}

class AitRootWatch {
  readonly rootPath: string;
  private readonly variants = new Map<boolean, SnapshotVariant>();
  private observerSubscription: FileObserverSubscription | null = null;
  private observationPromise: Promise<void> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceStartedAt = 0;
  private existenceTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private aitInitialized: boolean | null = null;

  constructor(
    rootPath: string,
    private readonly fileObserver: FileObserver,
    private readonly aitService: AitService,
    private readonly directoryExists: (directory: string) => Promise<boolean>,
    private readonly aitDatabaseExists: (rootPath: string) => Promise<boolean>,
    private readonly onInitializationChange: () => void | Promise<void>,
    private readonly onEmpty: () => void,
  ) {
    this.rootPath = rootPath;
  }

  get hasListeners(): boolean {
    return [...this.variants.values()].some((variant) => variant.listenerCount > 0);
  }

  getVariant(all: boolean, allocateEpoch: () => number): SnapshotVariant {
    let variant = this.variants.get(all);
    if (!variant) {
      variant = new SnapshotVariant(this.rootPath, all, allocateEpoch(), this.aitService);
      this.variants.set(all, variant);
    }
    return variant;
  }

  removeVariant(all: boolean): void {
    this.variants.delete(all);
  }

  removeListener(subscriptionId: string): boolean {
    for (const variant of this.variants.values()) {
      if (variant.removeListener(subscriptionId)) {
        return true;
      }
    }
    return false;
  }

  async start(): Promise<void> {
    if (this.closed || this.observationPromise) {
      return this.observationPromise ?? Promise.resolve();
    }
    this.observationPromise = this.attachOrProbe().finally(() => {
      this.observationPromise = null;
    });
    return this.observationPromise;
  }

  async refreshActiveVariants(): Promise<void> {
    await Promise.all([...this.variants.values()].map((variant) => variant.refresh(true)));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.existenceTimer) clearInterval(this.existenceTimer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.debounceTimer = null;
    this.existenceTimer = null;
    this.retryTimer = null;
    const subscription = this.observerSubscription;
    this.observerSubscription = null;
    await subscription?.unsubscribe().catch(() => undefined);
    await Promise.all([...this.variants.values()].map((variant) => variant.close()));
    this.variants.clear();
    this.onEmpty();
  }

  private async attachOrProbe(): Promise<void> {
    const directory = join(this.rootPath, ".ait");
    if (!(await this.directoryExists(directory))) {
      if (this.observerSubscription) {
        const subscription = this.observerSubscription;
        this.observerSubscription = null;
        await subscription.unsubscribe().catch(() => undefined);
      }
      await this.refreshInitializationState();
      this.enterExistenceProbe();
      return;
    }
    try {
      const recovering = this.existenceTimer !== null || this.retryTimer !== null;
      this.observerSubscription = await this.fileObserver.subscribe(directory, (error) => {
        if (error) {
          const subscription = this.observerSubscription;
          this.observerSubscription = null;
          void subscription?.unsubscribe();
          this.enterDegradedPolling();
          return;
        }
        this.scheduleRefresh();
      });
      if (this.existenceTimer) clearInterval(this.existenceTimer);
      this.existenceTimer = null;
      if (this.retryTimer) clearInterval(this.retryTimer);
      this.retryTimer = null;
      await this.refreshInitializationState();
      if (recovering) {
        await this.refreshActiveVariants();
      }
    } catch {
      this.enterDegradedPolling();
    }
  }

  private enterExistenceProbe(): void {
    if (this.existenceTimer) return;
    this.existenceTimer = setInterval(() => {
      void this.attachOrProbe();
    }, UNINITIALISED_PROBE_MS);
    (this.existenceTimer as unknown as { unref?: () => void }).unref?.();
  }

  private enterDegradedPolling(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      void this.attachOrProbe();
      void this.refreshActiveVariants();
    }, WATCH_RETRY_MS);
    (this.retryTimer as unknown as { unref?: () => void }).unref?.();
  }

  private scheduleRefresh(): void {
    if (this.closed) return;
    const now = Date.now();
    this.debounceStartedAt ||= now;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const elapsed = now - this.debounceStartedAt;
    const delay = elapsed >= MAX_DEBOUNCE_MS ? 0 : DEBOUNCE_MS;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.debounceStartedAt = 0;
      void this.refreshActiveVariants()
        .then(() => this.refreshInitializationState())
        .catch(() => undefined);
    }, delay);
  }

  private async refreshInitializationState(): Promise<void> {
    const next = await this.aitDatabaseExists(this.rootPath);
    if (this.aitInitialized === null) {
      this.aitInitialized = next;
      return;
    }
    if (this.aitInitialized === next) return;
    await this.onInitializationChange();
    this.aitInitialized = next;
  }
}

class SnapshotVariant {
  private snapshot: TrackerSnapshot;
  private fingerprint: string | null = null;
  private refreshPromise: Promise<TrackerSnapshot> | null = null;
  private refreshQueued = false;
  private closed = false;
  private readonly listeners = new Map<
    string,
    { projectId: string; listener: TrackerSnapshotListener }
  >();

  constructor(
    private readonly rootPath: string,
    private readonly all: boolean,
    private readonly epoch: number,
    private readonly aitService: AitService,
  ) {
    this.snapshot = {
      trackers: [],
      hiddenCount: 0,
      epoch,
      generation: 0,
      error: null,
      errorCode: null,
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  get initialized(): boolean {
    return this.fingerprint !== null;
  }

  get current(): TrackerSnapshot {
    return this.snapshot;
  }

  addListener(subscriptionId: string, projectId: string, listener: TrackerSnapshotListener): void {
    this.listeners.set(subscriptionId, { projectId, listener });
  }

  removeListener(subscriptionId: string): boolean {
    return this.listeners.delete(subscriptionId);
  }

  async refresh(notify: boolean): Promise<TrackerSnapshot> {
    if (this.closed) return this.snapshot;
    if (this.refreshPromise) {
      this.refreshQueued = true;
      return this.refreshPromise;
    }
    this.refreshPromise = (async () => {
      const result = await this.readAndAccept(notify);
      if (this.refreshQueued && !this.closed) {
        this.refreshQueued = false;
        return this.readAndAccept(true);
      }
      return result;
    })();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    await this.refreshPromise?.catch(() => undefined);
  }

  private async readAndAccept(notify: boolean): Promise<TrackerSnapshot> {
    let next: Omit<TrackerSnapshot, "epoch" | "generation">;
    try {
      const result = await this.aitService.listTrackers({ cwd: this.rootPath, all: this.all });
      next = {
        trackers: result.trackers,
        hiddenCount: result.hiddenCount,
        error: null,
        errorCode: null,
      };
    } catch (error) {
      next = {
        trackers: [],
        hiddenCount: 0,
        error: error instanceof Error ? error.message : String(error),
        errorCode: error instanceof AitCliError ? error.code : "unknown",
      };
    }
    const candidate = { ...next, epoch: this.epoch, generation: this.snapshot.generation + 1 };
    const fingerprint = JSON.stringify(next);
    const changed = fingerprint !== this.fingerprint;
    if (changed) {
      this.fingerprint = fingerprint;
      this.snapshot = candidate;
      if (notify) {
        for (const { projectId, listener } of this.listeners.values()) {
          listener({ ...candidate, trackers: [...candidate.trackers] }, projectId);
        }
      }
    }
    return this.snapshot;
  }
}
