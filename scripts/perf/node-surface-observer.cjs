// Synthetic workload only: compare existing writer inputs without issuing SQL.
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync, StatementSync } = require("node:sqlite");
const { threadId } = require("node:worker_threads");

const root = process.env.SQLMEASURE_OUT;
if (!root) throw new Error("SQLMEASURE_OUT required");
const statements = new WeakMap();
const rows = new WeakMap();
const fd = fs.openSync(path.join(root, `surface-${process.pid}-${threadId}.jsonl`), "a");
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql, ...args) {
  const statement = Reflect.apply(prepare, this, [sql, ...args]);
  statements.set(statement, { database: this, sql });
  return statement;
};
for (const method of ["get", "all", "run"]) {
  const original = StatementSync.prototype[method];
  StatementSync.prototype[method] = function (...args) {
    const statement = statements.get(this);
    const result = Reflect.apply(original, this, args);
    if (!statement) return result;
    let snapshot = rows.get(statement.database);
    if (!snapshot) {
      snapshot = new Map();
      rows.set(statement.database, snapshot);
    }
    if (/^select\b/i.test(statement.sql)) {
      for (const row of Array.isArray(result) ? result : [result]) {
        if (row?.device_id && "node_surface_json" in row) {
          snapshot.set(row.device_id, row);
        }
      }
    }
    const write = statement.sql.match(/^update "device_pairing_paired" set (.+) where /i);
    if (write) {
      const columns = [...write[1].matchAll(/"([^"]+)" = \?/g)].map((match) => match[1]);
      const index = columns.indexOf("node_surface_json");
      if (index >= 0) {
        const previous = snapshot.get(args.at(-1));
        const next = args[index];
        const before = previous?.node_surface_json;
        const oldSurface = before ? JSON.parse(before) : {};
        const newSurface = next ? JSON.parse(next) : {};
        const changedFields = [
          ...new Set([...Object.keys(oldSurface), ...Object.keys(newSurface)]),
        ].filter((key) => JSON.stringify(oldSurface[key]) !== JSON.stringify(newSurface[key]));
        fs.writeSync(
          fd,
          JSON.stringify({
            phase: fs.readFileSync(path.join(root, "phase"), "utf8").trim(),
            kind: "surface",
            observedPrevious: previous !== undefined,
            byteIdentical: before === next,
            changedFields,
          }) + "\n",
        );
      }
    }
    const returned = Array.isArray(result) ? result[0] : result;
    if (
      /^insert into "config_machine_state"/i.test(statement.sql) &&
      args[0] === "devicePairing.revision" &&
      returned?.value_json !== undefined
    ) {
      const previous = [...snapshot.values()].at(-1)?.pairing_revision;
      fs.writeSync(
        fd,
        JSON.stringify({
          phase: fs.readFileSync(path.join(root, "phase"), "utf8").trim(),
          kind: "revision",
          observedPrevious: previous !== undefined,
          byteIdentical: previous === returned.value_json,
        }) + "\n",
      );
    }
    return result;
  };
}
