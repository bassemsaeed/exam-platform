// Advanced calculator engine: exact expression parsing, zero eval().
// Grammar (recursive descent):
//   expr   := term (("+" | "-") term)*
//   term   := factor (("*" | "/") factor)*
//   factor := unary ("^" factor)?            (right-associative; -2^2 = -4)
//   unary  := "-" unary | postfix
//   postfix:= primary ("!" | "%")*           (% = divide by 100)
//   primary:= number | constant | func "(" expr ")" | "(" expr ")"
// Numbers are parsed in the active base (2/8/10/16). Functions and decimals
// only exist in base 10. Results round to 12 significant digits so float
// dust (0.1 + 0.2) never leaks into grades-side scratch work.

export type NumBase = 2 | 8 | 10 | 16;
export type AngleMode = "deg" | "rad";

export interface CalcError {
  error: string;
}

type Token =
  | { kind: "num"; text: string }
  | { kind: "op"; op: string }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "bang" }
  | { kind: "percent" }
  | { kind: "ident"; name: string };

const FUNCTIONS = new Set([
  "sin", "cos", "tan",
  "asin", "acos", "atan",
  "log", "ln", "sqrt", "abs", "recip",
]);
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export function tokenize(input: string, base: NumBase): Token[] | CalcError {
  const tokens: Token[] = [];
  let i = 0;
  const digit = (ch: string): boolean =>
    base === 16 ? /[0-9a-fA-F]/.test(ch)
    : base === 8 ? /[0-7]/.test(ch)
    : base === 2 ? /[01]/.test(ch)
    : /[0-9]/.test(ch);
  while (i < input.length) {
    const ch = input[i];
    if (ch === " " || ch === ",") { i++; continue; }
    if (ch === "(") { tokens.push({ kind: "lparen" }); i++; continue; }
    if (ch === ")") { tokens.push({ kind: "rparen" }); i++; continue; }
    if (ch === "!") { tokens.push({ kind: "bang" }); i++; continue; }
    if (ch === "%") { tokens.push({ kind: "percent" }); i++; continue; }
    if ("+-*/^".includes(ch)) {
      // Normalize pretty operators to ASCII.
      tokens.push({ kind: "op", op: ch });
      i++;
      continue;
    }
    if (ch === "×") { tokens.push({ kind: "op", op: "*" }); i++; continue; }
    if (ch === "÷") { tokens.push({ kind: "op", op: "/" }); i++; continue; }
    if (ch === "−") { tokens.push({ kind: "op", op: "-" }); i++; continue; }
    if (digit(ch) || (base === 10 && ch === ".")) {
      let text = "";
      let dots = 0;
      while (i < input.length && (digit(input[i]) || (base === 10 && input[i] === "."))) {
        if (input[i] === ".") {
          dots++;
          if (dots > 1) return { error: "Bad number" };
        }
        text += input[i];
        i++;
      }
      // Scientific E-notation in decimal only (from the EXP key).
      if (base === 10 && (input[i] === "E" || input[i] === "e")) {
        let exp = input[i];
        i++;
        if (input[i] === "+" || input[i] === "-") { exp += input[i]; i++; }
        let digits = "";
        while (i < input.length && /[0-9]/.test(input[i])) { digits += input[i]; i++; }
        if (!digits) return { error: "Bad number" };
        text += exp + digits;
      }
      if (text === ".") return { error: "Bad number" };
      tokens.push({ kind: "num", text });
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let name = "";
      while (i < input.length && /[a-zA-Z_0-9]/.test(input[i])) { name += input[i]; i++; }
      const lower = name.toLowerCase();
      // In hex mode single A-F letters are digits, not identifiers.
      if (base === 16 && /^[a-fA-F]$/.test(name)) {
        tokens.push({ kind: "num", text: name });
        continue;
      }
      if (base !== 10) return { error: "Functions need decimal mode" };
      if (FUNCTIONS.has(lower) || lower in CONSTANTS || lower === "ans") {
        tokens.push({ kind: "ident", name: lower });
        continue;
      }
      return { error: `Unknown: ${name}` };
    }
    return { error: `Bad character: ${ch}` };
  }
  return tokens;
}

function parseNumber(text: string, base: NumBase): number | null {
  if (base === 10) {
    const v = Number(text);
    return Number.isFinite(v) ? v : null;
  }
  if (!/^[0-9a-fA-F]+$/.test(text)) return null;
  const v = parseInt(text, base);
  return Number.isSafeInteger(v) ? v : null;
}

function factorial(n: number): number | null {
  if (!Number.isInteger(n) || n < 0 || n > 170) return null;
  let r = 1;
  for (let k = 2; k <= n; k++) r *= k;
  return r;
}

