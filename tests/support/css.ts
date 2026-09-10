/**
 * Reading a source file as text, without being fooled by the text inside a string.
 *
 * Several guards in this suite read a stylesheet — or the TSX beside it — as text and match
 * selectors and attributes in it, and each one strips comments first. They have to: these files
 * explain in prose exactly what the guard checks for, so a guard that reads its own explanation
 * fails on the very comment recording the fix. That has happened three times.
 *
 * Every one of them reached for the same regex, and it is wrong in the same way.
 *
 *   const text = css.replace(/\/\*[\s\S]*?\*\//g, " ");
 *
 * It gets the common case right and one uncommon case badly wrong. Neither language opens a
 * comment inside a string: `content: "/*"` and `url(a/*b.png)` are a quoted string and a url
 * token, and `const s = "/*"` is a string literal. To that regex each one is a comment opener,
 * and it then deletes every real rule up to the next comment close in the file. Nothing errors.
 * The guard downstream keeps passing, on a file it has silently stopped reading — which is the
 * one outcome these guards exist to make impossible.
 *
 * So the scanners below walk the text and track the contexts where a comment opener means
 * nothing. Two scanners, not one, because the two languages disagree about what a string is:
 * CSS has url() and no line comments, TSX has template literals, regex literals and `//`. A
 * single function pretending to serve both would be wrong for both. They share this file so the
 * next person who finds a hole in one knows where the other lives.
 */

/* ------------------------------------------------------------------ stylesheets */

/**
 * CSS with its comments replaced by `replacement`, honouring the three places CSS does not
 * treat `/*` as a comment opener: inside `'...'`, inside `"..."`, and inside an unquoted url()
 * token. An unterminated comment swallows the rest of the sheet, which is what CSS itself does.
 */
export function stripCssComments(css: string, replacement = " "): string {
  let out = "";
  let i = 0;
  const n = css.length;
  while (i < n) {
    const c = css[i];

    // A quoted string runs to its matching quote; a backslash escapes the next character.
    if (c === '"' || c === "'") {
      const end = endOfQuoted(css, i);
      out += css.slice(i, end);
      i = end;
      continue;
    }

    // An unquoted url() token runs to its ")" — url(a/*b.png) is a path, not a comment. A quoted
    // one (url("a.png")) is left to the string rule above, so a ")" inside the quotes cannot end
    // the token early.
    // The window used to be a fixed 6-character slice, which is only wide enough for ONE space
    // after "url(": `url(  a/*b.png)` fell through to the generic path and its `/*` opened a
    // comment again, swallowing every rule after it — the exact failure this scanner exists to
    // stop. CSS allows any run of whitespace there, so the run is scanned rather than guessed at.
    if ((c === "u" || c === "U") && isUnquotedUrl(css, i)) {
      const close = css.indexOf(")", i);
      const end = close === -1 ? n : close + 1;
      out += css.slice(i, end);
      i = end;
      continue;
    }

    if (c === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      out += replacement;
      i = close === -1 ? n : close + 2;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/**
 * Top-level rules only: selector plus body, with comments stripped and @-blocks skipped whole.
 *
 * `strip` is a seam, not an option. It exists so a test can run this walker over the same sheet
 * with the naive regex in place of the scanner and show the difference is the guard going blind,
 * rather than re-implementing the walker beside it and proving nothing. Callers pass nothing.
 */
export function topLevelRules(
  css: string,
  strip: (s: string) => string = stripCssComments,
): Array<{ sel: string; body: string }> {
  const text = strip(css);
  const rules: Array<{ sel: string; body: string }> = [];
  let i = 0;
  let sel = "";
  while (i < text.length) {
    const c = text[i];
    if (c === "{") {
      let depth = 0;
      let j = i;
      for (; j < text.length; j++) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}" && --depth === 0) break;
      }
      const trimmed = sel.trim();
      if (trimmed && !trimmed.startsWith("@")) rules.push({ sel: trimmed, body: text.slice(i + 1, j) });
      i = j + 1;
      sel = "";
      continue;
    }
    sel += c;
    i++;
  }
  return rules;
}

/**
 * Class names a sheet declares `display` for more than once at top level, with the values in
 * source order — the engine behind the one-class-one-component guard. Only a bare single-class
 * selector counts as a claim: `.a .b`, `.a:hover` and `.a[aria-disabled]` refine a name already
 * claimed rather than claiming it.
 */
export function displayCollisions(
  css: string,
  strip: (s: string) => string = stripCssComments,
): Array<[string, string[]]> {
  const claims = new Map<string, string[]>();
  for (const { sel, body } of topLevelRules(css, strip)) {
    const bare = /^\.([A-Za-z][A-Za-z0-9_-]*)$/.exec(sel);
    if (!bare) continue;
    const display = /(?:^|;)\s*display\s*:\s*([^;]+)/.exec(body);
    if (!display) continue;
    const list = claims.get(bare[1]) ?? [];
    list.push(display[1].trim());
    claims.set(bare[1], list);
  }
  return [...claims].filter(([, v]) => v.length > 1);
}

/* -------------------------------------------------------------------- TSX source */

// Characters after which a "/" opens a regex literal rather than dividing. Deliberately narrow.
// ")" and "]" are division (`bw / 2`, `up[i] / maxU`). "<" and "}" are excluded because in TSX
// they are how JSX spells `</div>` and `<rect ... rx={1.5} />`, and reading either as a regex
// would swallow the markup to the next "/" on the line.
const REGEX_MAY_FOLLOW = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", ";", "{", "+", "-", "*", "%", "~", "^"]);
const REGEX_MAY_FOLLOW_WORD = new Set(["return", "typeof", "instanceof", "case", "in", "of", "new", "delete", "void", "throw", "yield", "await", "do", "else"]);

/**
 * TSX with its comments replaced by `replacement`, honouring quoted strings, template literals
 * (including the `${ }` holes inside them, which can hold further templates) and regex literals.
 *
 * Line comments are stripped only where `//` opens a line, which is the rule these guards have
 * always used and the reason they survive `https://` in the markup. JSX text is not a string
 * literal, so a bare URL in the middle of a line has to stay untouched.
 *
 * The braces around a JSX `{ comment }` stay behind, as they do today — an empty pair is
 * balanced, so the one guard that brace-matches its way through a source file reads the same
 * either way, and leaving them costs nothing while telling a code block apart from a JSX child
 * would cost a parser.
 */
export function stripTsComments(src: string, replacement = " "): string {
  let out = "";
  let i = 0;
  const n = src.length;
  // Template literals nest through their ${ } holes, so the mode is a stack, and each code frame
  // carries its own brace depth to know which "}" closes a hole rather than a block.
  const modes: Array<"code" | "template"> = ["code"];
  const depths: number[] = [0];
  let prev = ""; // last significant character of real code, for the regex-or-division question
  let word = ""; // the identifier ending at `prev`, for `return /re/`
  let broken = true;

  const note = (ch: string) => {
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      broken = true;
      return;
    }
    prev = ch;
    if (/[A-Za-z0-9_$]/.test(ch)) word = broken ? ch : word + ch;
    else word = "";
    broken = false;
  };

  while (i < n) {
    const c = src[i];

    if (modes[modes.length - 1] === "template") {
      if (c === "\\") {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        out += c;
        i++;
        modes.pop();
        note("`");
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        out += "${";
        i += 2;
        modes.push("code");
        depths.push(0);
        continue;
      }
      out += c;
      i++;
      continue;
    }

    if (c === '"' || c === "'") {
      const end = endOfQuoted(src, i);
      out += src.slice(i, end);
      i = end;
      note(src[end - 1] ?? c);
      continue;
    }

    if (c === "`") {
      out += c;
      i++;
      modes.push("template");
      continue;
    }

    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      out += replacement;
      i = close === -1 ? n : close + 2;
      continue;
    }

    if (c === "/" && src[i + 1] === "/" && opensLine(src, i)) {
      const nl = src.indexOf("\n", i);
      out += replacement;
      i = nl === -1 ? n : nl;
      continue;
    }

    if (c === "/" && startsRegex(src, i, prev, word)) {
      const end = endOfRegex(src, i);
      if (end !== -1) {
        out += src.slice(i, end);
        i = end;
        note("/");
        continue;
      }
    }

    if (c === "{") depths[depths.length - 1]++;
    else if (c === "}") {
      if (depths[depths.length - 1] === 0 && modes.length > 1) {
        out += c;
        i++;
        modes.pop();
        depths.pop();
        note("}");
        continue;
      }
      depths[depths.length - 1]--;
    }

    out += c;
    note(c);
    i++;
  }
  return out;
}

