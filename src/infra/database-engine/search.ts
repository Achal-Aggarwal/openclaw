import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createFunctionModule, sql, type RawBuilder } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { isPostgresSqlConnection, type PostgresSqlConnection } from "../sql-connection.js";
import type { SearchSchema, SearchStore, StoreSearchCapabilities } from "./contract.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";
import { getAdmittedPostgresSchema } from "./postgres-schema.js";
import {
  assertPostgresSearchAdmitted,
  rebuildPostgresSearch,
  searchConfig,
  pgSearchName,
} from "./postgres-search-schema.js";
import { bindSqliteVectorCapability } from "./sqlite-vector.js";
import type { FullTextCapability, TextIndex, TextQuery } from "./text-contract.js";
import { matchesVectorRow, type VectorCapability, type VectorIndex } from "./vector-contract.js";
export type { SearchSchema, SearchStore, StoreSearchCapabilities } from "./contract.js";

function literalQuery(query: TextQuery): string {
  if (query.kind === "contains") {
    throw new Error("Literal contains requires the owner's SQLite substring policy");
  }
  if (query.kind === "term" || query.kind === "phrase") {
    const text =
      query.kind === "term" ? query.text.replaceAll('"', "") : query.text.replaceAll('"', '""');
    return `"${text}"${query.kind === "phrase" && query.prefix ? "*" : ""}`;
  }
  let separator = query.kind === "any" ? " OR " : " AND ";
  if (query.kind === "all" && query.clauses.every((clause) => clause.kind === "phrase")) {
    separator = " ";
  }
  return query.clauses
    .map((clause) => (clause.kind === "any" ? `(${literalQuery(clause)})` : literalQuery(clause)))
    .join(separator);
}

function bindSqliteFullText(store: object, db?: DatabaseSync): FullTextCapability {
  const relation = (index: TextIndex) => {
    if (index.store !== store || (db && !db.isOpen)) {
      throw new Error("Text index is not admitted to this open store");
    }
    return index.alias ?? index.table;
  };
  return {
    match(index, query) {
      const table = relation(index);
      const value = literalQuery(query);
      return index.matchField
        ? /* kysely-allow-raw: Native MATCH uses the admitted table and field declarations. */ sql<boolean>`${sql.ref(`${table}.${index.matchField}`)} match ${value}`
        : /* kysely-allow-raw: Native MATCH uses the admitted table and fixed rank clause. */ sql<boolean>`${sql.raw(table)} MATCH ${value}${sql.raw(index.hiddenRank ? ` AND ${table}.rank MATCH 'bm25()'` : "")}`;
    },
    rank(index) {
      const table = relation(index);
      return {
        value: /* kysely-allow-raw: Both native rank forms use the admitted table declaration. */ sql<number>`${sql.raw(index.hiddenRank ? `${table}.rank` : `bm25(${table})`)}`,
        order: "asc",
        toRank: (raw) => (Number.isFinite(raw) ? -raw : 0),
      };
    },
    snippet(index, field, maxTokens) {
      const table = relation(index);
      const column = index.fields.indexOf(field);
      if (column < 0) {
        throw new Error(`Text index has no field ${field}`);
      }
      return /* kysely-allow-raw: Native snippet uses the admitted table, checked field ordinal, and caller token budget. */ sql<string>`${sql.raw(`snippet(${table}, ${column}, '', '', ' … ', ${maxTokens})`)}`;
    },
    identity: (index) =>
      /* kysely-allow-raw: Native row identity uses the admitted index declaration. */ sql<number>`${sql.raw(`${relation(index)}.rowid`)}`,
    allocatedIdentity: (index) => {
      relation(index);
      return /* kysely-allow-raw: FTS insertion identity is connection-local SQLite state. */ sql<number>`${createFunctionModule()<number>("last_insert_rowid", [])}`;
    },
  };
}

