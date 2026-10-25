import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  browserTabKey,
  type BrowserTabSelection,
} from "../../components/browser/browser-target.ts";
import { browserTabCardRevision } from "./browser-tab-preview.ts";
import { extractToolCardsCached, resolveToolCardOutcome } from "./tool-cards.runtime.ts";

// History and live tool arrays are replaced, never mutated; scan each pair once
// instead of on every scroll-driven render.
const latestTabsByHistory = new WeakMap<
  readonly unknown[],
  { toolMessages: readonly unknown[]; latest: ReadonlyMap<string, BrowserTabSelection> }
>();

export function latestBrowserTabCards(
  messages: readonly unknown[],
  toolMessages: readonly unknown[],
): ReadonlyMap<string, BrowserTabSelection> {
  const cached = latestTabsByHistory.get(messages);
  if (cached?.toolMessages === toolMessages) {
    return cached.latest;
  }
  const latest = new Map<string, BrowserTabSelection>();
  // History precedes the current live stream. Select before search/virtualization
  // so expanding an old row cannot turn it into a new capture request.
  for (const source of [messages, toolMessages]) {
    for (const message of source) {
      if (!isRecord(message)) {
        continue;
      }
      for (const card of extractToolCardsCached(message)) {
        const revision = browserTabCardRevision(card);
        if (card.browserTab && revision && resolveToolCardOutcome(card, false) === "succeeded") {
          const key = browserTabKey(card.browserTab);
          latest.delete(key);
          latest.set(key, { tab: card.browserTab, revision });
        }
      }
    }
  }
  latestTabsByHistory.set(messages, { toolMessages, latest });
  return latest;
}
