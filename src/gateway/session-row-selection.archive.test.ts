import { expect, it } from "vitest";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { compareSessionEntryPairs, type SessionEntryPair } from "./session-list-order.js";
import {
  create as createRow,
  identity,
  type SelectionRow,
} from "./session-row-projection-record.js";
import { createSessionRowSelection } from "./session-row-selection.js";
import { filterAndSortSessionEntries, selectSessionEntries } from "./session-utils-list.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";

const cfg = { agents: { entries: { main: {} } } };
const storePath = "/synthetic/archive-selection.sqlite";
const agents = new Set(["main"]);
function fixture() {
  const context = buildSessionListRowMetadataContext({ now: 1000 });
  const selection = createSessionRowSelection(
    cfg,
    { path: storePath, paths: new Map([[storePath, 0]]), ownerAgentIds: agents },
    false,
    () => context,
    false,
    true,
  );
  const row = (key: string, entry: SessionEntry): SelectionRow => ({
    ...createRow({ key, agentId: "main", storeTarget: { agentId: "main", storePath } }, entry),
    entry,
  });
  const params = (selected: ReturnType<typeof selection.read>, opts: SessionsListParams) => ({
    cfg,
    opts,
    now: 1000,
    entries: selected.entries,
    involvementKeys: selected.involvementKeys,
    getTarget: selected.get,
    configuredAgentIds: agents,
    getRowContext: () => context,
  });
  return { selection, row, params };
}

it("keeps archive membership and ordering equivalent through add, replace, archive, unarchive and remove", () => {
  const { selection, row, params } = fixture();
  const rows = new Map<string, SelectionRow>();
  let seed = 243;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let step = 0; step < 100; step++) {
    const key = `agent:main:archive-${(random() >>> 8) % 16}`;
    const previous = rows.get(key);
    if (previous && random() % 5 === 0) {
      rows.delete(key);
      selection.change({
        kind: "row",
        id: identity(previous),
        key,
        agentId: "main",
        row: undefined,
      });
    } else {
      const next = row(key, {
        sessionId: key,
        updatedAt: random() % 20,
        lastInteractionAt: random() % 20,
        ...(random() % 3 === 0 ? { archivedAt: random() % 10 } : {}),
        spawnedBy: "agent:main:parent",
        participants: [{ identity: { type: "profile", id: "synthetic-person" } }],
      });
      rows.set(key, next);
      selection.add(next);
    }
    const resident = [...rows.values()].toReversed();
    const candidates = resident.filter((_, index) => index % 2 === 0);
    const all: SessionEntryPair[] = [...rows].map(([key, target]) => [key, target.entry]);
    const reference = (archived: SessionsListParams["archived"]) =>
      all.filter(
        ([, entry]) =>
          archived === "all" || (entry.archivedAt !== undefined) === (archived === true),
      );
    for (const archived of [undefined, false, true, "all"] as const) {
      for (const sortBy of [undefined, "updatedAt", "activity"] as const) {
        for (const shape of ["broad", "candidate", "resident"] as const) {
          const selected = selection.read(
            sortBy,
            shape === "candidate" ? candidates : undefined,
            shape === "resident" ? resident : undefined,
          );
          const source =
            shape === "broad" ? [...rows.values()] : shape === "candidate" ? candidates : resident;
          const expected: SessionEntryPair[] = source
            .filter(
              ({ entry }) =>
                archived === "all" || (entry.archivedAt !== undefined) === (archived === true),
            )
            .map((target) => [target.key, target.entry]);
          if (sortBy) expected.sort((a, b) => compareSessionEntryPairs(a, b, sortBy));
          expect(selected.entries(archived)).toEqual(expected);
        }
      }
      const selected = selection.read("updatedAt");
      for (const opts of [
        { rowMode: "sidebar", limit: 3 },
        { involvingProfileId: "synthetic-person", limit: 3 },
        { spawnedBy: "agent:main:parent", limit: 2, offset: 1 },
        { includeOwnerSessionCounts: true, limit: 4 },
        { agentId: "main", includePeople: true, limit: 5 },
      ] satisfies SessionsListParams[]) {
        const input = params(selected, { ...opts, archived });
        expect(
          selectSessionEntries({
            ...input,
            partitions: selected.partitions,
            retained: new WeakMap(),
          }),
        ).toEqual(selectSessionEntries({ ...input, entries: reference }));
        expect(filterAndSortSessionEntries(input)).toEqual(
          filterAndSortSessionEntries({ ...input, entries: reference }),
        );
      }
    }
  }
});

it("does not inspect row archive metadata again for partition misses or candidate reads", () => {
  const { selection, row, params } = fixture();
  let reads = 0;
  const rows = Array.from({ length: 128 }, (_, index) =>
    row(`agent:main:count-${index}`, {
      sessionId: `count-${index}`,
      updatedAt: index,
      get archivedAt() {
        reads++;
        return index % 4 === 0 ? undefined : 0;
      },
    }),
  );
  for (const target of rows) selection.add(target);
  const selected = selection.read("updatedAt");
  reads = 0;
  expect(
    selectSessionEntries({
      ...params(selected, {}),
      partitions: selected.partitions,
      retained: new WeakMap(),
    }).totalCount,
  ).toBe(32);
  expect(selection.read("updatedAt", rows).entries(false)).toHaveLength(32);
  expect(selection.read(undefined, undefined, rows).entries(true)).toHaveLength(96);
  expect(reads).toBe(0);
});
