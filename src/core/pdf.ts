import { constants, inflateSync } from 'node:zlib';

/**
 * Minimal PDF text extraction: every run of text on every page, with the position it is
 * drawn at. Enough for the Word-generated calendars this project reads, with no dependency.
 *
 * Positions are what matter here, not reading order. The calendars are tables, and text
 * extractors that rebuild lines (pdftotext -layout) misread them: cells in the same row sit
 * up to ~2pt apart vertically, which is enough to shift whole columns by a row. Working from
 * raw coordinates avoids that entirely. See parseCalendar in calendar.ts.
 *
 * Supported: classic and compressed (object stream) objects, FlateDecode streams, page trees,
 * the text operators, cm/q/Q transforms, simple and Type0 fonts with ToUnicode maps.
 * Not supported, because Word does not produce them: encryption, other stream filters.
 */

export interface TextItem {
  /** 1-based page number. */
  page: number;
  /** Text origin in PDF user space: points from the bottom-left corner, y grows upwards. */
  x: number;
  y: number;
  text: string;
}

// ---------------------------------------------------------------------------------------------
// Object model

class PdfRef {
  constructor(readonly num: number, readonly gen: number) {}
}

class PdfString {
  constructor(readonly bytes: number[]) {}
}

class PdfStream {
  constructor(readonly dict: PdfDict, readonly start: number, readonly length: number) {}
}

type PdfDict = Map<string, PdfValue>;
/** Names are plain strings, without the leading slash. */
type PdfValue = number | boolean | null | string | PdfString | PdfRef | PdfValue[] | PdfDict | PdfStream;

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

function isRegular(ch: string | undefined): boolean {
  return ch !== undefined && !WHITESPACE.has(ch.charCodeAt(0)) && !DELIMITERS.has(ch);
}

/**
 * Tokenizer and value parser over a latin1 string, so that one character is one byte.
 * `refs` enables the `n g R` lookahead, which only makes sense in object syntax.
 */
class Lexer {
  pos: number;

  constructor(readonly src: string, pos = 0, readonly refs = true) {
    this.pos = pos;
  }

