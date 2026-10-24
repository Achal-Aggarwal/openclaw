import { describe, expect, it, vi } from "vitest";
import { handleComposerMenuKeydown } from "./composer-menu.ts";
describe("composer suggestion Shift+Enter", () => {
  it.each([0, 2])("leaves Shift+Enter to native newline insertion with %i suggestions", (count) => {
    const menu = {
      count,
      index: 0,
      consumeEmpty: true,
      close: vi.fn(),
      move: vi.fn(),
      select: vi.fn(),
    };
    const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, cancelable: true });
    expect(handleComposerMenuKeydown(event, menu)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(menu.select).not.toHaveBeenCalled();
    expect(menu.close).not.toHaveBeenCalled();
  });
});
