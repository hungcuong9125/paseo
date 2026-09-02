import { describe, expect, test, vi } from "vitest";
import type { ClientSideConnection, SessionConfigOption } from "@agentclientprotocol/sdk";

import { createAntigravityACPThinkingBridge, isAntigravityACPProvider } from "./antigravity-acp.js";

const CONFIGURED_MODELS = [
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    thinkingOptions: [
      { id: "high", label: "High" },
      { id: "medium", label: "Medium", isDefault: true },
      { id: "low", label: "Low" },
    ],
  },
];

function antigravityModelOption(): SessionConfigOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
    options: [
      {
        value: "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
        name: "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
      },
      {
        value: "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
        name: "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
      },
      {
        value: "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
        name: "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
      },
    ],
  };
}

describe("isAntigravityACPProvider", () => {
  test("matches Antigravity provider ids and agy-acp commands", () => {
    expect(isAntigravityACPProvider("antigravity-peer", ["custom-acp"])).toBe(true);
    expect(isAntigravityACPProvider("custom", ["/Users/test/.local/bin/agy-acp"])).toBe(true);
    expect(isAntigravityACPProvider("custom", ["agy-acp.exe"])).toBe(true);
  });

  test("does not match unrelated ACP providers", () => {
    expect(isAntigravityACPProvider("grok-peer", ["grok", "agent", "stdio"])).toBe(false);
    expect(isAntigravityACPProvider("custom", ["kimi", "acp"])).toBe(false);
  });
});

describe("createAntigravityACPThinkingBridge", () => {
  test("maps a configured model and its default thinking option to the physical ACP model", async () => {
    const setSessionConfigOption = vi.fn(async () => ({
      configOptions: [antigravityModelOption()],
    }));
    const bridge = createAntigravityACPThinkingBridge(CONFIGURED_MODELS);
    expect(bridge).not.toBeNull();

    const result = await bridge!.providerModelWriter({
      connection: { setSessionConfigOption } as unknown as ClientSideConnection,
      sessionId: "session-1",
      requestedModelId: "gemini-3.8-flash",
      currentThinkingOptionId: null,
      configOptions: [antigravityModelOption()],
    });

    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      configId: "model",
      value: "gemini-3.8-flash-medium",
    });
    expect(result).toMatchObject({
      handled: true,
      currentModelId: "gemini-3.8-flash",
      currentThinkingOptionId: "medium",
    });
  });

  test("changes thinking by selecting the matching physical ACP model variant", async () => {
    const setSessionConfigOption = vi.fn(async () => ({
      configOptions: [antigravityModelOption()],
    }));
    const bridge = createAntigravityACPThinkingBridge(CONFIGURED_MODELS);

    await bridge!.thinkingOptionWriter({
      connection: { setSessionConfigOption } as unknown as ClientSideConnection,
      sessionId: "session-1",
      requestedThinkingOptionId: "low",
      currentModelId: "gemini-3.8-flash",
      configOptions: [antigravityModelOption()],
    });

    expect(setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: "session-1",
      configId: "model",
      value: "gemini-3.8-flash-low",
    });
  });

  test("fails closed when a configured variant is absent from the ACP model list", async () => {
    const bridge = createAntigravityACPThinkingBridge(CONFIGURED_MODELS);

    await expect(
      bridge!.thinkingOptionWriter({
        connection: { setSessionConfigOption: vi.fn() } as unknown as ClientSideConnection,
        sessionId: "session-1",
        requestedThinkingOptionId: "low",
        currentModelId: "gemini-3.8-flash",
        configOptions: [
          {
            ...antigravityModelOption(),
            options: [
              {
                value: "gemini-3.8-flash-high",
                name: "Gemini 3.8 Flash (High)",
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow('Antigravity ACP does not expose model variant "gemini-3.8-flash-low"');
  });
});
