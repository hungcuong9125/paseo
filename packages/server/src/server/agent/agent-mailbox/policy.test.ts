import { describe, expect, test } from "vitest";

import { resolveMailboxPolicy } from "./policy.js";

describe("resolveMailboxPolicy", () => {
  test("everything is off by default", () => {
    expect(
      resolveMailboxPolicy({ labels: {}, providerSettings: undefined, globalSettings: undefined }),
    ).toEqual({ enabled: false, resumeOnStartup: false });
  });

  test("the label beats the provider entry, which beats the global setting", () => {
    const globalSettings = { enabled: false, resumeOnStartup: true };
    const providerSettings = { enabled: true };

    expect(resolveMailboxPolicy({ labels: {}, providerSettings, globalSettings })).toEqual({
      enabled: true,
      resumeOnStartup: true,
    });
    expect(
      resolveMailboxPolicy({
        labels: { "paseo.mailbox": "off" },
        providerSettings,
        globalSettings,
      }).enabled,
    ).toBe(false);
    expect(
      resolveMailboxPolicy({
        labels: { "paseo.mailbox": "on" },
        providerSettings: undefined,
        globalSettings: undefined,
      }).enabled,
    ).toBe(true);
  });
});
