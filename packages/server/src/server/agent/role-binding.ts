import { createHash } from "node:crypto";
import {
  isProviderRoleBindingSupportedForRole,
  PaseoRoleIdSchema,
  RoleBindingReceiptSchema,
  type PaseoRoleId,
  type ProviderRoleBindingSupport,
  type RoleBindingInjectionMethod,
  type RoleBindingReceipt,
} from "@getpaseo/protocol/role-binding";
import { z } from "zod";

import { getRoleDefinition } from "./role-definitions.js";

export const PersistedRoleBindingSchema = RoleBindingReceiptSchema.extend({
  instructions: z.string().min(1),
});

export type PersistedRoleBinding = z.infer<typeof PersistedRoleBindingSchema>;

export interface MaterializeRoleBindingInput {
  roleId: PaseoRoleId;
  provider: string;
  providerBaseId?: string | null;
  providerSupport?: ProviderRoleBindingSupport;
  createdAt?: Date;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveProviderFamily(provider: string, providerBaseId?: string | null): string {
  return providerBaseId ?? provider;
}

function commandBasename(command: string): string {
  return command.split(/[\\/]/u).at(-1) ?? command;
}

function resolveBuiltInRoleBindingSupport(family: string): ProviderRoleBindingSupport | null {
  if (family === "mock") {
    return {
      status: "supported",
      injectionMethod: "mock-launch-context",
      notice: "Development-only synthetic provider; role instructions are bound at session launch.",
    };
  }
  const injectionMethods: Partial<Record<string, RoleBindingInjectionMethod>> = {
    codex: "codex-developer-instructions",
    claude: "claude-system-prompt",
    pi: "pi-before-agent-start",
    omp: "omp-append-system-prompt",
  };
  const injectionMethod = injectionMethods[family];
  return injectionMethod ? { status: "supported", injectionMethod } : null;
}

// COMPAT(legacyProviderRoleDetection): fail-closed migration guard only. Delete after
// 2026-09-30 together with legacy role-link inventory; no installer creates these.
export const LEGACY_PROVIDER_ROLE_DETECTION_EXPIRES_AT = "2026-09-30";

export function detectLegacyProviderRole(
  command: readonly string[] | undefined,
): PaseoRoleId | null {
  if (!command || command.length < 2) return null;

  const executable = commandBasename(command[0]);
  if (
    [
      "codex-profile",
      "codex-profile.py",
      "codex-cliproxy-profile",
      "codex-cliproxy-profile.py",
      "omp-role",
    ].includes(executable)
  ) {
    const parsed = PaseoRoleIdSchema.safeParse(command[1]);
    return parsed.success ? parsed.data : null;
  }

  if (executable === "claude" || executable === "claude.exe") {
    const agentFlag = command.indexOf("--agent");
    const agentName = agentFlag >= 0 ? command[agentFlag + 1] : undefined;
    const match = agentName?.match(/^paseo-(lead|peer|supervisor)$/u);
    if (match) {
      return PaseoRoleIdSchema.parse(match[1]);
    }
  }

  return null;
}

export function resolveProviderRoleBindingSupport(
  provider: string,
  providerBaseId?: string | null,
  legacyRoleId?: PaseoRoleId | null,
): ProviderRoleBindingSupport {
  if (legacyRoleId) {
    return {
      status: "unsupported",
      reason:
        `Legacy provider transport is already pinned to Paseo role '${legacyRoleId}'. ` +
        "Use a transport-only provider in the native role-first flow.",
    };
  }
  const family = resolveProviderFamily(provider, providerBaseId);
  const builtInSupport = resolveBuiltInRoleBindingSupport(family);
  if (builtInSupport) return builtInSupport;
  return {
    status: "unsupported",
    reason: `Provider family '${family}' has no qualified native durable role-instruction channel`,
  };
}

export function materializeRoleBinding(input: MaterializeRoleBindingInput): PersistedRoleBinding {
  const support =
    input.providerSupport ??
    resolveProviderRoleBindingSupport(input.provider, input.providerBaseId);
  if (support.roleIds && !support.roleIds.includes(input.roleId)) {
    throw new Error(
      `Provider '${input.provider}' cannot bind Paseo role '${input.roleId}': provider eligibility is limited to role(s): ${support.roleIds.join(", ")}`,
    );
  }
  if (support.status === "unsupported") {
    throw new Error(
      `Provider '${input.provider}' cannot bind Paseo role '${input.roleId}': ${support.reason}`,
    );
  }
  if (!isProviderRoleBindingSupportedForRole(support, input.roleId)) {
    throw new Error(
      `Provider '${input.provider}' cannot bind Paseo role '${input.roleId}': provider eligibility is limited to role(s): ${support.roleIds?.join(", ") ?? "none"}`,
    );
  }

  const definition = getRoleDefinition(input.roleId);
  const instructions = definition.instructions;

  return {
    roleId: input.roleId,
    definitionVersion: definition.version,
    definitionDigest: sha256(definition.instructions),
    bindingDigest: sha256(instructions),
    provider: input.provider,
    injectionMethod: support.injectionMethod,
    qualification: "implementation-supported",
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    instructions,
  };
}

export function toRoleBindingReceipt(binding: PersistedRoleBinding): RoleBindingReceipt {
  return RoleBindingReceiptSchema.parse(binding);
}

export function assertPersistedRoleBindingMatches(
  binding: PersistedRoleBinding,
  provider: string,
): void {
  if (binding.provider !== provider) {
    throw new Error(
      `Persisted role binding provider '${binding.provider}' does not match session provider '${provider}'`,
    );
  }
}

export function expectedInjectionMethod(
  provider: string,
  providerBaseId?: string | null,
): RoleBindingInjectionMethod | null {
  const support = resolveProviderRoleBindingSupport(provider, providerBaseId);
  return support.status === "supported" ? support.injectionMethod : null;
}
