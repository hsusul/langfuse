import {
  ColumnNode,
  IdentifierNode,
  RawNode,
  ReferenceNode,
  SelectQueryNode,
  TableNode,
  ValueNode,
  type OperationNode,
} from "kysely";

import { QueryCompileError, UnscopedRelationError } from "./errors";
import { functionNotAllowedError, isAllowedFunction } from "./functions";
import { PLAIN_IDENTIFIER, isPlaceholderType, walkNodes } from "./nodes";

/**
 * Raw SQL (`sql\`…\``) stays allowed for what the builder cannot express, but
 * only as a self-contained expression. Rejected, in any position:
 * - `modifyFront` / `modifyEnd`: text before or after the whole select, where
 *   `or 1 = 1` or a `settings` clause rewrites what tenancy scoped;
 * - a table reference parameter (`sql.table`);
 * - raw text that escapes its slot or reads a relation. The text is checked
 *   with nested raw SQL and `sql.id` / `sql.ref` names spliced in, as
 *   ClickHouse reads it: a comment (`--`, `#`, `/*`), `;`, `$` (heredoc
 *   strings), `{`/`}` (query parameters), a non-ASCII or control character
 *   (ClickHouse skips U+200B as whitespace), unmatched brackets or quotes, or
 *   a clause keyword (`select`, `from`, `join`, `union`, `intersect`,
 *   `except`, `settings`, `format`, `into`), or `apply`;
 * - a parameter other than raw SQL, a plain name, a value or a subquery;
 * - a name, value or subquery spliced inside a quote the raw text opened,
 *   where an inlined value's own quotes close it.
 *
 * A name after `in` and a call outside the allowlist are checked on the whole
 * compiled SQL ({@link assertCompiledSqlConfined}), where raw text and the
 * nodes beside it have glued into the tokens ClickHouse reads.
 */
export function assertRawSqlSafe(root: unknown): void {
  walkNodes(root, (node) => {
    if (SelectQueryNode.is(node)) assertNoModifiers(node);
    if (RawNode.is(node)) assertRawText(rawText(node));
  });
}

function assertNoModifiers(node: SelectQueryNode): void {
  const modifiers = [
    ...(node.frontModifiers ?? []),
    ...(node.endModifiers ?? []),
  ];
  // `distinct()` is a keyword modifier; `modifyFront/modifyEnd` carry raw SQL.
  if (modifiers.some((modifier) => modifier.rawModifier !== undefined)) {
    throw new UnscopedRelationError(
      "modifyFront/modifyEnd are rejected: raw text before or after a select can rewrite what the tenancy pass scoped. Express the clause with the builder or an extensions.ts helper.",
    );
  }
}

/** Placeholder for SQL that is no name: a value, a subquery, a bind. */
const OPAQUE = "?";

/** A name the compiler writes as is: `x`, `t.x`, `t.1`. */
const PLAIN_NAME = new RegExp(
  `${PLAIN_IDENTIFIER.source.slice(0, -1)}(\\.[A-Za-z0-9_]+)?$`,
);

/** Raw text as ClickHouse reads it, and where each non-raw parameter starts. */
type SplicedText = { text: string; parameters: number[] };

/** `node` as ClickHouse reads its text: names and nested raw SQL spliced in. */
function rawText(
  node: RawNode,
  spliced: SplicedText = { text: "", parameters: [] },
): SplicedText {
  node.sqlFragments.forEach((fragment, i) => {
    spliced.text += fragment;
    const parameter = node.parameters[i];
    if (parameter === undefined) return;
    if (RawNode.is(parameter)) {
      rawText(parameter, spliced);
      return;
    }
    spliced.parameters.push(spliced.text.length);
    spliced.text += parameterText(parameter);
  });
  return spliced;
}

/**
 * Parameter kinds are allowlisted: any other kind (`.as()`, `eb.parens`, a
 * function call) could write a name the text check never sees, as
 * `in ${sql.ref("scores").as("s")}` writes `in scores as s`.
 */
function parameterText(node: OperationNode): string {
  // A value is one bound or inlined literal; a subquery is scoped by tenancy.
  if (ValueNode.is(node) || SelectQueryNode.is(node)) return ` ${OPAQUE} `;
  if (TableNode.is(node)) {
    throw new UnscopedRelationError(
      "A table reference inside raw SQL (sql.table) is rejected in any position: it reads a relation the tenancy pass cannot scope. Read the table through selectFrom/innerJoin or a subquery instead.",
    );
  }
  const name = nameText(node);
  if (name === undefined) {
    return reject(
      `a ${node.kind} parameter is not raw SQL, a name, a value or a subquery`,
    );
  }
  if (!PLAIN_NAME.test(name)) {
    return reject(`the name "${name}" is not a plain identifier`);
  }
  // Spliced as written, so `fr${sql.id("om")}` reads `from`.
  return name;
}

