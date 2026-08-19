import type pino from "pino";
import type { TrackerErrorCode } from "@getpaseo/protocol/tracker/rpc-schemas";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { AitCliError, type AitService } from "../../../services/ait-cli-service.js";
import type { ProjectRegistry } from "../../workspace-registry.js";

export interface TrackerSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface TrackerSessionOptions {
  host: TrackerSessionHost;
  aitService: AitService;
  projectRegistry: Pick<ProjectRegistry, "get">;
  logger: pino.Logger;
}

class ProjectNotFoundError extends Error {}

export class TrackerSession {
  private readonly host: TrackerSessionHost;
  private readonly aitService: AitService;
  private readonly projectRegistry: Pick<ProjectRegistry, "get">;
  private readonly logger: pino.Logger;

  constructor(options: TrackerSessionOptions) {
    this.host = options.host;
    this.aitService = options.aitService;
    this.projectRegistry = options.projectRegistry;
    this.logger = options.logger;
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
    return { error: error instanceof Error ? error.message : String(error), errorCode: "unknown" };
  }

  private logFailure(requestType: string, error: unknown): void {
    this.logger.warn({ err: error, requestType }, "Trackers request failed");
  }

  async handleProjectTrackerListRequest(
    request: Extract<SessionInboundMessage, { type: "project.tracker.list.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const { trackers, hiddenCount } = await this.aitService.listTrackers({
        cwd,
        all: request.all,
      });
      this.host.emit({
        type: "project.tracker.list.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          trackers,
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
        input: { title: request.title, status: request.status, priority: request.priority },
      });
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
}
