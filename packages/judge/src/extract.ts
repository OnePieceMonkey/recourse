import type { HiddenKind, HiddenSegment, Inspectable } from "./types";

// Jev's state budget is ~32k tokens including the questions; 24k for the page
// leaves room for offer, question and the hidden-text block.
export const CHARS_PER_TOKEN = 4;
export const JUDGE_MAX_TOKENS = 24_000;
export const JUDGE_MAX_CHARS = JUDGE_MAX_TOKENS * CHARS_PER_TOKEN;

// Bodies are attacker-controlled: every loop below is linear and bounded.
const MAX_SEGMENTS = 500;
const MAX_SEGMENT_CHARS = 20_000;
const MAX_DEPTH = 512;
const METADATA_KINDS: ReadonlySet<HiddenKind> = new Set(["meta", "attribute", "link-title", "script-data"]);
const METADATA_MIN_WORDS = 3; // "Logo" or "width=device-width" cannot carry an instruction

/** Visible main text plus everything a human reader would not see. Deterministic. */
export function extractInspectableText(body: string, mimeType: string): Inspectable {
  const segs = new Segments();
  const inv = new Invisible(segs);
  const src = body.replace(/^﻿/, ""); // a leading BOM is legitimate
  const text = isHtml(src, mimeType) ? extractHtml(src, segs, inv) : extractMarkdown(src, segs, inv);
  scanBase64(src, segs, inv);
  inv.flush();
  return { text: tidy(text), hidden: segs.list };
}

/** Keeps head (2/3) and tail (1/3); injections are often placed at the end of a page. */
export function truncateMiddle(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const keep = Math.max(0, maxChars - 48); // 48 chars of room for the marker
  const head = Math.ceil((keep * 2) / 3);
  const marker = `\n[... ${text.length - keep} characters omitted ...]\n`;
  return { text: text.slice(0, head) + marker + text.slice(text.length - (keep - head)), truncated: true };
}

/** The `delivered.text` sent to the model: visible text, then hidden segments, labelled. */
export function judgeText(x: Inspectable, maxChars = JUDGE_MAX_CHARS): { text: string; truncated: boolean } {
  const lines = x.hidden.map((h) => `- (${h.kind}${h.where ? `, ${h.where}` : ""}) ${h.text.replace(/\s+/g, " ")}`);
  const hidden = lines.length
    ? truncateMiddle(`\n\n[Found in the page but not shown to human readers]\n${lines.join("\n")}`, Math.floor(maxChars / 4))
    : { text: "", truncated: false };
  const visible = truncateMiddle(x.text, maxChars - hidden.text.length);
  return { text: visible.text + hidden.text, truncated: visible.truncated || hidden.truncated };
}

// ---------- shared helpers ----------

class Segments {
  readonly list: HiddenSegment[] = [];
  private readonly seen = new Set<string>();