/** `sql.id("x")` → `x`, `sql.ref("db.t.x")` → `db.t.x`, `sql.ref("t.*")` → `t.*`. */
function nameText(node: OperationNode): string | undefined {
  if (IdentifierNode.is(node)) return node.name;
  if (!ReferenceNode.is(node)) return undefined;
  const { schema, identifier } = node.table?.table ?? {};
  const column = ColumnNode.is(node.column) ? node.column.column.name : "*";
  return [schema?.name, identifier?.name, column]
    .filter((part) => part !== undefined)
    .join(".");
}

/** Keywords that read a relation or start a clause outside the slot. */
const CLAUSE_KEYWORDS = new Set([
  "select",
  "from",
  "join",
  "union",
  "intersect",
  "except",
  "settings",
  "format",
  "into",
]);

/**
 * `t.* apply f` calls `f` on each column with no bracket, so the allowlist
 * never sees the call. The compiler never writes `apply`.
 */
const APPLY = /\bapply\b/i;
const APPLY_REASON = "APPLY calls a function by name, outside the allowlist";

function reject(reason: string): never {
  throw new UnscopedRelationError(
    `Raw SQL is rejected: ${reason}. Raw SQL must be a self-contained expression that reads no relation; prefer the builder or an extensions.ts helper.`,
  );
}

/** Throws on the shapes of raw text {@link assertRawSqlSafe} lists. */
function assertRawText({ text, parameters }: SplicedText): void {
  const { code, quotes } = lexSql(text, reject, () =>
    reject("it holds a query parameter"),
  );
  // `'${literal(") or (1 = 1 or t.id = ")}'`: the inlined value closes the raw quote.
  const quoted = (at: number) =>
    quotes.some(([start, end]) => at > start && at < end);
  if (parameters.some(quoted)) {
    reject("a parameter is spliced inside a quote the raw text opened");
  }
  for (const [word] of code.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    if (CLAUSE_KEYWORDS.has(word.toLowerCase())) {
      reject(`"${word}" starts a clause or reads a relation`);
    }
  }
  if (APPLY.test(code)) reject(APPLY_REASON);
}

/** SQL text as ClickHouse tokenizes it. */
type LexedSql = {
  /**
   * The text with each string literal and bind placeholder as `?` and each
   * quoted name unquoted.
   */
  code: string;
  /** For each opening bracket's index in `code`, its closing bracket's index. */
  closing: Map<number, number>;
  /** Each quoted span of the text, as `[start, end)`. */
  quotes: [number, number][];
  /** The index in `code` of each unquoted name that was quoted in the text. */
  quotedNames: Set<number>;
};

/** Each closing bracket's opening bracket. */
const OPENING_BRACKET: Record<string, string> = { ")": "(", "]": "[" };

/**
 * Lexes `text` and rejects what {@link scanSql} rejects and an unmatched
 * bracket. `placeholder` is called at a brace and returns the index of the
 * placeholder's last character.
 */
function lexSql(
  text: string,
  fail: (reason: string) => never,
  placeholder: (index: number) => number,
): LexedSql {
  let code = "";
  const closing = new Map<number, number>();
  const open: number[] = [];
  const quotes: [number, number][] = [];
  const quotedNames = new Set<number>();
  scanSql(text, fail, {
    quoted: (span, start) => {
      quotes.push([start, start + span.length]);
      code += " ";
      if (!span.startsWith("'")) quotedNames.add(code.length);
      code += `${quotedToken(span)} `;
    },
    code: (i) => {
      const char = text[i];
      if (char === "{" || char === "}") {
        code += ` ${OPAQUE} `;
        return placeholder(i);
      }
      if (char === "(" || char === "[") open.push(code.length);
      if (char === ")" || char === "]") {
        const start = open.pop();
        if (start === undefined || code[start] !== OPENING_BRACKET[char]) {
          fail("it closes a bracket it did not open");
        }
        closing.set(start, code.length);
      }
      code += char;
      return i;
    },
  });
  if (open.length > 0) fail("it leaves a bracket open");
  return { code, closing, quotes, quotedNames };
}

