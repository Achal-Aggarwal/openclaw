import type { SessionPlacementTarget } from "./session-placement-recovery.ts";

export function sessionPlacementDispatchParams(params: {
  key: string;
  agentId: string;
  target: SessionPlacementTarget;
}) {
  return {
    key: params.key,
    agentId: params.agentId,
    ...(params.target.kind === "profile"
      ? {
          profileId: params.target.profileId,
          ...(params.target.os ? { os: params.target.os } : {}),
          ...(params.target.machineClass ? { machineClass: params.target.machineClass } : {}),
        }
      : params.target.kind === "device"
        ? { deviceId: params.target.deviceId }
        : { autoDevice: true }),
  };
}
