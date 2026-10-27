import type { BackgroundPreference } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import {
  normalizeTabIconPreference,
  UI_APPEARANCE_PREFERENCE_KEYS,
} from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import { GatewayRequestError } from "../api/gateway-connect-errors.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { DEFAULT_SIDEBAR_ENTRIES } from "../app-navigation.ts";
import type { RuntimeConfigExternalMutationResult } from "../lib/config/config-gateway-operations.ts";
import {
  isAppearancePref,
  prefValuesEqual,
  isNavigationPref,
  SYNCED_PREFS,
  UI_NAVIGATION_PREFERENCE_KEYS,
  type ServerUiPrefs,
} from "./server-prefs-state.ts";
import { rebaseSidebarEntries } from "./server-prefs-write-batch.ts";
import { invalidateUserPreferences, saveUserPreferences } from "./user-prefs-cache.ts";
import { loadUserPreferences } from "./user-prefs-request.ts";

export async function writeProfileAppearancePrefs(
  client: GatewayBrowserClient | null,
  preferences: ServerUiPrefs,
  canDispatch: () => boolean,
  profileId?: string | null,
  expectedBackground?: BackgroundPreference | null,
): Promise<
  RuntimeConfigExternalMutationResult<unknown> & {
    batch: ServerUiPrefs;
    committedBatch?: ServerUiPrefs;
  }
> {
  let batch = preferences;
  const failure = (
    error: string,
    reason: Extract<
      RuntimeConfigExternalMutationResult<unknown>,
      { ok: false }
    >["reason"] = "unavailable",
    failedBatch = batch,
  ) => ({ ok: false as const, reason, error, batch: failedBatch });
  const writesNavigation = Object.keys(batch).some(isNavigationPref);
  if (writesNavigation) {
    batch = Object.fromEntries(Object.entries(batch).filter(([key]) => isNavigationPref(key)));
  }
  const writesTheme = batch.theme !== undefined || batch.themeMode !== undefined;
  if (writesTheme) {
    // themes.set owns the atomic theme/accent/font mutation, not other profile
    // values. Leave those pending for a separately authorized users.prefs.set.
    batch = Object.fromEntries(
      Object.entries(batch).filter(([key]) =>
        ["theme", "themeMode", "accent", "fontUi", "fontChat"].includes(key),
      ),
    );
  }
  if (!client || !canDispatch()) {
    return failure("Profile preferences are unavailable.");
  }
  if (batch.background !== undefined && expectedBackground === undefined) {
    return failure("Background preferences have not loaded.");
  }
  if (writesTheme) {
    invalidateUserPreferences(client);
  }
  try {
    if (writesNavigation) {
      if (!profileId) {
        return failure("Navigation profile is unavailable.");
      }
      const base = preferences.sidebarEntriesBase;
      const keys = Object.keys(batch).filter(isNavigationPref);
      const snapshot = await loadUserPreferences(client, profileId, {
        keys: keys.map((key) => UI_NAVIGATION_PREFERENCE_KEYS[key]),
      });
      // A read without complete coverage is never absence and must not seed a write.
      if (!canDispatch() || snapshot.status !== "ok") {
        return failure("Navigation preferences are unavailable.");
      }
      const committedBatch = { ...batch };
      if (Array.isArray(batch.sidebarEntries)) {
        const observed = SYNCED_PREFS.sidebarEntries.extract(base);
        const remote = SYNCED_PREFS.sidebarEntries.extract(
          snapshot.entries[UI_NAVIGATION_PREFERENCE_KEYS.sidebarEntries] ?? DEFAULT_SIDEBAR_ENTRIES,
        );
        if (!observed || !prefValuesEqual(observed, base)) {
          return failure(
            "Shortcuts are saved only on this device because their previous sync state is missing. Edit a shortcut to sync again.",
            "rejected",
            { sidebarEntries: batch.sidebarEntries },
          );
        }
        if (!remote) {
          return failure("Navigation preferences are unavailable.");
        }
        committedBatch.sidebarEntries = rebaseSidebarEntries(
          observed,
          batch.sidebarEntries,
          remote,
          preferences.sidebarEntriesOrder,
        );
      }
      const entries = Object.fromEntries(
        keys.map((key) => [UI_NAVIGATION_PREFERENCE_KEYS[key], committedBatch[key]]),
      );
      const expectedEntries = Object.fromEntries(
        keys.map((key) => {
          const prefKey = UI_NAVIGATION_PREFERENCE_KEYS[key];
          return [prefKey, snapshot.entries[prefKey] ?? null];
        }),
      );
      const result = await saveUserPreferences(client, { entries, expectedEntries });
      return result.status === "ok"
        ? { ok: true, value: result, refresh: { ok: true }, batch, committedBatch }
        : failure(
            "Navigation preferences changed or are unavailable.",
            result.status === "conflict" ? "conflict" : "unavailable",
          );
    }
    if (writesTheme) {
      const appearance = {
        ...(batch.accent !== undefined ? { accent: batch.accent } : {}),
        ...(batch.fontUi !== undefined ? { fontUi: batch.fontUi } : {}),
        ...(batch.fontChat !== undefined ? { fontChat: batch.fontChat } : {}),
      };
      const value = await client.request("themes.set", {
        ...(batch.theme !== undefined ? { id: batch.theme } : {}),
        ...(batch.themeMode !== undefined ? { mode: batch.themeMode } : {}),
        ...(Object.keys(appearance).length ? { appearance } : {}),
      });
      return { ok: true, value, refresh: { ok: true }, batch };
    }
    if (batch.tabIcon != null && !normalizeTabIconPreference(batch.tabIcon)) {
      return failure("Invalid tab icon preference.", "rejected");
    }
    const entries = Object.fromEntries(
      Object.entries(batch).flatMap(([key, value]) =>
        isAppearancePref(key) ? [[UI_APPEARANCE_PREFERENCE_KEYS[key], value]] : [],
      ),
    );
    const result = await saveUserPreferences(client, {
      entries,
      ...(batch.background !== undefined
        ? { expectedEntries: { [UI_APPEARANCE_PREFERENCE_KEYS.background]: expectedBackground } }
        : {}),
    });
    return result.status === "ok"
      ? { ok: true, value: result, refresh: { ok: true }, batch }
      : failure(
          "Profile preferences are unavailable.",
          result.status === "conflict" ? "conflict" : "rejected",
        );
  } catch (error) {
    const rejected =
      error instanceof GatewayRequestError &&
      (error.gatewayCode === "INVALID_REQUEST" || error.gatewayCode === "FORBIDDEN");
    return failure(
      error instanceof Error ? error.message : String(error),
      rejected ? "rejected" : "error",
    );
  } finally {
    if (writesTheme) {
      invalidateUserPreferences(client);
    }
  }
}
