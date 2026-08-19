import type pino from "pino";
import type { IssuesErrorCode } from "@getpaseo/protocol/issues/rpc-schemas";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { AitCliError, type AitService } from "../../../services/ait-cli-service.js";
import type { ProjectRegistry } from "../../workspace-registry.js";

export interface IssuesSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface IssuesSessionOptions {
  host: IssuesSessionHost;
  aitService: AitService;
  projectRegistry: Pick<ProjectRegistry, "get">;
  logger: pino.Logger;
}

class ProjectNotFoundError extends Error {}

export class IssuesSession {
  private readonly host: IssuesSessionHost;
  private readonly aitService: AitService;
  private readonly projectRegistry: Pick<ProjectRegistry, "get">;
  private readonly logger: pino.Logger;

  constructor(options: IssuesSessionOptions) {
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

  private toErrorTuple(error: unknown): { error: string; errorCode: IssuesErrorCode } {
    if (error instanceof AitCliError) {
      return { error: error.message, errorCode: error.code };
    }
    if (error instanceof ProjectNotFoundError) {
      return { error: error.message, errorCode: "not_found" };
    }
    return { error: error instanceof Error ? error.message : String(error), errorCode: "unknown" };
  }

  private logFailure(requestType: string, error: unknown): void {
    this.logger.warn({ err: error, requestType }, "Issues request failed");
  }

  async handleProjectIssuesListRequest(
    request: Extract<SessionInboundMessage, { type: "project.issues.list.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const { issues, hiddenCount } = await this.aitService.listIssues({ cwd, all: request.all });
      this.host.emit({
        type: "project.issues.list.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          issues,
          hiddenCount,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.issues.list.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          issues: [],
          hiddenCount: 0,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectIssuesShowRequest(
    request: Extract<SessionInboundMessage, { type: "project.issues.show.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const issue = await this.aitService.showIssue({ cwd, issueId: request.issueId });
      this.host.emit({
        type: "project.issues.show.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          issue,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.issues.show.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          issue: null,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectIssuesCreateRequest(
    request: Extract<SessionInboundMessage, { type: "project.issues.create.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const issue = await this.aitService.createIssue({
        cwd,
        input: {
          title: request.title,
          issueType: request.issueType,
          priority: request.priority,
          parentId: request.parentId,
          description: request.description,
        },
      });
      this.host.emit({
        type: "project.issues.create.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          issue,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.issues.create.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          issue: null,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectIssuesUpdateRequest(
    request: Extract<SessionInboundMessage, { type: "project.issues.update.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const issue = await this.aitService.updateIssue({
        cwd,
        issueId: request.issueId,
        input: { title: request.title, status: request.status, priority: request.priority },
      });
      this.host.emit({
        type: "project.issues.update.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          issue,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.issues.update.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          issue: null,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectIssuesCloseRequest(
    request: Extract<SessionInboundMessage, { type: "project.issues.close.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const issue = await this.aitService.closeIssue({
        cwd,
        issueId: request.issueId,
        note: request.note,
      });
      this.host.emit({
        type: "project.issues.close.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          issue,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.issues.close.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          issue: null,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectIssuesReopenRequest(
    request: Extract<SessionInboundMessage, { type: "project.issues.reopen.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const issue = await this.aitService.reopenIssue({ cwd, issueId: request.issueId });
      this.host.emit({
        type: "project.issues.reopen.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          issue,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.issues.reopen.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          issue: null,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectIssuesCancelRequest(
    request: Extract<SessionInboundMessage, { type: "project.issues.cancel.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const issue = await this.aitService.cancelIssue({
        cwd,
        issueId: request.issueId,
        reason: request.reason,
      });
      this.host.emit({
        type: "project.issues.cancel.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          issue,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      this.logFailure(request.type, error);
      this.host.emit({
        type: "project.issues.cancel.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          issue: null,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectIssuesNoteAddRequest(
    request: Extract<SessionInboundMessage, { type: "project.issues.note_add.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const note = await this.aitService.addNote({
        cwd,
        issueId: request.issueId,
        body: request.body,
      });
      this.host.emit({
        type: "project.issues.note_add.response",
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
        type: "project.issues.note_add.response",
        payload: {
          requestId: request.requestId,
          projectId: request.projectId,
          note: null,
          ...this.toErrorTuple(error),
        },
      });
    }
  }

  async handleProjectIssuesInitRequest(
    request: Extract<SessionInboundMessage, { type: "project.issues.init.request" }>,
  ): Promise<void> {
    try {
      const cwd = await this.resolveCwd(request.projectId);
      const { initialised } = await this.aitService.initTracker({ cwd, prefix: request.prefix });
      this.host.emit({
        type: "project.issues.init.response",
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
        type: "project.issues.init.response",
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
