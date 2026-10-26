import { ActivityGroupEntries } from "../../pages/chat/components/chat-message-group-rich-entry.ts";
import { hasToolMessageDemand } from "./tool-message-demand.ts";

type ChatToolFamily = typeof import("../../pages/chat/chat-tool-family-runtime.ts");
type ChatToolPresentation = typeof import("../../pages/chat/chat-tool-presentation.runtime.ts");

let family: ChatToolFamily | undefined;
let pending: Promise<ChatToolFamily> | undefined;
let presentation: ChatToolPresentation | undefined;
let presentationPending: Promise<ChatToolPresentation> | undefined;

/** Cache module code only; message facts stay with their synchronous owners. */
function loadChatToolFamily(): Promise<ChatToolFamily> {
  pending ??= import("../../pages/chat/chat-tool-family-runtime.ts").then(
    (loaded) => {
      family = loaded;
      return loaded;
    },
    (error: unknown) => {
      pending = undefined;
      throw error;
    },
  );
  return pending;
}

/** Pure consumers prepare message facts without evaluating renderer modules. */
export function prepareChatToolFamily(
  ...sources: readonly (readonly unknown[])[]
): true | Promise<true> {
  return family || !sources.some((messages) => messages.some(hasToolMessageDemand))
    ? true
    : loadChatToolFamily().then(() => true);
}

/** Prepare facts and row renderers together so cached activity commits complete. */
export function loadChatToolPresentation(): Promise<ChatToolPresentation> {
  presentationPending ??= Promise.all([
    loadChatToolFamily(),
    import("../../pages/chat/chat-tool-presentation.runtime.ts"),
    ActivityGroupEntries.preload(),
  ]).then(
    ([, loaded]) => {
      presentation = loaded;
      return loaded;
    },
    (error: unknown) => {
      presentationPending = undefined;
      throw error;
    },
  );
  return presentationPending;
}

/** Rendering needs both facts and components before synchronous projection. */
export function prepareChatToolPresentation(
  ...sources: readonly (readonly unknown[])[]
): true | Promise<true> {
  return presentation || !sources.some((messages) => messages.some(hasToolMessageDemand))
    ? true
    : loadChatToolPresentation().then(() => true);
}

export function readChatToolFamily(): ChatToolFamily {
  if (!family) {
    throw new Error("Chat tool data must be prepared before reading rich messages");
  }
  return family;
}