  skipWhitespace(): void {
    const s = this.src;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (WHITESPACE.has(c)) {
        this.pos++;
      } else if (c === 0x25 /* % */) {
        while (this.pos < s.length && s[this.pos] !== '\n' && s[this.pos] !== '\r') this.pos++;
      } else {
        break;
      }
    }
  }

  atEnd(): boolean {
    this.skipWhitespace();
    return this.pos >= this.src.length;
  }

  /** A bare keyword or operator: obj, stream, R, Tj, T*, ' and so on. */
  readKeyword(): string {
    this.skipWhitespace();
    const start = this.pos;
    while (isRegular(this.src[this.pos])) this.pos++;
    if (this.pos === start) {
      // A stray delimiter; consume it so the caller always makes progress.
      this.pos++;
    }
    return this.src.slice(start, this.pos);
  }

  /** True if the next token starts a value rather than an operator. */
  startsValue(): boolean {
    this.skipWhitespace();
    const c = this.src[this.pos];
    return c === '/' || c === '(' || c === '<' || c === '[' || (c !== undefined && /[0-9+\-.]/.test(c));
  }

  readValue(): PdfValue {
    this.skipWhitespace();
    const s = this.src;
    const c = s[this.pos];
    if (c === undefined) throw new Error('unexpected end of PDF data');

    if (c === '<' && s[this.pos + 1] === '<') return this.readDict();
    if (c === '<') return this.readHexString();
    if (c === '(') return this.readLiteralString();
    if (c === '[') return this.readArray();
    if (c === '/') return this.readName();
    if (/[0-9+\-.]/.test(c)) return this.readNumberOrRef();

    const word = this.readKeyword();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    throw new Error(`unexpected token "${word}" in PDF data`);
  }

  private readDict(): PdfDict {
    this.pos += 2;
    const dict: PdfDict = new Map();
    for (;;) {
      this.skipWhitespace();
      if (this.pos >= this.src.length) throw new Error('unterminated dictionary');
      if (this.src.startsWith('>>', this.pos)) {
        this.pos += 2;
        return dict;
      }
      const key = this.readValue();
      if (typeof key !== 'string') throw new Error('dictionary key is not a name');
      dict.set(key, this.readValue());
    }
  }

  private readArray(): PdfValue[] {
    this.pos++;
    const out: PdfValue[] = [];
    for (;;) {
      this.skipWhitespace();
      if (this.pos >= this.src.length) throw new Error('unterminated array');
      if (this.src[this.pos] === ']') {
        this.pos++;
        return out;
      }
      out.push(this.readValue());
    }
  }

  private readName(): string {
    this.pos++;
    const start = this.pos;
    while (isRegular(this.src[this.pos])) this.pos++;
    return this.src.slice(start, this.pos).replace(/#([0-9a-fA-F]{2})/g, (_, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    );
  }

  private readNumberOrRef(): number | PdfRef {
    const token = this.readKeyword();
    const value = Number(token);
    if (Number.isNaN(value)) throw new Error(`bad number "${token}" in PDF data`);
    if (!this.refs || !/^\d+$/.test(token)) return value;

    // Look ahead for "gen R" without consuming anything unless it matches.
    const save = this.pos;
    this.skipWhitespace();
    const gen = /^\d+/.exec(this.src.slice(this.pos, this.pos + 12));
    if (gen) {
      this.pos += gen[0].length;
      this.skipWhitespace();
      if (this.src[this.pos] === 'R' && !isRegular(this.src[this.pos + 1])) {
        this.pos++;
        return new PdfRef(value, Number(gen[0]));
      }
    }
    this.pos = save;
    return value;
  }

  private readHexString(): PdfString {
    this.pos++;
    const end = this.src.indexOf('>', this.pos);
    if (end === -1) throw new Error('unterminated hex string');
    let hex = this.src.slice(this.pos, end).replace(/[^0-9a-fA-F]/g, '');
    this.pos = end + 1;
    if (hex.length % 2) hex += '0';
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    return new PdfString(bytes);
  }

  private readLiteralString(): PdfString {
    const s = this.src;
    this.pos++;
    const bytes: number[] = [];
    let depth = 1;
    while (this.pos < s.length) {
      const c = s[this.pos++] as string;
      if (c === '\\') {
        const e = s[this.pos++];
        if (e === undefined) break;
        if (e === 'n') bytes.push(0x0a);
        else if (e === 'r') bytes.push(0x0d);
        else if (e === 't') bytes.push(0x09);
        else if (e === 'b') bytes.push(0x08);
        else if (e === 'f') bytes.push(0x0c);
        else if (e === '\r') {
          if (s[this.pos] === '\n') this.pos++; // line continuation
        } else if (e === '\n') {
          // line continuation
        } else if (/[0-7]/.test(e)) {
          let oct = e;
          while (oct.length < 3 && /[0-7]/.test(s[this.pos] ?? '')) oct += s[this.pos++];
          bytes.push(parseInt(oct, 8) & 0xff);
        } else {
          bytes.push(e.charCodeAt(0));
        }
        continue;
      }
      if (c === '(') depth++;
      if (c === ')' && --depth === 0) break;
      bytes.push(c.charCodeAt(0));
    }
    return new PdfString(bytes);
  }
}

// ---------------------------------------------------------------------------------------------
// Document

export class PdfDocument {
  private readonly src: string;
  /** Object number -> offset just after "n g obj", for objects stored directly in the file. */
  private readonly direct = new Map<number, number>();
  /** Object number -> containing object stream and index, for compressed objects. */
  private readonly compressed = new Map<number, { stream: number; index: number }>();
  private readonly cache = new Map<number, PdfValue>();
  private readonly objectStreams = new Map<number, { data: string; offsets: Map<number, number> }>();

