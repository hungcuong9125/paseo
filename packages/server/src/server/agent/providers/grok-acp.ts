import path from "node:path";

import type { ClientSideConnection } from "@agentclientprotocol/sdk";

import type { AgentSelectOption } from "../agent-sdk-types.js";

export const GROK_REASONING_EFFORT_META_KEY = "reasoningEffort";
export const GROK_SESSION_CONFIG_META_KEY = "x.ai/sessionConfig";

export interface GrokThinkingOptionWriteInput {
  connection: ClientSideConnection;
  sessionId: string;
  thinkingOptionId: string;
  modelId: string | null;
  availableModels?: Array<{
    modelId: string;
    _meta?: { [key: string]: unknown } | null;
  }> | null;
  sessionMeta?: { [key: string]: unknown } | null;
}

interface GrokThinkingDerivationInput {
  modelMeta?: { [key: string]: unknown } | null;
  sessionMeta?: { [key: string]: unknown } | null;
}

export function isGrokACPProvider(
  providerId: string | undefined,
  command: readonly string[],
): boolean {
  if (providerId === "grok" || providerId?.startsWith("grok-") === true) {
    return true;
  }
  return isGrokACPCommand(command);
}

export function isGrokACPCommand(command: readonly string[]): boolean {
  const binary = path.basename(command[0] ?? "").toLowerCase();
  if (binary !== "grok" && binary !== "grok.exe") {
    return false;
  }
  const args = command.slice(1);
  const agentIndex = args.indexOf("agent");
  return agentIndex >= 0 && args[agentIndex + 1] === "stdio";
}

export function buildGrokNewSessionMeta(input: {
  thinkingOptionId?: string | null;
}): { [key: string]: unknown } | undefined {
  if (!input.thinkingOptionId) {
    return undefined;
  }
  return { [GROK_REASONING_EFFORT_META_KEY]: input.thinkingOptionId };
}

export function buildGrokSetSessionModelMeta(input: {
  thinkingOptionId?: string | null;
}): { [key: string]: unknown } | undefined {
  return buildGrokNewSessionMeta(input);
}

export function deriveGrokThinkingOptions(input: GrokThinkingDerivationInput): AgentSelectOption[] {
  if (modelSupportsReasoningEffort(input.modelMeta) === false) {
    return [];
  }

  const modelCurrent = readOptionalString(input.modelMeta?.reasoningEffort);
  const modelEfforts = readEffortOptions(input.modelMeta?.reasoningEfforts, modelCurrent);
  if (modelEfforts.length > 0) {
    return modelEfforts;
  }

  return readSessionConfigEfforts(input.sessionMeta, modelCurrent);
}

export function deriveGrokCurrentThinkingOptionId(input: {
  models?: Array<{
    modelId: string;
    _meta?: { [key: string]: unknown } | null;
  }> | null;
  currentModelId?: string | null;
  sessionMeta?: { [key: string]: unknown } | null;
}): string | null {
  const currentModel = input.models?.find((model) => model.modelId === input.currentModelId);
  const options = deriveGrokThinkingOptions({
    modelMeta: currentModel?._meta,
    sessionMeta: input.sessionMeta,
  });
  return (
    options.find((option) => option.isDefault)?.id ??
    readOptionalString(currentModel?._meta?.reasoningEffort)
  );
}

export async function writeGrokThinkingOption(
  context: GrokThinkingOptionWriteInput,
): Promise<void> {
  const { connection, sessionId, thinkingOptionId, modelId, availableModels, sessionMeta } =
    context;
  if (!modelId) {
    throw new Error("Grok thinking requires a current session model");
  }
  if (typeof connection.unstable_setSessionModel !== "function") {
    throw new Error("Grok thinking requires ACP session/set_model");
  }

  const model = availableModels?.find((entry) => entry.modelId === modelId);
  if (modelSupportsReasoningEffort(model?._meta) === false) {
    throw new Error(`Model "${modelId}" does not support reasoning effort`);
  }

  const allowedOptions = deriveGrokThinkingOptions({
    modelMeta: model?._meta,
    sessionMeta,
  });
  if (allowedOptions.length > 0) {
    const allowedIds = allowedOptions.map((option) => option.id);
    if (!allowedIds.includes(thinkingOptionId)) {
      throw new Error(
        `Unknown Grok reasoning effort "${thinkingOptionId}". Allowed: ${allowedIds.join(", ")}`,
      );
    }
  }

  await connection.unstable_setSessionModel({
    sessionId,
    modelId,
    _meta: { [GROK_REASONING_EFFORT_META_KEY]: thinkingOptionId },
  });
}

function modelSupportsReasoningEffort(
  meta: { [key: string]: unknown } | null | undefined,
): boolean | null {
  if (meta == null) {
    return null;
  }
  if (meta.supportsReasoningEffort === false) {
    return false;
  }
  if (meta.supportsReasoningEffort === true) {
    return true;
  }
  return null;
}

function readSessionConfigEfforts(
  sessionMeta: { [key: string]: unknown } | null | undefined,
  current: string | null,
): AgentSelectOption[] {
  const raw = sessionMeta?.[GROK_SESSION_CONFIG_META_KEY];
  if (!isRecord(raw) || !Array.isArray(raw.options)) {
    return [];
  }

  const grouped = raw.options.find(
    (entry) => isRecord(entry) && entry.category === "mode" && Array.isArray(entry.options),
  );
  if (isRecord(grouped)) {
    const groupedCurrent = current ?? readOptionalString(grouped.currentValue);
    return readEffortOptions(grouped.options, groupedCurrent);
  }

  const flatIds: string[] = [];
  const labels = new Map<string, string>();
  let selected: string | null = current;
  for (const entry of raw.options) {
    if (!isRecord(entry) || entry.category !== "mode") {
      continue;
    }
    const id = readOptionalString(entry.id) ?? readOptionalString(entry.value);
    if (!id) {
      continue;
    }
    flatIds.push(id);
    const label = readOptionalString(entry.label) ?? readOptionalString(entry.name);
    if (label) {
      labels.set(id, label);
    }
    if (entry.current === true || entry.selected === true) {
      selected = id;
    }
  }
  return toThinkingOptions(flatIds, selected, labels);
}

function readEffortOptions(value: unknown, current: string | null): AgentSelectOption[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const options: AgentSelectOption[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0) {
      options.push({
        id: entry,
        label: entry,
        isDefault: current !== null && entry === current,
      });
      continue;
    }
    if (!isRecord(entry)) {
      continue;
    }
    const id = readOptionalString(entry.id) ?? readOptionalString(entry.value);
    if (!id) {
      continue;
    }
    const description = readOptionalString(entry.description);
    options.push({
      id,
      label: readOptionalString(entry.label) ?? readOptionalString(entry.name) ?? id,
      ...(description ? { description } : {}),
      isDefault: current !== null ? id === current : entry.default === true,
    });
  }
  return options;
}

function toThinkingOptions(
  ids: string[],
  current: string | null,
  labels?: Map<string, string>,
): AgentSelectOption[] {
  return ids.map((id) => ({
    id,
    label: labels?.get(id) ?? id,
    isDefault: current !== null && id === current,
  }));
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
