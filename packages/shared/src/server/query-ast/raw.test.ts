import {
  ColumnNode,
  ExpressionWrapper,
  JSONPathLegNode,
  JSONPathNode,
  JSONReferenceNode,
  ReferenceNode,
  TableNode,
  sql,
  type Expression,
  type SqlBool,
} from "kysely";
import { describe, expect, it } from "vitest";

import {
  compileClickhouseCondition,
  compileClickhouseQuery,
  renderClickhouseExpression,
  type ClickhouseCompilable,
} from "./compile";
import { getClickhouseKysely } from "./dialect";
import { QueryCompileError, UnscopedRelationError } from "./errors";
import { aliasRef, literal } from "./extensions";
import { functionNotAllowedError } from "./functions";
import { assertCompiledSqlConfined, assertRawSqlSafe } from "./raw";
import type { ClickHouseDatabase } from "./schema";

const db = getClickhouseKysely();
const where = (condition: Expression<SqlBool>) =>
  db.selectFrom("traces as t").select("t.id").where(condition);
type Query = { toOperationNode(): unknown };
const check = (query: Query) => () => assertRawSqlSafe(query.toOperationNode());

describe("raw SQL checks", () => {
  it.each<[string, Query]>([
    [
      "modifyEnd",
      db
        .selectFrom("traces")
        .select("id")
        .modifyEnd(sql`or 1 = 1`),
    ],
    [
      "modifyFront",
      db
        .selectFrom("traces")
        .select("id")
        .modifyFront(sql`x`),
    ],
    ["a -- comment", where(sql`1 = 1 -- `)],
    ["a # comment", where(sql`1 = 1 # `)],
    ["a /* comment", where(sql`1 = 1 /* `)],
    [
      "a comment after a backslash-escaped quote",
      where(sql`t.id = 'a\\' ' -- '`),
    ],
    ["a statement separator", where(sql`1 = 1; 1`)],
    // ClickHouse skips U+200B as whitespace: `in<U+200B>scores` reads the table.
    ["a table name after IN and U+200B", where(sql.raw("t.id in​scores"))],
    [
      "a call split by U+0085",
      where(sql.raw("length(currentUser\u0085()) > 0")),
    ],
    ["a bracket closed before it opens", where(sql`1 = 1) or (1 = 1`)],
    ["a bracket left open", where(sql`(1 = 1`)],
    ["a square bracket left open", where(sql`[1 = 1`)],
    ["crossed bracket kinds", where(sql`[t.id) or (1 = 1]`)],
    ["a quote left open", where(sql`t.id = '`)],
    ["a quoted name left open", where(sql`"t.id = 1`)],
    [
      "a keyword spliced in by sql.id",
      where(sql`t.id in (${sql.id("select")} 1)`),
    ],
    [
      "a keyword split by empty raw SQL",
      where(sql`t.id = (1 fr${sql.raw("")}om scores)`),
    ],
    [
      "a keyword split around an sql.id name",
      where(sql`t.id = (1 fr${sql.id("om")} scores)`),
    ],
    ...[
      "select",
      "from",
      "join",
      "union",
      "intersect",
      "except",
      "settings",
      "format",
      "into",
    ].map((keyword): [string, Query] => [
      `the keyword ${keyword}`,
      where(sql.raw(`1 ${keyword} 1`)),
    ]),
    [
      "an APPLY transformer",
      db.selectFrom("traces as t").select(sql`t.* apply file`.as("f")),
    ],
    ["a heredoc string", where(sql`t.id = $$'$$) or (1 = 1 or $$'$$ = ''`)],
    ["a query parameter", where(sql`t.id in {p2:Identifier}`)],
    ["a table reference", where(sql`t.id in ${sql.table("scores")}`)],
    [
      "an aliased name parameter",
      where(sql`t.id in ${sql.ref("scores").as("s")}`),
    ],
    [
      "a parenthesized name parameter",
      db
        .selectFrom("traces as t")
        .select("t.id")
        .where((eb) => sql`t.id in ${eb.parens(sql.ref("scores"))}`),
    ],
    [
      "a schema-qualified name parameter",
      where(sql`t.id = ${sql.ref("default.scores.id")}`),
    ],
    [
      "a keyword as the table of an sql.ref name",
      where(sql`t.id = ${sql.ref("select.id")}`),
    ],
  ])("rejects %s", (_shape, query) => {
    expect(check(query)).toThrow(UnscopedRelationError);
  });

  const bad = ") or (1 = 1 or t.id = ";
  it.each<[string, Query & ClickhouseCompilable]>([
    ["a value", where(sql`t.id = '${literal(bad)}'`)],
    ["a value in a nested raw", where(sql`t.id = '${sql`${literal(bad)}`}'`)],
    [
      "a value in an sql.join",
      where(sql`t.id = '${sql.join([literal(bad), literal("x")])}'`),
    ],
  ])("rejects %s spliced inside a quote the raw text opened", (_s, query) => {
    expect(() => compileClickhouseQuery(query, "proj-A")).toThrow(
      UnscopedRelationError,
    );
  });

  it("accepts expressions that stay in their slot and read no relation", () => {
    const query = db
      .selectFrom("traces as t")
      .distinct()
      .select(sql<string>`concat(t.id, '-- select from #')`.as("label"))
      .where(sql<boolean>`t.id in (${"a"}, ${"b"}) and has(${["x"]}, t.id)`)
      .where(sql<boolean>`(t.environment = 'it''s') and map() = map()`)
      .where(
        sql<boolean>`t.id in (${"a"}, lower(${"b"})) AND (t.login is null)`,
      )
      .where(sql<boolean>`t.id = 'a' or (t.name = 'b')`)
      .where(
        sql<boolean>`t.id in (${db.selectFrom("traces as s").select("s.id")})`,
      )
      .where((eb) => eb(sql`lower(t.id)`, "ilike", eb.val("%a%")));
    expect(check(query)).not.toThrow();
    expect(() => compileClickhouseQuery(query, "proj-A")).not.toThrow();
  });
});