  constructor(private readonly buf: Buffer) {
    this.src = buf.toString('latin1');
    if (!this.src.startsWith('%PDF-')) throw new Error('not a PDF file');

    // Scanning beats trusting the xref table: it survives damaged or incremental files, and
    // a later definition of the same object (an incremental update) overwrites the earlier.
    const re = /(?:^|[^0-9])(\d+)\s+(\d+)\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.src))) this.direct.set(Number(m[1]), re.lastIndex);

    for (const num of [...this.direct.keys()]) {
      const value = this.tryGet(num);
      if (!(value instanceof PdfStream) || value.dict.get('Type') !== 'ObjStm') continue;
      const header = this.objectStreamHeader(num);
      let index = 0;
      for (const objNum of header.offsets.keys()) {
        if (!this.direct.has(objNum)) this.compressed.set(objNum, { stream: num, index });
        index++;
      }
    }
  }

  private tryGet(num: number): PdfValue {
    try {
      return this.get(num);
    } catch {
      return null;
    }
  }

  get(num: number): PdfValue {
    if (this.cache.has(num)) return this.cache.get(num) as PdfValue;
    let value: PdfValue = null;

    const offset = this.direct.get(num);
    if (offset !== undefined) {
      const lexer = new Lexer(this.src, offset);
      value = lexer.readValue();
      if (value instanceof Map) {
        const after = lexer.readKeyword();
        if (after === 'stream') value = this.readStream(value, lexer.pos);
      }
    } else {
      const loc = this.compressed.get(num);
      if (loc) {
        const header = this.objectStreamHeader(loc.stream);
        const start = header.offsets.get(num);
        if (start !== undefined) value = new Lexer(header.data, start).readValue();
      }
    }

    this.cache.set(num, value);
    return value;
  }

  resolve(value: PdfValue | undefined): PdfValue | undefined {
    let v = value;
    for (let hops = 0; v instanceof PdfRef && hops < 32; hops++) v = this.get(v.num);
    return v;
  }

  private dictOf(value: PdfValue | undefined): PdfDict | undefined {
    const v = this.resolve(value);
    if (v instanceof Map) return v;
    if (v instanceof PdfStream) return v.dict;
    return undefined;
  }

  private readStream(dict: PdfDict, afterKeyword: number): PdfStream {
    let start = afterKeyword;
    if (this.src[start] === '\r') start++;
    if (this.src[start] === '\n') start++;

    const declared = this.resolve(dict.get('Length'));
    let length = typeof declared === 'number' ? declared : -1;
    // Trust /Length only if "endstream" follows it; otherwise find the terminator ourselves.
    const tail = length >= 0 ? this.src.slice(start + length, start + length + 12) : '';
    if (!/^\s*endstream/.test(tail)) {
      const end = this.src.indexOf('endstream', start);
      if (end === -1) throw new Error('stream without endstream');
      length = end - start;
      while (length > 0 && (this.src[start + length - 1] === '\n' || this.src[start + length - 1] === '\r')) length--;
    }
    return new PdfStream(dict, start, length);
  }

  /** Decoded stream bytes, as a latin1 string. */
  streamData(stream: PdfStream): string {
    const raw = this.buf.subarray(stream.start, stream.start + stream.length);
    const filter = this.resolve(stream.dict.get('Filter'));
    const filters = (Array.isArray(filter) ? filter : filter === undefined || filter === null ? [] : [filter]).map(
      (f) => this.resolve(f),
    );
    let data: Buffer = raw;
    for (const f of filters) {
      if (f === 'FlateDecode' || f === 'Fl') {
        data = inflateSync(data, { finishFlush: constants.Z_SYNC_FLUSH });
      } else {
        throw new Error(`unsupported PDF stream filter ${String(f)}`);
      }
    }
    const parms = this.dictOf(stream.dict.get('DecodeParms'));
    const predictor = parms?.get('Predictor');
    if (typeof predictor === 'number' && predictor > 1) {
      throw new Error(`unsupported PDF stream predictor ${predictor}`);
    }
    return data.toString('latin1');
  }

  private objectStreamHeader(num: number): { data: string; offsets: Map<number, number> } {
    const cached = this.objectStreams.get(num);
    if (cached) return cached;
    const stream = this.get(num);
    if (!(stream instanceof PdfStream)) throw new Error(`object ${num} is not an object stream`);
    const data = this.streamData(stream);
    const n = Number(this.resolve(stream.dict.get('N')));
    const first = Number(this.resolve(stream.dict.get('First')));
    const lexer = new Lexer(data, 0, false);
    const offsets = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const objNum = lexer.readValue();
      const rel = lexer.readValue();
      if (typeof objNum !== 'number' || typeof rel !== 'number') break;
      offsets.set(objNum, first + rel);
    }
    const header = { data, offsets };
    this.objectStreams.set(num, header);
    return header;
  }

  private catalog(): PdfDict {
    // The last /Root wins: incremental updates append a newer trailer.
    const roots = [...this.src.matchAll(/\/Root\s+(\d+)\s+(\d+)\s+R/g)];
    const last = roots[roots.length - 1];
    if (last) {
      const dict = this.dictOf(new PdfRef(Number(last[1]), Number(last[2])));
      if (dict) return dict;
    }
    for (const num of [...this.direct.keys(), ...this.compressed.keys()]) {
      const dict = this.dictOf(this.tryGet(num));
      if (dict?.get('Type') === 'Catalog') return dict;
    }
    throw new Error('PDF has no catalog');
  }

  /** Page dictionaries in document order. */
  pages(): PdfDict[] {
    const out: PdfDict[] = [];
    const seen = new Set<PdfDict>();
    const walk = (node: PdfDict | undefined, depth: number): void => {
      if (!node || seen.has(node) || depth > 64) return;
      seen.add(node);
      const kids = this.resolve(node.get('Kids'));
      if (node.get('Type') === 'Page' || (!Array.isArray(kids) && node.has('Contents'))) {
        out.push(node);
        return;
      }
      if (Array.isArray(kids)) for (const kid of kids) walk(this.dictOf(kid), depth + 1);
    };
    walk(this.dictOf(this.catalog().get('Pages')), 0);
    return out;
  }

  /** A page attribute, following /Parent for the inheritable ones (Resources). */
  inherited(page: PdfDict, key: string): PdfValue | undefined {
    let node: PdfDict | undefined = page;
    for (let depth = 0; node && depth < 64; depth++) {
      if (node.has(key)) return this.resolve(node.get(key));
      node = this.dictOf(node.get('Parent'));
    }
    return undefined;
  }

  contentOf(page: PdfDict): string {
    const contents = this.resolve(page.get('Contents'));
    const parts = Array.isArray(contents) ? contents : contents === undefined ? [] : [contents];
    return parts
      .map((p) => this.resolve(p))
      .filter((p): p is PdfStream => p instanceof PdfStream)
      .map((p) => this.streamData(p))
      .join('\n');
  }

  fontsOf(page: PdfDict): Map<string, Font> {
    const fonts = new Map<string, Font>();
    const resources = this.dictOf(this.inherited(page, 'Resources'));
    const fontDict = this.dictOf(resources?.get('Font'));
    if (!fontDict) return fonts;
    for (const [name, ref] of fontDict) {
      const font = this.dictOf(ref);
      if (!font) continue;
      const toUnicodeStream = this.resolve(font.get('ToUnicode'));
      fonts.set(name, {
        twoByte: font.get('Subtype') === 'Type0',
        toUnicode: toUnicodeStream instanceof PdfStream ? parseToUnicode(this.streamData(toUnicodeStream)) : undefined,
      });
    }
    return fonts;
  }
}

