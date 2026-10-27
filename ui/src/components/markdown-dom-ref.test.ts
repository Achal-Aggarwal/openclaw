import { createSignal, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { prepareMessageMarkdown } from "../pages/chat/components/chat-message-text-preparation.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { renderSolidRef } from "../test-helpers/render-solid-ref.ts";
import { createMarkdownRef } from "./markdown-dom-ref.ts";
import { toStreamingMarkdownDomParts } from "./markdown-live.ts";
import {
  partitionMarkdownHtml,
  prewarmSanitizedMarkdown,
  toSanitizedMarkdownContent,
  toSanitizedMarkdownHtml,
} from "./markdown.ts";

it("hands idle-prepared DOM to the first visible caller without parsing it again", () => {
  const source = 'idle-cache-paragraph <img src="x" onerror="alert(1)">';
  const html = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
  let parses = 0;
  Object.defineProperty(Element.prototype, "innerHTML", {
    ...html,
    set(value: string) {
      if (this instanceof HTMLTemplateElement && value.includes("idle-cache-paragraph")) {
        parses++;
      }
      html.set!.call(this, value);
    },
  });
  onTestFinished(() => {
    Object.defineProperty(Element.prototype, "innerHTML", html);
  });
  expect(prewarmSanitizedMarkdown(source, {})).toBe(true);
  expect(prewarmSanitizedMarkdown(source, {})).toBe(false);
  const cachedHtml = toSanitizedMarkdownHtml(source);
  const cached = toSanitizedMarkdownContent(source);
  expect(typeof cached).not.toBe("string");
  const view = renderSolidRef(() => createMarkdownRef(() => ({ content: cached })), {
    targetElement: document.createElement("div"),
  });
  expect(view.container.querySelector("[onerror]")).toBeNull();
  expect(parses).toBe(0);
  const reused = toSanitizedMarkdownContent(source);
  expect(reused).toBe(cachedHtml);
  const second = renderSolidRef(() => createMarkdownRef(() => ({ content: reused })), {
    targetElement: document.createElement("div"),
  });
  expect(second.container.innerHTML).toBe(view.container.innerHTML);
  expect(parses).toBe(1);
  // A return scroll can prepare DOM from the retained sanitized HTML before
  // its next mount. Ordinary idle warming must still finish after one pass.
  expect(prewarmSanitizedMarkdown(source, {})).toBe(false);
  expect(prewarmSanitizedMarkdown(source, {}, "fragment")).toBe(true);
  expect(prewarmSanitizedMarkdown(source, {}, "fragment")).toBe(false);
  const preparedParses = parses;
  const rewarmed = toSanitizedMarkdownContent(source);
  expect(typeof rewarmed).not.toBe("string");
  const third = renderSolidRef(() => createMarkdownRef(() => ({ content: rewarmed })), {
    targetElement: document.createElement("div"),
  });
  expect(third.container.innerHTML).toBe(view.container.innerHTML);
  expect(third.container.querySelector("[onerror]")).toBeNull();
  expect(parses).toBe(preparedParses);
  expect(prewarmSanitizedMarkdown(source, { interactiveImages: true })).toBe(true);
  expect(prewarmSanitizedMarkdown("oversized ".repeat(6000), {})).toBe(false);
});

it("bounds prepared DOM while keeping evicted HTML reusable", () => {
  const source = (index: number) => `bounded-idle-fragment-${index}`;
  for (let index = 0; index < 33; index++) {
    expect(prewarmSanitizedMarkdown(source(index), {})).toBe(true);
  }
  expect(typeof toSanitizedMarkdownContent(source(0))).toBe("string");
  expect(typeof toSanitizedMarkdownContent(source(32))).not.toBe("string");
  expect(typeof toSanitizedMarkdownContent(source(32))).toBe("string");
  for (let index = 0; index < 33; index++) {
    toSanitizedMarkdownContent(source(index));
    expect(prewarmSanitizedMarkdown(source(index), {}, "fragment")).toBe(true);
  }
  expect(typeof toSanitizedMarkdownContent(source(0))).toBe("string");
  expect(typeof toSanitizedMarkdownContent(source(32))).not.toBe("string");
  for (let index = 0; index < 64; index++) {
    prewarmSanitizedMarkdown(`near-first-${index}`, {}, index < 8 ? "cold-fragment" : "html");
  }
  expect(typeof toSanitizedMarkdownContent("near-first-0")).not.toBe("string");
  expect(typeof toSanitizedMarkdownContent("near-first-0")).toBe("string");
  expect(typeof toSanitizedMarkdownContent("near-first-63")).toBe("string");
});

it("mounts fresh chat Markdown without reparsing and keeps only HTML in its cache", () => {
  const marker = "chat-sanitized-fragment-first-mount";
  const source = `### ${marker}\n\n| State |\n| --- |\n| Ready |\n\n<img src="x" onerror="alert(1)"><script>alert(2)</script>`;
  const html = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
  let parses = 0;
  Object.defineProperty(Element.prototype, "innerHTML", {
    ...html,
    set(value: string) {
      if (this instanceof HTMLTemplateElement && value.includes(marker)) {
        parses++;
      }
      html.set!.call(this, value);
    },
  });
  onTestFinished(() => {
    Object.defineProperty(Element.prototype, "innerHTML", html);
  });
  const prepare = () =>
    prepareMessageMarkdown(
      source,
      marker,
      { role: "assistant", isStreaming: false },
      {},
    ).parts()[0];
  const fresh = prepare();
  expect(typeof fresh).not.toBe("string");
  const first = renderSolidRef(() => createMarkdownRef(() => ({ content: fresh })), {
    targetElement: document.createElement("div"),
  });
  expect(first.container.querySelector("h3")?.textContent).toBe(marker);
  expect(first.container.querySelector("td")?.textContent).toBe("Ready");
  expect(first.container.querySelector("script, [onerror]")).toBeNull();
  expect(parses).toBe(0);

  const cached = prepare();
  expect(typeof cached).toBe("string");
  const second = renderSolidRef(() => createMarkdownRef(() => ({ content: cached })), {
    targetElement: document.createElement("div"),
  });
  expect(second.container.innerHTML).toBe(first.container.innerHTML);
  expect(parses).toBe(1);
  expect(toSanitizedMarkdownHtml(source)).toBe(cached);
});

it("isolates ordinary and progress policies for fragment and HTML callers", () => {
  const source =
    '<progress value="2" max="5">fragment-policy-progress</progress><img src="x" onerror="alert(1)"><a href="javascript:alert(2)">Link</a>';
  expect(prewarmSanitizedMarkdown(source, { progressBars: true })).toBe(true);
  expect(prewarmSanitizedMarkdown(source, {})).toBe(true);
  const progress = toSanitizedMarkdownContent(source, { progressBars: true });
  const ordinary = toSanitizedMarkdownContent(source);
  if (typeof progress === "string" || typeof ordinary === "string") {
    throw new Error("Fresh Markdown must retain its sanitized fragment");
  }
  expect(progress.fragment.querySelector("progress")?.getAttribute("value")).toBe("2");
  expect(ordinary.fragment.querySelector("progress")).toBeNull();
  for (const fragment of [progress.fragment, ordinary.fragment]) {
    expect(fragment.querySelector("script, [onerror], [href]")).toBeNull();
  }

  const ordinaryHtml = toSanitizedMarkdownHtml(`${source} ordinary string`);
  const progressHtml = toSanitizedMarkdownHtml(`${source} progress string`, { progressBars: true });
  expect(typeof ordinaryHtml).toBe("string");
  expect(ordinaryHtml).not.toContain("<progress");
  expect(typeof progressHtml).toBe("string");
  expect(progressHtml).toContain('<progress value="2" max="5">');
  expect(toSanitizedMarkdownContent(source)).toBe(ordinary.html);
  expect(toSanitizedMarkdownContent(source, { progressBars: true })).toBe(progress.html);
});

it("mounts settled Markdown from one parse and preserves encoded carriage returns", () => {
  const content =
    '<p title="settled-parse&#13;title">settled-parse&#13;text</p><ul><li>settled-parse item</li></ul>';
  const html = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
  let parses = 0;
  Object.defineProperty(Element.prototype, "innerHTML", {
    ...html,
    set(value: string) {
      if (this instanceof HTMLTemplateElement && value.includes("settled-parse")) {
        parses++;
      }
      html.set!.call(this, value);
    },
  });
  onTestFinished(() => {
    Object.defineProperty(Element.prototype, "innerHTML", html);
  });
  const view = renderSolidRef(() => createMarkdownRef(() => ({ content })), {
    targetElement: document.createElement("div"),
  });
  expect(view.container.querySelector("p")?.textContent).toBe("settled-parse\rtext");
  expect(view.container.querySelector("p")?.getAttribute("title")).toBe("settled-parse\rtitle");
  expect(view.container.querySelector("li")?.textContent).toBe("settled-parse item");
  expect(parses).toBe(1);
});

it("commits Markdown before onUpdate and retires a replaced island", () => {
  const container = document.body.appendChild(document.createElement("div"));
  const [html, setHtml] = createSignal('<a href="#first">First</a>');
  const onUpdate = vi.fn(() => container.textContent);
  let bind!: (element: ParentNode) => void;
  const view = renderSolidRef(
    () => (bind = createMarkdownRef(() => ({ content: html(), onUpdate }))),
    { container, targetElement: document.createElement("div") },
  );
  onTestFinished(() => container.remove());
  expect(onUpdate).toHaveLastReturnedWith("First");
  const original = view.getByRole("link", { name: "First" });
  const replacement = container.appendChild(document.createElement("section"));
  bind(replacement);
  setHtml('<a href="#second">Second</a>');
  flush();
  expect(onUpdate).toHaveLastReturnedWith("Second");
  expect(original.isConnected).toBe(false);
  const current = view.getByRole("link", { name: "Second" });
  expect(replacement.contains(current)).toBe(true);

  view.unmount();
  expect(current).toMatchObject({ isConnected: false });
  expect(replacement.childNodes).toHaveLength(0);
});

it("keeps reusable prepared Markdown isolated from mounted decorations", () => {
  const fragment = document.createDocumentFragment();
  const paragraph = document.createElement("p");
  paragraph.textContent = "Prepared paragraph";
  const list = document.createElement("ul");
  list.innerHTML = "<li>Prepared item</li>";
  fragment.append(paragraph, list);
  const content = { html: paragraph.outerHTML + list.outerHTML, fragment };
  const first = renderSolidRef(() => createMarkdownRef(() => ({ content })), {
    targetElement: document.createElement("div"),
  });
  first.container.querySelector("p")!.textContent = "Mounted decoration";
  const second = renderSolidRef(() => createMarkdownRef(() => ({ content })), {
    targetElement: document.createElement("div"),
  });
  expect(second.container.querySelector("p")?.textContent).toBe("Prepared paragraph");
  expect(second.container.querySelector("li")?.textContent).toBe("Prepared item");
  expect(fragment.firstChild).toBe(paragraph);
  expect(fragment.lastChild).toBe(list);
  expect(paragraph.textContent).toBe("Prepared paragraph");
});

it.each([
  ["paragraph", "A growing reply", "p"],
  ["list", "- First item\n- Growing item", "ul"],
  ["code fence", "```text\nA growing block", "pre"],
])("retains every node across 12 %s updates", (_label, initial, selector) => {
  const [source, setSource] = createSignal(initial);
  const { container: target } = mountSolid(() => {
    const fragment = document.createDocumentFragment();
    createMarkdownRef(() => ({
      content: {
        messageKey: "stream",
        source: source(),
        parts: toStreamingMarkdownDomParts(source()),
      },
    }))(fragment);
    return Array.from(fragment.childNodes);
  });
  const retained = target.querySelector(selector);
  expect(retained).not.toBeNull();
  const observer = new MutationObserver(() => {});
  observer.observe(target, { childList: true, subtree: true, characterData: true });
  onTestFinished(() => observer.disconnect());
  for (let index = 1; index <= 12; index++) {
    setSource(initial + " with more text".repeat(index));
    flush();
  }
  const mutations = observer.takeRecords();
  expect(target.querySelector(selector)).toBe(retained);
  expect(mutations.flatMap((mutation) => [...mutation.removedNodes])).toHaveLength(0);
  expect(retained?.textContent).toContain(" with more text".repeat(12));
  expect(mutations.some((mutation) => mutation.type === "characterData")).toBe(true);
});

it("retires retained media when the Solid owner unmounts", () => {
  const dispose = vi.fn();
  const setConnected = vi.fn();
  const target = document.createElement("div");
  const media = {
    prefix: "MEDIA",
    render: (_index: number, container: HTMLElement) => {
      container.textContent = "Attachment";
      return { dispose, setConnected };
    },
  };
  const read = () => ({ content: "<p>Before MEDIA0END after</p>", media });
  const view = renderSolidRef(() => createMarkdownRef(read), { targetElement: target });
  expect(target.textContent).toBe("Before Attachment after");
  expect(setConnected).toHaveBeenCalledWith(true);
  view.unmount();
  expect(dispose).toHaveBeenCalledOnce();
  expect(target.childNodes).toHaveLength(0);
});

it("retains external long-code decoration until the exact source changes", () => {
  const markup = (code: string, prose: string) =>
    `<div class="code-block-wrapper"><div class="code-block-viewport"><pre><code data-code-highlight="ts">${code}</code></pre></div></div><p>${prose}</p>`;
  const [html, setHtml] = createSignal(markup("before", "First"));
  const view = renderSolidRef(
    () => createMarkdownRef(() => ({ content: html(), incremental: true })),
    { targetElement: document.createElement("div") },
  );
  const code = view.container.querySelector("code")!;
  const wrapper = view.container.querySelector(".code-block-wrapper");
  expect([...code.childNodes].map((node) => node.nodeType)).toEqual([Node.TEXT_NODE]);
  const highlighted = document.createElement("span");
  highlighted.className = "hljs-keyword";
  highlighted.textContent = "before";
  code.replaceChildren(highlighted);
  setHtml(markup("before", "Unrelated prose"));
  flush();
  expect(view.container.querySelector("code")).toBe(code);
  expect(code.firstChild).toBe(highlighted);
  setHtml(markup("after", "Unrelated prose"));
  flush();
  expect(view.container.querySelector(".code-block-wrapper")).toBe(wrapper);
  expect(view.container.querySelector("code")).not.toBe(code);
  expect(code.isConnected).toBe(false);
  expect(view.container.querySelector("code")?.textContent).toBe("after");
});

it("hands a closed stream fence to the code owner and retains its decoration at completion", () => {
  const codeSource = "const value = 1;\n".repeat(400);
  const [source, setSource] = createSignal("```ts\n" + codeSource);
  const [streaming, setStreaming] = createSignal(true);
  const options = { codeBlockInteraction: "interactive" } as const;
  const view = renderSolidRef(
    () =>
      createMarkdownRef(() => ({
        content: {
          messageKey: "large-fence-stream",
          source: source(),
          parts: streaming()
            ? toStreamingMarkdownDomParts(source(), options, "large-fence-stream")
            : partitionMarkdownHtml(
                toSanitizedMarkdownHtml(source(), options),
                "large-fence-stream",
              ),
        },
      })),
    { targetElement: document.createElement("div") },
  );
  expect(view.container.querySelector("code[data-code-highlight]")).toBeNull();
  expect(view.container.querySelector("code")?.textContent).toBe(codeSource);
  setSource(source() + "```\n\nDone.");
  flush();
  const code = view.container.querySelector("code[data-code-highlight]")!;
  expect(code).not.toBeNull();
  const highlighted = document.createElement("span");
  highlighted.className = "hljs-keyword";
  highlighted.textContent = codeSource;
  code.replaceChildren(highlighted);
  setStreaming(false);
  flush();
  expect(view.container.querySelector("code[data-code-highlight]")).toBe(code);
  expect(code.firstChild).toBe(highlighted);
  expect(code.textContent).toBe(codeSource);
});