  add(kind: HiddenKind, raw: string, where?: string, count?: number): void {
    const text = truncateMiddle(tidy(raw), MAX_SEGMENT_CHARS).text;
    if (!text || this.list.length >= MAX_SEGMENTS) return;
    if (METADATA_KINDS.has(kind) && text.split(/\s+/).length < METADATA_MIN_WORDS) return;
    const key = `${kind}\u0000${text}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push({ kind, text, ...(where ? { where } : {}), ...(count ? { count } : {}) });
  }
}

const tidy = (s: string) =>
  s
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// Zero-width and bidi controls. They are removed from all output so that a keyword
// split by them ("ig​nore") is matched, and counted as evidence of hiding.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const ANY_INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/u;
const TAG_RUN = /[\u{E0000}-\u{E007F}]+/gu;
const JOINERS = new Set([0x200c, 0x200d]); // legitimate in emoji and some scripts: stripped, not counted

class Invisible {
  private readonly counts = new Map<number, number>();
  constructor(private readonly segs: Segments) {}

  strip(s: string): string {
    if (!ANY_INVISIBLE.test(s)) return s;
    // A right-to-left override displays the following text reversed: record what a human sees.
    for (const m of s.matchAll(/‮([^‬\n]{1,2000})/g)) {
      this.segs.add("invisible-chars", [...m[1]!].reverse().join("").replace(INVISIBLE, ""), "right-to-left override, as displayed");
    }
    // Unicode tag characters mirror ASCII invisibly. Flag emoji use short runs; long runs smuggle text.
    s = s.replace(TAG_RUN, (run) => {
      const ascii = [...run]
        .map((c) => c.codePointAt(0)! - 0xe0000)
        .filter((c) => c >= 0x20 && c < 0x7f)
        .map((c) => String.fromCharCode(c))
        .join("");
      if (ascii.length >= 8) this.segs.add("tag-chars", ascii, "Unicode tag characters, decoded");
      return "";
    });
    s = s.replace(INVISIBLE, (c) => {
      const cp = c.codePointAt(0)!;
      if (!JOINERS.has(cp)) this.counts.set(cp, (this.counts.get(cp) ?? 0) + 1);
      return "";
    });
    return s.replace(/­/g, ""); // soft hyphen: common in German typography, can split keywords
  }

  flush(): void {
    let total = 0;
    const parts: string[] = [];
    for (const [cp, n] of this.counts) {
      total += n;
      parts.push(`U+${cp.toString(16).toUpperCase().padStart(4, "0")} x${n}`);
    }
    if (total) this.segs.add("invisible-chars", `${total} zero-width or bidi-control characters: ${parts.join(", ")}`, undefined, total);
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  shy: "­", zwj: "‍", zwnj: "‌", lrm: "‎", rlm: "‏", ZeroWidthSpace: "​",
  ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“",
  rdquo: "”", bdquo: "„", laquo: "«", raquo: "»", euro: "€", copy: "©",
  reg: "®", trade: "™", sect: "§", middot: "·", bull: "•", deg: "°",
  times: "×", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö",
  Uuml: "Ü", szlig: "ß", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç",
};

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(?:#[xX]([0-9a-fA-F]{1,6});?|#(\d{1,7});?|([A-Za-z][A-Za-z0-9]{1,31});)/g, (m, hex, dec, name) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? m;
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : "�";
  });
}

function isHtml(body: string, mimeType: string): boolean {
  if (/html|xhtml/i.test(mimeType)) return true;
  if (/markdown|text\/plain/i.test(mimeType)) return false;
  return /^\s*<(?:!doctype\s+html|html|head|body)\b/i.test(body);
}

// ---------- CSS: what hides an element ----------

type Rgb = [number, number, number];
const WHITE: Rgb = [255, 255, 255];
const NAMED_COLORS: Record<string, Rgb> = {
  white: WHITE, black: [0, 0, 0], snow: [255, 250, 250], ivory: [255, 255, 240], whitesmoke: [245, 245, 245],
};

const normStyle = (s: string) => s.toLowerCase().replace(/\s*([:;,()])\s*/g, "$1").trim();

function parseColor(v: string | undefined): Rgb | undefined {
  if (!v) return undefined;
  const hex = /#([0-9a-f]{3,8})\b/.exec(v);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join("");
    return h.length >= 6 ? [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16)) as Rgb : undefined;
  }
  const rgb = /rgba?\((\d{1,3}),(\d{1,3}),(\d{1,3})/.exec(v);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const named = /\b(white|black|snow|ivory|whitesmoke)\b/.exec(v);
  return named ? NAMED_COLORS[named[1]!] : undefined;
}

const cssValue = (style: string, prop: string) => new RegExp(`(?:^|;)${prop}:([^;!]+)`).exec(style)?.[1];
const closeColors = (a: Rgb, b: Rgb) => a.every((c, i) => Math.abs(c - b[i]!) <= 16);

/** Declarations that hide content on every screen (colour is checked separately). */
function hidingStyle(style: string): string | undefined {
  if (/(?:^|;)display:none/.test(style)) return "display:none";
  if (/(?:^|;)visibility:(?:hidden|collapse)/.test(style)) return "visibility:hidden";
  if (/(?:^|;)font-size:(?:0(?:\.0+)?[a-z%]*|(?:0?\.\d+|1)px)(?:;|!|$)/.test(style)) return "font-size:0";
  if (/(?:^|;)opacity:0(?:\.0\d*)?(?:;|!|$)/.test(style)) return "opacity:0";
  if (/(?:^|;)(?:left|right|top|text-indent|margin-left):-\d{3,}/.test(style)) return "off-screen";
  if (/(?:^|;)clip(?:-path)?:(?:rect\((?:0|1px)|inset\(50%)/.test(style)) return "clipped";
  if (/(?:^|;)(?:max-)?(?:height|width):0(?:px)?(?:;|$)/.test(style) && /(?:^|;)overflow:hidden/.test(style)) return "zero size";
  return undefined;
}

interface HidingRules {
  classes: Set<string>;
  ids: Set<string>;
}
const NO_RULES: HidingRules = { classes: new Set(), ids: new Set() };

// Common utility classes. Tailwind/Bootstrap pair them with responsive display
// classes ("hidden md:block"); then the content is visible on desktop.
const HIDING_UTILITY = new Set(["hidden", "sr-only", "visually-hidden", "screen-reader-text", "d-none", "invisible"]);
const RESPONSIVE_DISPLAY = /^(?:[a-z]{2,3}:(?:block|flex|grid|inline|table|contents)|d-(?:sm|md|lg|xl|xxl)-)/;

/** Class and id selectors that `<style>` blocks hide unconditionally (not inside @media). */
function hidingRules(html: string): HidingRules {
  const rules: HidingRules = { classes: new Set(), ids: new Set() };
  const open = /<style\b[^>]*>/gi;
  const close = /<\/style\s*>/gi;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    close.lastIndex = open.lastIndex;
    const end = close.exec(html);
    const css = html.slice(open.lastIndex, end ? end.index : html.length).replace(/\/\*[\s\S]*?\*\//g, "");
    let i = 0;
    while (i < css.length) {
      const brace = css.indexOf("{", i);
      if (brace < 0) break;
      let depth = 1;
      let j = brace + 1;
      for (; j < css.length && depth; j++) depth += css[j] === "{" ? 1 : css[j] === "}" ? -1 : 0;
      const selector = css.slice(i, brace).split(";").pop()!.trim();
      const block = normStyle(css.slice(brace + 1, j - 1));
      const sameColor = (() => {
        const fg = parseColor(cssValue(block, "color"));
        const bg = parseColor(cssValue(block, "background-color") ?? cssValue(block, "background"));
        return !!fg && !!bg && closeColors(fg, bg);
      })();
      if (!selector.startsWith("@") && !block.includes("{") && (hidingStyle(block) || sameColor)) {
        for (const sel of selector.split(",")) {
          const s = sel.trim();
          const cls = /^[a-z0-9]*\.([\w-]+)$/i.exec(s);
          if (cls) rules.classes.add(cls[1]!.toLowerCase());
          const id = /^[a-z0-9]*#([\w-]+)$/i.exec(s);
          if (id) rules.ids.add(id[1]!.toLowerCase());
        }
      }
      i = j;
    }
    if (!end) break;
    open.lastIndex = close.lastIndex;
  }
  return rules;
}

/** Why an element is invisible to a human reader, if it is. `bg` is the effective background. */
function hiddenReason(name: string, attrs: Map<string, string>, rules: HidingRules, parentBg?: Rgb): { reason?: string; bg?: Rgb } {
  const style = normStyle(attrs.get("style") ?? "");
  const bg = parseColor(cssValue(style, "background-color") ?? cssValue(style, "background")) ?? parentBg;
  if (name === "template") return { reason: "template", bg };
  if (attrs.has("hidden")) return { reason: "hidden attribute", bg };
  if (attrs.get("aria-hidden")?.trim().toLowerCase() === "true") return { reason: "aria-hidden", bg };
  const byStyle = hidingStyle(style);
  if (byStyle) return { reason: byStyle, bg };
  const classes = (attrs.get("class") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const responsive = classes.some((c) => RESPONSIVE_DISPLAY.test(c));
  for (const c of classes) {
    if (rules.classes.has(c)) return { reason: `.${c} (style rule)`, bg };
    if (HIDING_UTILITY.has(c) && !responsive) return { reason: `.${c}`, bg };
  }
  const id = attrs.get("id")?.toLowerCase();
  if (id && rules.ids.has(id)) return { reason: `#${id} (style rule)`, bg };
  const fg = parseColor(cssValue(style, "color"));
  if (fg && closeColors(fg, bg ?? WHITE)) return { reason: "text colour matches background", bg };
  return { bg };
}

// ---------- HTML ----------

const VOID = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const BLOCK = new Set(
  "address article aside blockquote body dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr html li main nav ol p pre section summary table tbody thead tfoot tr ul".split(" "),
);
const AUTO_CLOSE = new Set("p li dt dd tr td th option".split(" "));
const RAW_TEXT = new Set(["script", "style", "title", "textarea"]);
const MODEL_TAGS = new Set(["system", "instruction", "instructions", "prompt", "sys"]);
const TEXT_ATTRS = ["alt", "title", "aria-label", "aria-description", "placeholder"];
const TAG_START = /<(\/?)([a-zA-Z][\w:-]*)/y;

interface Frame {
  name: string;
  hidden: boolean;
  bg?: Rgb;
  buf?: string[]; // own output buffer: hidden content or a blockquote
  where?: string;
}

/** Reads attributes after the tag name up to the closing `>`, honouring quotes. */
function readTag(html: string, i: number): { attrs: Map<string, string>; end: number; selfClosing: boolean } {
  const attrs = new Map<string, string>();
  const n = html.length;
  let selfClosing = false;
  while (i < n) {
    const start = i;
    const c = html[i]!;
    if (c === ">") return { attrs, end: i + 1, selfClosing };
    if (c === "/") {
      selfClosing = html[i + 1] === ">";
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !/[\s=>/]/.test(html[j]!)) j++;
    const name = html.slice(i, j).toLowerCase();
    i = j;
    while (i < n && /\s/.test(html[i]!)) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (i < n && /\s/.test(html[i]!)) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        value = html.slice(i + 1, close < 0 ? n : close);
        i = close < 0 ? n : close + 1;
      } else {
        let k = i;
        while (k < n && !/[\s>]/.test(html[k]!)) k++;
        value = html.slice(i, k);
        i = k;
      }
    }
    if (name && !attrs.has(name)) attrs.set(name, value);
    if (i === start) i++; // always make progress on malformed input
  }
  return { attrs, end: n, selfClosing };
}

