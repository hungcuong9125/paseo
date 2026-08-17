import { describe, expect, test } from "vitest";

import {
  PASEO_ROLE_DEFINITIONS_VERSION,
  type ProviderRoleBindingSupport,
} from "@getpaseo/protocol/role-binding";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentClient, AgentModelDefinition, AgentMode } from "./agent-sdk-types.js";
import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import {
  assertPersistedRoleBindingMatches,
  detectLegacyProviderRole,
  expectedInjectionMethod,
  materializeRoleBinding,
  resolveProviderRoleBindingSupport,
  toRoleBindingReceipt,
} from "./role-binding.js";
import { getRoleDefinition } from "./role-definitions.js";

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

function createExtraClient(provider: string): AgentClient {
  return {
    provider,
    capabilities: TEST_CAPABILITIES,
    async createSession() {
      throw new Error("not implemented");
    },
    async resumeSession() {
      throw new Error("not implemented");
    },
    async fetchCatalog() {
      return { models: [] as AgentModelDefinition[], modes: [] as AgentMode[] };
    },
    async isAvailable() {
      return true;
    },
  } satisfies AgentClient;
}

describe("detectLegacyProviderRole", () => {
  test.each([
    [["codex-profile", "lead"], "lead"],
    [["/usr/local/bin/codex-profile.py", "peer"], "peer"],
    [["codex-cliproxy-profile", "supervisor"], "supervisor"],
    [["omp-role", "peer"], "peer"],
    [["claude", "--agent", "paseo-lead"], "lead"],
    [["claude.exe", "--agent", "paseo-supervisor"], "supervisor"],
  ] as const)("recognizes legacy wrapper %j as role %s", (command, roleId) => {
    expect(detectLegacyProviderRole(command as unknown as readonly string[])).toBe(roleId);
  });

  test.each([
    [["claude"], null],
    [["claude", "--agent", "custom-agent"], null],
    [["codex-profile"], null],
    [["codex-profile", "admin"], null],
    [undefined, null],
  ] as const)("does not infer a role from %j", (command, expected) => {
    expect(detectLegacyProviderRole(command as readonly string[] | undefined)).toBe(expected);
  });
});

describe("resolveProviderRoleBindingSupport", () => {
  test.each([
    ["codex", "codex-developer-instructions"],
    ["claude", "claude-system-prompt"],
    ["pi", "pi-before-agent-start"],
    ["omp", "omp-append-system-prompt"],
    ["mock", "mock-launch-context"],
  ])("builtin family %s resolves to %s", (family, injectionMethod) => {
    const support = resolveProviderRoleBindingSupport(family);
    expect(support).toMatchObject({ status: "supported", injectionMethod });
  });

  test("custom providers inherit the base family channel", () => {
    const support = resolveProviderRoleBindingSupport("my-codex", "codex");
    expect(support).toEqual({
      status: "supported",
      injectionMethod: "codex-developer-instructions",
    });
  });

  test("generic ACP and unknown providers fail closed", () => {
    for (const provider of ["my-acp", "copilot", "cursor", "opencode"]) {
      const support = resolveProviderRoleBindingSupport(provider);
      expect(support.status).toBe("unsupported");
      if (support.status === "unsupported") {
        expect(support.reason).toContain(provider);
      }
    }
  });

  test("legacy role wrappers are excluded from the native role-first flow", () => {
    const support = resolveProviderRoleBindingSupport("codex-lead", "codex", "lead");
    expect(support.status).toBe("unsupported");
    if (support.status === "unsupported") {
      expect(support.reason).toContain("already pinned");
    }
  });

  test("expectedInjectionMethod mirrors supported families", () => {
    expect(expectedInjectionMethod("claude")).toBe("claude-system-prompt");
    expect(expectedInjectionMethod("my-claude", "claude")).toBe("claude-system-prompt");
    expect(expectedInjectionMethod("copilot")).toBeNull();
  });
});

