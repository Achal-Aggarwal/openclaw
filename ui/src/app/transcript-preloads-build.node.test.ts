// @vitest-environment node
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { expect, it } from "vitest";
import { collectControlUiBootAssets } from "../../config/control-ui-boot-preloads.ts";

it("downloads cached transcript renderers with Chat while retaining lazy evaluation", async () => {
  const root = fileURLToPath(new URL("../pages/chat/components/", import.meta.url));
  const renderers = [
    "chat-message-activity-view.tsx",
    "chat-divider.tsx",
    "chat-tool-card-row.solid.tsx",
    "chat-source-previews.tsx",
  ];
  const modules: Record<string, string> = {
    "/entry.js": renderers
      .map(
        (name, index) => `globalThis.load${index} = () => import(${JSON.stringify(root + name)});`,
      )
      .join("\n"),
    ...Object.fromEntries(
      renderers.map((name) => [root + name, `globalThis.loaded = ${JSON.stringify(name)};`]),
    ),
  };
  const built = await build({
    configFile: false,
    logLevel: "silent",
    plugins: [
      {
        name: "transcript-preload-fixture",
        resolveId: (id) => (id in modules ? id : undefined),
        load: (id) => modules[id],
        generateBundle(_options, bundle) {
          const assets = collectControlUiBootAssets(bundle);
          for (const name of renderers) {
            const chunk = Object.values(bundle).find(
              (entry) => entry.type === "chunk" && entry.facadeModuleId === root + name,
            );
            expect(chunk?.type).toBe("chunk");
            if (!chunk || chunk.type !== "chunk") {
              throw new Error(`Missing renderer: ${name}`);
            }
            expect(assets.chat.has(chunk.fileName)).toBe(true);
            expect(assets.new.has(chunk.fileName)).toBe(false);
            expect(assets.initial.has(chunk.fileName)).toBe(false);
            const entry = Object.values(bundle).find(
              (candidate) => candidate.type === "chunk" && candidate.isEntry,
            );
            expect(entry?.type === "chunk" && entry.imports.includes(chunk.fileName)).toBe(false);
          }
        },
      },
    ],
    build: { write: false, rolldownOptions: { input: "/entry.js" } },
  });
  expect(built).toBeDefined();
});
