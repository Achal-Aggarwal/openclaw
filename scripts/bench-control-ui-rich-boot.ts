import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
} from "../src/gateway/control-ui-bootstrap-contract.ts";
import {
  installMockGateway,
  controlUiSessionUrl,
  controlUiBundledGatewayUrl,
  createControlUiMockBootstrapConfig,
  resolvePlaywrightChromiumExecutablePath,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { startControlUiBenchGatewayServer } from "./lib/control-ui-bench-gateway-server.ts";
import { startControlUiBenchProxy } from "./lib/control-ui-bench-proxy.ts";
import {
  prepareColdLoadTraceEvent,
  summarizeColdLoadTrace,
  summarizeJavaScriptResources,
  summarizeScriptCoverage,
} from "./lib/control-ui-cold-load-trace.ts";
import { emulateNavigationWorkerNetwork } from "./lib/control-ui-navigation-network.ts";

// A small initial transcript isolates first-paint delays in optional rich renderers.
const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string" },
    "compare-bundle-dir": { type: "string" },
    "gateway-url": { type: "string" },
    variant: { type: "string" },
    "expected-build-id": { type: "string" },
    coverage: { type: "boolean", default: false },
    trace: { type: "boolean", default: false },
    output: { type: "string", default: ".artifacts/control-ui-rich-boot" },
    pairs: { type: "string" },
    "network-latency-ms": { type: "string", default: "0" },
    "service-worker": { type: "boolean", default: false },
    http2: { type: "boolean", default: false },
    "compare-http2": { type: "boolean", default: false },
    "compare-delivery-hints": { type: "boolean", default: false },
    "typeface-profile": { type: "string", default: "claw" },
  },
});
if (values.coverage && values.trace) {
  throw new Error("Capture coverage and trace in separate diagnostic invocations");
}
const externalGatewayUrl = values["gateway-url"];
if (!values["bundle-dir"] || (!externalGatewayUrl && !values["compare-bundle-dir"])) {
  throw new Error("bundle-dir and either compare-bundle-dir or gateway-url are required");
}
if (externalGatewayUrl) {
  if (!["base", "control", "head"].includes(values.variant ?? "") || !values["expected-build-id"]) {
    throw new Error("gateway-url requires variant=base|control|head and expected-build-id");
  }
  if (values.http2 || values["compare-http2"] || values["compare-delivery-hints"]) {
    throw new Error("HTTP delivery comparisons require a locally owned Gateway");
  }
  if (values["compare-bundle-dir"] || (values.pairs !== undefined && values.pairs !== "1")) {
    throw new Error("gateway-url runs one selected build in one fresh browser process");
  }
} else if (values.variant || values["expected-build-id"]) {
  throw new Error("variant and expected-build-id require gateway-url");
}
const runtimeHead = externalGatewayUrl
  ? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  : undefined;
const output = path.resolve(values.output, new Date().toISOString().replaceAll(":", "-"));
const base = path.resolve(values["bundle-dir"]);
const head = path.resolve(values["compare-bundle-dir"] ?? values["bundle-dir"]);
const pairs = Number(values.pairs ?? (externalGatewayUrl ? "1" : "20"));
const networkLatencyMs = Number(values["network-latency-ms"]);
if (!["claw", "dash", "system"].includes(values["typeface-profile"])) {
  throw new Error("typeface-profile must be claw, dash, or system");
}
const typefacePreferences = {
  theme: values["typeface-profile"] === "dash" ? "dash" : "claw",
  themeMode: "light",
  ...(values["typeface-profile"] === "system" ? { fontUi: "system", fontChat: "system" } : {}),
};
if (
  !Number.isSafeInteger(pairs) ||
  pairs < 1 ||
  !Number.isFinite(networkLatencyMs) ||
  networkLatencyMs < 0
) {
  throw new Error("pairs must be a positive integer and network-latency-ms must be nonnegative");
}
const variants = externalGatewayUrl
  ? ([[values.variant!, base]] as const)
  : ([
      ["base", base],
      ["control", base],
      ["head", head],
    ] as const);