/**
 * Characters ClickHouse and these checks read alike outside quotes: printable
 * ASCII and ASCII whitespace. ClickHouse skips U+200B or U+0085 as
 * whitespace, where a JS regex reads them as part of a word.
 */
const PLAIN_CHAR = /^[\t\n\v\f\r\x20-\x7e]$/;

/**
 * Walks `text` as ClickHouse lexes quotes: `'…'` strings, `"…"` and
 * `` `…` `` names, `\` escaping the next character, a doubled quote read as
 * close and reopen. Each quoted span goes to `visit.quoted`, each other
 * character to `visit.code`, which returns the index of the last character it
 * consumed. Outside quotes, `fail` is called on what ClickHouse reads
 * differently from the checks: a comment, `;`, a heredoc `$`, a character
 * outside {@link PLAIN_CHAR}; and on a quote left open.
 */
function scanSql(
  text: string,
  fail: (reason: string) => never,
  visit: {
    quoted(span: string, start: number): void;
    code(index: number): number;
  },
): void {
  let quoteStart: number | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoteStart !== undefined) {
      if (char === "\\") i++;
      else if (char === text[quoteStart]) {
        visit.quoted(text.slice(quoteStart, i + 1), quoteStart);
        quoteStart = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quoteStart = i;
      continue;
    }
    if (!PLAIN_CHAR.test(char)) {
      const hex = char.charCodeAt(0).toString(16).toUpperCase();
      fail(`it holds U+${hex.padStart(4, "0")} outside quotes`);
    }
    const pair = text.slice(i, i + 2);
    if (pair === "--" || pair === "/*" || char === "#") {
      fail("it holds a comment, which can swallow the injected scope");
    }
    if (char === ";") fail("it holds a statement separator");
    // `$$…$$` / `$tag$…$tag$` is a ClickHouse string this lexer does not model.
    if (char === "$") fail("it holds a heredoc string");
    i = visit.code(i);
  }
  if (quoteStart !== undefined) fail("it leaves a quote open");
}

/**
 * A string literal reads as a value; a quoted name as the name it quotes, so
 * `"joinGet"(…)` is checked as a call of `joinGet`.
 */
function quotedToken(quoted: string): string {
  if (quoted.startsWith("'")) return OPAQUE;
  const name = quoted.slice(1, -1);
  return PLAIN_IDENTIFIER.test(name) ? name : "quoted_name";
}

/** A bind placeholder as the compiler writes it: `{p1:Array(String)}`. */
const PLACEHOLDER = /\{[A-Za-z_][A-Za-z0-9_]*:([^{}]*)\}/y;

/**
 * Throws unless compiled `sql` reads, token by token, as the compiler wrote
 * it. Outside quotes: no comment, `;`, heredoc, non-ASCII or control
 * character; braces only as bind placeholders of a value type; no `apply`; no
 * name on the right of `in`; and every call on the allowlist in
 * `functions.ts`. This sees
 * the tokens that raw SQL and the nodes beside it glue: `-` and `-1` glue to
 * the comment `--1`, and `not ${sql`t.id in`}` beside `scores` reads
 * `not t.id in scores`.
 */
export function assertCompiledSqlConfined(sql: string): void {
  const lexed = lexSql(sql, rejectCompiledSql, (i) => {
    PLACEHOLDER.lastIndex = i;
    const placeholder = PLACEHOLDER.exec(sql);
    if (!placeholder || !isPlaceholderType(placeholder[1])) {
      return rejectCompiledSql("it holds a brace that is no bind placeholder");
    }
    return i + placeholder[0].length - 1;
  });
  if (APPLY.test(lexed.code)) rejectCompiledSql(APPLY_REASON);
  assertNoNameAfterIn(lexed);
  assertAllowedCompiledCalls(lexed);
}

function rejectCompiledSql(reason: string): never {
  throw new QueryCompileError(
    `Compiled SQL is rejected: ${reason}. Raw SQL or an inlined value wrote text that ClickHouse reads outside its slot.`,
  );
}

/** A name ClickHouse reads as a column or table: `scores`, `t.id`. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*/;

/** Words that start a subquery inside brackets. */
const SUBQUERY_START = /^(select|with)\b/i;