describe("compiled SQL: names after IN and calls", () => {
  const compile = (query: ClickhouseCompilable) => () =>
    compileClickhouseQuery(query, "proj-A");

  it.each<[string, ClickhouseCompilable]>([
    ["a table name after IN", where(sql`t.id in scores`)],
    [
      "a table name after NOT IN, by sql.ref",
      where(sql`t.id not in ${sql.ref("scores")}`),
    ],
    ["a quoted table name after IN", where(sql`t.id in "scores"`)],
    ["a bracketed table name after IN", where(sql`t.id in (scores)`)],
    ["a square-bracketed table name after IN", where(sql`t.id in [scores]`)],
    ["a table name in an in() call", where(sql`in(t.id, scores)`)],
    [
      "a table name split across binary operation parts",
      db
        .selectFrom("traces as t")
        .select("t.id")
        .where((eb) => eb(sql`t.id in`, sql``, sql.id("scores"))),
    ],
    [
      "a table name after a raw IN operator with a parameter",
      db
        .selectFrom("traces as t")
        .select("t.id")
        .where((eb) =>
          eb(
            eb.ref("t.id"),
            sql`in${sql.raw("")}`,
            sql<string>`${sql.id("scores")}`,
          ),
        ),
    ],
    [
      "a column after a raw IN operator with a parameter",
      db
        .selectFrom("traces as t")
        .select("t.id")
        .where((eb) =>
          eb(eb.ref("t.id"), sql`in${sql.raw("")}`, eb.ref("t.id")),
        ),
    ],
    [
      "a table name split across nested binary operations",
      db
        .selectFrom("traces as t")
        .select("t.id")
        .where((eb) =>
          eb(
            eb(eb.ref("t.id"), "=", sql<string>`t.id in`),
            sql``,
            sql<SqlBool>`${sql.id("scores")}`,
          ),
        ),
    ],
    [
      "a table name after a raw NOT IN operator",
      db
        .selectFrom("traces as t")
        .select("t.id")
        .where((eb) =>
          eb("t.id", sql`not in`, sql<string>`${sql.ref("scores")}`),
        ),
    ],
    [
      "a table name after a raw IN under NOT",
      db
        .selectFrom("traces as t")
        .select("t.id")
        .where((eb) =>
          eb(eb.not(sql`t.id in`), sql``, sql<string>`${sql.id("scores")}`),
        ),
    ],
    [
      "a table name after a raw IN under NOT NOT",
      db
        .selectFrom("traces as t")
        .select("t.id")
        .where((eb) =>
          eb(
            eb.not(eb.not(sql`t.id in`)),
            sql``,
            sql<string>`${sql.id("scores")}`,
          ),
        ),
    ],
    [
      "a table name after a raw IN under unary minus",
      db
        .selectFrom("traces as t")
        .select("t.id")
        .where((eb) =>
          eb(eb.neg(sql`t.id in`), sql``, sql<string>`${sql.id("scores")}`),
        ),
    ],
    [
      "a table name after a raw IN that ends a BETWEEN",
      db
        .selectFrom("traces as t")
        .select("t.id")
        .where((eb) =>
          eb(
            eb.between(sql`t.id`, sql`'a'`, sql`'b' or t.id in`),
            sql``,
            sql<SqlBool>`${sql.id("scores")}`,
          ),
        ),
    ],
    [
      "a bracketed alias after a raw NOT IN with a parameter",
      db
        .selectFrom("traces as t")
        .select("t.id")
        .where((eb) =>
          eb(
            eb.ref("t.id"),
            sql`not ${sql.raw("in")}`,
            eb.parens(aliasRef<string>("scores")),
          ),
        ),
    ],
    ["a table name in a bracketed list", where(sql`t.id in (${"a"}, scores)`)],
    ["a table name in double brackets", where(sql`t.id in ((scores))`)],
    [
      "a table name in a list that starts with a quoted keyword",
      where(sql`t.id in ("with", scores)`),
    ],
  ])("rejects %s", (_shape, query) => {
    expect(compile(query)).toThrow(UnscopedRelationError);
  });

  it("rejects a name after IN in compileClickhouseCondition", () => {
    const query = db
      .selectFrom("traces as t")
      .where((eb) =>
        eb(eb.not(sql`t.id in`), sql``, sql<string>`${sql.id("scores")}`),
      );
    expect(() => compileClickhouseCondition(query, "proj-A", "f_")).toThrow(
      UnscopedRelationError,
    );
  });

  it.each<[string, ClickhouseCompilable]>([
    ["dictGet", where(sql`dictGet('d', 'x', t.id) = 1`)],
    ["joinGet", where(sql`"joinGet"('j', 'v', t.id) = 1`)],
    [
      "joinGet",
      db
        .selectFrom("traces as t")
        .select("t.id")
        .where((eb) =>
          eb(sql`joinGet`, sql``, eb.tuple("j", "v", eb.ref("t.id"))),
        ),
    ],
    [
      "dictGet",
      db
        .selectFrom("traces as t")
        .select("t.id")
        .where((eb) =>
          eb(eb.not(sql`dictGet`), sql``, eb.tuple("d", "x", eb.ref("t.id"))),
        ),
    ],
    [
      "getSetting",
      where(sql`getSetting${db.selectFrom("traces as s").select("s.id")} = 1`),
    ],
    ["with", where(sql`with(t.id) = 1`)],
  ])("rejects %s with the builder's allowlist error", (name, query) => {
    expect(compile(query)).toThrow(functionNotAllowedError(name).message);
  });

  it("accepts the Kysely shapes that write a keyword before a bracket", () => {
    const queries: ClickhouseCompilable[] = [
      db
        .selectFrom("traces as t")
        .select("t.id")
        .groupBy("t.id")
        .having((eb) =>
          eb.and([eb("t.id", "=", "a"), eb("t.environment", "=", "b")]),
        ),
      db.selectFrom("traces as t").select((eb) =>
        eb
          .case()
          .when(eb.and([eb("t.id", "=", "a"), eb("t.environment", "=", "b")]))
          .then("a")
          .else("b")
          .end()
          .as("c"),
      ),
      db.selectFrom("traces as t").select((eb) =>
        eb
          .case()
          .when("t.id", "=", "a")
          .then(eb.or([eb("t.environment", "=", "a"), eb("t.id", "=", "b")]))
          .else(eb.or([eb("t.environment", "=", "c"), eb("t.id", "=", "d")]))
          .end()
          .as("c"),
      ),
      db
        .selectFrom("traces as t")
        .select("t.id")
        .orderBy((eb) => eb.parens(eb.ref("t.id"))),
      db
        .selectFrom("traces as t")
        .distinct()
        .select((eb) => eb.parens(eb.ref("t.id")).as("x")),
    ];
    for (const query of queries) expect(compile(query)).not.toThrow();
  });

  it("accepts a cast to a type with arguments", () => {
    const query = where(
      sql`cast(t.id as Array(Nullable(String))) = ${["a"]} and t.id::Nullable(String) = ${"a"}`,
    );
    expect(compile(query)).not.toThrow();
  });
});

