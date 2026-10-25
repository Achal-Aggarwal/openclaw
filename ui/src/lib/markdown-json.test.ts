import { describe, expect, it, vi } from "vitest";
import { prepareMarkdownJson, prepareMarkdownJsonOptions } from "./markdown-json.ts";

const runtime = vi.hoisted(() => ({ evaluations: 0 }));
vi.mock("../components/markdown-json-parser.runtime.ts", async (importOriginal) => {
  runtime.evaluations += 1;
  return importOriginal<typeof import("../components/markdown-json-parser.runtime.ts")>();
});

describe("JSON rendering preparation", () => {
  it("keeps plain and over-budget input synchronous, then preserves the canonical JSON tree", async () => {
    expect(prepareMarkdownJson("A plain **Markdown** reply.")).toBeNull();
    const oversized = `{"value":"${"x".repeat(20_000)}"}`;
    expect(prepareMarkdownJson(oversized)).toEqual({ text: oversized });
    const plainOptions = prepareMarkdownJsonOptions("A plain **Markdown** reply.", {
      codeBlockInteraction: "interactive",
    });
    expect(plainOptions).not.toBeInstanceOf(Promise);
    expect((await plainOptions).jsonParser?.("No JSON")).toBeNull();
    for (const prose of ["A reply with [link](https://example.com)", "The result is [1, 2]."]) {
      const options = prepareMarkdownJsonOptions(prose, { codeBlockInteraction: "interactive" });
      expect(options).not.toBeInstanceOf(Promise);
    }
    const literalSource = `${"x".repeat(40_001)}\n\`\`\`json\n{"value":1}\n\`\`\``;
    const literalOptions = prepareMarkdownJsonOptions(literalSource, {
      codeBlockInteraction: "interactive",
    });
    expect(literalOptions).not.toBeInstanceOf(Promise);
    expect(runtime.evaluations).toBe(0);

    const text = '{"duplicate":1,"duplicate":1e2}';
    const pending = prepareMarkdownJson(text);
    expect(pending).toBeInstanceOf(Promise);
    const json = await pending;
    expect(json?.text).toBe(text);
    expect(json?.root?.children).toHaveLength(2);
    const lexicalValue = json!.root!.children![1]!.children![1]!;
    expect(text.slice(lexicalValue.offset, lexicalValue.offset + lexicalValue.length)).toBe("1e2");
    expect(runtime.evaluations).toBe(1);

    for (const source of [`\`\`\`json\n${text}\n\`\`\``, `~~~json\n${text}\n~~~`, `    ${text}`]) {
      const options = await prepareMarkdownJsonOptions(source, {
        codeBlockInteraction: "interactive",
      });
      expect(options.jsonParser?.(text)?.root?.children).toHaveLength(2);
    }
    const documentOptions = await prepareMarkdownJsonOptions(literalSource, {
      codeBlockInteraction: "interactive",
      mode: "document",
    });
    expect(documentOptions.jsonParser?.(text)?.root?.children).toHaveLength(2);
    expect(prepareMarkdownJson(text)).not.toBeInstanceOf(Promise);
    expect(runtime.evaluations).toBe(1);
  });
});
