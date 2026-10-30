/**
 * Markdown のライブプレビュー付きの編集欄 (Obsidian の「ライブプレビュー」と同じ考え方)
 *   - 常に編集できる 1 つの欄。カーソルのある行は打ったままの Markdown、それ以外の行は変換した見た目で出す
 *   - 仕組み: CodeMirror 6 + @lezer/markdown の構文木。カーソルの無い行では、記法の印 (#、**、`、- 、[ ]、``` など) を隠し、
 *     見出しの大きさ・太字・斜体・コード・箇条書きの点・チェック・リンク・画像を装飾で表す (本文は常にそのまま残る)
 *   - 表はそのまま (等幅) で出す。画像は http(s) の URL と、置き場 (assetBase) が分かる相対パスだけ描く
 * Input : value = 本文, onChange = 本文が変わった (少し待ってまとめて呼ぶ), onBlur = 欄を離れた, onFiles = 画像の貼り付け・ドロップ,
 *         placeholder, autoFocus, assetBase = 相対パスの画像の置き場
 * Output: 編集欄の JSX
 */
import { splitLinks } from "../lib/localLink";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder as cmPlaceholder, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { useEffect, useRef } from "react";

/** 画像の部品 (カーソルの無い行で ![alt](src) の代わりに描く) */
class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) { super(); }
  eq(other: ImageWidget): boolean { return other.src === this.src && other.alt === this.alt; }
  toDOM(): HTMLElement {
    const img = document.createElement("img");
    img.src = this.src; img.alt = this.alt; img.className = "cm-md-img"; img.loading = "lazy";
    return img;
  }
  ignoreEvent(): boolean { return false; }
}
/** 文字だけの部品 (箇条書きの点・チェック・区切り線) */
class TextWidget extends WidgetType {
  constructor(readonly text: string, readonly cls: string) { super(); }
  eq(other: TextWidget): boolean { return other.text === this.text && other.cls === this.cls; }
  toDOM(): HTMLElement { const span = document.createElement("span"); span.className = this.cls; span.textContent = this.text; return span; }
}
class RuleWidget extends WidgetType {
  eq(): boolean { return true; }
  toDOM(): HTMLElement { const hr = document.createElement("hr"); hr.className = "cm-md-hr"; return hr; }
}

const hide = Decoration.replace({});
const marks = {
  strong: Decoration.mark({ class: "cm-md-strong" })
, em: Decoration.mark({ class: "cm-md-em" })
, strike: Decoration.mark({ class: "cm-md-strike" })
, code: Decoration.mark({ class: "cm-md-code" })
, link: Decoration.mark({ class: "cm-md-link" })
, url: Decoration.mark({ class: "cm-md-url" })
, quote: Decoration.mark({ class: "cm-md-quote" })
};
const lineClass = (cls: string) => Decoration.line({ class: cls });