/**
 * Rejects a name on the right of `in`, which ClickHouse reads as a table:
 * `in scores`, `in (scores)`, `in (1, scores)`, or the call `in(t.id,
 * scores)`. A subquery, a bind, a literal or a call stays allowed, as in
 * `in (select …)`, `in {p:Array(String)}`, `in (?, lower(?))`.
 */
function assertNoNameAfterIn(lexed: LexedSql): void {
  for (const match of lexed.code.matchAll(/(?<![A-Za-z0-9_.])in\b/gi)) {
    assertInOperand(lexed, match.index + match[0].length);
  }
}

/** Checks the operand that starts at `from` (after whitespace) in `code`. */
function assertInOperand(lexed: LexedSql, from: number): void {
  const { code, closing, quotedNames } = lexed;
  const start = code.length - code.slice(from).trimStart().length;
  const end = closing.get(start);
  if (end === undefined) {
    assertNoBareName(code.slice(start));
    return;
  }
  const elements = listElements(code, start + 1, end, closing);
  // `in ("with", scores)` is a list: a quoted name is never a keyword.
  const first = elements[0];
  const subquery = SUBQUERY_START.test(code.slice(first, end));
  if (subquery && !quotedNames.has(first)) return;
  for (const element of elements) {
    if (closing.has(element)) assertInOperand(lexed, element);
    else assertNoBareName(code.slice(element, end));
  }
}

/** Throws if `text` starts with a name that is not a call. */
function assertNoBareName(text: string): void {
  const name = NAME.exec(text.trimStart())?.[0];
  if (name === undefined) return;
  const after = text.trimStart().slice(name.length).trimStart();
  if (after.startsWith("(")) return;
  throw new UnscopedRelationError(
    `Compiled SQL is rejected: the name "${name}" on the right of IN is read as a table, unscoped. Compare against a value list, a parameter, or a subquery.`,
  );
}

/**
 * The start index (after whitespace) of each comma-separated element of the
 * list between `from` and `end`, nested brackets skipped.
 */
function listElements(
  code: string,
  from: number,
  end: number,
  closing: Map<number, number>,
): number[] {
  const starts: number[] = [];
  let element = from;
  for (let i = from; i <= end; i++) {
    if (i === end || code[i] === ",") {
      const text = code.slice(element, i);
      starts.push(element + text.length - text.trimStart().length);
      element = i + 1;
    } else {
      i = closing.get(i) ?? i;
    }
  }
  return starts;
}

/**
 * Words the compiler writes before `(` that are SQL syntax, each one a test
 * or golden needs: `from (select …)`, `join (select …)`, `on (…)`,
 * `where (…)`, `select (…)`, `as (select …)`, `and (…)`, `or (…)`,
 * `not (…)`, `in (…)`, `exists (select …)`, `count(*) filter(where …)`,
 * `over(…)`, `cast(x as T)`, `having (…)`, `when (…)`, `then (…)`,
 * `else (…)`, `order by (…)`, `distinct (…)`. None names a ClickHouse function
 * but `and`, `or`, `not`, `in` and `cast`, which read no relation; `in(x, t)` is checked
 * as an IN. Any other word before `(` is checked as a call.
 */
const NON_FUNCTION_WORDS = new Set([
  "and",
  "as",
  "cast",
  "by",
  "distinct",
  "else",
  "exists",
  "filter",
  "from",
  "having",
  "in",
  "join",
  "not",
  "on",
  "or",
  "over",
  "select",
  "then",
  "when",
  "where",
]);

/**
 * Throws on a call outside the allowlist in `functions.ts`. A name after
 * `as` or `::` is a type (`cast(x as Nullable(String))`), which ClickHouse
 * never reads as a call; its arguments are skipped.
 */
function assertAllowedCompiledCalls({ code, closing }: LexedSql): void {
  let skipUntil = -1;
  for (const match of code.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    if (match.index < skipUntil) continue;
    const name = match[1];
    if (/(?:(?<![A-Za-z0-9_])as|::)$/i.test(textBefore(code, match.index))) {
      skipUntil = closing.get(match.index + match[0].length - 1) ?? skipUntil;
      continue;
    }
    if (NON_FUNCTION_WORDS.has(name.toLowerCase())) continue;
    if (!isAllowedFunction(name)) throw functionNotAllowedError(name);
  }
}

/** Up to three characters of `code` before `index`, whitespace skipped. */
function textBefore(code: string, index: number): string {
  let end = index;
  while (end > 0 && /\s/.test(code[end - 1])) end--;
  return code.slice(Math.max(0, end - 3), end);
}
