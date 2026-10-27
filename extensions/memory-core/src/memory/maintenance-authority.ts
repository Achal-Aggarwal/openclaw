import { AsyncLocalStorage } from "node:async_hooks";

// Explicit remote maintenance carries the admitted operator authority to the
// existing SQLite publication owner, including its synchronous commit guard.
const maintenanceAuthority = new AsyncLocalStorage<() => void>();

export function withMemoryMaintenanceAuthority<T>(
  assertCurrent: () => void,
  run: () => Promise<T>,
): Promise<T> {
  assertCurrent();
  return maintenanceAuthority.run(assertCurrent, run);
}

export function captureMemoryMaintenanceAuthority(): (() => void) | undefined {
  return maintenanceAuthority.getStore();
}