// ---------------------------------------------------------------------------------------------
// Fonts

interface Font {
  /** Type0 fonts (Word uses Identity-H) take two bytes per character code. */
  twoByte: boolean;
  toUnicode?: Map<number, string>;
}

function utf16be(hex: string): string {
  let out = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

/** The bfchar and bfrange sections of a ToUnicode CMap. */
export function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of (block[1] ?? '').matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(parseInt(m[1] as string, 16), utf16be(m[2] as string));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1] ?? '';
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g;
    for (const m of body.matchAll(re)) {
      const lo = parseInt(m[1] as string, 16);
      const hi = parseInt(m[2] as string, 16);
      if (hi < lo || hi - lo > 0xffff) continue;
      if (m[3] !== undefined) {
        const base = m[3];
        const prefix = base.slice(0, -4);
        const last = parseInt(base.slice(-4), 16);
        for (let code = lo; code <= hi; code++) map.set(code, utf16be(prefix) + String.fromCharCode(last + code - lo));
      } else {
        const targets = [...(m[4] ?? '').matchAll(/<([0-9a-fA-F]*)>/g)].map((t) => utf16be(t[1] as string));
        targets.forEach((t, i) => map.set(lo + i, t));
      }
    }
  }
  return map;
}

function decodeText(bytes: number[], font: Font | undefined): string {
  if (!font) return String.fromCharCode(...bytes);
  let out = '';
  if (font.twoByte) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = ((bytes[i] as number) << 8) | (bytes[i + 1] as number);
      out += font.toUnicode?.get(code) ?? '�';
    }
    return out;
  }
  // Simple fonts: digits, ':' and '/' are plain ASCII in every standard encoding.
  for (const b of bytes) out += font.toUnicode?.get(b) ?? String.fromCharCode(b);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Content streams

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m then n, in PDF's row-vector convention. */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function numbers(operands: PdfValue[], count: number): number[] | undefined {
  const tail = operands.slice(-count);
  return tail.length === count && tail.every((v) => typeof v === 'number') ? (tail as number[]) : undefined;
}

