import { onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";

/** Hold chunk delivery while preserving the production module and its exports. */
export function createHeldImport<T extends object>() {
  const ready = createDeferred();
  const entered = createDeferred();
  const settled = createDeferred();
  const load = vi.fn(async (original: () => Promise<T>) => {
    entered.resolve();
    try {
      await ready.promise;
      return await original();
    } finally {
      settled.resolve();
    }
  });
  onTestFinished(() => ready.resolve());
  return { ready, entered, settled, load };
}