function extractHtml(html: string, segs: Segments, inv: Invisible): string {
  const rules = hidingRules(html);
  const n = html.length;
  const stack: Frame[] = [];
  const bufs: string[][] = [[]]; // output targets; bufs[0] is the visible text
  let hiddenDepth = 0;
  let preDepth = 0;
  const out = () => bufs[bufs.length - 1]!;
  const clean = (s: string) => inv.strip(decodeEntities(s));
  const emit = (s: string) => {
    if (s) out().push(preDepth ? clean(s) : clean(s).replace(/\s+/g, " "));
  };

  const openMarker = (name: string): string => {
    if (/^h[1-6]$/.test(name)) return `\n\n${"#".repeat(Number(name[1]))} `;
    if (name === "li") return "\n- ";
    if (name === "pre") return "\n```\n";
    if (name === "code") return preDepth ? "" : "`";
    if (name === "q") return "“";
    if (name === "td" || name === "th") return " ";
    return BLOCK.has(name) ? "\n" : "";
  };
  const closeMarker = (name: string): string => {
    if (/^h[1-6]$/.test(name)) return "\n\n";
    if (name === "pre") return "\n```\n";
    if (name === "code") return preDepth ? "" : "`";
    if (name === "q") return "”";
    return BLOCK.has(name) && name !== "li" ? "\n" : ""; // the next "\n- " separates list items
  };

  const pop = () => {
    const f = stack.pop()!;
    if (f.hidden) hiddenDepth--;
    if (f.name === "pre") preDepth--;
    if (f.buf) {
      bufs.pop();
      const content = f.buf.join("");
      if (f.hidden) segs.add("hidden-element", content, f.where);
      else out().push(`\n${tidy(content).split("\n").map((l) => `> ${l}`).join("\n")}\n`);
    }
  };
  const closeTag = (name: string) => {
    let k = stack.length - 1;
    while (k >= 0 && stack[k]!.name !== name) k--;
    if (k < 0) {
      if (BLOCK.has(name)) out().push("\n"); // stray end tag such as </p>
      return;
    }
    while (stack.length > k) {
      out().push(closeMarker(stack[stack.length - 1]!.name));
      pop();
    }
  };

  const openTag = (name: string, attrs: Map<string, string>, selfClosing: boolean) => {
    for (const a of TEXT_ATTRS) {
      const v = attrs.get(a);
      if (v) segs.add("attribute", clean(v), `${name}[${a}]`);
    }
    if (name === "meta" && attrs.get("content")) {
      const label = ["name", "property", "itemprop", "http-equiv"].find((k) => attrs.has(k));
      segs.add("meta", clean(attrs.get("content")!), label ? `meta ${label}=${attrs.get(label)}` : "meta");
    }
    if (name === "input" && attrs.get("type")?.toLowerCase() === "hidden" && attrs.get("value")) {
      segs.add("hidden-element", clean(attrs.get("value")!), "input type=hidden");
    }
    if (MODEL_TAGS.has(name)) segs.add("markup", `<${name}>`, "tag addressed to a model");

    // Implied end tags, as browsers do: <p>a<p>b, <li>a<li>b, <p>a<div>b.
    const top = stack[stack.length - 1];
    if (top && ((AUTO_CLOSE.has(name) && top.name === name) || (top.name === "p" && BLOCK.has(name)))) closeTag(top.name);

    if (VOID.has(name) || selfClosing) {
      if (name === "br" || name === "hr") out().push("\n");
      return;
    }
    if (stack.length >= MAX_DEPTH) return; // beyond this, content stays visible (fail-visible)

    const { reason, bg } = hiddenReason(name, attrs, rules, stack[stack.length - 1]?.bg);
    const f: Frame = { name, hidden: !!reason, bg };
    if (reason && !hiddenDepth) {
      f.buf = [];
      f.where = `${name}: ${reason}`;
    } else if (name === "blockquote" && !reason) {
      f.buf = [];
    }
    stack.push(f);
    if (f.hidden) hiddenDepth++;
    if (f.buf) bufs.push(f.buf);
    out().push(openMarker(name)); // after the push, so a hidden heading's marker stays hidden
    if (name === "pre") preDepth++;
  };

  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      emit(html.slice(i));
      break;
    }
    if (lt > i) emit(html.slice(i, lt));
    i = lt;

    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      segs.add("comment", clean(html.slice(i + 4, end < 0 ? n : end)));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", i)) {
      const end = html.indexOf("]]>", i);
      emit(html.slice(i + 9, end < 0 ? n : end));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const end = html.indexOf(">", i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    TAG_START.lastIndex = i;
    const m = TAG_START.exec(html);
    if (!m) {
      emit("<"); // a literal "<", as in "a < b"
      i++;
      continue;
    }
    const name = m[2]!.toLowerCase();
    const tag = readTag(html, TAG_START.lastIndex);
    i = tag.end;
    if (m[1]) {
      closeTag(name);
      continue;
    }
    if (RAW_TEXT.has(name) && !tag.selfClosing) {
      const closeRe = new RegExp(`</${name}\\b[^>]*>`, "gi");
      closeRe.lastIndex = i;
      const close = closeRe.exec(html);
      const content = html.slice(i, close ? close.index : n);
      i = close ? closeRe.lastIndex : n;
      if (name === "title") segs.add("meta", clean(content), "title");
      else if (name === "textarea") emit(content);
      else if (name === "script") {
        const type = (tag.attrs.get("type") ?? "").toLowerCase();
        if (type && !/javascript|ecmascript|module/.test(type)) segs.add("script-data", inv.strip(content), `script type=${type}`);
      }
      continue;
    }
    openTag(name, tag.attrs, tag.selfClosing);
  }
  while (stack.length) pop(); // unclosed elements at end of input
  return bufs[0]!.join("");
}