/**
 * Runs the text operators of one page. Consecutive shows with no repositioning between them
 * become one item: Word draws a cell's text as a single TJ, so an item is a cell fragment.
 */
function extractPage(content: string, fonts: Map<string, Font>, page: number): TextItem[] {
  const items: TextItem[] = [];
  const lexer = new Lexer(content, 0, false);
  // q/Q save and restore the whole graphics state, which includes the text font and leading.
  const stack: { ctm: Matrix; font: Font | undefined; leading: number }[] = [];
  let ctm: Matrix = IDENTITY;
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let leading = 0;
  let font: Font | undefined;
  let current: TextItem | null = null;
  let operands: PdfValue[] = [];

  const moveTo = (m: Matrix) => {
    tlm = m;
    tm = m;
    current = null;
  };
  const show = (value: PdfValue | undefined) => {
    if (!(value instanceof PdfString)) return;
    const text = decodeText(value.bytes, font);
    if (!current) {
      const at = multiply(tm, ctm);
      current = { page, x: at[4], y: at[5], text: '' };
      items.push(current);
    }
    current.text += text;
  };
  const gap = () => {
    if (current) current.text += ' ';
  };

  while (!lexer.atEnd()) {
    if (lexer.startsValue()) {
      try {
        operands.push(lexer.readValue());
      } catch {
        lexer.pos++;
        operands = [];
      }
      continue;
    }
    const op = lexer.readKeyword();
    switch (op) {
      case 'true':
      case 'false':
      case 'null':
        operands.push(op === 'true' ? true : op === 'false' ? false : null);
        continue;
      case 'q':
        stack.push({ ctm, font, leading });
        break;
      case 'Q': {
        const saved = stack.pop();
        if (saved) ({ ctm, font, leading } = saved);
        break;
      }
      case 'cm': {
        const n = numbers(operands, 6);
        if (n) ctm = multiply(n as Matrix, ctm);
        break;
      }
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        current = null;
        break;
      case 'ET':
        current = null;
        break;
      case 'Tf': {
        const name = operands[operands.length - 2];
        if (typeof name === 'string') font = fonts.get(name);
        break;
      }
      case 'TL': {
        const n = numbers(operands, 1);
        if (n) leading = n[0] as number;
        break;
      }
      case 'Td':
      case 'TD': {
        const n = numbers(operands, 2);
        if (n) {
          const [tx, ty] = n as [number, number];
          if (op === 'TD') leading = -ty;
          moveTo(multiply([1, 0, 0, 1, tx, ty], tlm));
        }
        break;
      }
      case 'Tm': {
        const n = numbers(operands, 6);
        if (n) moveTo(n as Matrix);
        break;
      }
      case 'T*':
        moveTo(multiply([1, 0, 0, 1, 0, -leading], tlm));
        break;
      case 'Tj':
        show(operands[operands.length - 1]);
        break;
      case "'":
      case '"':
        moveTo(multiply([1, 0, 0, 1, 0, -leading], tlm));
        show(operands[operands.length - 1]);
        break;
      case 'TJ': {
        const arr = operands[operands.length - 1];
        if (Array.isArray(arr)) {
          for (const part of arr) {
            // A large negative adjustment is a visible gap (thousandths of an em).
            if (typeof part === 'number') {
              if (part < -250) gap();
            } else {
              show(part);
            }
          }
        }
        break;
      }
      case 'BI': {
        // Inline image: skip its binary data, which could otherwise look like operators.
        const id = content.indexOf('ID', lexer.pos);
        const end = id === -1 ? -1 : content.slice(id + 2).search(/\sEI(?=\s|$)/);
        lexer.pos = end === -1 ? content.length : id + 2 + end + 3;
        break;
      }
      default:
        break;
    }
    operands = [];
  }
  return items;
}

/** Every text item on every page of a PDF. */
export function extractText(pdf: Buffer): TextItem[] {
  const doc = new PdfDocument(pdf);
  const pages = doc.pages();
  if (pages.length === 0) throw new Error('PDF has no pages');
  return pages.flatMap((page, i) => extractPage(doc.contentOf(page), doc.fontsOf(page), i + 1));
}
