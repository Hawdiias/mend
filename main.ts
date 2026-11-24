// mend — one patch tool for every AI edit format.
//
// Applies a patch written in any of the four formats AI tools emit (unified
// diff, SEARCH/REPLACE blocks, the V4A begin/end-patch format, or JSON edit
// commands) to the working tree, with the exact output and exit-code contract
// of SPEC.md. Deterministic, standard library only, no network.
//
// Run `mend [--format=NAME] [--check] [--strict] [--] [PATCH]`: PATCH is a
// patch file path, or standard input when omitted or `-`.

import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Error types. Exit2 is the single line mend prints on exit 2. Fail is one
// edit's failure: a code and the path as the patch named it.
// ---------------------------------------------------------------------------

class Exit2 extends Error {
  line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

class Fail extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// The working tree: the original file bytes plus the bytes as the edits so
// far leave them (null = the file does not exist). Nothing reaches the disk
// until every edit has run and none failed.
// ---------------------------------------------------------------------------

class Tree {
  original = new Map<string, string | null>();
  now = new Map<string, string | null>();
  moves: Array<[string, string]> = [];

  get(path: string): string | null {
    if (this.now.has(path)) return this.now.get(path) as string | null;
    if (!this.original.has(path)) {
      let text: string | null;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        text = null;
      }
      this.original.set(path, text);
    }
    return this.original.get(path) as string | null;
  }