function tsquery(query: TextQuery, config: string): RawBuilder<unknown> {
  if (query.kind === "contains") {
    throw new Error("Contains is only available on an admitted trigram index");
  }
  if (query.kind !== "term" && query.kind !== "phrase") {
    if (query.clauses.every((clause) => clause.kind === "term" || clause.kind === "phrase")) {
      // Bind a flat query once. Thousands of literal atoms must not expand the
      // SQL expression tree before PostgreSQL can apply its text-search parser.
      const separator = query.kind === "all" ? " & " : " | ";
      return /* kysely-allow-raw: The recordset contains bound literals; only the closed query-kind selects conjunction. */ sql`coalesce((
        SELECT string_agg('(' || nullif(parsed.value::text, '') ||
          CASE WHEN atom.prefix THEN ':*' ELSE '' END || ')', ${separator})
        FROM json_to_recordset(${JSON.stringify(query.clauses)}::json)
          AS atom(kind text, text text, prefix boolean)
        CROSS JOIN LATERAL (SELECT CASE WHEN atom.kind = 'term'
          THEN plainto_tsquery(${sql.lit(config)}::regconfig, atom.text)
          ELSE phraseto_tsquery(${sql.lit(config)}::regconfig, atom.text)
        END AS value) AS parsed
      ), '')::tsquery`;
    }
    const clauses = query.clauses.map((clause) => tsquery(clause, config));
    return clauses.length
      ? /* kysely-allow-raw: Only the closed query-kind enum selects an operator. */ sql`(${sql.join(clauses, sql.raw(query.kind === "all" ? " && " : " || "))})`
      : sql`''::tsquery`;
  }
  const parsed =
    query.kind === "term"
      ? sql`plainto_tsquery(${sql.lit(config)}::regconfig, ${query.text})`
      : sql`phraseto_tsquery(${sql.lit(config)}::regconfig, ${query.text})`;
  return query.kind === "phrase" && query.prefix
    ? sql`coalesce((nullif(${parsed}::text, '') || ':*')::tsquery, ''::tsquery)`
    : parsed;
}

