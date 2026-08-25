import type pino from "pino";
import type { TrackerErrorCode } from "@getpaseo/protocol/tracker/rpc-schemas";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { AitCliError, type AitService } from "../../../services/ait-cli-service.js";
import type { ProjectRegistry } from "../../workspace-registry.js";
import {
  getTrackerStatsCounts,
  type TrackerSyncManager,
  withTrackerSubtreeStats,
} from "../../tracker-sync-manager.js";
import type { TrackerSummary } from "@getpaseo/protocol/tracker/types";

export interface TrackerSessionHost {
  emit(msg: SessionOutboundMessage): void;
  refreshProjectDescriptor?: (projectId: string) => void | Promise<void>;
}

export interface TrackerSessionOptions {
  host: TrackerSessionHost;
  aitService: AitService;
  projectRegistry: Pick<ProjectRegistry, "get">;
  logger: pino.Logger;
  trackerSyncManager?: TrackerSyncManager;
}

class ProjectNotFoundError extends Error {}

export class TrackerSession {
  private readonly host: TrackerSessionHost;
  private readonly aitService: AitService;
  private readonly projectRegistry: Pick<ProjectRegistry, "get">;
  private readonly logger: pino.Logger;
  private readonly trackerSyncManager: TrackerSyncManager | null;
  private readonly subscriptions = new Set<string>();

  constructor(options: TrackerSessionOptions) {
    this.host = options.host;
    this.aitService = options.aitService;
    this.projectRegistry = options.projectRegistry;
    this.logger = options.logger;
    this.trackerSyncManager = options.trackerSyncManager ?? null;
  }

  private async resolveCwd(projectId: string): Promise<string> {
    const project = await this.projectRegistry.get(projectId);
    if (!project) {
      throw new ProjectNotFoundError(`Project not found: ${projectId}`);
    }
    return project.rootPath;
  }

  private toErrorTuple(error: unknown): { error: string; errorCode: TrackerErrorCode } {
    if (error instanceof AitCliError) {
      return { error: error.message, errorCode: error.code };
    }
    if (error instanceof ProjectNotFoundError) {
      return { error: error.message, errorCode: "not_found" };
    }
    if (error && typeof error === "object" && "trackerErrorCode" in error) {
      const code = (error as { trackerErrorCode?: TrackerErrorCode }).trackerErrorCode;
      if (code)
        return { error: error instanceof Error ? error.message : String(error), errorCode: code };
    }
    return { error: error instanceof Error ? error.message : String(error), errorCode: "unknown" };
  }

  private logFailure(requestType: string, error: unknown): void {
    this.logger.warn({ err: error, requestType }, "Trackers request failed");
  }

  private async readFullTrackers(projectId: string, cwd: string): Promise<TrackerSummary[]> {
    if (this.trackerSyncManager) {
      const snapshot = await this.trackerSyncManager.getSnapshot(projectId, true);
      if (snapshot.error) {
        throw new AitCliError(snapshot.errorCode ?? "unknown", snapshot.error);
      }
      return snapshot.trackers;
    }
    const result = await this.aitService.listTrackers({ cwd, all: true });
    return result.trackers;
  }

