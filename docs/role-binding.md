# Role binding

Lead, Peer, and Supervisor are native roles picked at agent creation, without editing provider config. Selecting a role makes the daemon — not the caller — own that agent's standing instructions for its whole life.

## Flow

1. The daemon computes role support for every provider in the snapshot (`getRoleBindingSupport` in `packages/server/src/server/agent/provider-snapshot-manager.ts`). Support follows the provider **family** (`codex`, `claude`, `pi`, `omp`, `mock`), so a custom provider with `extends: "codex"` inherits the Codex channel. Everything else is `unsupported` — there is no fallback to initial prompts.
2. Each `ProviderSnapshotEntry` carries the result in `roleBinding` (`packages/protocol/src/messages.ts`). The field is optional: an old daemon never sends it, and the app hides the role picker when no entry has it. That presence check is the only feature gate — no `server_info.features.*` flag.
3. The composer's role dropdown (draft agents) lives in `packages/app/src/composer/agent-controls/index.tsx`, fed by `input-draft.ts`. Picking a role filters the provider/model lists to compatible providers and auto-switches off an incompatible one.
4. Submit sends `roleId` top-level on `create_agent_request` (never inside `config`). `AgentManager.createAgentInternal` rejects `roleId` together with `config.systemPrompt` — the role owns the durable instruction channel — then materializes an immutable binding and attaches it to the launch context.
5. Each adapter injects the binding through its native channel on create **and** resume:

| Family | Channel                                                                                     | Site                                  |
| ------ | ------------------------------------------------------------------------------------------- | ------------------------------------- |
| codex  | `developerInstructions` on `thread/start` (and collaboration-mode `developer_instructions`) | `providers/codex-app-server-agent.ts` |
| claude | Claude Code preset `systemPrompt.append`; native subagents disabled while role-bound        | `providers/claude/agent.ts`           |
| pi     | generated `before_agent_start` extension                                                    | `providers/pi/agent.ts`               |
| omp    | `--append-system-prompt`                                                                    | `providers/omp/agent.ts`              |
| mock   | recorded on the session for tests                                                           | `providers/mock-load-test-agent.ts`   |

6. The full binding (including instruction bytes) persists on the agent record (`roleBinding` in `STORED_AGENT_SCHEMA`); resume and reload reuse the exact persisted bytes and never re-resolve from the catalog. The wire payload exposes only the secret-safe receipt (`toRoleBindingReceipt` strips instructions); the live composer shows the bound role as a read-only badge.

## Invariants

- Role-bound agents pin their model at create; `setAgentModel` rejects changes.
- `definitionDigest`/`bindingDigest` are sha256 over the instruction bytes. Changing the standing bytes in `packages/server/src/server/agent/role-definitions.ts` requires bumping `PASEO_ROLE_DEFINITIONS_VERSION` so old receipts expose the drift.
- Role definitions are the demonthorn profile bytes (`profiles/roles/*.md` in the demonthorn tree), embedded verbatim in `role-definitions.ts`.

## Legacy role wrappers fail closed

Custom providers whose command is a legacy per-role wrapper (`codex-profile <role>`, `codex-cliproxy-profile <role>`, `omp-role <role>`, `claude --agent paseo-<role>`) are detected by `detectLegacyProviderRole` and marked `unsupported` — their transport already carries a role, and double-binding would create two authority sources. This is a migration guard (`COMPAT(legacyProviderRoleDetection)`, expires 2026-09-30). Role is never inferred from an arbitrary provider name.

## Scope

Ported from the paseo-doctrine-downstream fork as the minimal core of its native role binding (`docs/native-role-binding.md` there). Deliberately not ported: workspace-protocol admission gating, assignment contracts, Beads/Council tool ceilings, execution profiles, launch contracts, and the Cursor/Antigravity ACP drivers. If you need those, port them as separate decisions — do not grow this feature sideways.