  write(checkOnly: boolean): void {
    const paths = new Set([...this.original.keys(), ...this.now.keys()]);
    for (const p of paths) {
      const was = this.original.get(p) ?? null;
      const is = this.now.has(p) ? (this.now.get(p) as string | null) : was;
      if (was === is || checkOnly) continue;
      if (is === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, is);
      }
    }
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

const blank = (s: string): boolean => s.trim() === '';

function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// Patch lines: the text split at \n, one trailing \r removed from each piece,
// and the empty piece a trailing \n leaves dropped.
function patchLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

// A file's own line model: its break (CRLF when its first \n follows a \r),
// its lines, and whether it ended with a break.
interface FileLines {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let finalBreak = false;
  if (parts[parts.length - 1] === '') {
    parts.pop();
    finalBreak = true;
  }
  return { br, lines: parts, finalBreak };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

// ---------------------------------------------------------------------------
// Section 5: the three matching tiers. Tier 0 is exact; tier 1 also forgives
// trailing spaces and tabs; tier 2 forgives leading whitespace too. findTier
// returns the first tier with at least one occurrence of the old lines at or
// after `from`, and every occurrence at that tier.
// ---------------------------------------------------------------------------

const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function lineAtTier(fileLine: string, patchLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === patchLine;
  if (tier === 1) return rtrimST(fileLine) === rtrimST(patchLine);
  return trimST(fileLine) === trimST(patchLine);
}

interface Found {
  tier: number;
  at: number[];
}

function findTier(
  fileLines: string[],
  old: string[],
  strict: boolean,
  from = 0,
): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at: number[] = [];
    for (let i = Math.max(0, from); i + old.length <= fileLines.length; i++) {
      let ok = true;
      for (let k = 0; k < old.length; k++) {
        if (!lineAtTier(fileLines[i + k], old[k], tier)) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

// At tier 2 a written line that is not blank and starts with the old block's
// own indent P has that indent replaced by the file's indent F.
function reindent(line: string, bigF: string, bigP: string): string {
  if (line.trim() === '') return line;
  if (line.startsWith(bigP)) return bigF + line.slice(bigP.length);
  return line;
}

// Walk a hunk or chunk body in order and build the replacement lines: a
// context line is written as the file's own matched line, a deleted line is
// skipped, and an added line is written from the patch (re-indented at
// tier 2). Deleted lines still consume their slot in the matched block.
function buildReplacement(
  fileLines: string[],
  pos: number,
  old: string[],
  items: BodyItem[],
  tier: number,
): string[] {
  const bigF = leadST(fileLines[pos] ?? '');
  const bigP = leadST(old[0] ?? '');
  const out: string[] = [];
  let j = pos;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[j]);
      j += 1;
    } else if (it.kind === 'del') {
      j += 1;
    } else if (it.kind === 'add') {
      out.push(tier === 2 ? reindent(it.text, bigF, bigP) : it.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits. An array, or JSON Lines. Any fault in reading an
// edit object is a parse error naming the line the format's rule gives.
// ---------------------------------------------------------------------------

interface JsonEdit {
  path: string;
  command: string;
  fileText?: string;
  oldStr?: string;
  newStr?: string;
  insertLine?: number;
}

function jsonEditOrNull(o: unknown): JsonEdit | null {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (typeof r.path !== 'string') return null;
  if (r.command === 'create') {
    if (typeof r.file_text !== 'string') return null;
    return { path: r.path, command: 'create', fileText: r.file_text };
  }
  if (r.command === 'str_replace') {
    if (typeof r.old_str !== 'string' || r.old_str === '') return null;
    if (r.new_str !== undefined && typeof r.new_str !== 'string') return null;
    return {
      path: r.path,
      command: 'str_replace',
      oldStr: r.old_str,
      newStr: typeof r.new_str === 'string' ? r.new_str : undefined,
    };
  }
  if (r.command === 'insert') {
    if (typeof r.insert_line !== 'number' || !Number.isInteger(r.insert_line)) return null;
    if (typeof r.new_str !== 'string') return null;
    return { path: r.path, command: 'insert', insertLine: r.insert_line, newStr: r.new_str };
  }
  return null;
}

function readJsonEdits(text: string, lines: string[]): JsonEdit[] {
  const f = lines.findIndex((l) => !blank(l));
  if (f === -1) throw new Exit2('error: parse 1');
  const failAt = f + 1;
  if (lines[f].trimStart().startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${failAt}`);
    }
    if (!Array.isArray(value)) throw new Exit2(`error: parse ${failAt}`);
    return value.map((el) => {
      const e = jsonEditOrNull(el);
      if (e === null) throw new Exit2(`error: parse ${failAt}`);
      return e;
    });
  }
  const edits: JsonEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (blank(lines[i])) continue;
    let value: unknown;
    try {
      value = JSON.parse(lines[i]);
    } catch {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const e = jsonEditOrNull(value);
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  }
  return edits;
}

function jsonEditFn(e: JsonEdit): Edit {
  return (tree) => {
    if (!safePath(e.path)) throw new Fail('unsafe', e.path);
    const before = tree.get(e.path);
    if (e.command === 'create') {
      if (before !== null) throw new Fail('exists', e.path);
      tree.now.set(e.path, e.fileText as string);
      return;
    }
    if (before === null) throw new Fail('missing', e.path);
    if (e.command === 'str_replace') {
      const oldStr = e.oldStr as string;
      const newStr = e.newStr ?? '';
      // A CRLF file is worked on in LF terms and written back in CRLF.
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replace(/\r\n/g, '\n') : s);
      const hay = lf(before);
      const needle = lf(oldStr);
      let count = 0;
      let at = -1;
      for (let k = hay.indexOf(needle); k !== -1; k = hay.indexOf(needle, k + 1)) {
        count += 1;
        at = k;
      }
      if (count === 0) throw new Fail('no-match', e.path);
      if (count > 1) throw new Fail('ambiguous', e.path);
      let out = hay.slice(0, at) + lf(newStr) + hay.slice(at + needle.length);
      if (crlf) out = out.replace(/\n/g, '\r\n');
      tree.now.set(e.path, out);
      return;
    }
    // insert
    const f = splitFile(before);
    const at = e.insertLine as number;
    if (at < 0 || at > f.lines.length) throw new Fail('no-match', e.path);
    const add = patchLines(e.newStr as string);
    const lines = [...f.lines.slice(0, at), ...add, ...f.lines.slice(at)];
    tree.now.set(e.path, joinFile({ br: f.br, lines, finalBreak: f.finalBreak }));
  };
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

type BodyKind = 'ctx' | 'del' | 'add' | 'bs';
interface BodyItem {
  kind: BodyKind;
  text: string;
  fromEmpty: boolean; // the patch line was completely empty (a context line)
}
interface Hunk {
  a: number;
  items: BodyItem[];
}
interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  sawOld: boolean; // a /dev/null on the --- side
  sawNewNull: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

// The path a --- or +++ line names: after the 4 characters, up to the first
// tab, surrounding spaces removed, one leading a/ or b/ removed.
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const fresh = (): USection => ({
    gitOld: null,
    gitNew: null,
    pairOld: null,
    pairNew: null,
    sawOld: false,
    sawNewNull: false,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    delFile: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1];
      cur.gitNew = m[2];
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0) {
        cur = fresh();
        sections.push(cur);
      }
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]);
      if (oldP === '/dev/null') cur.sawOld = true;
      else cur.pairOld = oldP;
      if (newP === '/dev/null') cur.sawNewNull = true;
      else cur.pairNew = newP;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const items: BodyItem[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
        if (l === '') items.push({ kind: 'ctx', text: '', fromEmpty: true });
        else if (l[0] === ' ') items.push({ kind: 'ctx', text: l.slice(1), fromEmpty: false });
        else if (l[0] === '-') items.push({ kind: 'del', text: l.slice(1), fromEmpty: false });
        else if (l[0] === '+') items.push({ kind: 'add', text: l.slice(1), fromEmpty: false });
        else if (l[0] === '\\') items.push({ kind: 'bs', text: '', fromEmpty: false });
        else break;
        j += 1;
      }
      while (items.length > 0) {
        const last = items[items.length - 1];
        if (last.kind === 'ctx' && last.fromEmpty) items.pop();
        else break;
      }
      cur.hunks.push({ a: Number(m[1]), items });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // Header lines, between the section start and its first hunk.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        const newP = headerPath(line);
        if (newP === '/dev/null') cur.sawNewNull = true;
        else cur.pairNew = newP;
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) cur.newFile = true;
      if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1; // prose, fences, anything else outside a body: ignored
  }
  return sections;
}

// Whether a `\` line follows the body's last context or + line.
function backslashAfterLastWrite(items: BodyItem[]): boolean {
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k].kind === 'ctx' || items[k].kind === 'add') {
      return k + 1 < items.length && items[k + 1].kind === 'bs';
    }
  }
  return false;
}

// Apply one section's hunks to a file's text, in order, against the evolving
// file. Throws Fail('no-match') when a hunk finds nothing.
function applyHunks(text: string, hunks: Hunk[], strict: boolean): string {
  const f = splitFile(text);
  let d = 0;
  for (const hunk of hunks) {
    const old: string[] = [];
    for (const it of hunk.items) {
      if (it.kind === 'ctx' || it.kind === 'del') old.push(it.text);
    }
    const bs = backslashAfterLastWrite(hunk.items);
    if (old.length === 0) {
      const add = hunk.items.filter((it) => it.kind === 'add').map((it) => it.text);
      const at = Math.min(Math.max(hunk.a + d, 0), f.lines.length);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...add);
      if (atEnd) f.finalBreak = !bs;
      d += add.length;
      continue;
    }
    const found = findTier(f.lines, old, strict);
    if (found === null) throw new Fail('no-match', '');
    const target = hunk.a - 1 + d;
    let pos = found.at[0];
    for (const p of found.at) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const replacement = buildReplacement(f.lines, pos, old, hunk.items, found.tier);
    const toEnd = pos + old.length === f.lines.length;
    f.lines.splice(pos, old.length, ...replacement);
    if (toEnd) f.finalBreak = !bs;
    d += replacement.length - old.length;
  }
  return joinFile(f);
}

function unifiedEditFn(s: USection, strict: boolean): Edit {
  return (tree) => {
    const oldPath = s.pairOld ?? s.renameFrom ?? s.gitOld;
    const newPath = s.pairNew ?? s.renameTo ?? s.gitNew;
    const isCreate = s.sawOld || s.newFile;
    const isDelete = !isCreate && (s.sawNewNull || s.delFile);
    // Every path the edit names is checked for safety before anything else.
    if (!isCreate && oldPath !== null && !safePath(oldPath)) throw new Fail('unsafe', oldPath);
    if (!isDelete && newPath !== null && !safePath(newPath)) throw new Fail('unsafe', newPath);

    if (isCreate) {
      const target = newPath as string;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const added: string[] = [];
      let lastAddNext: BodyItem | undefined;
      const flat: BodyItem[] = [];
      for (const h of s.hunks) flat.push(...h.items);
      for (let k = 0; k < flat.length; k++) {
        if (flat[k].kind === 'add') {
          added.push(flat[k].text);
          lastAddNext = flat[k + 1];
        }
      }
      const endsWithBreak = !(lastAddNext !== undefined && lastAddNext.kind === 'bs');
      tree.now.set(target, added.length === 0 ? '' : added.join('\n') + (endsWithBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const target = oldPath as string;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const src = oldPath as string;
    const dst = newPath as string;
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    const isMove = dst !== src;
    if (isMove && tree.get(dst) !== null) throw new Fail('exists', dst);
    let after: string;
    try {
      after = applyHunks(before, s.hunks, strict);
    } catch (err) {
      if (err instanceof Fail) throw new Fail(err.code, src);
      throw err;
    }
    if (isMove) {
      tree.now.set(src, null);
      tree.now.set(dst, after);
      tree.moves.push([src, dst]);
    } else {
      tree.now.set(src, after);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  old: string[];
  neu: string[];
}

const trimEnd = (s: string): string => s.replace(/\s+$/, '');

function parseSR(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (trimEnd(lines[i]) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (trimEnd(lines[j]) === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq !== -1) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (trimEnd(lines[j]) === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq === -1 || rep === -1) throw new Exit2(`error: parse ${i + 1}`);
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      if (!blank(lines[j]) && !lines[j].trim().startsWith('```')) {
        path = lines[j].trim();
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, old: lines.slice(i + 1, eq), neu: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks;
}

function srEditFn(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safePath(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.neu.length === 0 ? '' : b.neu.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = splitFile(before);
    const found = findTier(f.lines, b.old, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.at.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.at[0];
    const bigF = leadST(f.lines[pos]);
    const bigP = leadST(b.old[0]);
    const replacement = b.neu.map((l) => (found.tier === 2 ? reindent(l, bigF, bigP) : l));
    f.lines.splice(pos, b.old.length, ...replacement);
    tree.now.set(b.path, joinFile(f));
  };
}

// ---------------------------------------------------------------------------
// Section 8: the V4A format.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

const isVHeader = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function parseV4A(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first === -1) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const content: Array<{ text: string; fromEmpty: boolean }> = [];
      let j = i + 1;
      while (j < last && !isVHeader(lines[j])) {
        const l = lines[j];
        if (l.startsWith('+')) content.push({ text: l.slice(1), fromEmpty: false });
        else if (l === '') content.push({ text: '', fromEmpty: true });
        else throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      while (content.length > 0 && content[content.length - 1].fromEmpty) content.pop();
      sections.push({ kind: 'add', path, addLines: content.map((c) => c.text), moveTo: null, chunks: [] });
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      sections.push({
        kind: 'delete',
        path: line.slice('*** Delete File: '.length).trim(),
        addLines: [],
        moveTo: null,
        chunks: [],
      });
      i += 1;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j].startsWith('*** Move to: ')) {
        moveTo = lines[j].slice('*** Move to: '.length).trim();
        j += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const startChunk = (anchor: string | null): VChunk => {
        const c: VChunk = { anchor, items: [], eof: false };
        chunks.push(c);
        return c;
      };
      while (j < last && !isVHeader(lines[j])) {
        const l = lines[j];
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = startChunk(anchor === '' ? null : anchor);
          j += 1;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) cur = startChunk(null);
          cur.eof = true;
          j += 1;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null || cur.eof) cur = startChunk(null);
          if (l === '') cur.items.push({ kind: 'ctx', text: '', fromEmpty: true });
          else if (l[0] === ' ') cur.items.push({ kind: 'ctx', text: l.slice(1), fromEmpty: l.trim() === '' });
          else if (l[0] === '-') cur.items.push({ kind: 'del', text: l.slice(1), fromEmpty: false });
          else cur.items.push({ kind: 'add', text: l.slice(1), fromEmpty: false });
          j += 1;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      // Blank lines at the end of the section are not part of it.
      if (chunks.length > 0) {
        const tail = chunks[chunks.length - 1];
        while (tail.items.length > 0) {
          const lastIt = tail.items[tail.items.length - 1];
          if (lastIt.kind === 'ctx' && lastIt.fromEmpty) tail.items.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      sections.push({ kind: 'update', path, addLines: [], moveTo, chunks });
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections;
}

function v4aEditFn(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safePath(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    // update
    if (s.moveTo !== null && !safePath(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let at = -1;
        for (const tier of tiers) {
          for (let k = cursor; k < f.lines.length; k++) {
            if (lineAtTier(f.lines[k], chunk.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at !== -1) break;
        }
        if (at === -1) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      const old: string[] = [];
      for (const it of chunk.items) {
        if (it.kind === 'ctx' || it.kind === 'del') old.push(it.text);
      }
      if (old.length === 0) {
        const add = chunk.items.filter((it) => it.kind === 'add').map((it) => it.text);
        const at = chunk.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines.splice(at, 0, ...add);
        cursor = at + add.length;
        continue;
      }
      const found = findTier(f.lines, old, strict, cursor);
      if (found === null) throw new Fail('no-match', s.path);
      const candidates = chunk.eof
        ? found.at.filter((p) => p + old.length === f.lines.length)
        : found.at;
      if (candidates.length === 0) throw new Fail('no-match', s.path);
      const pos = candidates[0];
      const replacement = buildReplacement(f.lines, pos, old, chunk.items, found.tier);
      f.lines.splice(pos, old.length, ...replacement);
      cursor = pos + replacement.length;
    }
    const after = joinFile(f);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, after);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, after);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 4: format detection, used when --format=auto.
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const f = lines.findIndex((l) => !blank(l));
  if (f !== -1) {
    if (lines[f].trim() === '*** Begin Patch') return 'v4a';
    const c = lines[f].trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  if (lines.some((l) => trimEnd(l) === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// The run itself: parse the arguments, read the patch, read its edits in its
// format, apply them in order, and report as SPEC.md section 2 requires.
// ---------------------------------------------------------------------------

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function emit(line: string): void {
  process.stdout.write(line + '\n');
}

function run(argv: string[]): number {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  let file: string | null = null;
  let positionalOnly = false;
  for (const arg of argv) {
    if (!positionalOnly && arg === '--') {
      positionalOnly = true;
    } else if (!positionalOnly && arg === '--check') {
      if (checkOnly) return fail2('error: usage');
      checkOnly = true;
    } else if (!positionalOnly && arg === '--strict') {
      if (strict) return fail2('error: usage');
      strict = true;
    } else if (!positionalOnly && arg.startsWith('--format=')) {
      if (format !== null) return fail2('error: usage');
      format = arg.slice('--format='.length);
      if (!FORMATS.includes(format)) return fail2('error: usage');
    } else if (!positionalOnly && arg.startsWith('-') && arg !== '-') {
      return fail2('error: usage');
    } else {
      if (file !== null) return fail2('error: usage');
      file = arg;
    }
  }

  let text = '';
  try {
    text = readFileSync(file === null || file === '-' ? 0 : file, 'utf8');
  } catch {
    if (file !== null && file !== '-') return fail2('error: no-patch');
  }
  const lines = patchLines(text);

  let fmt = format ?? 'auto';
  if (fmt === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) return fail2('error: format');
    fmt = detected;
  }

  let edits: Edit[];
  try {
    if (fmt === 'json') edits = readJsonEdits(text, lines).map(jsonEditFn);
    else if (fmt === 'unified') edits = parseUnified(lines).map((s) => unifiedEditFn(s, strict));
    else if (fmt === 'search-replace') edits = parseSR(lines).map((b) => srEditFn(b, strict));
    else edits = parseV4A(lines).map((s) => v4aEditFn(s, strict));
  } catch (err) {
    if (err instanceof Exit2) return fail2(err.line);
    throw err;
  }
  if (edits.length === 0) return fail2('error: parse 1');

  const tree = new Tree();
  const failed: Fail[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (err) {
      if (err instanceof Fail) {
        tree.now = snapshot;
        tree.moves.length = movesLen;
        failed.push(err);
      } else {
        throw err;
      }
    }
  }
  if (failed.length > 0) {
    for (const f of failed) emit(`error: ${f.code} ${f.path}`);
    emit(`failed: ${failed.length} of ${edits.length} edits`);
    return 1;
  }

  tree.write(checkOnly);

  // The summary rows: one per path whose bytes changed, in UTF-8 byte order,
  // with a successful move shown as a single R row sorted by its new path.
  const byBytes = (a: string, b: string): number =>
    Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  const movedAway = new Set<string>();
  const movedInto = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original.get(oldP) ?? null;
    const isOld = tree.now.has(oldP) ? (tree.now.get(oldP) as string | null) : wasOld;
    const wasNew = tree.original.get(newP) ?? null;
    const isNew = tree.now.has(newP) ? (tree.now.get(newP) as string | null) : wasNew;
    if (wasOld !== null && isOld === null && wasNew === null && isNew !== null) {
      movedAway.add(oldP);
      movedInto.add(newP);
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  const paths = new Set([...tree.original.keys(), ...tree.now.keys()]);
  for (const p of paths) {
    const was = tree.original.get(p) ?? null;
    const is = tree.now.has(p) ? (tree.now.get(p) as string | null) : was;
    if (was === is) continue;
    if (movedAway.has(p) || movedInto.has(p)) continue;
    const tag = was === null ? 'A' : is === null ? 'D' : 'M';
    rows.push({ key: p, line: `${tag} ${p}` });
  }
  rows.sort((x, y) => byBytes(x.key, y.key));
  for (const r of rows) emit(r.line);
  emit(rows.length === 1 ? 'ok: 1 file' : `ok: ${rows.length} files`);
  return 0;
}

function fail2(line: string): number {
  emit(line);
  return 2;
}

// In a trial the grader serves checks over MAKEFUN_ENV_URL and main.ts hands
// over to runner.ts; run directly, mend is the command-line tool of section 1.
if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import('./runner.ts');
  await runTrial();
} else {
  process.exitCode = run(process.argv.slice(2));
}