function applyFunc(name: string, x: number, mode: AngleMode): number | null {
  const toRad = (d: number) => (mode === "deg" ? (d * Math.PI) / 180 : d);
  const fromRad = (r: number) => (mode === "deg" ? (r * 180) / Math.PI : r);
  switch (name) {
    case "sin": return Math.sin(toRad(x));
    case "cos": return Math.cos(toRad(x));
    case "tan": {
      const c = Math.cos(toRad(x));
      if (Math.abs(c) < 1e-15) return null;
      return Math.tan(toRad(x));
    }
    case "asin": return Math.abs(x) <= 1 ? fromRad(Math.asin(x)) : null;
    case "acos": return Math.abs(x) <= 1 ? fromRad(Math.acos(x)) : null;
    case "atan": return fromRad(Math.atan(x));
    case "log": return x > 0 ? Math.log10(x) : null;
    case "ln": return x > 0 ? Math.log(x) : null;
    case "sqrt": return x >= 0 ? Math.sqrt(x) : null;
    case "abs": return Math.abs(x);
    case "recip": return x !== 0 ? 1 / x : null;
    default: return null;
  }
}

export function evaluate(
  input: string,
  base: NumBase,
  angle: AngleMode,
  ans: number,
): number | CalcError {
  const toks = tokenize(input, base);
  if ("error" in toks) return toks;
  let pos = 0;
  const peek = (): Token | null => toks[pos] ?? null;
  const eat = (): Token => toks[pos++];

  function parseExpr(): number | CalcError {
    let left = parseTerm();
    if (typeof left !== "number") return left;
    for (;;) {
      const t = peek();
      if (t?.kind !== "op" || (t.op !== "+" && t.op !== "-")) return left;
      eat();
      const right = parseTerm();
      if (typeof right !== "number") return right;
      left = t.op === "+" ? left + right : left - right;
    }
  }
  function parseTerm(): number | CalcError {
    let left = parseUnary();
    if (typeof left !== "number") return left;
    for (;;) {
      const t = peek();
      if (t?.kind !== "op" || (t.op !== "*" && t.op !== "/")) return left;
      eat();
      const right = parseUnary();
      if (typeof right !== "number") return right;
      if (t.op === "/") {
        if (right === 0) return { error: "Can't divide by zero" };
        left = left / right;
      } else {
        left = left * right;
      }
    }
  }
  function parseFactor(): number | CalcError {
    const baseVal = parsePostfix();
    if (typeof baseVal !== "number") return baseVal;
    const t = peek();
    if (t?.kind === "op" && t.op === "^") {
      eat();
      const exp = parseUnary(); // right-associative, signed exponents ok
      if (typeof exp !== "number") return exp;
      const r = Math.pow(baseVal, exp);
      if (!Number.isFinite(r)) return { error: "Result too large" };
      return r;
    }
    return baseVal;
  }
  function parseUnary(): number | CalcError {
    const t = peek();
    if (t?.kind === "op" && (t.op === "+" || t.op === "-")) {
      eat();
      const v = parseUnary();
      if (typeof v !== "number") return v;
      return t.op === "-" ? -v : v;
    }
    return parseFactor();
  }
  function parsePostfix(): number | CalcError {
    let v = parsePrimary();
    if (typeof v !== "number") return v;
    for (;;) {
      const t = peek();
      if (t?.kind === "bang") {
        eat();
        const f = factorial(v);
        if (f === null) return { error: "Factorial needs 0–170 integer" };
        v = f;
      } else if (t?.kind === "percent") {
        eat();
        v = v / 100;
      } else {
        return v;
      }
    }
  }
  function parsePrimary(): number | CalcError {
    const t = eat();
    if (!t) return { error: "Empty expression" };
    if (t.kind === "num") {
      const v = parseNumber(t.text, base);
      return v === null ? { error: "Bad number" } : v;
    }
    if (t.kind === "lparen") {
      const v = parseExpr();
      if (typeof v !== "number") return v;
      const close = eat();
      if (!close || close.kind !== "rparen") return { error: "Missing )" };
      return v;
    }
    if (t.kind === "ident") {
      if (t.name === "ans") return ans;
      if (t.name in CONSTANTS) return CONSTANTS[t.name];
      const open = eat();
      if (!open || open.kind !== "lparen") return { error: `Missing ( after ${t.name}` };
      const arg = parseExpr();
      if (typeof arg !== "number") return arg;
      const close = eat();
      if (!close || close.kind !== "rparen") return { error: "Missing )" };
      const r = applyFunc(t.name, arg, angle);
      if (r === null || Number.isNaN(r)) return { error: `${t.name} out of range` };
      return r;
    }
    return { error: "Unexpected symbol" };
  }

  const value = parseExpr();
  if (typeof value !== "number") return value;
  if (pos < toks.length) return { error: "Unexpected symbol" };
  return value;
}

/** Round float dust (0.1+0.2) while keeping 12 significant digits. */
export function clean(n: number): number {
  if (!Number.isFinite(n)) return n;
  if (n === 0) return 0;
  const rounded = Number(n.toPrecision(12));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function toBase(n: number, base: NumBase): string {
  const v = Math.trunc(n);
  if (!Number.isSafeInteger(v)) return "Overflow";
  const neg = v < 0;
  const out = Math.abs(v).toString(base).toUpperCase();
  return (neg ? "-" : "") + out;
}

/** Format a computed value for display in the active base. */
export function formatValue(n: number, base: NumBase): string {
  if (!Number.isFinite(n)) return "Error";
  if (base !== 10) return toBase(n, base);
  const v = clean(n);
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e13 || abs < 1e-9) {
    return v.toExponential(6).replace(/(\.\d*?)0+e/, "$1e").replace(/\.e/, "e");
  }
  return String(v);
}