/* ------------------------------------------------------------------------ shared */

/** Index just past the closing quote of the string starting at `i`, honouring backslash escapes. */
function endOfQuoted(s: string, i: number): number {
  const quote = s[i];
  let j = i + 1;
  // A newline ends the scan. Neither CSS nor JS lets a '...' or "..." span a raw line break, so a
  // quote with no partner on its own line was never a string opener — in TSX it is almost always
  // an apostrophe in JSX text (`the operator's note`, and overview-screen.tsx really has one).
  // Without this the scan ran to the next quote ANYWHERE later in the file and skipped every
  // comment in between, so a guard read comment prose as code: the very thing being guarded
  // against, arriving through a different door.
  while (j < s.length && s[j] !== quote && s[j] !== "\n") j += s[j] === "\\" ? 2 : 1;
  return s[j] === quote ? Math.min(j + 1, s.length) : Math.min(j, s.length);
}

/** `url(` followed by any run of whitespace and then an unquoted first character. */
function isUnquotedUrl(s: string, i: number): boolean {
  if (s.slice(i, i + 4).toLowerCase() !== "url(") return false;
  let j = i + 4;
  while (j < s.length && /\s/.test(s[j])) j++;
  const c = s[j];
  return c !== undefined && c !== '"' && c !== "'" && c !== ")";
}

/** True when only whitespace separates `i` from the start of its line. */
function opensLine(s: string, i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    const c = s[j];
    if (c === "\n") return true;
    if (c !== " " && c !== "\t" && c !== "\r") return false;
  }
  return true;
}

function startsRegex(s: string, i: number, prev: string, word: string): boolean {
  const next = s[i + 1];
  // "/>" closes a JSX tag, "/=" divides, "/*" and "//" are comments and were handled above.
  if (next === undefined || next === ">" || next === "=" || next === "*" || next === "/") return false;
  if (prev === "") return true;
  if (/[A-Za-z0-9_$]/.test(prev)) return REGEX_MAY_FOLLOW_WORD.has(word);
  return REGEX_MAY_FOLLOW.has(prev);
}

/**
 * Index just past a regex literal and its flags, or -1 if the run is not one after all. A regex
 * cannot span a line, so hitting a newline first is the signal that this "/" was something else
 * and should be emitted as an ordinary character.
 */
function endOfRegex(s: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "\n") return -1;
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      let k = j + 1;
      while (k < s.length && /[a-z]/.test(s[k])) k++;
      return k;
    }
  }
  return -1;
}
