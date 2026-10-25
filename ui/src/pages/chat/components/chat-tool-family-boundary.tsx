import { createContext, createMemo, Show, useContext, type Accessor, type Element } from "solid-js";
import { prepareChatToolPresentation } from "../../../lib/chat/tool-family.ts";
import { ChatImportBoundary } from "./chat-import-boundary.tsx";

const ToolFamilyReadiness = createContext<Accessor<true>>(() => true);

/** Nested projections must recheck readiness before reading newly published inputs. */
export function useChatToolReadiness(): Accessor<true> {
  return useContext(ToolFamilyReadiness);
}

type BoundaryProps = {
  sources: readonly (readonly unknown[])[];
  children: Element;
  fallback?: Element;
};

function ReadyContent(props: BoundaryProps) {
  const ready = createMemo(() => prepareChatToolPresentation(...props.sources));
  return (
    <ToolFamilyReadiness value={ready}>
      <Show when={ready()}>{props.children}</Show>
    </ToolFamilyReadiness>
  );
}

/** Standalone transcript consumers share code readiness, including retry ownership. */
export function ChatToolFamilyBoundary(props: BoundaryProps) {
  return (
    <ChatImportBoundary identity={props.sources} fallback={() => props.fallback}>
      <ReadyContent {...props} />
    </ChatImportBoundary>
  );
}