  async handleProjectTrackerListRequest(
    request: Extract<SessionInboundMessage, { type: "project.tracker.list.request" }>,
  ): Promise<void> {
    // Paginated or filtered requests hit aitService for the visible page. The
    // manager still supplies the full snapshot used for daemon-side subtree
    // counts. Kanban's requests never carry these fields and keep taking the
    // unchanged legacy path below.
    if (request.page || request.status || request.trackerType || request.priority || request.sort) {
      await this.handlePaginatedListRequest(request);
      return;
    }
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const snapshot = this.trackerSyncManager
        ? await this.trackerSyncManager.list(request.projectId, request.all === true)
        : null;
      if (snapshot?.error) {
        throw new AitCliError(snapshot.errorCode ?? "unknown", snapshot.error);
      }
      const { trackers: resultTrackers, hiddenCount } =
        snapshot ?? (await this.aitService.listTrackers({ cwd, all: request.all }));
      const fullTrackers =
        request.all === true ? resultTrackers : await this.readFullTrackers(request.projectId, cwd);
      this.host.emit({
        type: "project.tracker.list.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          trackers: withTrackerSubtreeStats(resultTrackers, fullTrackers),
          hiddenCount,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.tracker.list.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          trackers: [],
          hiddenCount: 0,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  private async handlePaginatedListRequest(
    request: Extract<SessionInboundMessage, { type: "project.tracker.list.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      let offset: number | undefined;
      if (request.page) {
        offset = request.page.cursor ? Number(request.page.cursor) : 0;
      }
      const result = await this.aitService.listTrackers({
        cwd,
        all: request.all,
        status: request.status,
        type: request.trackerType,
        priority: request.priority,
        sort: request.sort,
        limit: request.page?.limit,
        offset,
      });
      const fullTrackers = await this.readFullTrackers(request.projectId, cwd);
      this.host.emit({
        type: "project.tracker.list.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          trackers: withTrackerSubtreeStats(result.trackers, fullTrackers),
          hiddenCount: result.hiddenCount,
          // Omitted entirely when the service fell back to an unpaginated old
          // CLI binary — absence means "complete result", not "no more pages".
          ...(result.pageInfo ? { pageInfo: result.pageInfo } : {}),
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.tracker.list.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          trackers: [],
          hiddenCount: 0,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectTrackerStatsRequest(
    request: Extract<SessionInboundMessage, { type: "project.tracker.stats.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const trackers = await this.readFullTrackers(request.projectId, cwd);
      this.host.emit({
        type: "project.tracker.stats.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          counts: getTrackerStatsCounts(trackers),
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.tracker.stats.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          counts: null,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectTrackerSearchRequest(
    request: Extract<SessionInboundMessage, { type: "project.tracker.search.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const { trackers, pageInfo } = await this.aitService.searchTrackers({
        cwd,
        query: request.query,
        limit: request.page.limit,
        offset: request.page.cursor ? Number(request.page.cursor) : 0,
      });
      this.host.emit({
        type: "project.tracker.search.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          trackers,
          pageInfo,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.tracker.search.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          trackers: [],
          pageInfo: { nextCursor: null, hasMore: false },
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectTrackerSubscribeRequest(
    request: Extract<SessionInboundMessage, { type: "project.tracker.subscribe.request" }>,
  ): Promise<void> {
    if (!this.trackerSyncManager) {
      this.host.emit({
        type: "project.tracker.subscribe.response",
        payload: {
          requestId: request.requestId,
          subscriptionId: request.subscriptionId,
          projectId: request.projectId,
          trackers: [],
          hiddenCount: 0,
          epoch: 1,
          generation: 1,
          error: "Live tracker sync is unavailable",
          errorCode: "unknown",
        },
      });
      return;
    }
    try {
      const snapshot = await this.trackerSyncManager.subscribe({
        projectId: request.projectId,
        all: request.all,
        subscriptionId: request.subscriptionId,
        listener: (update, projectId) => {
          this.host.emit({
            type: "project.tracker.updated",
            payload: { ...update, projectId, subscriptionId: request.subscriptionId },
          });
        },
      });
      this.subscriptions.add(request.subscriptionId);
      this.host.emit({
        type: "project.tracker.subscribe.response",
        payload: {
          ...snapshot,
          requestId: request.requestId,
          projectId: request.projectId,
          subscriptionId: request.subscriptionId,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      const { error: message, errorCode } = this.toErrorTuple(error);
      this.host.emit({
        type: "project.tracker.subscribe.response",
        payload: {
          requestId: request.requestId,
          subscriptionId: request.subscriptionId,
          projectId: request.projectId,
          trackers: [],
          hiddenCount: 0,
          epoch: 1,
          generation: 1,
          error: message,
          errorCode,
        },
      });
    }
  }

  async handleProjectTrackerUnsubscribeRequest(
    request: Extract<SessionInboundMessage, { type: "project.tracker.unsubscribe.request" }>,
  ): Promise<void> {
    await this.trackerSyncManager?.unsubscribe(request.subscriptionId);
    this.subscriptions.delete(request.subscriptionId);
  }

  async cleanup(): Promise<void> {
    const subscriptions = [...this.subscriptions];
    this.subscriptions.clear();
    await Promise.all(
      subscriptions.map((subscriptionId) => this.trackerSyncManager?.unsubscribe(subscriptionId)),
    );
  }

  private async refreshAfterMutation(cwd: string): Promise<void> {
    await this.trackerSyncManager?.requestRefresh(cwd);
  }

  async handleProjectTrackerShowRequest(
    request: Extract<SessionInboundMessage, { type: "project.tracker.show.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const tracker = await this.aitService.showTracker({ cwd, trackerId: request.trackerId });
      this.host.emit({
        type: "project.tracker.show.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          tracker,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.tracker.show.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          tracker: null,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectTrackerCreateRequest(
    request: Extract<SessionInboundMessage, { type: "project.tracker.create.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const tracker = await this.aitService.createTracker({
        cwd,
        input: {
          title: request.title,
          trackerType: request.trackerType,
          priority: request.priority,
          parentId: request.parentId,
          description: request.description,
        },
      });
      await this.refreshAfterMutation(cwd);
      this.host.emit({
        type: "project.tracker.create.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          tracker,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.tracker.create.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          tracker: null,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectTrackerUpdateRequest(
    request: Extract<SessionInboundMessage, { type: "project.tracker.update.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const tracker = await this.aitService.updateTracker({
        cwd,
        trackerId: request.trackerId,
        input: {
          title: request.title,
          status: request.status,
          priority: request.priority,
          description: request.description,
        },
      });
      await this.refreshAfterMutation(cwd);
      this.host.emit({
        type: "project.tracker.update.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          tracker,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.tracker.update.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          tracker: null,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectTrackerCloseRequest(
    request: Extract<SessionInboundMessage, { type: "project.tracker.close.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const tracker = await this.aitService.closeTracker({
        cwd,
        trackerId: request.trackerId,
        note: request.note,
      });
      await this.refreshAfterMutation(cwd);
      this.host.emit({
        type: "project.tracker.close.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          tracker,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.tracker.close.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          tracker: null,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectTrackerReopenRequest(
    request: Extract<SessionInboundMessage, { type: "project.tracker.reopen.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const tracker = await this.aitService.reopenTracker({ cwd, trackerId: request.trackerId });
      await this.refreshAfterMutation(cwd);
      this.host.emit({
        type: "project.tracker.reopen.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          tracker,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.tracker.reopen.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          tracker: null,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectTrackerCancelRequest(
    request: Extract<SessionInboundMessage, { type: "project.tracker.cancel.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const tracker = await this.aitService.cancelTracker({
        cwd,
        trackerId: request.trackerId,
        reason: request.reason,
      });
      await this.refreshAfterMutation(cwd);
      this.host.emit({
        type: "project.tracker.cancel.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          tracker,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.tracker.cancel.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          tracker: null,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectTrackerDeleteRequest(
    request: Extract<SessionInboundMessage, { type: "project.tracker.delete.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const deletedIds = await this.aitService.deleteTracker({
        cwd,
        trackerId: request.trackerId,
        cascade: request.cascade,
      });
      await this.refreshAfterMutation(cwd);
      this.host.emit({
        type: "project.tracker.delete.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          deletedIds,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.tracker.delete.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          deletedIds: null,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectTrackerNoteAddRequest(
    request: Extract<SessionInboundMessage, { type: "project.tracker.note_add.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const note = await this.aitService.addNote({
        cwd,
        trackerId: request.trackerId,
        body: request.body,
      });
      await this.refreshAfterMutation(cwd);
      this.host.emit({
        type: "project.tracker.note_add.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          note,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.tracker.note_add.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          note: null,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectTrackerInitRequest(
    request: Extract<SessionInboundMessage, { type: "project.tracker.init.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const { initialised } = await this.aitService.initTracker({ cwd, prefix: request.prefix });
      await this.refreshAfterMutation(cwd);
      await this.host.refreshProjectDescriptor?.(request.projectId);
      this.host.emit({
        type: "project.tracker.init.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          initialised,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.tracker.init.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          initialised: false,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectTrackerReadyRequest(
    request: Extract<SessionInboundMessage, { type: "project.tracker.ready.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const readyIds = await this.aitService.listReadyIds({ cwd });
      this.host.emit({
        type: "project.tracker.ready.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          readyIds,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.tracker.ready.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          readyIds: [],
          ...this.toErrorTuple(error),
        },
      });
    }
  }
}
