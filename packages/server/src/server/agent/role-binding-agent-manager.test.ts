import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentCreateSessionOptions,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import type { AgentLaunchContext } from "./agent-sdk-types.js";

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class RecordingSession implements AgentSession {
  readonly provider: string;
  readonly id = "test-session";
  readonly capabilities = TEST_CAPABILITIES;
  closed = false;

  constructor(config: AgentSessionConfig) {
    this.provider = config.provider;
  }

  async run() {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }
  async startTurn() {
    return { turnId: "turn-1" };
  }
  subscribe() {
    return () => undefined;
  }
  async *streamHistory() {}
  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode() {
    return undefined;
  }
  getPendingPermissions() {
    return [];
  }
  async respondToPermission() {
    return undefined;
  }
  describePersistence() {
    return null;
  }
  async interrupt() {
    return undefined;
  }
  async close() {
    this.closed = true;
  }
}

class RecordingClient implements AgentClient {
  readonly provider: string;
  readonly capabilities = TEST_CAPABILITIES;
  readonly launches: Array<{
    config: AgentSessionConfig;
    launchContext?: AgentLaunchContext;
    options?: AgentCreateSessionOptions;
  }> = [];

  constructor(provider: string) {
    this.provider = provider;
  }

  async isAvailable() {
    return true;
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    this.launches.push({ config, launchContext, options });
    return new RecordingSession(config);
  }

  async resumeSession(
    _handle: { sessionId: string },
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.launches.push({ config, launchContext });
    return new RecordingSession(config);
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }
}

interface RoleManagerFixture {
  manager: AgentManager;
  registry: AgentStorage;
  codex: RecordingClient;
  workdir: string;
  cleanup(): Promise<void>;
}

async function createRoleManagerFixture(): Promise<RoleManagerFixture> {
  const logger = createTestLogger();
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-role-binding-"));
  const codex = new RecordingClient("codex");
  const registry = new AgentStorage(join(workdir, "agents"), logger);
  await registry.initialize();
  const manager = new AgentManager({
    clients: { codex },
    registry,
    logger,
    idFactory: () => `agent-role-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  return {
    manager,
    registry,
    codex,
    workdir,
    async cleanup() {
      await Promise.allSettled(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

const AGENT_IDS = {
  agent_role_create: randomUUID(),
  agent_role_system_prompt: randomUUID(),
  agent_role_unknown_provider: randomUUID(),
  agent_role_fail_closed: randomUUID(),
  agent_role_model_pin: randomUUID(),
  agent_role_persist: randomUUID(),
};

describe("AgentManager role-bound creation", () => {
  test("materializes an immutable binding and passes instructions through the launch context", async () => {
    const fixture = await createRoleManagerFixture();
    try {
      const agent = await fixture.manager.createAgent(
        { provider: "codex", cwd: fixture.workdir },
        AGENT_IDS.agent_role_create,
        { workspaceId: undefined, roleId: "lead" },
      );

      expect(agent.roleBinding).toMatchObject({
        roleId: "lead",
        provider: "codex",
        injectionMethod: "codex-developer-instructions",
        qualification: "implementation-supported",
      });
      expect(agent.roleBinding?.instructions.length ?? 0).toBeGreaterThan(0);

      expect(fixture.codex.launches).toHaveLength(1);
      const launch = fixture.codex.launches[0];
      expect(launch.launchContext?.roleBinding).toEqual({
        roleId: "lead",
        instructions: agent.roleBinding?.instructions,
      });
      // The durable instruction channel belongs to the role, not the caller.
      expect(launch.config.systemPrompt).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  test("rejects caller systemPrompt on a role-bound launch", async () => {
    const fixture = await createRoleManagerFixture();
    try {
      await expect(
        fixture.manager.createAgent(
          { provider: "codex", cwd: fixture.workdir, systemPrompt: "caller prompt" },
          AGENT_IDS.agent_role_system_prompt,
          { workspaceId: undefined, roleId: "peer" },
        ),
      ).rejects.toThrowError(/rejects config\.systemPrompt/u);
      expect(fixture.codex.launches).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("fails closed for providers without a native role channel", async () => {
    const fixture = await createRoleManagerFixture();
    try {
      await expect(
        fixture.manager.createAgent(
          { provider: "codex", cwd: fixture.workdir },
          AGENT_IDS.agent_role_unknown_provider,
          { workspaceId: undefined, roleId: "lead" },
        ),
      ).resolves.toBeDefined();

      await expect(
        fixture.manager.createAgent(
          { provider: "unknown-provider", cwd: fixture.workdir },
          AGENT_IDS.agent_role_fail_closed,
          { workspaceId: undefined, roleId: "lead" },
        ),
      ).rejects.toThrowError(/no qualified native durable role-instruction channel/u);
    } finally {
      await fixture.cleanup();
    }
  });

  test("pins the model on role-bound agents", async () => {
    const fixture = await createRoleManagerFixture();
    try {
      const agent = await fixture.manager.createAgent(
        { provider: "codex", cwd: fixture.workdir },
        AGENT_IDS.agent_role_model_pin,
        { workspaceId: undefined, roleId: "supervisor" },
      );
      await expect(fixture.manager.setAgentModel(agent.id, "gpt-other")).rejects.toThrowError(
        /pin their model at create/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test("persists the binding and resumes with the exact same instruction bytes", async () => {
    const fixture = await createRoleManagerFixture();
    try {
      const agent = await fixture.manager.createAgent(
        { provider: "codex", cwd: fixture.workdir },
        AGENT_IDS.agent_role_persist,
        { workspaceId: undefined, roleId: "peer" },
      );
      const persisted = await fixture.registry.get(AGENT_IDS.agent_role_persist);
      expect(persisted?.roleBinding).toMatchObject({ roleId: "peer", provider: "codex" });
      expect(persisted?.roleBinding?.instructions).toBe(agent.roleBinding?.instructions);

      await fixture.manager.reloadAgentSession(AGENT_IDS.agent_role_persist);
      const resumeCount = fixture.codex.launches.length;
      const resume = fixture.codex.launches[resumeCount - 1];
      expect(resume.launchContext?.roleBinding?.instructions).toBe(agent.roleBinding?.instructions);
    } finally {
      await fixture.cleanup();
    }
  });
});
