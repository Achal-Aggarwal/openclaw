import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Slash commands and the welcome screen need this copy before discovery overlays load.
const catalog = {
  chat: {
    welcome: {
      hintBeforeShortcut: "Type a message below ·",
      hintAfterShortcut: "for commands",
      recentSessions: "Recent chats",
      suggestions: {
        whatCanYouDo: en.chat.welcome.suggestions.whatCanYouDo,
        summarizeRecentSessions: "Summarize my recent sessions",
        configureChannel: "Help me configure a channel",
        checkSystemHealth: "Check system health",
        exploreOpenClaw: "Tour OpenClaw's code and docs",
        investigateInSandbox: "Investigate an issue in a sandbox",
        openDraftPullRequest: "Fix a bug and open a draft PR",
      },
    },
    commands: {
      arguments: "Command arguments",
      menu: "Slash commands",
      optionCount: "{count} options",
      clearDescription: "Clear chat history",
      redirectDescription: "Abort and restart with a new message",
      steerDescription: "Inject a message into the active run",
      exportDescription: "Download this conversation as Markdown",
      categories: {
        session: "Session",
        model: "Model",
        agents: "Agents",
        tools: "Tools",
      },
    },
  },
} satisfies TranslationMap;

export const registerChatDiscoveryEnglish = Object.assign(
  () => {
    Object.assign(en.chat.welcome, catalog.chat.welcome);
    Object.assign(en.chat.commands, catalog.chat.commands);
  },
  { catalog },
);
