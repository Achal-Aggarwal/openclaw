import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordConfigSchema } from "../../config-api.js";
import { mergeDiscordAccountConfig } from "../accounts.js";
import { DiscordActivitiesRuntime } from "./runtime.js";
import { createActivityTestRuntime } from "./test-helpers.test-support.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Discord Activities config", () => {
  it("accepts the strict activities block", () => {
    const parsed = DiscordConfigSchema.safeParse({
      activities: { clientSecret: "secret", applicationId: "123456789012345678" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a non-snowflake Activity application ID", () => {
    const parsed = DiscordConfigSchema.safeParse({
      activities: { clientSecret: "secret", applicationId: "abc" },
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown activities keys", () => {
    const parsed = DiscordConfigSchema.safeParse({
      activities: { clientSecret: "secret", publicUrl: "https://example.com" },
    });
    expect(parsed.success).toBe(false);
  });

  it("resolves config and environment secrets only when the block exists", () => {
    const resolve = (activities: DiscordAccountConfig["activities"], env: NodeJS.ProcessEnv = {}) =>
      new DiscordActivitiesRuntime(
        createActivityTestRuntime().store,
        () => ({ channels: { discord: { token: "testtok", applicationId: "456", activities } } }),
        env,
      ).resolveAccount("default");
    expect(resolve(undefined, { DISCORD_CLIENT_SECRET: "envsec" })).toBeNull();
    expect(resolve({})).toBeNull();
    expect(resolve({ applicationId: "123" }, { DISCORD_CLIENT_SECRET: "envsec" })).toMatchObject({
      clientSecret: "envsec",
      applicationId: "123",
    });
    expect(resolve({ clientSecret: "cfgsec" }, { DISCORD_CLIENT_SECRET: "envsec" })).toMatchObject({
      clientSecret: "cfgsec",
      applicationId: "456",
    });
  });

  it("merges root Activity credentials with account-specific application IDs", () => {
    const account = mergeDiscordAccountConfig(
      {
        channels: {
          discord: {
            activities: { clientSecret: "rootsec" },
            accounts: { work: { activities: { applicationId: "123" } } },
          },
        },
      },
      "work",
    );
    expect(account.activities).toEqual({ clientSecret: "rootsec", applicationId: "123" });
  });
});
