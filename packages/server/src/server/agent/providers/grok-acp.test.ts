import { describe, expect, test, vi } from "vitest";
import type { ClientSideConnection } from "@agentclientprotocol/sdk";

import {
  GROK_REASONING_EFFORT_META_KEY,
  buildGrokNewSessionMeta,
  deriveGrokThinkingOptions,
  isGrokACPProvider,
  writeGrokThinkingOption,
} from "./grok-acp.js";

describe("isGrokACPProvider", () => {
  test("matches Grok seat overlays and grok agent stdio launches", () => {
    expect(isGrokACPProvider("grok-lead", ["echo"])).toBe(true);
    expect(isGrokACPProvider("grok-peer", ["echo"])).toBe(true);
    expect(isGrokACPProvider("grok-supervisor", ["echo"])).toBe(true);
    expect(isGrokACPProvider("grok-review", ["echo"])).toBe(true);
    expect(isGrokACPProvider("custom", ["grok", "agent", "stdio"])).toBe(true);
    expect(isGrokACPProvider("custom", ["/usr/local/bin/grok", "agent", "stdio"])).toBe(true);
  });

  test("does not match other ACP providers", () => {
    expect(isGrokACPProvider("kimi", ["kimi", "acp"])).toBe(false);
    expect(isGrokACPProvider("cursor", ["cursor-agent", "acp"])).toBe(false);
    expect(isGrokACPProvider("acp", ["my-agent", "stdio"])).toBe(false);
    expect(isGrokACPProvider("acp", ["grok", "chat"])).toBe(false);
  });
});

describe("deriveGrokThinkingOptions", () => {
  test("uses the model's reasoningEfforts list and current effort", () => {
    expect(
      deriveGrokThinkingOptions({
        modelMeta: {
          supportsReasoningEffort: true,
          reasoningEfforts: ["low", "medium", "high", "xhigh"],
          reasoningEffort: "medium",
        },
      }),
    ).toEqual([
      { id: "low", label: "low", isDefault: false },
      { id: "medium", label: "medium", isDefault: true },
      { id: "high", label: "high", isDefault: false },
      { id: "xhigh", label: "xhigh", isDefault: false },
    ]);
  });

  test("parses Grok's live object-shaped reasoningEfforts", () => {
    expect(
      deriveGrokThinkingOptions({
        modelMeta: {
          supportsReasoningEffort: true,
          reasoningEffort: "high",
          reasoningEfforts: [
            {
              id: "xhigh",
              value: "xhigh",
              label: "Extra High Effort",
              description: "Highest effort and reasoning level",
              default: true,
            },
            {
              id: "high",
              value: "high",
              label: "High Effort",
              description: "Higher implementation quality with extensive reasoning",
              default: true,
            },
            {
              id: "medium",
              value: "medium",
              label: "Medium Effort",
              default: false,
            },
            {
              id: "low",
              value: "low",
              label: "Low Effort",
              default: false,
            },
          ],
        },
      }),
    ).toEqual([
      {
        id: "xhigh",
        label: "Extra High Effort",
        description: "Highest effort and reasoning level",
        isDefault: false,
      },
      {
        id: "high",
        label: "High Effort",
        description: "Higher implementation quality with extensive reasoning",
        isDefault: true,
      },
      { id: "medium", label: "Medium Effort", isDefault: false },
      { id: "low", label: "Low Effort", isDefault: false },
    ]);
  });

  test("parses Grok's flat x.ai/sessionConfig mode options as effort ids", () => {
    expect(
      deriveGrokThinkingOptions({
        modelMeta: { supportsReasoningEffort: true },
        sessionMeta: {
          "x.ai/sessionConfig": {
            options: [
              { id: "grok-4.6", category: "model" },
              { id: "xhigh", category: "mode" },
              { id: "high", category: "mode" },
              { id: "medium", category: "mode" },
              { id: "low", category: "mode" },
            ],
          },
        },
      }),
    ).toEqual([
      { id: "xhigh", label: "xhigh", isDefault: false },
      { id: "high", label: "high", isDefault: false },
      { id: "medium", label: "medium", isDefault: false },
      { id: "low", label: "low", isDefault: false },
    ]);
  });

  test("omits thinking options when the model does not support effort", () => {
    expect(
      deriveGrokThinkingOptions({
        modelMeta: { supportsReasoningEffort: false, reasoningEfforts: ["low", "high"] },
      }),
    ).toEqual([]);
  });

  test("falls back to x.ai/sessionConfig mode options as effort ids", () => {
    expect(
      deriveGrokThinkingOptions({
        modelMeta: { supportsReasoningEffort: true },
        sessionMeta: {
          "x.ai/sessionConfig": {
            options: [
              {
                category: "mode",
                currentValue: "high",
                options: [
                  { value: "minimal", name: "Minimal" },
                  { value: "low", name: "Low" },
                  { value: "medium", name: "Medium" },
                  { value: "high", name: "High" },
                  { value: "xhigh", name: "Extra High" },
                ],
              },
            ],
          },
        },
      }),
    ).toEqual([
      { id: "minimal", label: "Minimal", isDefault: false },
      { id: "low", label: "Low", isDefault: false },
      { id: "medium", label: "Medium", isDefault: false },
      { id: "high", label: "High", isDefault: true },
      { id: "xhigh", label: "Extra High", isDefault: false },
    ]);
  });
});

