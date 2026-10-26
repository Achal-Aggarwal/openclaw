import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { withClientCredentialStore } from "../infra/client-credential-store.test-support.js";
import {
  loadDeviceAuthTokens,
  storeDeviceAuthToken as seedDeviceAuthToken,
} from "../infra/device-auth-store.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectDevicePairingHealthFindings } from "./doctor-device-pairing.js";

afterEach(() => vi.restoreAllMocks());

it("creates and reads the token inventory off the host, preserving role order and valid rows", async () => {
  await withOpenClawTestState({ label: "doctor-token-inventory" }, async (state) => {
    const coldSql = observeMainThreadSql({ includeClose: true });
    try {
      expect(await loadDeviceAuthTokens({ deviceId: "synthetic-device", env: state.env })).toEqual(
        [],
      );
      coldSql.expectIdle();
    } finally {
      coldSql.restore();
      await closeOpenClawStateDatabaseAsync();
    }
    await expect(fs.stat(state.statePath("client", "credentials.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const operatorClock = vi.spyOn(Date, "now").mockReturnValueOnce(20);
    const operatorWrite = seedDeviceAuthToken({
      deviceId: "synthetic-device",
      role: " operator ",
      token: "synthetic-operator-token",
      scopes: ["operator.write", " operator.read ", "operator.read"],
      env: state.env,
    });
    operatorClock.mockRestore();
    const operator = await operatorWrite;
    const nodeClock = vi.spyOn(Date, "now").mockReturnValueOnce(10);
    const nodeWrite = seedDeviceAuthToken({
      deviceId: "synthetic-device",
      role: "node",
      token: "synthetic-node-token",
      env: state.env,
    });
    nodeClock.mockRestore();
    const node = await nodeWrite;
    await seedDeviceAuthToken({
      deviceId: "another-device",
      role: "operator",
      token: "synthetic-other-token",
      env: state.env,
    });
    withClientCredentialStore(state.env, false, (db) =>
      db
        .prepare(
          "INSERT INTO device_auth_tokens (device_id, role, token, scopes_json, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
        )
        .run("synthetic-device", "malformed", "synthetic-malformed-token", "not-json", 1),
    );
    await closeOpenClawStateDatabaseAsync();
    const reopenedSql = observeMainThreadSql({ includeClose: true });
    try {
      const input = { deviceId: "synthetic-device", env: { ...state.env } };
      const inventory = loadDeviceAuthTokens(input);
      input.deviceId = "another-device";
      input.env.OPENCLAW_STATE_DIR = state.path("changed-target");
      expect(await inventory).toEqual([node, operator]);
      await closeOpenClawStateDatabaseAsync();
      reopenedSql.expectIdle();
      await expect(fs.stat(state.path("changed-target"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      reopenedSql.restore();
    }
  });
});

it("detects stale local tokens from the active state view while checking legacy files at the source", async () => {
  await withOpenClawTestState({ label: "doctor-token-active-view" }, async (state) => {
    const identity = loadOrCreateDeviceIdentity();
    const pairing = await requestDevicePairing({
      deviceId: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      role: "operator",
      scopes: ["operator.read"],
    });
    await approveDevicePairing(pairing.request.requestId, { callerScopes: ["operator.read"] });
    const staleTokenClock = vi.spyOn(Date, "now").mockReturnValueOnce(1);
    const staleTokenWrite = seedDeviceAuthToken({
      deviceId: identity.deviceId,
      role: "operator",
      token: "synthetic-stale-token",
      scopes: ["operator.read"],
    });
    staleTokenClock.mockRestore();
    await staleTokenWrite;
    const sourceDir = state.path("source-state");
    await fs.mkdir(`${sourceDir}/identity`, { recursive: true });
    await fs.writeFile(`${sourceDir}/identity/device-auth.json`, '{"version":1}');
    using prepare = vi.spyOn(DatabaseSync.prototype, "prepare");

    const findings = await collectDevicePairingHealthFindings({
      cfg: { gateway: { mode: "local" } },
      env: { ...state.env, OPENCLAW_STATE_DIR: sourceDir },
    });
    expect(findings.map(({ requirement }) => requirement)).toEqual([
      "device-auth-store-legacy-file",
      "local-token-stale",
    ]);
    expect(JSON.stringify(findings)).not.toContain("synthetic-stale-token");
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('"device_auth_tokens"'))).toEqual([]);
  });
});