// ---------- Markdown and plain text ----------

const INSTRUCTION_LABEL = /^(?:instructions?|system|system[-_]?prompt|prompt|ai|agent|llm|assistant|for[-_]?ai|ai[-_]instructions?|hidden)$/i;

function extractMarkdown(md: string, segs: Segments, inv: Invisible): string {
  let s = inv.strip(md.replace(/\r\n?/g, "\n"));
  s = s.replace(/<!--([\s\S]*?)(?:-->|$)/g, (_, c: string) => (segs.add("comment", c), ""));
  // Inline HTML that a Markdown renderer would hide.
  s = s.replace(/<([a-z][\w-]*)\b([^>\n]*)>([\s\S]{0,5000}?)<\/\1\s*>/gi, (all, name: string, attrs: string, inner: string) => {
    const { reason } = hiddenReason(name.toLowerCase(), readTag(`${attrs}>`, 0).attrs, NO_RULES);
    return reason ? (segs.add("hidden-element", decodeEntities(inner), `${name}: ${reason}`), "") : all;
  });

  const lines = s.split("\n");
  const keep: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const closeRe = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !closeRe.test(lines[j]!)) j++;
      const block = lines.slice(i + 1, j);
      if (INSTRUCTION_LABEL.test(fence[2]!)) segs.add("instruction-block", block.join("\n"), `fenced block "${fence[2]}"`);
      else keep.push(line, ...block, ...(j < lines.length ? [lines[j]!] : []));
      i = j;
      continue;
    }
    // Reference definitions are never rendered; `[//]: # (...)` is the Markdown comment idiom.
    const ref = /^ {0,3}\[([^\]]+)\]:\s*(\S+)(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*$/.exec(line);
    if (ref) {
      const title = ref[3] ?? ref[4] ?? ref[5] ?? "";
      if (ref[1] === "//" || ref[2] === "#") segs.add("comment", title, "markdown reference comment");
      else if (title) segs.add("link-title", title, `reference [${ref[1]}]`);
      continue;
    }
    keep.push(line);
  }
  // Inline link titles show only as a tooltip.
  return keep
    .join("\n")
    .replace(/(!?\[[^\]\n]*\]\(\s*<?[^\s)>]*>?)\s+(?:"([^"\n]*)"|'([^'\n]*)')\s*\)/g, (_, head: string, t1?: string, t2?: string) => {
      segs.add("link-title", t1 ?? t2 ?? "", "link title");
      return `${head})`;
    });
}