describe("compiled SQL check", () => {
  it.each([
    ["a -- comment", "select 1 --1"],
    ["a /* comment", "select 1 /* x */"],
    ["a # comment", "select 1 # x"],
    ["a statement separator", "select 1; select 2"],
    ["a heredoc string", "select $$'$$ -- '"],
    ["a non-ASCII character", "select t.id in​scores"],
    ["a control character", "select 1\u0000"],
    ["a quote left open", "select 'a"],
    ["a brace that opens no placeholder", "select {'a': 1}"],
    ["a placeholder of no type", "select {p1:String --}"],
    ["an Identifier placeholder", "select t.id in {p2:Identifier}"],
    ["a stray closing brace", "select 1}"],
    ["an APPLY transformer", "select s.* apply file from s"],
  ])("rejects %s outside quotes", (_shape, text) => {
    expect(() => assertCompiledSqlConfined(text)).toThrow(QueryCompileError);
  });

  it("accepts comments, braces and non-ASCII in quotes, and bind placeholders", () => {
    expect(() =>
      assertCompiledSqlConfined(
        "select 'a''-- é;', `#x`, \"/*\", 'a\\' -- ', - -1 where t.ts > {p1:DateTime64(3, 'UTC')} and t.id in {p2:Array(String)}",
      ),
    ).not.toThrow();
  });

  // A newline in the literal ends the `--1` comment; the scores read follows.
  const injected = sql<boolean>`t.id = ${sql.lit("\nproject_id from scores --")}`;

  it.each<[string, () => unknown]>([
    [
      "compileClickhouseQuery",
      () =>
        compileClickhouseQuery(
          db
            .selectFrom("traces as t")
            .select([sql<number>`0 -${sql.lit(-1)}`.as("a"), "t.id"])
            .where(injected),
          "proj-A",
        ),
    ],
    [
      "compileClickhouseCondition",
      () =>
        compileClickhouseCondition(
          db
            .selectFrom("traces as t")
            .where(sql<boolean>`0 -${sql.lit(-1)} = 1`)
            .where(injected),
          "proj-A",
          "f_",
        ),
    ],
    [
      "renderClickhouseExpression",
      () => renderClickhouseExpression(sql`0 -${sql.lit(-1)}`),
    ],
  ])(
    "%s rejects a comment glued across raw SQL and a value",
    (_entry, compile) => {
      expect(compile).toThrow("it holds a comment");
    },
  );

  // The key `a\` writes `'$."a\"'`, where `\"` escapes the quote that closes the key.
  it.each(["a\\", "a\n"])(
    "rejects the JSON path key %j, which ClickHouse reads in a string",
    (key) => {
      const path = JSONPathNode.cloneWithLeg(
        JSONPathNode.create(),
        JSONPathLegNode.create("Member", key),
      );
      const query = db
        .selectFrom("traces as t")
        .select(() =>
          new ExpressionWrapper<ClickHouseDatabase, "traces", string>(
            JSONReferenceNode.create(
              ReferenceNode.create(
                ColumnNode.create("id"),
                TableNode.create("t"),
              ),
              path,
            ),
          ).as("k"),
        );
      expect(() => compileClickhouseQuery(query, "proj-A")).toThrow(
        "A JSON path key holds a backslash or a control character",
      );
    },
  );

  it("spaces unary minus from a negative operand, so it writes no comment", () => {
    const query = db
      .selectFrom("traces as t")
      .select((eb) => [eb.neg(eb.lit(-1)).as("a"), "t.id"])
      .where((eb) =>
        eb("t.id", "=", literal("\nproject_id, id from scores --")),
      );
    expect(compileClickhouseQuery(query, "proj-A").sql).toBe(
      "select - -1 as a, t.id from traces as t where t.project_id = {p1:String} and t.id = '\nproject_id, id from scores --'",
    );
  });

  // The raw operand writes an empty first fragment before the `-1`.
  it("spaces unary minus from a raw operand that starts empty", () => {
    const query = db
      .selectFrom("traces as t")
      .select((eb) => eb.neg(sql<number>`${sql.lit(-1)}`).as("a"));
    expect(compileClickhouseQuery(query, "proj-A").sql).toBe(
      "select - -1 as a from traces as t where t.project_id = {p1:String}",
    );
  });
});