/** 画像の src を解決する (http(s) / data はそのまま、相対パスは置き場を前に付ける。置き場が無ければ null) */
function resolveSrc(src: string, assetBase: string | null): string | null {
  if (/^(https?:)?\/\//i.test(src) || src.startsWith("data:") || src.startsWith("blob:")) return src;
  return assetBase ? assetBase + src.replace(/^\.?\//, "") : null;
}

/**
 * ライブプレビューの装飾を作る拡張
 * Input : getAssetBase = 相対パスの画像の置き場を返す関数 (変わりうるので関数で渡す)
 */
function livePreview(getAssetBase: () => string | null): Extension {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = this.build(view); }
    // (構文木は少しずつ作られるので、木が進んだときも描き直す。そうしないと最初の表示が打ったままの文で止まる)
    update(u: ViewUpdate) { if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) this.decorations = this.build(u.view); }
    build(view: EditorView): DecorationSet {
      const { state } = view;
      const doc = state.doc;
      // カーソル (選択) のある行の番号: この行では記法をそのまま出す
      const active = new Set<number>();
      if (view.hasFocus) for (const r of state.selection.ranges) { const from = doc.lineAt(r.from).number, to = doc.lineAt(r.to).number; for (let n = from; n <= to; n++) active.add(n); }
      const isActive = (from: number, to: number): boolean => { const a = doc.lineAt(from).number, b = doc.lineAt(to).number; for (let n = a; n <= b; n++) if (active.has(n)) return true; return false; };
      const assetBase = getAssetBase();
      // 装飾は位置順に積む必要があるので、いったん集めてから並べる
      const items: { from: number; to: number; deco: Decoration; line?: boolean }[] = [];
      const push = (from: number, to: number, deco: Decoration) => { items.push({ from, to, deco }); };
      const addLine = (pos: number, deco: Decoration) => { const l = doc.lineAt(pos); items.push({ from: l.from, to: l.from, deco, line: true }); };
      const tree = syntaxTree(state);
      // (小さな文は全部を装飾する: 画面の外にある行も、スクロールして見えた瞬間から見た目になっている。大きな文は見えている範囲だけ)
      const ranges = doc.length < 50_000 ? [{ from: 0, to: doc.length }] : view.visibleRanges;
      for (const { from, to } of ranges) {
        tree.iterate({ from, to, enter: (node) => {
          const n = node.name;
          const inactive = !isActive(node.from, node.to);
          // ---- 見出し: 行の大きさは常に。印 (# と空白) はカーソルの無い行で隠す ----
          const h = /^ATXHeading(\d)$/.exec(n);
          if (h) { addLine(node.from, lineClass(`cm-md-h${h[1]}`)); return; }
          if (n === "HeaderMark") { if (inactive && node.node.parent?.name.startsWith("ATXHeading")) push(node.from, Math.min(node.to + 1, doc.lineAt(node.to).to), hide); return; }
          // ---- 強調・取り消し・インラインコード ----
          if (n === "StrongEmphasis") { push(node.from, node.to, marks.strong); return; }
          if (n === "Emphasis") { push(node.from, node.to, marks.em); return; }
          if (n === "Strikethrough") { push(node.from, node.to, marks.strike); return; }
          if (n === "InlineCode") { push(node.from, node.to, marks.code); return; }
          if (n === "EmphasisMark" || n === "StrikethroughMark" || (n === "CodeMark" && node.node.parent?.name === "InlineCode")) { if (inactive) push(node.from, node.to, hide); return; }
          // ---- 箇条書き・番号つき・チェック: 印を点やチェックに替える (カーソルの無い行) ----
          if (n === "ListItem") { addLine(node.from, lineClass("cm-md-li")); return; }
          if (n === "ListMark") {
            if (!inactive) return;
            const text = doc.sliceString(node.from, node.to);
            const ordered = /^\d/.test(text);
            // チェック (- [ ] / - [x]) は、次の TaskMarker と合わせて 1 つの印にする
            const next = node.node.nextSibling;
            if (next?.name === "Task") {
              const marker = next.node.getChild("TaskMarker");
              if (marker) { const done = /x/i.test(doc.sliceString(marker.from, marker.to)); push(node.from, Math.min(marker.to + 1, doc.lineAt(marker.to).to), Decoration.replace({ widget: new TextWidget(done ? "☑" : "☐", "cm-md-task" + (done ? " cm-md-task--done" : "")) })); return; }
            }
            push(node.from, Math.min(node.to + 1, doc.lineAt(node.to).to), Decoration.replace({ widget: new TextWidget(ordered ? text : "•", "cm-md-bullet") }));
            return;
          }
          if (n === "Task") { const marker = node.node.getChild("TaskMarker"); if (marker && /x/i.test(doc.sliceString(marker.from, marker.to))) push(node.from, node.to, marks.strike); return; }
          // ---- リンク・画像 ----
          if (n === "Image") {
            if (!inactive) return;
            const url = node.node.getChild("URL");
            const src = url ? resolveSrc(doc.sliceString(url.from, url.to), assetBase) : null;
            const alt = /^!\[([^\]]*)\]/.exec(doc.sliceString(node.from, node.to))?.[1] ?? "";
            push(node.from, node.to, Decoration.replace({ widget: src ? new ImageWidget(src, alt) : new TextWidget(`[${alt || "image"}]`, "cm-md-img-missing") }));
            return false;
          }
          if (n === "Link") { push(node.from, node.to, marks.link); return; }
          if (n === "LinkMark") { if (inactive && node.node.parent?.name === "Link") push(node.from, node.to, hide); return; }
          if (n === "URL" && node.node.parent?.name === "Link") {
            // [文](URL) の URL 部分は、カーソルの無い行では隠す (文だけがリンクに見える)。<URL> だけの自動リンクはそのまま
            if (inactive && node.node.prevSibling?.name === "LinkMark") push(node.from, node.to, hide); else push(node.from, node.to, marks.url);
            return;
          }
          // ---- コードブロック: ``` の行はカーソルが無ければ隠し、中身は等幅の帯 ----
          if (n === "FencedCode") {
            const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
            for (let l = first.number; l <= last.number; l++) addLine(doc.line(l).from, lineClass("cm-md-codeblock"));
            if (!isActive(first.from, first.to)) push(first.from, first.from, lineClass("cm-md-fence-hidden"));
            if (!isActive(last.from, last.to) && last.number !== first.number) push(last.from, last.from, lineClass("cm-md-fence-hidden"));
            return;
          }
          // ---- 引用・区切り線 ----
          if (n === "Blockquote") { const first = doc.lineAt(node.from), last = doc.lineAt(node.to); for (let l = first.number; l <= last.number; l++) addLine(doc.line(l).from, lineClass("cm-md-blockquote")); return; }
          if (n === "QuoteMark") { if (inactive) push(node.from, Math.min(node.to + 1, doc.lineAt(node.to).to), hide); return; }
          if (n === "HorizontalRule") { if (inactive) push(node.from, node.to, Decoration.replace({ widget: new RuleWidget() })); return; }
          if (n === "Table") { const first = doc.lineAt(node.from), last = doc.lineAt(node.to); for (let l = first.number; l <= last.number; l++) addLine(doc.line(l).from, lineClass("cm-md-table")); return; }
          return;
        } });
      }
      // 置き換え (widget / 隠す) は入れ子・部分的な重なりを避ける: 先に始まり広いものを採り、重なる後のものは捨てる。並べ替えは Decoration.set に任せる
      items.sort((a, b) => a.from - b.from || b.to - a.to);
      const out: ReturnType<Decoration["range"]>[] = [];
      let lastTo = -1;
      for (const it of items) {
        const replacing = !it.line && (it.deco.spec.widget !== undefined || (it.deco.spec.class === undefined && it.from !== it.to));
        if (replacing) { if (it.from < lastTo) continue; lastTo = it.to; }
        out.push(it.deco.range(it.from, it.to));
      }
      try { return Decoration.set(out, true); } catch (e) { console.error("live preview decorations", e); return Decoration.none; }
    }
  }, { decorations: (v) => v.decorations });
}