// ---------- base64 ----------

const BASE64_RUN = /[A-Za-z0-9+/_-]{40,}={0,2}/g;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Records base64 runs that decode to readable text. Images and hashes decode to bytes and are skipped. */
function scanBase64(body: string, segs: Segments, inv: Invisible): void {
  for (const m of body.matchAll(BASE64_RUN)) {
    const run = m[0].slice(0, 100_000); // multiple of 4; an image data URI can be megabytes
    if (/^[0-9a-f]+$/i.test(run) || !/[A-Z]/.test(run) || !/[a-z]/.test(run)) continue; // hex digests, slugs
    let b64 = run.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    if (b64.length % 4 === 1) b64 = b64.slice(0, -1);
    let decoded: string;
    try {
      decoded = utf8.decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    } catch {
      continue;
    }
    const printable = decoded.replace(/[^\x20-\x7E\n\t -￿]/g, "").length / decoded.length;
    const letters = (decoded.match(/\p{L}/gu) ?? []).length / decoded.replace(/\s/g, "").length;
    if (decoded.length >= 16 && printable > 0.95 && letters > 0.6 && (decoded.match(/ /g) ?? []).length >= 2) {
      segs.add("base64", inv.strip(decoded), `base64 (${run.length} chars)`);
    }
  }
}
