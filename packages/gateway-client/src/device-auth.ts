export function normalizeDeviceMetadataForAuth(value?: string | null): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

type DeviceAuthPayloadParams = {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
};

type DeviceAuthPayloadV3Params = DeviceAuthPayloadParams & {
  platform?: string | null;
  deviceFamily?: string | null;
};

function deviceAuthPayloadParts(params: DeviceAuthPayloadParams): string[] {
  return [
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
  ];
}

export function buildDeviceAuthPayload(params: DeviceAuthPayloadParams): string {
  return ["v2", ...deviceAuthPayloadParts(params)].join("|");
}

export function buildDeviceAuthPayloadV3(params: DeviceAuthPayloadV3Params): string {
  // Device signatures are byte-for-byte compared by the gateway. Normalize
  // optional metadata before joining so case differences do not break auth.
  return [
    "v3",
    ...deviceAuthPayloadParts(params),
    normalizeDeviceMetadataForAuth(params.platform),
    normalizeDeviceMetadataForAuth(params.deviceFamily),
  ].join("|");
}