/** 画像の置き場 (store から引く。この欄は store に依存しないよう、関数で受け取る) */
function placeholderOf(text: string): Extension { return cmPlaceholder(text); }

/**
 * クリックした位置の Markdown のリンクの行き先 ([文字](行き先) の行き先、<https://...> の中身)
 * Input : view, pos = 文書の位置 / Output: 行き先の文字列 (リンクの上でなければ undefined)
 */
function linkTargetAt(view: EditorView, pos: number): string | undefined {
  for (let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === "URL") return view.state.sliceDoc(node.from, node.to);
    if (node.name === "Link" || node.name === "Image" || node.name === "Autolink") {
      const url = node.getChild("URL");
      return url ? view.state.sliceDoc(url.from, url.to) : undefined;
    }
  }
  // [文字](行き先) の形でなくても、文中の URL やファイルらしいパス (docs/design.md など) の上なら、それを行き先にする
  const line = view.state.doc.lineAt(pos);
  let at = line.from;
  for (const piece of splitLinks(line.text)) {
    const end = at + piece.text.length;
    if (piece.kind !== "text" && pos >= at && pos <= end) return piece.text;
    at = end;
  }
  return undefined;
}

export function LiveMarkdownEditor({ value, onChange, onBlur, onFiles, onOpenLink, placeholder, autoFocus, assetBase, readOnly = false, minHeight = 240 }: {
  value: string; onChange: (v: string) => void; onBlur?: () => void; onFiles?: (files: FileList | null, e: { preventDefault: () => void }) => void
  /** Ctrl (Mac は Cmd) + クリックしたリンクの行き先を受け取る (手元のファイル・URL を開く。ふつうのクリックは文字の編集のまま) */
; onOpenLink?: (href: string) => void
; placeholder?: string; autoFocus?: boolean; assetBase: string | null; readOnly?: boolean; minHeight?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const assetRef = useRef(assetBase); assetRef.current = assetBase;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onBlurRef = useRef(onBlur); onBlurRef.current = onBlur;
  const onFilesRef = useRef(onFiles); onFilesRef.current = onFiles;
  const onOpenLinkRef = useRef(onOpenLink); onOpenLinkRef.current = onOpenLink;
  const readOnlyComp = useRef(new Compartment());
  // 欄を作る (1 回)。本文の更新は下の effect で差分として入れる
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current
    , state: EditorState.create({ doc: value, extensions: [
        history(), keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]), EditorView.lineWrapping
      , markdown({ base: markdownLanguage }), livePreview(() => assetRef.current)
      , placeholderOf(placeholder ?? "")
      , readOnlyComp.current.of(EditorState.readOnly.of(readOnly))
      , EditorView.updateListener.of((u) => { if (u.docChanged) onChangeRef.current(u.state.doc.toString()); })
      , EditorView.domEventHandlers({
          blur: () => { onBlurRef.current?.(); return false; }
        , mousedown: (e, view) => {
            // Ctrl / Cmd + クリック: リンクの行き先を開く (編集のカーソル移動はしない)
            if (!(e.ctrlKey || e.metaKey) || !onOpenLinkRef.current) return false;
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
            const href = pos === null ? undefined : linkTargetAt(view, pos);
            if (!href) return false;
            e.preventDefault();
            onOpenLinkRef.current(href);
            return true;
          }
        , paste: (e) => { if (e.clipboardData?.files.length) { onFilesRef.current?.(e.clipboardData.files, e); return e.defaultPrevented; } return false; }
        , drop: (e) => { if (e.dataTransfer?.files.length) { onFilesRef.current?.(e.dataTransfer.files, e); return e.defaultPrevented; } return false; }
        })
      ] })
    });
    viewRef.current = view;
    if (autoFocus) view.focus();
    return () => { view.destroy(); viewRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // 外から本文が変わった (別のボックスを選んだ、画像を貼った、AI が書き換えた) ときは、欄の中身を差し替える (打っている最中の自分の変更は同じ文字列なので何もしない)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);
  useEffect(() => { viewRef.current?.dispatch({ effects: readOnlyComp.current.reconfigure(EditorState.readOnly.of(readOnly)) }); }, [readOnly]);
  return <div ref={host} className="live-md" style={{ minHeight }} />;
}
/** 構文木の節の型 (読みやすさのため) */
export type { SyntaxNode };
