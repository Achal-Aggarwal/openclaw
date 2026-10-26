import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString as readNonEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isDiscordAccountEnabledForRuntime,
  listDiscordAccountIds,
  resolveDiscordAccount,
} from "../accounts.js";
import { resolveDiscordProxyFetchForAccount } from "../proxy-fetch.js";
import { selectDiscordActivitiesRuntimeConfig } from "../runtime-config.js";
import type { DiscordActivityStore } from "./store.js";

type ResolvedDiscordActivityAccount = {
  accountId: string;
  applicationId: string;
  botAuth: string;
  clientSecret: string;
  proxyFetch?: typeof fetch;
};

export class DiscordActivitiesRuntime {
  private readonly learnedApplicationIds = new Map<string, string>();

  constructor(
    readonly store: DiscordActivityStore,
    private readonly getCurrentConfig: () => OpenClawConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  currentConfig(): OpenClawConfig {
    return selectDiscordActivitiesRuntimeConfig(this.getCurrentConfig());
  }

  registerApplicationId(accountId: string, applicationId: string): void {
    const trimmed = applicationId.trim();
    if (trimmed) {
      this.learnedApplicationIds.set(accountId, trimmed);
    }
  }

  resolveAccount(
    accountId: string | null | undefined,
    cfg = this.currentConfig(),
  ): ResolvedDiscordActivityAccount | null {
    const account = resolveDiscordAccount({ cfg, accountId });
    if (
      !listDiscordAccountIds(cfg).includes(account.accountId) ||
      !isDiscordAccountEnabledForRuntime(account, cfg) ||
      account.tokenStatus !== "available"
    ) {
      return null;
    }
    const activities = account.config.activities;
    const clientSecret =
      activities &&
      (readNonEmpty(activities.clientSecret) ?? readNonEmpty(this.env.DISCORD_CLIENT_SECRET));
    if (!clientSecret) {
      return null;
    }
    const applicationId =
      readNonEmpty(activities?.applicationId) ??
      this.learnedApplicationIds.get(account.accountId) ??
      account.config.applicationId?.trim();
    if (!applicationId) {
      return null;
    }
    const bot = account.token.trim();
    return {
      accountId: account.accountId,
      applicationId,
      botAuth: bot,
      clientSecret,
      proxyFetch: resolveDiscordProxyFetchForAccount(account, cfg),
    };
  }

  resolveHttpAccount(applicationId?: string): ResolvedDiscordActivityAccount | null {
    const cfg = this.currentConfig();
    const accounts = listDiscordAccountIds(cfg)
      .map((accountId) => this.resolveAccount(accountId, cfg))
      .filter((account): account is ResolvedDiscordActivityAccount => account !== null);
    if (applicationId) {
      return accounts.find((account) => account.applicationId === applicationId) ?? null;
    }
    return accounts.length === 1 ? (accounts[0] ?? null) : null;
  }

  hasEnabledAccounts(): boolean {
    const cfg = this.currentConfig();
    return listDiscordAccountIds(cfg).some(
      (accountId) => this.resolveAccount(accountId, cfg) !== null,
    );
  }
}

let activeRuntime: DiscordActivitiesRuntime | undefined;

export function setDiscordActivitiesRuntime(runtime: DiscordActivitiesRuntime | undefined): void {
  activeRuntime = runtime;
}

export function getDiscordActivitiesRuntime(): DiscordActivitiesRuntime | undefined {
  return activeRuntime;
}