const sessionKey = "agent:main:dashboard:rich-risk-proof";
const finalText = "The completed rich run is ready.";
const activeText = "The active run is inspecting the synthetic layout.";
const now = Date.now();
const historyMessages = [
  { role: "user", content: "Inspect the synthetic layout.", timestamp: now - 5000 },
  {
    role: "assistant",
    content: "I will inspect the layout first.",
    phase: "commentary",
    runId: "completed-risk",
    timestamp: now - 4000,
  },
  {
    role: "toolResult",
    toolName: "read",
    toolCallId: "read-layout",
    content: "Synthetic layout inspection complete.",
    runId: "completed-risk",
    timestamp: now - 3000,
  },
  {
    role: "assistant",
    content: finalText,
    phase: "final_answer",
    runId: "completed-risk",
    timestamp: now - 2000,
  },
  { role: "user", content: "Continue with the next synthetic check.", timestamp: now - 1000 },
];
await mkdir(output, { recursive: true });
const server = externalGatewayUrl ? undefined : await startControlUiBenchGatewayServer(base);
const gatewayUrl = externalGatewayUrl ?? server!.baseUrl;
let proxy: Awaited<ReturnType<typeof startControlUiBenchProxy>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let workerNetwork: Awaited<ReturnType<typeof emulateNavigationWorkerNetwork>> | undefined;
const results: unknown[] = [];
try {
  if (server && (values.http2 || values["compare-http2"])) {
    proxy = await startControlUiBenchProxy(server.baseUrl);
  }
  browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  });
  if (values["service-worker"]) {
    workerNetwork = await emulateNavigationWorkerNetwork(browser, {
      latency: networkLatencyMs,
      downloadThroughput: networkLatencyMs ? 1_250_000 : -1,
      uploadThroughput: -1,
    });
  }
  for (let pair = 0; pair < pairs; pair++) {
    for (const [variant, bundle] of variants) {
      const baseUrl =
        externalGatewayUrl ??
        (proxy && (!values["compare-http2"] || variant === "head")
          ? proxy.baseUrl
          : server!.baseUrl);
      await server?.selectBuild(bundle);
      server?.setPreloadHeadersEnabled(!values["compare-delivery-hints"] || variant === "head");
      const source = await readFile(path.join(bundle, "sw.js"), "utf8");
      const buildId = /EMBEDDED_CACHE_VERSION = "([^"]+)"/.exec(source)![1]!;
      if (externalGatewayUrl && buildId !== values["expected-build-id"]) {
        throw new Error("Selected bundle build does not match expected-build-id");
      }
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
        colorScheme: "light",
        serviceWorkers: values["service-worker"] ? "allow" : "block",
        ignoreHTTPSErrors: Boolean(proxy),
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const requests: Array<{
        requestId: string;
        url: string;
        type: string;
        startTimestampSeconds: number;
        responseTimestampSeconds?: number;
        endTimestampSeconds?: number;
        transferBytes?: number;
        error?: string;
      }> = [];
      const requestsById = new Map<string, (typeof requests)[number]>();
      const rawTrace: unknown[] = [];
      try {
        const scenario = {
          methodResponses: {
            "config.get": {
              appliedConfigHash: "synthetic-typography",
              configRevisionHash: "synthetic-typography",
              hash: "synthetic-typography",
              config: { ui: { prefs: typefacePreferences } },
              raw: JSON.stringify({ ui: { prefs: typefacePreferences } }),
              issues: [],
              valid: true,
            },
          },
          serverBuildId: buildId,
          sessionKey,
          historyMessages,
          inFlightRun: { runId: "active-risk", text: activeText, startedAt: now },
          sessionInfo: {
            key: sessionKey,
            hasActiveRun: true,
            activeRunIds: ["active-risk"],
            status: "running",
          },
        };
        server?.setFixtureReader((pathname) =>
          pathname.endsWith(CONTROL_UI_BOOTSTRAP_CONFIG_PATH)
            ? {
                body: JSON.stringify(createControlUiMockBootstrapConfig(scenario)),
                contentType: "application/json",
              }
            : undefined,
        );
        await page.addInitScript(
          ({ gatewayUrl: settingsGatewayUrl, prefs }) => {
            if (location.origin !== "null") {
              localStorage.setItem(
                `openclaw.control.settings.v1:${settingsGatewayUrl}`,
                JSON.stringify({ gatewayUrl: settingsGatewayUrl, ...prefs }),
              );
            }
          },
          { gatewayUrl: controlUiBundledGatewayUrl(baseUrl), prefs: typefacePreferences },
        );
        await installMockGateway(page, scenario);
        // HTTP interception disables the browser cache, including speculative
        // preload reuse. The isolated server owns the synthetic bootstrap read.
        if (server) {
          await page.unrouteAll();
        }
        const init = ({
          bootstrap,
          attribute,
          finalText: completedText,
          activeText: runningText,
        }: {
          bootstrap: string;
          attribute: string;
          finalText: string;
          activeText: string;
        }) => {
          const apply = () => {
            if (!document.documentElement) {
              return false;
            }
            document.documentElement.setAttribute(attribute, bootstrap);
            return true;
          };
          if (!apply()) {
            const observer = new MutationObserver(() => {
              if (apply()) {
                observer.disconnect();
              }
            });
            observer.observe(document, { childList: true });
          }
          performance.setResourceTimingBufferSize(2000);
          const timings: Record<string, number> = {};
          const longTasks: Array<{ start: number; duration: number }> = [];
          const recordLongTasks = (entries: PerformanceEntry[]) => {
            for (const entry of entries) {
              longTasks.push({ start: entry.startTime, duration: entry.duration });
            }
          };
          const observer = new PerformanceObserver((list) => recordLongTasks(list.getEntries()));
          observer.observe({ type: "longtask", buffered: true });
          Object.assign(window, {
            __richRiskReadiness: timings,
            __richRiskLongTasks: () => {
              recordLongTasks(observer.takeRecords());
              return longTasks;
            },
          });
          timings.layoutShift = 0;
          new PerformanceObserver((entries) => {
            for (const entry of entries.getEntries()) {
              if (!Reflect.get(entry, "hadRecentInput")) {
                timings.layoutShift += Reflect.get(entry, "value");
              }
            }
          }).observe({ type: "layout-shift", buffered: true });
          const visible = (node: Element) => {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > 0 &&
              rect.top < innerHeight &&
              style.visibility !== "hidden" &&
              style.display !== "none"
            );
          };
          const check = () => {
            const composer = document.querySelector<HTMLTextAreaElement>(
              ".agent-chat__composer-combobox textarea",
            );
            if (!timings.composerMs && composer && !composer.disabled && visible(composer)) {
              timings.composerMs = performance.now();
            }
            for (const bubble of document.querySelectorAll("section.chat .chat-text")) {
              if (!visible(bubble)) {
                continue;
              }
              if (!timings.finalMs && bubble.textContent?.includes(completedText)) {
                timings.finalMs = performance.now();
              }
              if (!timings.activeMs && bubble.textContent?.includes(runningText)) {
                timings.activeMs = performance.now();
              }
            }
            if (!timings.composerMs || !timings.finalMs || !timings.activeMs) {
              requestAnimationFrame(check);
            }
          };
          requestAnimationFrame(check);
        };
        const initOptions = {
          bootstrap: JSON.stringify(createControlUiMockBootstrapConfig(scenario)),
          attribute: CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
          finalText,
          activeText,
        };
        await page.addInitScript({
          content: `;(() => { const __name = (fn) => fn; (${init.toString()})(${JSON.stringify(initOptions)}); })();`,
        });
        const cdp = await context.newCDPSession(page);
        const responses: Array<{
          url: string;
          protocol?: string;
          connectionId?: number;
          status: number;
          fromServiceWorker: boolean;
          headers: Record<string, string>;
        }> = [];
        cdp.on("Network.requestWillBeSent", (event) => {
          const previous = requestsById.get(event.requestId);
          if (previous && event.redirectResponse) {
            previous.endTimestampSeconds = event.timestamp;
          }
          const request = {
            requestId: event.requestId,
            url: event.request.url,
            type: event.type ?? "Other",
            startTimestampSeconds: event.timestamp,
          };
          requests.push(request);
          requestsById.set(event.requestId, request);
        });
        cdp.on("Network.responseReceived", (event) => {
          const request = requestsById.get(event.requestId);
          if (request) {
            request.responseTimestampSeconds = event.timestamp;
          }
          const { response } = event;
          responses.push({
            url: response.url,
            protocol: response.protocol,
            connectionId: response.connectionId,
            status: response.status,
            fromServiceWorker: response.fromServiceWorker ?? false,
            headers: Object.fromEntries(
              Object.entries(response.headers)
                .filter(([name]) => /^(cache-control|content-encoding|vary|link)$/i.test(name))
                .map(([name, value]) => [name.toLowerCase(), value]),
            ),
          });
        });
        cdp.on("Network.loadingFinished", (event) => {
          const request = requestsById.get(event.requestId);
          if (request) {
            request.endTimestampSeconds = event.timestamp;
            request.transferBytes = event.encodedDataLength;
          }
        });
        cdp.on("Network.loadingFailed", (event) => {
          const request = requestsById.get(event.requestId);
          if (request) {
            request.endTimestampSeconds = event.timestamp;
            request.error = event.errorText;
          }
        });
        const earlyHints: unknown[] = [];
        cdp.on("Network.responseReceivedEarlyHints", (event) => earlyHints.push(event));
        await cdp.send("Network.enable");
        let workerSetup:
          | { scriptUrl?: string; navigationPreloadEnabled?: boolean; nativeAuthRequests?: number }
          | undefined;
        if (values["service-worker"]) {
          await page.goto(controlUiSessionUrl(baseUrl, sessionKey));
          await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
          workerSetup = await page.evaluate(async () => {
            const registration = await navigator.serviceWorker.ready;
            return {
              scriptUrl: registration.active?.scriptURL,
              navigationPreloadEnabled: (await registration.navigationPreload?.getState())?.enabled,
            };
          });
          if (server) {
            const nativeAuthUrl = new URL(controlUiSessionUrl(baseUrl, sessionKey));
            nativeAuthUrl.searchParams.set("openclaw_http_auth", "1");
            server.requests.length = 0;
            await page.goto(nativeAuthUrl.href);
            workerSetup.nativeAuthRequests = server.requests.filter(
              (request) => request.url === nativeAuthUrl.pathname + nativeAuthUrl.search,
            ).length;
            if (workerSetup.nativeAuthRequests !== 1) {
              throw new Error(
                `Native auth navigation sent ${workerSetup.nativeAuthRequests} requests`,
              );
            }
          }
          // Retire the warm document before stopping its worker: its resume and
          // offline-cache probes must not restart it during cold-state setup.
          await page.goto("about:blank");
          // Own browser/profile only: exercise a stopped worker with cold assets.
          await cdp.send("ServiceWorker.enable");
          await cdp.send("ServiceWorker.stopAllWorkers");
          await cdp.send("Storage.clearDataForOrigin", {
            origin: new URL(baseUrl).origin,
            storageTypes: "cache_storage,indexeddb,local_storage",
          });
        }
        await cdp.send("Network.clearBrowserCache");
        await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: networkLatencyMs,
          downloadThroughput: networkLatencyMs ? 1_250_000 : -1,
          uploadThroughput: -1,
        });
        await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
        if (values.trace) {
          cdp.on("Tracing.dataCollected", (data) => rawTrace.push(...data.value));
          await cdp.send("Profiler.enable");
          await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
          await cdp.send("Profiler.start");
          await cdp.send("Tracing.start", {
            categories: [
              "toplevel,loading,blink.user_timing,devtools.timeline",
              "disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack",
              "v8",
            ].join(","),
            transferMode: "ReportEvents",
          });
        }
        if (values.coverage) {
          await page.coverage.startJSCoverage({ resetOnNavigation: true });
        }
        const before = (await cdp.send("Performance.getMetrics")).metrics;
        const hostLoad = loadavg();
        responses.length = 0;
        earlyHints.length = 0;
        requests.length = 0;
        requestsById.clear();
        if (server) {
          server.requests.length = 0;
        }
        const workerRequestStart = workerNetwork?.snapshot().requests.length ?? 0;
        await page.goto(controlUiSessionUrl(baseUrl, sessionKey), {
          waitUntil: "domcontentloaded",
        });
        if (!(await page.evaluate(() => Reflect.has(window, "__richRiskReadiness")))) {
          throw new Error(`Readiness initializer failed: ${errors.join("; ")}`);
        }
        await page.waitForFunction(
          () => {
            const readiness = Reflect.get(window, "__richRiskReadiness");
            return readiness?.composerMs && readiness?.finalMs && readiness?.activeMs;
          },
          undefined,
          { timeout: 30000 },
        );
        const after = (await cdp.send("Performance.getMetrics")).metrics;
        workerNetwork?.assertHealthy();
        const data = await page.evaluate(() => ({
          at: performance.now(),
          readiness: Reflect.get(window, "__richRiskReadiness"),
          longTasks: Reflect.get(window, "__richRiskLongTasks")(),
          navigation: performance.getEntriesByType("navigation").map((entry) => entry.toJSON()),
          resources: (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).map(
            (entry) => ({
              // Retain original resource fields alongside normalized coverage metrics.
              name: entry.name,
              startTime: entry.startTime,
              duration: entry.duration,
              fetchStart: entry.fetchStart,
              domainLookupStart: entry.domainLookupStart,
              domainLookupEnd: entry.domainLookupEnd,
              connectStart: entry.connectStart,
              connectEnd: entry.connectEnd,
              requestStart: entry.requestStart,
              responseStart: entry.responseStart,
              responseEnd: entry.responseEnd,
              nextHopProtocol: entry.nextHopProtocol,
              encodedBodySize: entry.encodedBodySize,
              decodedBodySize: entry.decodedBodySize,
              transferSize: entry.transferSize,
              url: entry.name,
              initiator: entry.initiatorType,
              initiatorType: entry.initiatorType,
              startMs: entry.startTime,
              requestMs: entry.requestStart,
              responseMs: entry.responseStart,
              endMs: entry.responseEnd,
              decodedBytes: entry.decodedBodySize,
              encodedBytes: entry.encodedBodySize,
              transferBytes: entry.transferSize,
            }),
          ),
        }));
        const requestSnapshot = requests.map((request) => ({ ...request }));
        const responseSnapshot = [...responses];
        const earlyHintsSnapshot = [...earlyHints];
        const workerRequestSnapshot = workerNetwork?.snapshot().requests.slice(workerRequestStart);
        const serverRequests = server ? [...server.requests] : undefined;
        const cpu = Object.fromEntries(
          [
            "TaskDuration",
            "ScriptDuration",
            "LayoutDuration",
            "RecalcStyleDuration",
            "ThreadTime",
          ].map((key) => {
            const start = before.find((metric) => metric.name === key)?.value;
            const end = after.find((metric) => metric.name === key)?.value;
            if (start === undefined || end === undefined) {
              throw new Error(`Missing rich-boot CPU metric: ${key}`);
            }
            return [key, 1000 * (end - start)];
          }),
        );
        const coverage = values.coverage
          ? (await page.coverage.stopJSCoverage()).map((entry) =>
              Object.assign(
                { url: entry.url, functions: entry.functions },
                summarizeScriptCoverage(entry),
              ),
            )
          : undefined;
        let trace: ReturnType<typeof summarizeColdLoadTrace> | undefined;
        if (values.trace) {
          const profile = await cdp.send("Profiler.stop");
          const complete = new Promise<void>((resolve) => {
            cdp.once("Tracing.tracingComplete", () => resolve());
          });
          await cdp.send("Tracing.end");
          await complete;
          trace = summarizeColdLoadTrace(rawTrace.map(prepareColdLoadTraceEvent), data.at);
          if (!trace.navigationStartFound) {
            throw new Error("Rich trace lacks navigationStart boundary");
          }
          const prefix = path.join(output, `${variant}-${pair}`);
          await writeFile(`${prefix}.trace.json`, JSON.stringify({ traceEvents: rawTrace }));
          await writeFile(`${prefix}.cpuprofile`, JSON.stringify(profile.profile));
        }
        const networkBytes = summarizeJavaScriptResources(data.resources, coverage);
        if (serverRequests) {
          const documentPath = new URL(controlUiSessionUrl(baseUrl, sessionKey)).pathname;
          const documentRequests = serverRequests.filter((request) => request.url === documentPath);
          if (documentRequests.length !== 1) {
            throw new Error(`Expected one document request, received ${documentRequests.length}`);
          }
        }
        results.push({
          pair,
          variant,
          buildId,
          gatewayUrl: baseUrl,
          hostLoad,
          ...data,
          responses: responseSnapshot,
          requests: requestSnapshot,
          serverRequests,
          workerRequests: workerRequestSnapshot,
          earlyHints: earlyHintsSnapshot,
          workerSetup,
          cpu,
          errors,
          networkBytes,
          coverage,
          trace,
        });
        await writeFile(
          path.join(output, "summary.json"),
          JSON.stringify(
            {
              workload: "cold initial completed+active rich run",
              base,
              head,
              pairs,
              networkLatencyMs,
              gatewayUrl,
              externalGateway: Boolean(externalGatewayUrl),
              runtimeHead,
              metricTimeDomain: "threadTicks",
              coverage: values.coverage,
              traced: values.trace,
              measurementBoundary:
                "Navigation through first visible composer, completed answer and active answer; no post-readiness settling delay.",
              serviceWorker: values["service-worker"],
              http2: values.http2,
              compareHttp2: values["compare-http2"],
              compareDeliveryHints: values["compare-delivery-hints"],
              typefaceProfile: values["typeface-profile"],
              results,
            },
            null,
            2,
          ),
        );
        if (pair === 0) {
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await page.screenshot({ path: path.join(output, `${variant}.png`) });
        }
        console.log(
          JSON.stringify({ pair, variant, hostLoad, readiness: data.readiness, cpu, errors }),
        );
        if (errors.length) {
          throw new Error(errors.join("\n"));
        }
      } catch (error) {
        if (values.trace) {
          await writeFile(
            path.join(output, `${variant}-${pair}-failure.trace.json`),
            JSON.stringify({ incomplete: true, traceEvents: rawTrace }),
          );
        }
        await page.screenshot({ path: path.join(output, `${variant}-${pair}-failure.png`) });
        await writeFile(
          path.join(output, `${variant}-${pair}-failure.json`),
          JSON.stringify(
            {
              errors,
              requests,
              diagnosticTraceEventCount: rawTrace.length,
              browser: await page.evaluate(() => ({
                readiness: Reflect.get(window, "__richRiskReadiness"),
                text: document.querySelector("section.chat")?.textContent,
              })),
            },
            null,
            2,
          ),
        );
        throw error;
      } finally {
        await context.close();
      }
    }
  }
} finally {
  try {
    try {
      await workerNetwork?.close();
    } finally {
      await browser?.close();
    }
  } finally {
    try {
      await proxy?.close();
    } finally {
      await server?.close();
    }
  }
}
