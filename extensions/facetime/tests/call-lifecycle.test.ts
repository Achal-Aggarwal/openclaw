import { describe, expect, it, vi } from "vitest";
import { ActiveFaceTimeCall, FaceTimeCallRegistry } from "../src/runtime-state.js";

function activeCall(callUUID: string) {
  return new ActiveFaceTimeCall({
    callUUID,
    phase: "active",
    owner: { senderId: "owner@example.com", senderIsOwner: true },
  });
}

describe("FaceTime call lifecycle", () => {
  it("resolves every retained UUID alias to exactly the current generation", () => {
    const registry = new FaceTimeCallRegistry();
    const current = activeCall("stable-uuid");
    registry.create(current);
    registry.retainAlias(current, "provisional-uuid");

    expect(registry.get("PROVISIONAL-UUID")).toBe(current);
    registry.close(current);
    expect(registry.get("provisional-uuid")).toBeUndefined();

    const successor = activeCall("successor-uuid");
    registry.create(successor);
    expect(registry.get("provisional-uuid")).toBeUndefined();
    expect(registry.get("successor-uuid")).toBe(successor);
  });

  it("resolves an existing call and every waiter when a call is registered", async () => {
    const registry = new FaceTimeCallRegistry();
    const waiting = [
      registry.waitForCall(undefined, 2_750),
      registry.waitForCall(" CALL-1 ", 2_750),
    ];
    const call = activeCall("call-1");
    registry.create(call);

    await expect(Promise.all(waiting)).resolves.toEqual([call, call]);
    await expect(registry.waitForCall("call-1", 0)).resolves.toBe(call);
  });

  it("waits for the requested alias rather than an unrelated registration", async () => {
    const registry = new FaceTimeCallRegistry();
    const waiting = registry.waitForCall(" LATE-ALIAS ", 2_750);
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    const call = activeCall("call-1");
    registry.create(call);
    await Promise.resolve();
    expect(settled).toBe(false);

    registry.retainAlias(call, "late-alias");
    await expect(waiting).resolves.toBe(call);
  });

  it("expires at the deadline and lets a later wait receive the next call", async () => {
    vi.useFakeTimers();
    try {
      const registry = new FaceTimeCallRegistry();
      const waiting = registry.waitForCall("call-1", 2_750);
      let settled = false;
      void waiting.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(2_749);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(waiting).resolves.toBeUndefined();

      const later = registry.waitForCall("call-1", 2_750);
      const call = activeCall("call-1");
      registry.create(call);
      await expect(later).resolves.toBe(call);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a carrier command that settles after closing advances generation", async () => {
    const call = activeCall("call-1");
    let settle = (_value: string) => {};
    const nativeAction = vi.fn(
      async () =>
        await new Promise<string>((resolve) => {
          settle = resolve;
        }),
    );
    const generation = call.generation;
    const command = call.runCarrierCommand({ generation, action: nativeAction });
    await vi.waitFor(() => expect(nativeAction).toHaveBeenCalledOnce());
    call.beginClosing();
    settle("unmuted");

    await expect(command).rejects.toThrow("lifecycle changed");
    expect(call.carrierMode).toBe("closing");
  });
});
