import path from "node:path";
import * as ts from "typescript/ast";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createNativeTypeScriptParser,
  createNativeTypeScriptProject,
  type NativeTypeScriptProject,
} from "../../scripts/lib/native-typescript.mts";

describe("native TypeScript source ownership", () => {
  const parser = createNativeTypeScriptParser();
  afterAll(() => parser.close());

  it("replaces batch contents without invalidating already returned syntax trees", () => {
    const [first, second] = parser.parseSourceFiles([
      { fileName: "first.ts", text: "export type First = { value: string };" },
      { fileName: "second.ts", text: "export const second = 2;" },
    ]);
    expect(first?.getText()).toBe("export type First = { value: string };");
    expect(second?.getText()).toBe("export const second = 2;");
    expect(parser.getSyntacticDiagnostics()).toEqual([]);

    parser.parseSourceFiles([]);
    const replacement = parser.parseSourceFile("replacement.ts", "const broken = ;");
    expect(replacement.getText()).toBe("const broken = ;");
    expect(parser.getSyntacticDiagnostics("replacement.ts")).toEqual([
      expect.objectContaining({ code: 1109, text: "Expression expected." }),
    ]);
    expect(first?.getText()).toBe("export type First = { value: string };");
  });

  it("rejects reuse after the owner closes", () => {
    const closedParser = createNativeTypeScriptParser();
    closedParser.close();
    closedParser.close();
    expect(() => closedParser.parseSourceFile("closed.ts", "const value = 1;")).toThrow(
      "Native TypeScript parser is closed",
    );
  });
});

describe("native TypeScript semantic overlays", () => {
  const root = path.resolve(".artifacts", "native-typescript-virtual-fixture");
  const source = path.join(root, "consumer.ts");
  let session: NativeTypeScriptProject;

  beforeAll(() => {
    session = createNativeTypeScriptProject({
      cwd: root,
      configFileName: "tsconfig.json",
      files: {
        "tsconfig.json": JSON.stringify({
          compilerOptions: { noLib: true, strict: true, types: [], module: "nodenext" },
          files: ["consumer.ts"],
        }),
        "consumer.ts":
          'import { value as renamed } from "./dependency.js"; import * as dependency from "./dependency.js"; const count: number = renamed;',
        "dependency.ts": 'export const value = "text";',
      },
    });
  });
  afterAll(() => session?.close());

  it("shares exact alias targets without changing non-alias or missing symbols", () => {
    const locations: ts.Node[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isImportSpecifier(node) ||
        ts.isNamespaceImport(node) ||
        ts.isVariableDeclaration(node)
      ) {
        locations.push(node.name);
      }
      node.forEachChild(visit);
    };
    session.project.program.getSourceFile(source)!.forEachChild(visit);
    const symbols = session.project.checker.getSymbolAtLocation(locations);
    session.prepareAliases([...symbols, undefined, symbols[0]]);
    const resolved = symbols.map(session.resolveAlias);
    expect(resolved[0]?.name).toBe("value");
    expect(
      session.project.checker.getExportsOfModule(resolved[1]!).map((symbol) => symbol.name),
    ).toEqual(["value"]);
    expect(resolved[2]).toBe(symbols[2]);
    expect(session.resolveAlias(symbols[0])).toBe(resolved[0]);
    expect(session.resolveAlias(undefined)).toBeUndefined();
  });

  it("resolves virtual dependencies and reports real cross-file type errors", () => {
    expect(session.project.program.getSourceFileNames()).toContain(
      path.join(root, "dependency.ts").split(path.sep).join("/"),
    );
    expect(session.project.program.getSemanticDiagnostics(source)).toEqual([
      expect.objectContaining({
        code: 2322,
        text: "Type 'string' is not assignable to type 'number'.",
      }),
    ]);
  });
});
