import { describe, expect, it } from "vitest";
import { controlUiPreloadLinks } from "./control-ui-route-preloads.ts";

describe("controlUiPreloadLinks", () => {
  it("keeps critical script fetches alongside module preparation without duplicate links", () => {
    const html = `
      <script type="module" src="/openclaw/assets/entry.js"></script>
      <link rel="modulepreload" as="script" href="/openclaw/assets/module.js">
      <link rel="preload" as="script" crossorigin href="/openclaw/assets/presentation.js">
      <link rel="preload" as="script" crossorigin href="/openclaw/assets/presentation.js">
      <link rel="preload" as="style" href="/openclaw/assets/presentation.css">
      <link rel="stylesheet" href="/assets/entry.css">
    `;
    expect(controlUiPreloadLinks(html)).toEqual([
      "</openclaw/assets/entry.js>; rel=modulepreload; crossorigin",
      "</openclaw/assets/module.js>; rel=modulepreload; crossorigin",
      "</openclaw/assets/presentation.js>; rel=preload; as=script; crossorigin",
      "</openclaw/assets/presentation.css>; rel=preload; as=style; crossorigin",
      "</assets/entry.css>; rel=preload; as=style; crossorigin",
    ]);
  });

  it("excludes low-priority interactions and URLs outside the build asset contract", () => {
    const html = `
      <link rel="preload" as="script" fetchpriority="low" href="/assets/menu.js">
      <link rel="modulepreload" fetchpriority="low" href="/assets/optional.js">
      <link rel="preload" as="script" href="https://example.test/assets/remote.js">
      <link rel="preload" as="script" href="./assets/relative.js">
      <link rel="preload" as="script" href="/assets/query.js?v=1">
      <link rel="preload" as="script" href="/assets/fragment.js#v1">
      <link rel="preload" as="script" href="/outside.js">
      <script src="/assets/classic.js"></script>
      <link rel="prefetch" as="script" href="/assets/later.js">
    `;
    expect(controlUiPreloadLinks(html)).toEqual([]);
  });
});
