import { z } from "zod";

export const PASEO_ROLE_IDS = ["lead", "peer", "supervisor"] as const;

export const PaseoRoleIdSchema = z.enum(PASEO_ROLE_IDS);
export type PaseoRoleId = z.infer<typeof PaseoRoleIdSchema>;

// Version of the bundled role definition bytes. Changing standing role
// instructions requires bumping this so persisted receipts expose the drift.
export const PASEO_ROLE_DEFINITIONS_VERSION = "1.0.0";

export const PASEO_ROLE_SUMMARIES = [
  {
    id: "lead",
    label: "Lead",
    description:
      "Owns routing, integration, engineering decisions, and acceptance across the project.",
  },
  {
    id: "peer",
    label: "Peer",
    description: "Owns independent technical judgment inside one bounded assignment.",
  },
  {
    id: "supervisor",
    label: "Supervisor",
    description: "Observes orchestration and advises the Human without becoming a super-Lead.",
  },
] as const satisfies ReadonlyArray<{
  id: PaseoRoleId;
  label: string;
  description: string;
}>;

export const RoleBindingInjectionMethodSchema = z.enum([
  "codex-developer-instructions",
  "claude-system-prompt",
  "pi-before-agent-start",
  "omp-append-system-prompt",
  "mock-launch-context",
]);
export type RoleBindingInjectionMethod = z.infer<typeof RoleBindingInjectionMethodSchema>;

export const ProviderRoleBindingSupportSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("supported"),
    injectionMethod: RoleBindingInjectionMethodSchema,
    // COMPAT(providerRoleIds): absence means all roles.
    roleIds: z.array(PaseoRoleIdSchema).min(1).optional(),
    notice: z.string().optional(),
  }),
  z.object({
    status: z.literal("unsupported"),
    reason: z.string(),
    // An unavailable provider can still declare its policy admission set so
    // callers distinguish role denial from a separate transport blocker.
    roleIds: z.array(PaseoRoleIdSchema).min(1).optional(),
  }),
]);
export type ProviderRoleBindingSupport = z.infer<typeof ProviderRoleBindingSupportSchema>;

export function isProviderRoleBindingSupportedForRole(
  support: ProviderRoleBindingSupport | null | undefined,
  roleId: PaseoRoleId | null | undefined,
): boolean {
  return (
    roleId !== null &&
    roleId !== undefined &&
    support?.status === "supported" &&
    (support.roleIds === undefined || support.roleIds.includes(roleId))
  );
}

const Sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const RoleBindingReceiptSchema = z.object({
  roleId: PaseoRoleIdSchema,
  definitionVersion: z.string(),
  definitionDigest: Sha256DigestSchema,
  bindingDigest: Sha256DigestSchema,
  provider: z.string(),
  injectionMethod: RoleBindingInjectionMethodSchema,
  qualification: z.literal("implementation-supported"),
  createdAt: z.string(),
});
export type RoleBindingReceipt = z.infer<typeof RoleBindingReceiptSchema>;