describe("writeGrokThinkingOption", () => {
  test("calls session/set_model with the current model and reasoningEffort meta", async () => {
    const unstableSetSessionModel = vi.fn(async () => undefined);

    await writeGrokThinkingOption({
      connection: {
        unstable_setSessionModel: unstableSetSessionModel,
      } as unknown as ClientSideConnection,
      sessionId: "session-1",
      thinkingOptionId: "high",
      modelId: "grok-4.6",
      availableModels: [
        {
          modelId: "grok-4.6",
          _meta: {
            supportsReasoningEffort: true,
            reasoningEfforts: ["low", "medium", "high", "xhigh"],
          },
        },
      ],
    });

    expect(unstableSetSessionModel).toHaveBeenCalledWith({
      sessionId: "session-1",
      modelId: "grok-4.6",
      _meta: { [GROK_REASONING_EFFORT_META_KEY]: "high" },
    });
  });

  test("rejects unknown effort ids with the allowed list", async () => {
    const unstableSetSessionModel = vi.fn(async () => undefined);

    await expect(
      writeGrokThinkingOption({
        connection: {
          unstable_setSessionModel: unstableSetSessionModel,
        } as unknown as ClientSideConnection,
        sessionId: "session-1",
        thinkingOptionId: "turbo",
        modelId: "grok-4.6",
        availableModels: [
          {
            modelId: "grok-4.6",
            _meta: {
              supportsReasoningEffort: true,
              reasoningEfforts: ["low", "medium", "high"],
            },
          },
        ],
      }),
    ).rejects.toThrow('Unknown Grok reasoning effort "turbo". Allowed: low, medium, high');
    expect(unstableSetSessionModel).not.toHaveBeenCalled();
  });

  test("rejects models that do not support reasoning effort", async () => {
    await expect(
      writeGrokThinkingOption({
        connection: { unstable_setSessionModel: vi.fn() } as unknown as ClientSideConnection,
        sessionId: "session-1",
        thinkingOptionId: "high",
        modelId: "grok-3",
        availableModels: [{ modelId: "grok-3", _meta: { supportsReasoningEffort: false } }],
      }),
    ).rejects.toThrow('Model "grok-3" does not support reasoning effort');
  });
});

describe("buildGrokNewSessionMeta", () => {
  test("includes reasoningEffort when create-time thinking is set", () => {
    expect(buildGrokNewSessionMeta({ thinkingOptionId: "high" })).toEqual({
      reasoningEffort: "high",
    });
    expect(buildGrokNewSessionMeta({ thinkingOptionId: null })).toBeUndefined();
  });
});
