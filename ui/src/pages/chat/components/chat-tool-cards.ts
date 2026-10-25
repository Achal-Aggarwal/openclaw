import { readChatToolFamily } from "../../../lib/chat/tool-family.ts";
import { hasToolMessageDemand } from "../../../lib/chat/tool-message-demand.ts";
import type * as Runtime from "./chat-tool-cards.runtime.ts";

export type { BrowserTabPreview } from "./chat-tool-cards.runtime.ts";

export const selectBrowserTabPreviews: typeof Runtime.selectBrowserTabPreviews = (...args) =>
  args[0].some((group) => group.messages.some((item) => hasToolMessageDemand(item.message)))
    ? readChatToolFamily().selectBrowserTabPreviews(...args)
    : [];

export const selectWorkGroupBrowserTabPreviews: typeof Runtime.selectWorkGroupBrowserTabPreviews = (
  ...args
) =>
  args[0].some((item) =>
    item.groups.some((group) =>
      group.messages.some((entry) => hasToolMessageDemand(entry.message)),
    ),
  )
    ? readChatToolFamily().selectWorkGroupBrowserTabPreviews(...args)
    : new Map();
