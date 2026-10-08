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
  const models = configuredModels.filter((model) => model.thinkingOptions?.length);
  if (models.length === 0) return null;

  function getConfiguredModel(modelId: string | null): ProviderProfileModel | undefined {
    if (!modelId) return undefined;
    const id = modelId.split("\t", 1)[0];
    return models.find(
      (model) =>
        model.id === id ||
        model.thinkingOptions?.some((option) => `${model.id}-${option.id}` === id),
    );
  }

  async function selectModelVariant(input: {
    connection: ACPProviderModelWriterContext["connection"];
    sessionId: string;
    configOptions: SessionConfigOption[];
    modelId: string;
    thinkingOptionId: string;
  }): Promise<SessionConfigOption[]> {
    const option = findSelectConfigOption({
      configOptions: input.configOptions,
      category: "model",
    });
    if (!option) throw new Error("Antigravity ACP does not expose model selection");

    const variantId = `${input.modelId}-${input.thinkingOptionId}`;
    const choice = flattenSelectOptions(option.options).find(
      (candidate) => candidate.value.split("\t", 1)[0] === variantId,
    );
    if (!choice) {
      throw new Error(`Antigravity ACP does not expose configured model variant "${variantId}"`);
    }
    const response = await input.connection.setSessionConfigOption({
      sessionId: input.sessionId,
      configId: option.id,
      value: choice.value,
    });
    return response.configOptions;
  }

  return {
    async providerModelWriter(context) {
      const model = getConfiguredModel(context.requestedModelId);
      if (!model?.thinkingOptions?.length) return { handled: false };

      const thinkingOption =
        model.thinkingOptions.find((option) => option.id === context.currentThinkingOptionId) ??
        model.thinkingOptions.find((option) => option.isDefault) ??
        model.thinkingOptions[0]!;
      const configOptions = await selectModelVariant({
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
        configOptions,
      };
    },
    async thinkingOptionWriter(context) {
      const model = getConfiguredModel(context.modelId);
      if (!model?.thinkingOptions?.length) {
        throw new Error("Antigravity thinking requires a configured model with thinking options");
      }
      const isConfigured = model.thinkingOptions.some(
        (option) => option.id === context.thinkingOptionId,
      );
      if (!isConfigured) {
        throw new Error(
          `Unknown Antigravity thinking option "${context.thinkingOptionId}" for model "${model.id}"`,
        );
      }
      await selectModelVariant({
        connection: context.connection,
        sessionId: context.sessionId,
        configOptions: context.configOptions,
        modelId: model.id,
        thinkingOptionId: context.thinkingOptionId,
      });
    },
  };
}

function flattenSelectOptions(options: SelectConfigOption["options"]): Array<{ value: string }> {
  const flattened: Array<{ value: string }> = [];
  for (const option of options) {
    if ("value" in option) {
      flattened.push(option);
    } else {
      flattened.push(...option.options);
    }
  }
  return flattened;
}
