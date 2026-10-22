import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as legacyInspection from "../config/sessions/legacy-store-inspection.js";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readArchivedSessionOwnership } from "./doctor-session-sqlite-discovery.js";

const ENTRY_COUNT = 500_000;

afterEach(() => {
  vi.restoreAllMocks();
});

it("preserves archived ownership with half a million metadata entries", async () => {
  await withOpenClawTestState({ label: "doctor-archive-scale" }, async (state) => {
    const directory = state.sessionsDir();
    fs.mkdirSync(directory, { recursive: true });
    const target = { agentId: "main", storePath: path.join(directory, "sessions.json") };
    const archivePath = path.join(directory, "sessions.json.original");
    fs.writeFileSync(archivePath, "{}");
    const entries = Array.from({ length: ENTRY_COUNT }, (_, index) => ({
      sessionKey: `agent:main:dashboard:${index}`,
      entry: { sessionId: `history-${index}`, updatedAt: 1, sessionFile: "sqlite:main:id:/unused" },
    }));
    vi.spyOn(legacyInspection, "readLegacySessionStoreEntries").mockReturnValue({ entries });
    const issues: Parameters<typeof readArchivedSessionOwnership>[2] = [];

    const records = readArchivedSessionOwnership(
      target,
      [
        {
          kind: "legacy-store",
          sourcePath: target.storePath,
          archivePath,
          artifact: {
            identity: readMigrationArtifactIdentity(archivePath),
            classification: "protected",
            reason: "unreferenced-history",
            dependencies: [],
            disposal: { state: "retained" },
          },
        },
      ],
      issues,
    );

    expect(issues).toEqual([]);
    expect(records).toHaveLength(ENTRY_COUNT);
    expect(records?.at(-1)).toMatchObject({
      sessionKey: `agent:main:dashboard:${ENTRY_COUNT - 1}`,
      entry: { sessionId: `history-${ENTRY_COUNT - 1}` },
    });
  });
});
