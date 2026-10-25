/* @vitest-environment jsdom */
import { createComponent, createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { t } from "../i18n/index.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { WizardStepControls } from "./wizard-step-controls.tsx";

type Props = Parameters<typeof WizardStepControls>[0];
function fixture(props: (defaults: Props) => Props = (defaults) => defaults) {
  const defaults: Props = {
    step: { id: "secret", type: "text", sensitive: true },
    inputId: "secret",
    busy: false,
    value: "secret",
    sensitiveRevealed: false,
    onValueChange: vi.fn(),
    onAnswer: vi.fn(),
    onToggleSensitiveVisibility: vi.fn(),
  };
  const { container } = mountSolid(() => createComponent(WizardStepControls, props(defaults)));
  return {
    ...defaults,
    onInput: defaults.onValueChange,
    onToggle: defaults.onToggleSensitiveVisibility,
    input: container.querySelector<HTMLInputElement>("[data-sensitive-value]")!,
    mask: container.querySelector<HTMLElement>(".oc-sensitive-mask[data-sensitive-mask]")!,
    maskText: container.querySelector<HTMLElement>("[data-sensitive-mask-text]")!,
    toggle: container.querySelector<HTMLButtonElement>(".oc-sensitive-toggle")!,
  };
}
it.each([false, true])("handles visibility and mask edits (revealed=%s)", (revealed) => {
  const { input, mask, maskText, toggle, onInput, onToggle } = fixture((defaults) => ({
    ...defaults,
    sensitiveRevealed: revealed,
  }));
  expect(input).toMatchObject({ type: revealed ? "text" : "password", value: "secret" });
  expect(mask.hidden).toBe(revealed);
  expect(toggle.dataset.sensitiveIcon).toBe(revealed ? "eye-off" : "eye");
  const label = revealed ? "configForm.hideValue" : "configForm.revealValue";
  expect(toggle.getAttribute("aria-label")).toBe(t(label));
  expect(toggle.getAttribute("aria-pressed")).toBe(String(revealed));
  if (revealed) {
    toggle.click();
    expect(onToggle).toHaveBeenCalledOnce();
    return;
  }
  expect(maskText.textContent).toBe("******");
  input.value = "longer-key";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.scrollLeft = 12;
  input.dispatchEvent(new Event("scroll"));
  expect(onInput).toHaveBeenCalledWith("longer-key");
  expect(maskText).toMatchObject({
    textContent: "**********",
    style: { transform: "translateX(-12px)" },
  });
  input.value = "👨‍👩‍👧‍👦x";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(maskText.textContent).toBe("**");
});

it("keeps a controlled concealed value usable after clearing and restoring it", () => {
  let restore!: (value: string) => void;
  const { input, maskText } = fixture((defaults) => {
    const [value, setValue] = createSignal("secret", { ownedWrite: true });
    restore = setValue;
    return {
      ...defaults,
      get value() {
        return value();
      },
      onValueChange: (next) => setValue(typeof next === "string" ? next : ""),
    };
  });
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(maskText.textContent).toBe("");
  restore("restored");
  flush();
  expect([input.value, maskText.textContent]).toEqual(["restored", "********"]);
});
