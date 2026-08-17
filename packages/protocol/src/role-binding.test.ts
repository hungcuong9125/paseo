import { describe, expect, test } from "vitest";

import {
  isProviderRoleBindingSupportedForRole,
  PASEO_ROLE_DEFINITIONS_VERSION,
  PASEO_ROLE_IDS,
  PASEO_ROLE_SUMMARIES,
  ProviderRoleBindingSupportSchema,
  RoleBindingReceiptSchema,
} from "./role-binding.js";

describe("Paseo role binding protocol", () => {
  test("publishes the three Foundation roles under one definitions version", () => {
    expect(PASEO_ROLE_IDS).toEqual(["lead", "peer", "supervisor"]);
    expect(PASEO_ROLE_SUMMARIES.map((summary) => summary.id)).toEqual(PASEO_ROLE_IDS);
    for (const summary of PASEO_ROLE_SUMMARIES) {
      expect(summary.label.length).toBeGreaterThan(0);
      expect(summary.description.length).toBeGreaterThan(0);
    }
    expect(PASEO_ROLE_DEFINITIONS_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  test("keeps supported and unsupported provider capability explicit", () => {
    expect(
      ProviderRoleBindingSupportSchema.parse({
        status: "supported",
        injectionMethod: "codex-developer-instructions",
      }),
    ).toEqual({
      status: "supported",
      injectionMethod: "codex-developer-instructions",
    });
    expect(
      ProviderRoleBindingSupportSchema.parse({
        status: "supported",
        injectionMethod: "mock-launch-context",
      }),
    ).toEqual({
      status: "supported",
      injectionMethod: "mock-launch-context",
    });
    expect(() => ProviderRoleBindingSupportSchema.parse({ status: "unsupported" })).toThrow();
    expect(() =>
      ProviderRoleBindingSupportSchema.parse({
        status: "candidate",
        injectionMethod: "codex-developer-instructions",
        reason: "runtime canary required",
      }),
    ).toThrow();

    const peerOnly = ProviderRoleBindingSupportSchema.parse({
      status: "supported",
      injectionMethod: "claude-system-prompt",
      roleIds: ["peer"],
    });
    expect(isProviderRoleBindingSupportedForRole(peerOnly, "peer")).toBe(true);
    expect(isProviderRoleBindingSupportedForRole(peerOnly, "lead")).toBe(false);
    expect(isProviderRoleBindingSupportedForRole(peerOnly, "supervisor")).toBe(false);
    expect(isProviderRoleBindingSupportedForRole(peerOnly, null)).toBe(false);

    const unavailablePeerOnly = ProviderRoleBindingSupportSchema.parse({
      status: "unsupported",
      reason: "transport unavailable",
      roleIds: ["peer"],
    });
    expect(unavailablePeerOnly.roleIds).toEqual(["peer"]);
    expect(isProviderRoleBindingSupportedForRole(unavailablePeerOnly, "peer")).toBe(false);
  });

  test("role receipts contain no materialized instruction bytes", () => {
    const receipt = RoleBindingReceiptSchema.parse({
      roleId: "lead",
      definitionVersion: PASEO_ROLE_DEFINITIONS_VERSION,
      definitionDigest: "a".repeat(64),
      bindingDigest: "c".repeat(64),
      provider: "codex",
      injectionMethod: "codex-developer-instructions",
      qualification: "implementation-supported",
      createdAt: "2026-08-05T00:00:00.000Z",
      instructions: "must be stripped",
    });

    expect(receipt).not.toHaveProperty("instructions");
  });
});