function bindPostgresSearch(
  db: PostgresSqlConnection,
  schema: SearchSchema,
): StoreSearchCapabilities {
  assertPostgresSearchAdmitted(db, schema);
  const config = `${pgSearchName(getPostgresPhysicalFacts(db)!.namespace)}.${pgSearchName(searchConfig)}`;
  const extension = pgSearchName(schema.extensionSchema ?? "public");
  const store = {};
  const text = Object.fromEntries(
    Object.entries(schema.text ?? {}).map(([name, index]) => [name, { ...index, store }]),
  );
  const vectors = Object.fromEntries(
    Object.entries(schema.vector ?? {}).map(([name, index]) => [name, { ...index, store }]),
  );
  const relation = (index: TextIndex, field = "openclaw_search") => {
    if (!db.isOpen || index.store !== store) {
      throw new Error("Text index is not admitted to this open store");
    }
    return /* kysely-allow-raw: Identifiers come only from this store's admitted index declaration. */ sql.ref(
      `${index.alias ?? index.table}.${field}`,
    );
  };
  const requireQuery = (query?: TextQuery) => {
    if (!query) {
      throw new Error("PostgreSQL rank and snippet require the literal search query");
    }
    return tsquery(query, config);
  };
  return {
    text,
    vectors,
    diagnostics: [],
    rebuild: () => rebuildPostgresSearch(db, schema),
    fullText: Object.keys(text).length
      ? {
          match(index, query) {
            const column = relation(index, query.kind === "contains" ? index.fields[0] : undefined);
            // Long intent prompts can exceed PostgreSQL's tsquery tree limit.
            // Ordinary queries keep the indexable single-tsquery predicate.
            if (
              query.kind === "any" &&
              query.clauses.length > 128 &&
              query.clauses.every(
                (clause): clause is Extract<TextQuery, { kind: "phrase" }> =>
                  clause.kind === "phrase" && !clause.prefix,
              )
            ) {
              const phrases = query.clauses.map((clause) => clause.text);
              return /* kysely-allow-raw: Bound literal phrases are matched independently against the admitted vector. */ sql<boolean>`EXISTS (SELECT 1 FROM json_array_elements_text(${JSON.stringify(phrases)}::json) AS search_terms(value) WHERE ${column} @@ phraseto_tsquery(${sql.lit(config)}::regconfig, search_terms.value))`;
            }
            if (query.kind === "contains") {
              if (index.postgres?.mode !== "trigram") {
                throw new Error("Contains requires a declared PostgreSQL trigram index");
              }
              const pattern = `%${query.text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
              return /* kysely-allow-raw: PostgreSQL's literal trigram predicate returns boolean. */ sql<boolean>`${column} ILIKE ${pattern} ESCAPE '\\'`;
            }
            return /* kysely-allow-raw: PostgreSQL's tsvector predicate returns boolean. */ sql<boolean>`${column} @@ ${tsquery(query, config)}`;
          },
          rank(index, query, options) {
            if (query?.kind === "contains") {
              if (index.postgres?.mode !== "trigram") {
                throw new Error("Contains requires a declared PostgreSQL trigram index");
              }
              return {
                value: /* kysely-allow-raw: The admitted extension ranks a bound literal against its declared field. */ sql<number>`${sql.raw(extension)}.word_similarity(${query.text}, ${relation(index, index.fields[0])})`,
                order: "desc",
                toRank: (raw) => raw,
              };
            }
            const column = relation(index);
            const rankFunction =
              options?.postgres?.rank === "frequency" ? sql`ts_rank` : sql`ts_rank_cd`;
            return {
              value: /* kysely-allow-raw: The closed rank choice selects a native numeric function. */ sql<number>`${rankFunction}(${column}, ${requireQuery(query)}, ${options?.postgres?.normalization ?? 2})`,
              order: "desc",
              toRank: (raw) => raw,
            };
          },
          snippet(index, field, maxTokens, query, maxChars = 500) {
            if (maxTokens < 2) {
              throw new Error("PostgreSQL snippets require at least two tokens");
            }
            if (!index.fields.includes(field)) {
              throw new Error(`Text index has no field ${field}`);
            }
            const words = Math.max(1, Math.min(48, Math.trunc(maxTokens)));
            return /* kysely-allow-raw: The native headline is bounded text from the admitted field. */ sql<string>`left(ts_headline(${sql.lit(config)}::regconfig, ${relation(index, field)}, ${requireQuery(query)}, ${`StartSel='', StopSel='', MaxWords=${words}, MinWords=1, MaxFragments=1, FragmentDelimiter=' … '`}), ${Math.max(1, Math.min(500, Math.trunc(maxChars)))})`;
          },
          identity: (index) =>
            /* kysely-allow-raw: The declared source identity is the native numeric row identity. */ sql<number>`${relation(index, index.postgres!.identity)}`,
          allocatedIdentity() {
            throw new Error("PostgreSQL insert identities must use RETURNING");
          },
        }
      : null,
    vector:
      schema.mode === "keyword-only" || !Object.keys(vectors).length
        ? null
        : bindPostgresVector(db, store, schema),
  };
}

function bindPostgresVector(
  db: PostgresSqlConnection,
  store: object,
  schema: SearchSchema,
): VectorCapability {
  const kysely = getNodeSqliteKysely(db);
  const extension = pgSearchName(schema.extensionSchema ?? "public");
  const binaryPrefilter = getAdmittedPostgresSchema(db)?.postgresVectorSearchVersion === 2;
  const own = (index: VectorIndex) => {
    if (!db.isOpen || index.store !== store) {
      throw new Error("Vector index is not admitted to this open store");
    }
    return index.postgres!;
  };
  const write = (index: VectorIndex) => {
    const source = own(index);
    if (!db.isTransaction) {
      throw new Error("Vector mutation requires the owner's transaction");
    }
    return source;
  };
  return {
    idSet(index, ids) {
      own(index);
      return /* kysely-allow-raw: Bound JSON elements retain string ID type. */ sql<string>`SELECT value FROM json_array_elements_text(${JSON.stringify(ids)}::json)`;
    },
    prepareExists(index) {
      own(index);
      const statement =
        /* sqlite-allow-raw: PostgreSQL projection lookup uses its admitted identity. */ db.prepare(
          `SELECT id FROM ${pgSearchName(index.table)} WHERE id = ?`,
        );
      return (id) => Boolean(statement.get(id));
    },
    async nearest(request) {
      const source = own(request.index);
      request.signal?.throwIfAborted();
      if (
        request.vector.length !== source.dimensions ||
        request.vector.some(
          (value) => !Number.isFinite(value) || !Number.isFinite(Math.fround(value)),
        ) ||
        !request.vector.some((value) => Math.fround(value) !== 0)
      ) {
        throw new Error(
          "PostgreSQL cosine query requires a finite nonzero vector matching the admitted dimensions; rebuild for a changed embedding model.",
        );
      }
      const vector = `[${request.vector.map(Math.fround).join(",")}]`;
      const stored =
        /* kysely-allow-raw: The vector column belongs to the admitted index. */ sql.ref(
          `${request.index.alias}.embedding`,
        );
      const distance = /* kysely-allow-raw: Native cosine uses admitted identifiers and a bound vector. */ sql<number>`${sql.ref(`${request.index.alias}.embedding`)} ${sql.raw(`OPERATOR(${extension}.<=>)`)} ${vector}::${sql.raw(extension)}.vector`;
      const bits =
        /* kysely-allow-raw: The binary column belongs to the admitted projection. */ sql.ref(
          `${request.index.alias}.embedding_bits`,
        );
      const eligible = binaryPrefilter
        ? /* kysely-allow-raw: The stored sketch is null exactly when cosine is ineligible. */ sql<boolean>`${bits} IS NOT NULL`
        : /* kysely-allow-raw: Historical projections compute eligibility from the vector. */ sql<boolean>`${sql.raw(extension)}.vector_norm(${stored}) > 0`;
      const candidates = binaryPrefilter
        ? request.candidates?.({
            match: eligible,
            distance: /* kysely-allow-raw: Hamming preselection uses the admitted sketch and extension. */ sql<number>`${bits} ${sql.raw(`OPERATOR(${extension}.<~>)`)} ${sql.raw(extension)}.binary_quantize(${vector}::${sql.raw(extension)}.vector)`,
            limit: request.limit * 8,
          })
        : undefined;
      const query = request.query({
        match: candidates
          ? /* kysely-allow-raw: Only scoped, eligible prefilter IDs reach exact cosine reranking. */ sql<boolean>`${sql.ref(`${request.index.alias}.id`)} IN (SELECT id FROM openclaw_vector_candidates)`
          : eligible,
        distance,
      });
      // Materialize IDs only: the cheap scan must not fetch every float32 payload.
      const candidateCte = candidates
        ? sql`WITH openclaw_vector_candidates AS MATERIALIZED (${candidates})`
        : sql``;
      const rows = executeSqliteQuerySync(db, {
        compile: () =>
          sql`${candidateCte} SELECT * FROM (${query}) AS openclaw_candidates LIMIT ${request.limit}`.compile(
            kysely,
          ),
      }).rows;
      if (
        !rows.every(request.isRow) ||
        !rows.every((row) => matchesVectorRow(row, request.index.rowShape))
      ) {
        throw new Error("PostgreSQL vector query returned an invalid row");
      }
      for (const row of rows) {
        const prefix = request.textPrefix;
        if (prefix && row && typeof row === "object") {
          const text = Reflect.get(row, prefix.column);
          if (typeof text === "string") {
            Reflect.set(row, prefix.column, truncateUtf16Safe(text, prefix.maxChars));
          }
        }
      }
      return { rows, fallbackScanRequired: false };
    },
    remove(index, scope) {
      write(index);
      const ids =
        "toOperationNode" in scope
          ? sql`${scope}`
          : sql`SELECT value FROM json_array_elements_text(${JSON.stringify(scope)}::json)`;
      executeSqliteQuerySync(db, {
        compile: () =>
          /* kysely-allow-raw: The table belongs to the admitted store; IDs remain bound. */ sql`DELETE FROM ${sql.table(index.table)} WHERE id IN (${ids})`.compile(
            kysely,
          ),
      });
    },
    drop() {
      throw new Error(
        "PostgreSQL vector DDL belongs to store schema admission; rebuild the projection instead",
      );
    },
    create(index, dimensions) {
      const source = write(index);
      if (source.dimensions !== dimensions) {
        throw new Error(
          "PostgreSQL vector dimensions changed; reopen with the new search schema and rebuild",
        );
      }
    },
    write(index, rows) {
      const source = write(index);
      // Refresh from authoritative bytes, never re-encode a caller's possibly rounded embedding.
      const statement =
        /* sqlite-allow-raw: PostgreSQL projection refresh derives from canonical source bytes. */ db.prepare(
          `INSERT INTO ${pgSearchName(index.table)}(id, embedding) SELECT ${pgSearchName(source.key)}, openclaw_vector(${pgSearchName(source.embedding)}, ${source.dimensions}) FROM ${pgSearchName(source.source)} WHERE ${pgSearchName(source.key)} = ? AND octet_length(${pgSearchName(source.embedding)}) > 0 ON CONFLICT (id) DO UPDATE SET embedding = excluded.embedding`,
        );
      for (const row of rows) {
        statement.run(row.id);
      }
    },
  };
}

/** @experimental Bind once alongside the owner's admission, using its declared indexes. */
export function bindStoreSearch(store: SearchStore, schema: SearchSchema): StoreSearchCapabilities {
  const postgres = "databasePath" in store ? Boolean(store.input) : isPostgresSqlConnection(store);
  if (postgres) {
    if ("databasePath" in store || !isPostgresSqlConnection(store)) {
      throw new Error("PostgreSQL search requires the admitted worker connection");
    }
    return bindPostgresSearch(store, schema);
  }
  const sqlite = "databasePath" in store || isPostgresSqlConnection(store) ? undefined : store;
  const databasePath = "databasePath" in store ? store.databasePath : (sqlite?.location() ?? "");
  const token = {};
  const bindIndexes = <Definition>(definitions: Record<string, Definition> = {}) =>
    Object.fromEntries(
      Object.entries(definitions).map(([name, definition]) => [
        name,
        { ...definition, store: token },
      ]),
    );
  return {
    fullText: bindSqliteFullText(token, sqlite),
    vector: bindSqliteVectorCapability({ store: token, databasePath }, sqlite),
    text: bindIndexes(schema.text),
    vectors: bindIndexes(schema.vector),
    diagnostics: [],
  };
}
