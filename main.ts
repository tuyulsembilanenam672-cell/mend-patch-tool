// mend: apply AI-written edits in four formats (unified diff, SEARCH/REPLACE,
// V4A patch, JSON tool calls) to a tree of text files, per SPEC.md.
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines under its own line break, and whether it ends with one. */
interface FileLines {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A line under one matching tier. */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/**
 * The first tier (0, 1, 2; 0 only when strict) at which O occurs in the file's
 * lines at or after `from`, and every such position. For an end-of-file
 * search only occurrences ending at the file's last line count.
 */
function findTier(
  fileLines: string[],
  O: string[],
  strict: boolean,
  from = 0,
  eofOnly = false,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = O.map((l) => norm(l, tier));
    const pos: number[] = [];
    for (let i = from; i + O.length <= fileLines.length; i += 1) {
      let ok = true;
      for (let j = 0; j < O.length; j += 1) {
        if (norm(fileLines[i + j]!, tier) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (eofOnly && i + O.length !== fileLines.length) continue;
      pos.push(i);
    }
    if (pos.length > 0) return { tier, positions: pos };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, tier by tier. */
function findAnchor(fileLines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = norm(anchor, tier);
    for (let i = from; i < fileLines.length; i += 1) {
      if (norm(fileLines[i]!, tier) === want) return i;
    }
  }
  return -1;
}

/** One line of N: a context line is written as the file's own matched line. */
interface NItem {
  text: string;
  /** Index into O when this is a context line, else null. */
  ctx: number | null;
}

/**
 * Replace O at position `pos` with N. At tier 2 every other line of N is
 * re-indented from O's first line's leading whitespace to the file's.
 */
function applyReplacement(fileLines: string[], O: string[], N: NItem[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const reindent = tier === 2 && O.length > 0;
  const f = reindent ? leadingWs(fileLines[pos]!) : '';
  const p = reindent ? leadingWs(O[0]!) : '';
  for (const item of N) {
    if (item.ctx !== null) {
      out.push(fileLines[pos + item.ctx]!);
      continue;
    }
    let t = item.text;
    if (reindent && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return [...fileLines.slice(0, pos), ...out, ...fileLines.slice(pos + O.length)];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, in order, for the R output lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Detect the patch format from its lines, or null when none holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const lines = [...f.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile({ br: f.br, lines, final: f.final }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- Section 6: unified diffs ---- */

interface Hunk {
  a: number;
  body: string[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

/** A ---/+++ path: text after the four characters, up to the first tab, trimmed, a/ or b/ removed. */
function cleanHeaderPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseDiffGit(line: string): [string, string] | null {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  if (m === null) return null;
  return [m[1]!, m[2]!];
}

/** A hunk header's old start A, or null when the line is not one. */
function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) return null;
  return parseInt(m[1]!, 10);
}

/** A hunk body's old lines O and new lines N (context lines in both). */
function hunkLines(body: string[]): { O: string[]; N: NItem[] } {
  const O: string[] = [];
  const N: NItem[] = [];
  for (const b of body) {
    if (b === '' || b[0] === ' ') {
      const text = b === '' ? '' : b.slice(1);
      O.push(text);
      N.push({ text, ctx: O.length - 1 });
    } else if (b[0] === '-') {
      O.push(b.slice(1));
    } else if (b[0] === '+') {
      N.push({ text: b.slice(1), ctx: null });
    }
    // A '\' line only marks no-newline on the body line before it.
  }
  return { O, N };
}

/** Whether a '\' line follows the hunk's last context or '+' line. */
function lastContextOrPlusNoNL(body: string[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    const b = body[i]!;
    if (b === '' || b[0] === ' ' || b[0] === '+') last = i;
  }
  if (last < 0) return false;
  return body[last + 1]?.startsWith('\\') ?? false;
}

/** A created file's text: the '+' lines of all hunks, in order. */
function creationText(hunks: Hunk[]): string {
  const plus: string[] = [];
  let noNL = false;
  for (const hunk of hunks) {
    let lastPlus = -1;
    for (let i = 0; i < hunk.body.length; i += 1) {
      if (hunk.body[i]![0] === '+') lastPlus = i;
    }
    for (const b of hunk.body) {
      if (b[0] === '+') plus.push(b.slice(1));
    }
    if (lastPlus >= 0) noNL = hunk.body[lastPlus + 1]?.startsWith('\\') ?? false;
  }
  if (plus.length === 0) return '';
  return plus.join('\n') + (noNL ? '' : '\n');
}

/** Apply a section's hunks in order to a file's lines. */
function applyHunks(f: FileLines, hunks: Hunk[], path: string, strict: boolean): FileLines {
  let lines = f.lines;
  let finalBr = f.final;
  let d = 0;
  for (const hunk of hunks) {
    const { O, N } = hunkLines(hunk.body);
    const noNL = lastContextOrPlusNoNL(hunk.body);
    if (O.length > 0) {
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const runsToEnd = best + O.length === lines.length;
      lines = applyReplacement(lines, O, N, best, found.tier);
      if (runsToEnd) finalBr = !noNL;
      d += N.length - O.length;
    } else {
      const pos = Math.max(0, Math.min(hunk.a + d, lines.length));
      const atEnd = pos === lines.length;
      lines = [...lines.slice(0, pos), ...N.map((item) => item.text), ...lines.slice(pos)];
      if (atEnd) finalBr = !noNL;
      d += N.length;
    }
  }
  return { br: f.br, lines, final: finalBr };
}

function sectionEdit(s: Section, strict: boolean): Edit {
  let oldPath: string | null;
  let newPath: string | null;
  if (s.hasPair) {
    oldPath = s.pairOld;
    newPath = s.pairNew;
  } else {
    oldPath = s.renameFrom ?? s.gitOld;
    newPath = s.renameTo ?? s.gitNew;
  }
  if (oldPath === '/dev/null') oldPath = null;
  if (newPath === '/dev/null') newPath = null;
  const creation = oldPath === null || s.creation;
  const deletion = newPath === null || s.deletion;
  const hunks = s.hunks;
  return (tree) => {
    if (creation) {
      const target = newPath ?? '';
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      tree.now.set(target, creationText(hunks));
      return;
    }
    if (deletion) {
      const target = oldPath ?? '';
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const oldP = oldPath!;
    const newP = newPath!;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    const text = joinFile(applyHunks(splitFile(before), hunks, oldP, strict));
    if (oldP !== newP) {
      tree.now.set(newP, text);
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, text);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  const fresh = (gitOld: string | null, gitNew: string | null): Section => ({
    gitOld,
    gitNew,
    pairOld: null,
    pairNew: null,
    hasPair: false,
    renameFrom: null,
    renameTo: null,
    creation: false,
    deletion: false,
    hunks: [],
  });
  let cur: Section | null = null;
  let inHeader = false;
  const n = lines.length;
  let i = 0;
  const pairAhead = (j: number): boolean => (lines[j + 1] ?? '').startsWith('+++ ');
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const g = parseDiffGit(l);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh(g[0], g[1]);
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      if (l.startsWith('--- ') && pairAhead(i)) {
        cur = fresh(null, null);
        cur.pairOld = cleanHeaderPath(l);
        cur.pairNew = cleanHeaderPath(lines[i + 1]!);
        cur.hasPair = true;
        sections.push(cur);
        inHeader = true;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && pairAhead(i)) {
      if (inHeader && !cur.hasPair) {
        cur.pairOld = cleanHeaderPath(l);
        cur.pairNew = cleanHeaderPath(lines[i + 1]!);
        cur.hasPair = true;
        i += 2;
        continue;
      }
      cur = fresh(null, null);
      cur.pairOld = cleanHeaderPath(l);
      cur.pairNew = cleanHeaderPath(lines[i + 1]!);
      cur.hasPair = true;
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const a = parseHunkHeader(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      i += 1;
      const body: string[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && pairAhead(i)) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push(b);
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a, body });
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        cur.pairNew = cleanHeaderPath(l);
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.creation = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.deletion = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/* ---- Section 7: SEARCH/REPLACE blocks ---- */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const items: NItem[] = newLines.map((text) => ({ text, ctx: null }));
    const out = applyReplacement(f.lines, oldLines, items, found.positions[0]!, found.tier);
    tree.now.set(path, joinFile({ br: f.br, lines: out, final: f.final }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let k = searchLine + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '=======') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    const sep = k;
    k += 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    const end = k;
    edits.push(srEdit(path, lines.slice(searchLine + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

/* ---- Section 8: V4A patches ---- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

interface VSection {
  kind: string;
  path: string;
  lineNo: number;
  lines: { text: string; no: number }[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const rawSections: VSection[] = [];
  let curRaw: VSection | null = null;
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    const m = /^\*\*\* (Add File|Delete File|Update File): (.*)$/.exec(l);
    if (m !== null) {
      curRaw = { kind: m[1]!, path: m[2]!.trim(), lineNo: i + 1, lines: [] };
      rawSections.push(curRaw);
      i += 1;
      continue;
    }
    if (curRaw === null) {
      if (blank(l)) {
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    curRaw.lines.push({ text: l, no: i + 1 });
    i += 1;
  }
  const edits: Edit[] = [];
  for (const rs of rawSections) {
    while (rs.lines.length > 0 && blank(rs.lines[rs.lines.length - 1]!.text)) rs.lines.pop();
    if (rs.kind === 'Add File') {
      const fileLines: string[] = [];
      for (const { text, no } of rs.lines) {
        if (text === '') {
          fileLines.push('');
          continue;
        }
        if (text[0] === '+') {
          fileLines.push(text.slice(1));
          continue;
        }
        throw new Exit2(`error: parse ${no}`);
      }
      edits.push((tree) => {
        const p = rs.path;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (rs.kind === 'Delete File') {
      for (const { text, no } of rs.lines) {
        if (blank(text)) continue;
        throw new Exit2(`error: parse ${no}`);
      }
      edits.push((tree) => {
        const p = rs.path;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    let moveTo: string | null = null;
    const chunks: VChunk[] = [];
    let curChunk: VChunk | null = null;
    let seenContent = false;
    for (const { text, no } of rs.lines) {
      if (text === '') {
        if (curChunk !== null) {
          curChunk.body.push('');
        } else if (chunks.length === 0 && !seenContent) {
          curChunk = { anchor: null, eof: false, body: [''] };
          seenContent = true;
        }
        continue;
      }
      if (text.startsWith('*** Move to: ')) {
        if (moveTo !== null || curChunk !== null || chunks.length > 0 || seenContent) throw new Exit2(`error: parse ${no}`);
        moveTo = text.slice('*** Move to: '.length).trim();
        seenContent = true;
        continue;
      }
      if (text.startsWith('*** End of File')) {
        if (text.trim() !== '*** End of File') throw new Exit2(`error: parse ${no}`);
        if (curChunk === null) throw new Exit2(`error: parse ${no}`);
        curChunk.eof = true;
        chunks.push(curChunk);
        curChunk = null;
        seenContent = true;
        continue;
      }
      if (text.startsWith('@@')) {
        if (curChunk !== null) chunks.push(curChunk);
        const a = text.slice(2).trim();
        curChunk = { anchor: a === '' ? null : a, eof: false, body: [] };
        seenContent = true;
        continue;
      }
      if (text[0] === ' ' || text[0] === '-' || text[0] === '+') {
        if (curChunk === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${no}`);
          curChunk = { anchor: null, eof: false, body: [] };
        }
        curChunk.body.push(text);
        seenContent = true;
        continue;
      }
      throw new Exit2(`error: parse ${no}`);
    }
    if (curChunk !== null) chunks.push(curChunk);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${rs.lineNo}`);
    edits.push((tree) => {
      const p = rs.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const f = splitFile(before);
      let fileLines = f.lines;
      let cursor = 0;
      for (const chunk of chunks) {
        if (chunk.anchor !== null) {
          const at = findAnchor(fileLines, chunk.anchor, cursor, strict);
          if (at < 0) throw new Fail('no-match', p);
          cursor = at + 1;
        }
        const { O, N } = hunkLines(chunk.body);
        if (O.length > 0) {
          const found = findTier(fileLines, O, strict, cursor, chunk.eof);
          if (found === null) throw new Fail('no-match', p);
          const pos = found.positions[0]!;
          fileLines = applyReplacement(fileLines, O, N, pos, found.tier);
          cursor = pos + N.length;
        } else {
          const pos = chunk.eof ? fileLines.length : cursor;
          fileLines = [...fileLines.slice(0, pos), ...N.map((item) => item.text), ...fileLines.slice(pos)];
          cursor = pos + N.length;
        }
      }
      const text = joinFile({ br: f.br, lines: fileLines, final: f.final });
      if (moveTo !== null) {
        tree.now.set(moveTo, text);
        tree.now.set(p, null);
        tree.moves.push([p, moveTo]);
      } else {
        tree.now.set(p, text);
      }
    });
  }
  return edits;
}

/* ---- Sections 1, 2 and 10: invocation, output, order and atomicity ---- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
