import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { CanvasWidgetMount } from "./canvas-widget-mount-lazy.ts";
import { ToolPreview } from "./chat-message-deferred.tsx";

const moduleReady = vi.hoisted(() => Promise.withResolvers<void>());
const canvasModuleStarted = vi.hoisted(() => vi.fn());
// mock-isolation: Observe the real Canvas import without mounting its Gateway-backed host.
vi.mock("./canvas-widget-mount.tsx", () => {
  canvasModuleStarted();
  return { CanvasWidgetMount: () => null };
});
// mock-isolation: Control lazy module readiness independently of the widget renderer and catalog setup.
vi.mock("./widget-card-view.tsx", async () => {
  await moduleReady.promise;
  return { ToolPreview: () => <span>Widget renderer ready</span> };
});

type PreviewInput = Parameters<typeof ToolPreview>[0];

it("reserves widget height and starts admitted Canvas while the card renderer is pending", async () => {
  const preload = vi.spyOn(CanvasWidgetMount, "preload");
  let setInput!: (input: PreviewInput) => void;
  let setSavedHeight!: (height: number | undefined) => void;
  const mounted = mountSolid(() => {
    const [savedHeight, setHeight] = createSignal<number>();
    setSavedHeight = setHeight;
    const [input, updateInput] = createSignal<PreviewInput>({
      preview: {
        kind: "canvas",
        surface: "assistant_message",
        render: "url",
        url: "/chart",
        preferredHeight: 220,
      },
      surface: "chat_message",
    });
    setInput = updateInput;
    return (
      <ToolPreview
        preview={input().preview}
        surface={input().surface}
        options={{
          ...input().options,
          widgetLayout: {
            read: () => savedHeight(),
            readRows: () => undefined,
            write: () => undefined,
            writeRows: () => {},
            invalidateRow: () => {},
          },
        }}
      />
    );
  });
  try {
    flush();
    const placeholder = () =>
      mounted.container.querySelector<HTMLElement>(".chat-tool-card__preview");
    expect(placeholder()?.style.minHeight).toBe("220px");
    expect(mounted.container.textContent).not.toContain("Widget renderer ready");
    setSavedHeight(700);
    flush();
    expect(placeholder()?.style.minHeight).toBe("700px");
    const managed = {
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      viewId: "synthetic-canvas",
      url: "/__openclaw__/canvas/documents/synthetic-canvas/index.html",
    } satisfies NonNullable<PreviewInput["preview"]>;
    const excluded: PreviewInput[] = [
      { preview: undefined, surface: "chat_message" },
      { preview: managed, surface: "chat_tool" },
      { preview: managed, surface: "chat_message", options: { mediaReadAllowed: false } },
      { preview: { ...managed, sandbox: "strict" }, surface: "chat_message" },
      { preview: { ...managed, mcpApp: { viewId: "synthetic-app" } }, surface: "chat_message" },
      {
        preview: { ...managed, url: "https://www.youtube.com/watch?v=abc123xyz45" },
        surface: "chat_message",
      },
    ];
    for (const input of excluded) {
      setInput(input);
      flush();
      expect(preload).not.toHaveBeenCalled();
    }
    setInput({
      preview: managed,
      surface: "chat_message",
      options: { embedSandboxMode: "strict" },
    });
    flush();
    expect(preload).toHaveBeenCalledTimes(1);
    await waitForSolid(() => expect(canvasModuleStarted).toHaveBeenCalledTimes(1));
    expect(mounted.container.textContent).not.toContain("Widget renderer ready");
    moduleReady.resolve();
    await waitForSolid(() =>
      expect(mounted.container.textContent).toContain("Widget renderer ready"),
    );
    expect(placeholder()).toBeNull();
  } finally {
    moduleReady.resolve();
    preload.mockRestore();
    mounted.unmount();
  }
});
