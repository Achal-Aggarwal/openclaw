import { expect, it } from "vitest";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { extractTranscriptRange } from "./chat-transcript-range.ts";

it("keeps measured neighbors parked while retaining cold, dynamic, and focused rows", () => {
  const rows: TranscriptRow<number>[] = Array.from({ length: 20 }, (_, index) => ({
    kind: "item",
    key: `row:${index}`,
    item: index,
    retainDom: index !== 6 && index !== 12,
  }));
  const indexes = new Map(rows.map((row, index) => [row.key, index]));
  const range = { startIndex: 8, endIndex: 10, overscan: 2, count: rows.length };
  const measured = new Map([
    ["row:7", 100],
    ["row:11", 100],
  ]);

  expect(extractTranscriptRange(range, indexes, [], rows, measured)).toEqual([6, 8, 9, 10, 12]);
  expect(extractTranscriptRange(range, indexes, ["row:11"], rows, measured)).toEqual([
    6, 8, 9, 10, 11, 12,
  ]);
  expect(extractTranscriptRange(range, indexes, [], rows, new Map())).toEqual([
    6, 7, 8, 9, 10, 11, 12,
  ]);
});
