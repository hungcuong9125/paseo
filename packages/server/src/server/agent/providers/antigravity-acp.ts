import path from "node:path";

import type { SessionConfigOption } from "@agentclientprotocol/sdk";

import type { ProviderProfileModel } from "../provider-launch-config.js";
import {
  findSelectConfigOption,
  type ACPProviderModelWriterContext,
  type ACPProviderModelWriteResult,
  type ACPThinkingOptionWriterContext,
  type SelectConfigOption,
} from "./acp-agent.js";

export interface AntigravityACPThinkingBridge {
  providerModelWriter: (
    context: ACPProviderModelWriterContext,
  ) => Promise<ACPProviderModelWriteResult>;
  thinkingOptionWriter: (context: ACPThinkingOptionWriterContext) => Promise<void>;
}

export function isAntigravityACPProvider(
  providerId: string | undefined,
  command: readonly string[],
): boolean {
  if (providerId === "antigravity" || providerId?.startsWith("antigravity-") === true) {
    return true;
  }
  const binary = path.basename(command[0] ?? "").toLowerCase();
  return binary === "agy-acp" || binary === "agy-acp.exe";
}

export function createAntigravityACPThinkingBridge(
  configuredModels: readonly ProviderProfileModel[],
): AntigravityACPThinkingBridge | null {
  const thinkingModels = configuredModels.filter((model) => model.thinkingOptions?.length);
  if (thinkingModels.length === 0) {
    return null;
  }

  const modelsById = new Map(thinkingModels.map((model) => [model.id, model]));

  return {
    providerModelWriter: async (context) => {
      const model = modelsById.get(context.requestedModelId);
      if (!model?.thinkingOptions?.length) {
        return { handled: false };
      }
      const thinkingOption =
        model.thinkingOptions.find((option) => option.id === context.currentThinkingOptionId) ??
        model.thinkingOptions.find((option) => option.isDefault) ??
        model.thinkingOptions[0];
      const response = await selectAntigravityModelVariant({
        connection: context.connection,
        sessionId: context.sessionId,
        configOptions: context.configOptions,
        modelId: model.id,
        thinkingOptionId: thinkingOption.id,
      });
      return {
        handled: true,
        currentModelId: model.id,
        currentThinkingOptionId: thinkingOption.id,
        configOptions: response.configOptions,
      };
    },
    thinkingOptionWriter: async (context) => {
      const model = context.modelId ? modelsById.get(context.modelId) : undefined;
      if (!model?.thinkingOptions?.length) {
        throw new Error("Antigravity thinking requires a configured model with thinkingOptions");
      }
      if (!model.thinkingOptions.some((option) => option.id === context.thinkingOptionId)) {
        throw new Error(
          `Unknown Antigravity thinking option "${context.thinkingOptionId}" for model "${model.id}". Allowed: ${model.thinkingOptions
            .map((option) => option.id)
            .join(", ")}`,
        );
      }
      await selectAntigravityModelVariant({
        connection: context.connection,
        sessionId: context.sessionId,
        configOptions: context.configOptions,
        modelId: model.id,
        thinkingOptionId: context.thinkingOptionId,
      });
    },
  };
}

async function selectAntigravityModelVariant({
  connection,
  sessionId,
  configOptions,
  modelId,
  thinkingOptionId,
}: {
  connection: ACPProviderModelWriterContext["connection"];
  sessionId: string;
  configOptions: SessionConfigOption[];
  modelId: string;
  thinkingOptionId: string;
}): Promise<{ configOptions: SessionConfigOption[] }> {
  const modelOption = findSelectConfigOption({ configOptions, category: "model" });
  if (!modelOption) {
    throw new Error("Antigravity ACP does not expose model selection");
  }
  const variantId = `${modelId}-${thinkingOptionId}`;
  const choice = flattenSelectOptions(modelOption.options).find(
    (option) => option.value === variantId || option.value.split("\t", 1)[0] === variantId,
  );
  if (!choice) {
    throw new Error(
      `Antigravity ACP does not expose model variant "${variantId}" for configured thinking option`,
    );
  }
  return await connection.setSessionConfigOption({
    sessionId,
    configId: modelOption.id,
    value: variantId,
  });
}

function flattenSelectOptions(options: SelectConfigOption["options"]): Array<{ value: string }> {
  const flattened: Array<{ value: string }> = [];
  for (const option of options) {
    if ("value" in option) {
      flattened.push(option);
      continue;
    }
    flattened.push(...option.options);
  }
  return flattened;
}
