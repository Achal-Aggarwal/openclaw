// Source-module tests share compilation, while every suite retains its own browser contexts.
import type { TestProject } from "vitest/node";
import { startControlUiE2eServer } from "../../ui/src/test-helpers/control-ui-e2e.ts";

declare module "vitest" {
  export interface ProvidedContext {
    controlUiE2eSourceBaseUrl?: string | null;
  }
}

export default async function setup(project: TestProject) {
  const root = project.vitest.getRootProject();
  if (root.getProvidedContext().controlUiE2eSourceBaseUrl !== undefined) {
    return undefined;
  }
  if (!project.getProvidedContext().controlUiE2eChromium.available) {
    root.provide("controlUiE2eSourceBaseUrl", null);
    return undefined;
  }
  const server = await startControlUiE2eServer(undefined, { source: true });
  try {
    root.provide("controlUiE2eSourceBaseUrl", server.baseUrl);
  } catch (error) {
    await server.close();
    throw error;
  }
  return () => server.close();
}
