import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { resetTranscriptTestDom } from "./components/chat-transcript.test-support.ts";

export function resetChatViewTestState() {
  resetChatViewState();
  resetTranscriptTestDom();
}
