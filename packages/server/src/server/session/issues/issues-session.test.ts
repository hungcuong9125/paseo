import { describe, expect, it } from "vitest";
import pino from "pino";
import { IssuesSession } from "./issues-session.js";
import { createStub } from "../../test-utils/class-mocks.js";
import { findByType } from "../../test-utils/session-stubs.js";
import type { SessionOutboundMessage } from "../../messages.js";
import { AitCliError, type AitService } from "../../../services/ait-cli-service.js";
import type { ProjectRegistry } from "../../workspace-registry.js";

const PROJECT_ID = "prj_abc123";
const CWD = "/repo/my-project";

function makeSession(ait: { [K in keyof AitService]?: unknown }) {
  const emitted: SessionOutboundMessage[] = [];
  const projectRegistry = createStub<Pick<ProjectRegistry, "get">>({
    get: async (id: string) =>
      id === PROJECT_ID
        ? ({ projectId: PROJECT_ID, rootPath: CWD } as Awaited<ReturnType<ProjectRegistry["get"]>>)
        : null,
  });
  const session = new IssuesSession({
    host: { emit: (message) => emitted.push(message) },
    aitService: createStub<AitService>(ait),
    projectRegistry,
    logger: pino({ level: "silent" }),
  });
  return { session, emitted };
}

const SAMPLE_ISSUE = {
  id: "proj-1",
  title: "Fix the thing",
  type: "task" as const,
  status: "open" as const,
  priority: "P2" as const,
  parentId: null,
};

describe("IssuesSession", () => {
  it("resolves projectId to cwd before calling the ait service", async () => {
    let receivedCwd: string | undefined;
    const { session, emitted } = makeSession({
      listIssues: async ({ cwd }: { cwd: string }) => {
        receivedCwd = cwd;
        return { issues: [SAMPLE_ISSUE], hiddenCount: 0 };
      },
    });

    await session.handleProjectIssuesListRequest({
      type: "project.issues.list.request",
      requestId: "r1",
      projectId: PROJECT_ID,
    });

    expect(receivedCwd).toBe(CWD);
    const response = findByType(emitted, "project.issues.list.response");
    expect(response?.payload.issues).toEqual([SAMPLE_ISSUE]);
    expect(response?.payload.error).toBeNull();
    expect(response?.payload.errorCode).toBeNull();
  });

  it("emits not_found when the projectId does not resolve", async () => {
    const { session, emitted } = makeSession({});

    await session.handleProjectIssuesListRequest({
      type: "project.issues.list.request",
      requestId: "r2",
      projectId: "prj_does_not_exist",
    });

    const response = findByType(emitted, "project.issues.list.response");
    expect(response?.payload.issues).toEqual([]);
    expect(response?.payload.errorCode).toBe("not_found");
    expect(response?.payload.error).toContain("prj_does_not_exist");
  });

  it("maps an AitCliError's code and message onto the response payload", async () => {
    const { session, emitted } = makeSession({
      showIssue: async () => {
        throw new AitCliError("uninitialised", "no ait database — run 'ait init' first");
      },
    });

    await session.handleProjectIssuesShowRequest({
      type: "project.issues.show.request",
      requestId: "r3",
      projectId: PROJECT_ID,
      issueId: "proj-1",
    });

    const response = findByType(emitted, "project.issues.show.response");
    expect(response?.payload.issue).toBeNull();
    expect(response?.payload.errorCode).toBe("uninitialised");
    expect(response?.payload.error).toBe("no ait database — run 'ait init' first");
  });

  it("passes create fields through to the ait service", async () => {
    let received: unknown;
    const { session, emitted } = makeSession({
      createIssue: async (options: unknown) => {
        received = options;
        return SAMPLE_ISSUE;
      },
    });

    await session.handleProjectIssuesCreateRequest({
      type: "project.issues.create.request",
      requestId: "r4",
      projectId: PROJECT_ID,
      title: "Fix the thing",
      issueType: "task",
      priority: "P2",
    });

    expect(received).toEqual({
      cwd: CWD,
      input: {
        title: "Fix the thing",
        issueType: "task",
        priority: "P2",
        parentId: undefined,
        description: undefined,
      },
    });
    const response = findByType(emitted, "project.issues.create.response");
    expect(response?.payload.issue).toEqual(SAMPLE_ISSUE);
  });

  it("close/reopen/cancel each call their matching ait service method and emit a summary", async () => {
    const closed = { ...SAMPLE_ISSUE, status: "closed" as const };
    const { session, emitted } = makeSession({
      closeIssue: async () => closed,
    });

    await session.handleProjectIssuesCloseRequest({
      type: "project.issues.close.request",
      requestId: "r5",
      projectId: PROJECT_ID,
      issueId: SAMPLE_ISSUE.id,
    });

    const response = findByType(emitted, "project.issues.close.response");
    expect(response?.payload.issue).toEqual(closed);
    expect(response?.payload.error).toBeNull();
  });

  it("note_add emits the created note", async () => {
    const note = { id: "n1", body: "root cause found", createdAt: "2026-01-01T00:00:00Z" };
    const { session, emitted } = makeSession({
      addNote: async () => note,
    });

    await session.handleProjectIssuesNoteAddRequest({
      type: "project.issues.note_add.request",
      requestId: "r6",
      projectId: PROJECT_ID,
      issueId: SAMPLE_ISSUE.id,
      body: "root cause found",
    });

    const response = findByType(emitted, "project.issues.note_add.response");
    expect(response?.payload.note).toEqual(note);
  });

  it("init emits initialised: false alongside the error when initTracker rejects", async () => {
    const { session, emitted } = makeSession({
      initTracker: async () => {
        throw new AitCliError("cli_missing", "The 'ait' CLI is not installed on this host.");
      },
    });

    await session.handleProjectIssuesInitRequest({
      type: "project.issues.init.request",
      requestId: "r7",
      projectId: PROJECT_ID,
    });

    const response = findByType(emitted, "project.issues.init.response");
    expect(response?.payload.initialised).toBe(false);
    expect(response?.payload.errorCode).toBe("cli_missing");
  });
});
