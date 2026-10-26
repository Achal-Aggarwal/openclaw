// Installation-local client token cache; paired-device authority remains Gateway-owned.
import {
  type DeviceAuthEntry,
  normalizeDeviceAuthRole,
  normalizeDeviceAuthScopes,
} from "../shared/device-auth.js";
import { runClientCredentialOperationAsync } from "./client-credential-async.js";
import type { ClientTokenKey, ClientTokenRecord } from "./client-credential-store.js";

type DeviceAuthRow = Pick<ClientTokenRecord, "token" | "role" | "scopes_json" | "updated_at_ms">;

function deviceAuthEntryFromRow(row: DeviceAuthRow): DeviceAuthEntry | null {
  try {
    const scopes = JSON.parse(row.scopes_json) as unknown;
    if (!Array.isArray(scopes)) {
      return null;
    }
    return {
      token: row.token,
      role: row.role,
      scopes: normalizeDeviceAuthScopes(scopes),
      updatedAtMs: row.updated_at_ms,
    };
  } catch {
    return null;
  }
}

function createDeviceAuthEntry(params: {
  role: string;
  token: string;
  scopes?: string[];
  updatedAtMs?: number;
}): DeviceAuthEntry {
  return {
    token: params.token,
    role: normalizeDeviceAuthRole(params.role),
    scopes: normalizeDeviceAuthScopes(params.scopes),
    updatedAtMs: params.updatedAtMs ?? Date.now(),
  };
}

type DeviceAuthOperation = {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  assertCurrent?: () => void;
};
type DeviceAuthLookup = DeviceAuthOperation & { deviceId: string; role: string };
type OriginDeviceAuthLookup = DeviceAuthLookup & { gatewayScope: string };
type DeviceAuthRead = {
  onSnapshot?: (observation: {
    entry: DeviceAuthEntry | null;
    expectedToken: string | null;
  }) => void;
};
type DeviceAuthWrite = DeviceAuthLookup & {
  token: string;
  scopes?: string[];
  expectedToken?: string | null;
};
type DeviceAuthClear = DeviceAuthLookup & {
  expectedToken?: string;
  observedToken?: string;
};

function captureDeviceAuthOperation(params: DeviceAuthOperation) {
  const env = { ...(params.env ?? process.env) };
  const { signal, assertCurrent } = params;
  const assertActive = () => {
    signal?.throwIfAborted();
    assertCurrent?.();
  };
  assertActive();
  return { env, signal, assertCurrent: assertActive };
}

function tokenKey(params: DeviceAuthLookup, gatewayScope?: string): ClientTokenKey {
  return {
    device_id: params.deviceId,
    role: normalizeDeviceAuthRole(params.role),
    ...(gatewayScope === undefined ? {} : { gateway_scope: gatewayScope }),
  };
}

async function readDeviceAuth(
  params: DeviceAuthLookup & DeviceAuthRead,
  gatewayScope?: string,
): Promise<DeviceAuthEntry | null> {
  const captured = captureDeviceAuthOperation(params);
  const result = await runClientCredentialOperationAsync(
    captured.env,
    {
      kind: "token.read",
      key: tokenKey(params, gatewayScope),
    },
    captured,
  );
  if (result.kind !== "token") {
    throw new Error("Client credential owner returned an unexpected token result.");
  }
  captured.assertCurrent();
  const observation = {
    entry: result.token ? deviceAuthEntryFromRow(result.token) : null,
    expectedToken: result.token?.token ?? null,
  };
  params.onSnapshot?.(observation);
  return observation.entry;
}

export function loadDeviceAuthToken(
  params: DeviceAuthLookup & DeviceAuthRead,
): Promise<DeviceAuthEntry | null> {
  return readDeviceAuth(params);
}

export const loadDeviceAuthTokenReadOnly = loadDeviceAuthToken;

export async function loadDeviceAuthTokens(
  params: DeviceAuthOperation & { deviceId: string },
): Promise<DeviceAuthEntry[]> {
  const captured = captureDeviceAuthOperation(params);
  const entries: DeviceAuthEntry[] = [];
  let afterRole: string | undefined;
  do {
    const result = await runClientCredentialOperationAsync(
      captured.env,
      {
        kind: "token.list",
        device_id: params.deviceId,
        afterRole,
      },
      captured,
    );
    if (result.kind !== "tokens") {
      throw new Error("Client credential owner returned an unexpected token list.");
    }
    for (const row of result.tokens) {
      const entry = deviceAuthEntryFromRow(row);
      if (entry) {
        entries.push(entry);
      }
    }
    afterRole = result.nextRole ?? undefined;
  } while (afterRole !== undefined);
  captured.assertCurrent();
  return entries;
}

async function storeToken(
  params: DeviceAuthWrite,
  gatewayScope?: string,
): Promise<DeviceAuthEntry | null> {
  const captured = captureDeviceAuthOperation(params);
  const entry = createDeviceAuthEntry(params);
  const result = await runClientCredentialOperationAsync(
    captured.env,
    {
      kind: "token.replace",
      key: tokenKey(params, gatewayScope),
      expectedToken: params.expectedToken,
      token: {
        device_id: params.deviceId,
        role: entry.role,
        token: entry.token,
        scopes_json: JSON.stringify(entry.scopes),
        updated_at_ms: entry.updatedAtMs,
      },
    },
    captured,
  );
  if (result.kind !== "changed") {
    throw new Error("Client credential owner returned an unexpected token write result.");
  }
  return result.changed ? entry : null;
}

async function clearToken(params: DeviceAuthClear, gatewayScope?: string): Promise<boolean> {
  const captured = captureDeviceAuthOperation(params);
  const result = await runClientCredentialOperationAsync(
    captured.env,
    {
      kind: "token.remove",
      key: tokenKey(params, gatewayScope),
      expectedToken: params.expectedToken,
      observedToken: params.observedToken,
    },
    captured,
  );
  if (result.kind !== "changed") {
    throw new Error("Client credential owner returned an unexpected token removal result.");
  }
  return result.changed;
}

export function storeDeviceAuthToken(params: DeviceAuthWrite): Promise<DeviceAuthEntry | null> {
  return storeToken(params);
}
export function clearDeviceAuthToken(params: DeviceAuthClear): Promise<boolean> {
  return clearToken(params);
}
export function loadOriginDeviceToken(
  params: OriginDeviceAuthLookup & DeviceAuthRead,
): Promise<DeviceAuthEntry | null> {
  return readDeviceAuth(params, params.gatewayScope);
}
export const loadOriginDeviceTokenReadOnly = loadOriginDeviceToken;
export function storeOriginDeviceToken(
  params: DeviceAuthWrite & { gatewayScope: string },
): Promise<DeviceAuthEntry | null> {
  return storeToken(params, params.gatewayScope);
}
export function clearOriginDeviceToken(
  params: DeviceAuthClear & { gatewayScope: string },
): Promise<boolean> {
  return clearToken(params, params.gatewayScope);
}