describe("materializeRoleBinding", () => {
  test("materializes an immutable Lead binding with digests over definition bytes", () => {
    const definition = getRoleDefinition("lead");
    const binding = materializeRoleBinding({
      roleId: "lead",
      provider: "codex",
      createdAt: new Date("2026-08-17T00:00:00.000Z"),
    });

    expect(binding).toMatchObject({
      roleId: "lead",
      definitionVersion: PASEO_ROLE_DEFINITIONS_VERSION,
      provider: "codex",
      injectionMethod: "codex-developer-instructions",
      qualification: "implementation-supported",
      createdAt: "2026-08-17T00:00:00.000Z",
    });
    expect(binding.definitionDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(binding.bindingDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(binding.instructions.length).toBeGreaterThan(0);
    expect(binding.instructions).toContain(definition.instructions);
  });

  test("each role definition carries distinct standing instructions", () => {
    const definitions = (["lead", "peer", "supervisor"] as const).map((roleId) =>
      getRoleDefinition(roleId),
    );
    expect(new Set(definitions.map((definition) => definition.instructions)).size).toBe(3);
    for (const definition of definitions) {
      expect(definition.instructions).toContain("Room role:");
    }
  });

  test("rejects providers without a qualified native channel", () => {
    expect(() => materializeRoleBinding({ roleId: "lead", provider: "copilot" })).toThrowError(
      /no qualified native durable role-instruction channel/u,
    );
  });

  test("rejects roles outside the provider eligibility ceiling", () => {
    const peerOnly: ProviderRoleBindingSupport = {
      status: "supported",
      injectionMethod: "claude-system-prompt",
      roleIds: ["peer"],
    };
    expect(() =>
      materializeRoleBinding({
        roleId: "lead",
        provider: "claude",
        providerSupport: peerOnly,
      }),
    ).toThrowError(/eligibility is limited/u);
  });

  test("receipts strip materialized instruction bytes", () => {
    const binding = materializeRoleBinding({ roleId: "peer", provider: "pi" });
    const receipt = toRoleBindingReceipt(binding);
    expect(receipt).not.toHaveProperty("instructions");
    expect(receipt.roleId).toBe("peer");
    expect(receipt.injectionMethod).toBe("pi-before-agent-start");
  });

  test("persisted bindings must match the session provider", () => {
    const binding = materializeRoleBinding({ roleId: "lead", provider: "codex" });
    expect(() => assertPersistedRoleBindingMatches(binding, "codex")).not.toThrow();
    expect(() => assertPersistedRoleBindingMatches(binding, "claude")).toThrowError(
      /does not match session provider/u,
    );
  });
});

describe("provider snapshot role binding support", () => {
  test("snapshot entries expose daemon-computed role binding support", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: { codex: createExtraClient("codex") },
    });
    try {
      const entries = await manager.listProviders({
        cwd: "/tmp/project",
        providers: ["codex"],
        wait: true,
      });
      const codex = entries.find((entry) => entry.provider === "codex");
      expect(codex?.roleBinding).toEqual({
        status: "supported",
        injectionMethod: "codex-developer-instructions",
      });

      const state = manager.getAgentManagerProviderState();
      expect(state.roleBindingSupport["codex"]).toEqual({
        status: "supported",
        injectionMethod: "codex-developer-instructions",
      });
    } finally {
      manager.destroy();
    }
  });

  test("legacy wrapper commands surface as unsupported without name-based inference", async () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        "codex-lead": {
          extends: "codex",
          label: "Codex Lead",
          command: ["/opt/paseo/codex-profile", "lead"],
        },
      },
    });
    try {
      const entries = await manager.listProviders({
        cwd: "/tmp/project",
        providers: ["codex-lead"],
        wait: true,
      });
      const legacy = entries.find((entry) => entry.provider === "codex-lead");
      expect(legacy?.roleBinding?.status).toBe("unsupported");
    } finally {
      manager.destroy();
    }
  });
});
