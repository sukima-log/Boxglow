/**
 * アプリの状態 (Zustand)
 *
 * project を単一の正とし、変更はすべて apply(純粋関数) を通す。apply は履歴 (元に戻す / やり直す) を積み、
 * 保存は変更から少し遅らせて IndexedDB に書く。
 */
import { useMemo } from "react";
import { create } from "zustand";
import { createProject, defaultTaskParent, fromJSON, isInScope, majorOf, normalizeCollapsed, normalizeInputNames, resolveAllOverlaps, scopeFor, toJSON, wireNetTabs, withIndex } from "../model/graph";
export { isInScope, majorBlocks } from "../model/graph";
import { blockSize } from "../model/size";
import { ensurePermission, readLocalFile, writeLocalFile } from "../lib/localfile";
import { buildSampleProject } from "../model/sample";
import exampleText from "../../examples/logic-daw/boxglow.json?raw";
import type { Project } from "../model/types";
import { deleteProject, listProjects, loadProject, saveProject, type ProjectMeta } from "../lib/storage";
import { t } from "../i18n"; // 画面に出す文言 (toast など) の言語切替

/** 履歴に積む上限 */
const HISTORY_LIMIT = 100;

/** 保存を遅らせる時間 (ms) */
const SAVE_DELAY = 400;

export interface Selection {
  blockId: string | null;
  edgeId: string | null;
  /** 最上位の入力ノード / 最終成果物ノードを選んでいるとき */
  terminal: "in" | "out" | null;
  /** 入力グループのノードを選んでいるとき (terminal = "in" とともに) */
  terminalGroup: string | null;
  /** プロジェクト設定 (名前・説明) を開いているとき */
  project: boolean;
  /** タイムライン (活動・判断・ログ) を開いているとき */
  timeline: boolean;
}

/** 何も選んでいない状態 */
export const NO_SELECTION: Selection = { blockId: null, edgeId: null, terminal: null, terminalGroup: null, project: false, timeline: false };

interface State {
  project: Project | null;
  /** サンプルなど、保存しないプロジェクトを開いているか */
  ephemeral: boolean;
  /** 保存先: ブラウザ内 (idb) か、ローカルファイル (file) か */
  source: "idb" | "file" | "serve" | "vscode";
  /** ローカルファイルの名前 (source = file のとき) */
  fileName: string | null;
  readonly: boolean;
  /** View モードで畳んだ / 展開した箱 (画面だけの状態。ファイルには書かない)。id -> collapsed */
  viewCollapsed: Record<string, boolean>;
  /** 箱を畳む / 展開する。All で大項目なら、そのタブを開く。Edit なら共有の配置として保存、View なら画面だけ */
  toggleCollapsed: (blockId: string) => void;
  /** 開いているタブ (大項目の箱の id)。null なら All (大項目の一覧)。画面だけの状態で、プロジェクトごとにブラウザに記憶 */
  viewScope: string | null;
  /** 表示範囲を切り替える (null = All)。範囲の外にある箱の選択は解除する */
  setViewScope: (blockId: string | null) => void;
  /** 今すぐ保存する (Save ボタン。自動保存を待たずに書く) */
  saveNow: () => void;

  embed: boolean;
  projects: ProjectMeta[];
  selection: Selection;
  /** 直前まで選んでいた線の id (箱をダブルクリックしてタブを開くとき、最初のクリックで外れた線の選択を戻すため) */
  lastEdgeId: string | null;
  past: Project[];
  future: Project[];
  /** 画面の下に短く出す通知 */
  toast: string | null;
  /** 「自分」として選んだメンバー id (ブラウザごとに記憶。プロジェクトごと) */
  meId: string | null;
  setMe: (memberId: string | null) => void;
  /** Edit モード (ドラッグでの移動・結線・階層移動と Del キーが効く)。View なら閲覧と選択だけ。プロジェクトごとに記憶 */
  editMode: boolean;
  setEditMode: (on: boolean) => void;
  /** キャンバスに「このブロックが見えるように寄せて」と頼む (追加直後など)。nonce で同じ id でも再度反応する */
  focus: { blockId: string; nonce: number } | null;
  focusBlock: (blockId: string, opts?: { scope?: boolean }) => void;
  saveState: "saved" | "saving" | "unsaved" | "none";

  /** 純粋関数で project を変更する。history=false なら履歴に積まない (ドラッグ中など) */
  apply: (fn: (p: Project) => Project, opts?: { history?: boolean }) => void;
  undo: () => void;
  redo: () => void;
  select: (sel: Partial<Selection>) => void;
  setToast: (msg: string | null) => void;

  refreshList: () => Promise<void>;
  newProject: (name: string) => Promise<void>;
  openProject: (id: string) => Promise<boolean>;
  openProjectObject: (p: Project, ephemeral: boolean) => void;
  importJSON: (text: string) => Promise<void>;
  openSample: () => void;
  /** 公開用の例 (examples/logic-daw/boxglow.json) を開く (保存しない) */
  openExample: () => void;
  /** ローカルの boxglow.json を開く (監視と書き戻しを始める) */
  openLocalFile: (handle: FileSystemFileHandle) => Promise<boolean>;
  /** ローカルサーバ (npx boxglow serve) の boxglow.json を開く (API で読み書き。変更は SSE で受ける) */
  openFromServer: () => Promise<boolean>;
  /** VS Code 拡張の webview の中で開く (拡張とメッセージで読み書き。ファイルの変更は拡張から届く) */
  openFromVsCode: () => void;
  copyToMine: () => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  closeProject: () => void;
  setMode: (opts: { readonly?: boolean; embed?: boolean }) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** 記憶してある「自分」を読む (メンバーに居なければ null) */
function loadMe(p: Project): string | null {
  try {
    const id = localStorage.getItem(`boxglow:me:${p.id}`);
    return id && p.members.some((m) => m.id === id) ? id : null;
  } catch {
    return null;
  }
}

/** 開いたときのモードは常に View (誤操作を防ぐため。編集するときに Edit に切り替える) */
/**
 * ブラウザに記憶した表示範囲 (タブ) を読む
 * Input : p = 開いたプロジェクト
 * Output: 大項目の箱の id (無い・消えていれば null = All)
 */
function loadScope(p: Project): string | null {
  try {
    const id = localStorage.getItem(`boxglow:scope:${p.id}`);
    return id && p.blocks[id] ? id : null;
  } catch {
    return null;
  }
}

function loadEditMode(_p: Project): boolean {
  return false;
}

/** ローカルファイル連携の状態 (ハンドルは保存できないのでモジュール変数に持つ) */
let fileHandle: FileSystemFileHandle | null = null;
let fileLastModified = 0;
let watchTimer: ReturnType<typeof setInterval> | null = null;
/** ローカルサーバ連携の状態: 自分が最後に書いた中身 (サーバからの変更通知と区別する) と、通知の接続 */
let serveLastText = "";
let serveEvents: EventSource | null = null;
/** VS Code の webview の API (拡張の中だけで定義される)。postMessage で拡張とやり取りする */
type VsCodeApi = { postMessage: (msg: unknown) => void };
declare global { interface Window { acquireVsCodeApi?: () => VsCodeApi } }
let vscodeApi: VsCodeApi | null = null;
let vscodeLastText = "";

/** サーバの API の場所 (アプリは相対パスで配信されるので、ページの場所から解く) */
const serveApi = (path: string): string => new URL(path, document.baseURI).toString();
/** サーバへ書く */
async function writeToServer(text: string): Promise<void> {
  serveLastText = text;
  const r = await fetch(serveApi("api/project"), { method: "PUT", headers: { "content-type": "application/json" }, body: text });
  if (!r.ok) throw new Error(t("サーバに書けません ({status})", { status: r.status }));
}
/** ファイルの監視間隔 (ms) */
const WATCH_INTERVAL = 1500;

export const useProjectStore = create<State>((set, get) => {
  /** 保存を予約する (連続する変更は 1 回にまとめる) */
  const scheduleSave = () => {
    const { project, ephemeral, readonly } = get();
    if (!project || ephemeral || readonly) return;
    set({ saveState: "unsaved" });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null; // 発火したら「未保存の変更がある」状態は終わり (外からの変更の読み直しを止めない)
      const p = get().project;
      if (!p) return;
      set({ saveState: "saving" });
      try {
        if (get().source === "serve") {
          await writeToServer(toJSON(p) + "\n");
          set({ saveState: "saved" });
        } else if (get().source === "vscode" && vscodeApi) {
          // 拡張に書いてもらう (ファイルは拡張が持っている)
          vscodeLastText = toJSON(p) + "\n";
          vscodeApi.postMessage({ type: "save", text: vscodeLastText });
          set({ saveState: "saved" });
        } else if (get().source === "file" && fileHandle) {
          // 最初の保存のときに書き込み権限を求める (開くときは読み取りだけ)
          if (!(await ensurePermission(fileHandle, "readwrite"))) {
            set({ saveState: "unsaved", toast: t("ファイルへの書き込みが許可されていません (Save を押すともう一度確認します)") });
            return;
          }
          // ローカルファイルへ書き戻す (書いた後の更新時刻を覚えて、自分の書き込みを外部の変更と間違えない)
          fileLastModified = await writeLocalFile(fileHandle, toJSON(p) + "\n");
          set({ saveState: "saved" });
        } else {
          await saveProject(p);
          set({ saveState: "saved" });
          void get().refreshList();
        }
      } catch (e) {
        set({ saveState: "unsaved", toast: t("保存に失敗しました: {error}", { error: String(e) }) });
      }
    }, SAVE_DELAY);
  };

  /** URL のハッシュに開いているプロジェクト id を書く (再読み込みで戻れるように) */
  /** ローカルファイルの監視を止める */
  const stopWatching = () => {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
    fileHandle = null;
    if (serveEvents) serveEvents.close();
    serveEvents = null;
  };

  const rememberInUrl = (id: string | null) => {
    const url = new URL(window.location.href);
    url.hash = id ? `p=${id}` : "";
    history.replaceState(null, "", url.toString());
  };

  return {
    project: null
  , ephemeral: false
  , source: "idb"
  , fileName: null
  , readonly: false
  , viewCollapsed: {}
  , viewScope: null
  , setViewScope: (blockId) => {
      const { project, selection } = get();
      if (!project) return;
      // タブになるのは大項目だけ (中の箱は入れ子で見せる)。大項目以外を指定されたら、その箱が属する大項目のタブにする
      const scope = blockId && project.blocks[blockId] ? majorOf(project, blockId) : null;
      try {
        if (scope) localStorage.setItem(`boxglow:scope:${project.id}`, scope);
        else localStorage.removeItem(`boxglow:scope:${project.id}`);
      } catch {
        /* 記憶できなくても動く */
      }
      // 範囲の外の箱を選んだままだと、詳細パネルに見えない物が出て混乱するので外す (Summary などの選択は保つ)。
      // 線の選択は保つ: 線は境界を越えて別のタブへ続くので、選んだままタブを移って接続先を追えるようにする
      const keepSel = scope && selection.blockId && !isInScope(project, scope, selection.blockId) ? { ...selection, blockId: null } : selection;
      set({ viewScope: scope, selection: keepSel });
    }
  , saveNow: () => {
      const { project, ephemeral, readonly } = get();
      if (!project || ephemeral || readonly) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      scheduleSave();
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      void (async () => {
        set({ saveState: "saving" });
        try {
          if (get().source === "serve") {
            await writeToServer(toJSON(get().project!) + "\n");
          } else if (get().source === "vscode" && vscodeApi) {
            vscodeLastText = toJSON(get().project!) + "\n";
            vscodeApi.postMessage({ type: "save", text: vscodeLastText });
          } else if (get().source === "file" && fileHandle) {
            if (!(await ensurePermission(fileHandle, "readwrite"))) { set({ saveState: "unsaved", toast: t("ファイルへの書き込みが許可されていません") }); return; }
            fileLastModified = await writeLocalFile(fileHandle, toJSON(get().project!) + "\n");
          } else {
            await saveProject(get().project!);
            void get().refreshList();
          }
          set({ saveState: "saved" });
        } catch (e) {
          set({ saveState: "unsaved", toast: t("保存に失敗しました: {error}", { error: e instanceof Error ? e.message : String(e) }) });
        }
      })();
    }
  , toggleCollapsed: (blockId) => {
      const { project, editMode, readonly, viewCollapsed, viewScope } = get();
      if (!project || !project.blocks[blockId]) return;
      // All の図では大項目は展開しない (中はタブで見る)。畳む / 展開の操作はその大項目のタブを開く操作にする
      if (viewScope === null && majorOf(project, blockId) === blockId) {
        // ダブルクリックの 1 回目で箱が選ばれ、直前まで選んでいた線の選択が外れている。
        // その線がこのタブへ続いているなら、線を選んだままタブを開く (線を選んで接続先の箱をダブルクリックする流れ)
        const { lastEdgeId, selection } = get();
        if (lastEdgeId && selection.blockId === blockId && project.edges[lastEdgeId] && wireNetTabs(project, lastEdgeId).includes(blockId)) {
          set({ selection: { ...NO_SELECTION, edgeId: lastEdgeId } });
        }
        get().setViewScope(blockId);
        return;
      }
      if (!Object.values(project.blocks).some((b) => b.parentId === blockId)) return; // 子が無ければ畳めない
      if (editMode && !readonly) {
        // 共有の配置として保存する (他の人・AI にも同じ見え方になる)。画面だけの記録は消して、保存した値を見せる
        const rest = { ...viewCollapsed };
        delete rest[blockId];
        set({ viewCollapsed: rest });
        get().apply((p) => {
          const q = structuredClone(p);
          q.blocks[blockId].collapsed = !q.blocks[blockId].collapsed;
          return q;
        });
        return;
      }
      // 見るだけ: 画面の中だけで切り替える (ファイルに差分を出さない)
      const cur = viewCollapsed[blockId] ?? project.blocks[blockId].collapsed;
      set({ viewCollapsed: { ...viewCollapsed, [blockId]: !cur } });
    }
  , embed: false
  , projects: []
  , selection: NO_SELECTION
  , lastEdgeId: null
  , past: []
  , future: []
  , toast: null
  , meId: null
  , editMode: false
  , setEditMode: (on) => set(on ? { editMode: true, viewCollapsed: {} } : { editMode: on }) // 記憶しない (開くたびに View から)。Edit に入るときは画面だけの畳みを捨てて共有の配置を見せる
  , setMe: (memberId) => {
      const p = get().project;
      if (p) {
        try {
          if (memberId) localStorage.setItem(`boxglow:me:${p.id}`, memberId);
          else localStorage.removeItem(`boxglow:me:${p.id}`);
        } catch {
          /* 記憶できなくても動く */
        }
      }
      set({ meId: memberId });
    }
  , focus: null
  , focusBlock: (blockId, opts) => {
      // 箱が見える画面に切り替えてから寄せる: 親の箱を開く (親がプロジェクトの箱や最上位なら All)。
      // scope: false なら画面は変えない (キャンバスでクリックして選んだときは、クリック側が箱を開くのでここでは切り替えない)
      const { project, viewScope } = get();
      if (opts?.scope !== false && project && project.blocks[blockId]) {
        const want = scopeFor(project, blockId);
        if (want !== viewScope) get().setViewScope(want);
      }
      set({ focus: { blockId, nonce: Date.now() } });
    }
  , saveState: "none"

  , apply: (fn, opts) => {
      const { project, past, readonly } = get();
      if (!project || readonly) return;
      let next = fn(project);
      if (next === project) return;
      // 大項目は畳んだ状態でそろえる (All は大項目までしか出さない)。箱は重ねない: 変更のたびに同じ階層の重なりを押し出す (ドラッグ中は呼び出し側が history=false で呼ぶので除く)
      next = normalizeCollapsed(normalizeInputNames(next).project);
      if (opts?.history !== false) next = resolveAllOverlaps(next, blockSize);
      const history = opts?.history ?? true;
      set({
        project: next
      , past: history ? [...past.slice(-HISTORY_LIMIT + 1), project] : past
      , future: history ? [] : get().future
      });
      scheduleSave();
    }

  , undo: () => {
      const { project, past, future } = get();
      if (!project || past.length === 0) return;
      const prev = past[past.length - 1];
      set({ project: prev, past: past.slice(0, -1), future: [project, ...future] });
      scheduleSave();
    }

  , redo: () => {
      const { project, past, future } = get();
      if (!project || future.length === 0) return;
      const [next, ...rest] = future;
      set({ project: next, past: [...past, project], future: rest });
      scheduleSave();
    }

    // 選択は 1 種類だけ (ブロック / 線 / 入出力ノード / プロジェクト設定)。指定した項目以外は解除する
  , select: (sel) => {
      const cur = get().selection;
      const next = { ...NO_SELECTION, ...sel };
      // 「線を選んでいた → 箱を選んだ」の直後だけ、その線を覚える (同じ箱を続けて選ぶダブルクリックの 2 回目では保つ)。
      // 線を外しただけ (何もない所を押した) や別の物を選んだときは忘れる (あとで無関係に線が選び直されないように)
      const lastEdgeId = cur.edgeId && next.blockId ? cur.edgeId : next.blockId && next.blockId === cur.blockId ? get().lastEdgeId : null;
      set({ selection: next, lastEdgeId });
    }
  , setToast: (msg) => set({ toast: msg })

  , refreshList: async () => set({ projects: await listProjects() })

  , newProject: async (name) => {
      const p = createProject(name || t("無題のプロジェクト"));
      await saveProject(p);
      get().openProjectObject(p, false);
      get().setEditMode(true);
      await get().refreshList();
    }

  , openProject: async (id) => {
      const p = await loadProject(id);
      if (!p) return false;
      get().openProjectObject(p, false);
      return true;
    }

  , openProjectObject: (p, ephemeral) => {
      stopWatching();
      set({ project: p, ephemeral, source: "idb", fileName: null, past: [], future: [], selection: NO_SELECTION, viewCollapsed: {}, viewScope: loadScope(p), saveState: ephemeral ? "none" : "saved", meId: loadMe(p), editMode: loadEditMode(p) });
      rememberInUrl(ephemeral ? null : p.id);
    }

  , openLocalFile: async (handle) => {
      if (!(await ensurePermission(handle, "read"))) {
        set({ toast: t("ファイルの読み書きが許可されませんでした") });
        return false;
      }
      let text: string;
      try {
        const r = await readLocalFile(handle);
        text = r.text;
        fileLastModified = r.lastModified;
      } catch (e) {
        set({ toast: t("ファイルを読めません: {error}", { error: String(e) }) });
        return false;
      }
      let p: Project;
      try {
        p = fromJSON(text);
      } catch (e) {
        set({ toast: e instanceof Error ? e.message : String(e) });
        return false;
      }
      stopWatching();
      fileHandle = handle;
      set({ project: p, ephemeral: false, source: "file", fileName: handle.name, past: [], future: [], selection: NO_SELECTION, viewCollapsed: {}, viewScope: loadScope(p), saveState: "saved", meId: loadMe(p), editMode: loadEditMode(p) });
      rememberInUrl(null);
      // 監視: 外部 (CLI など) が書き換えたら読み直す (自分の書き込みは fileLastModified で区別)
      watchTimer = setInterval(async () => {
        if (!fileHandle) return;
        try {
          const f = await fileHandle.getFile();
          if (f.lastModified === fileLastModified) return;
          if (saveTimer) return; // 自分の未保存の変更がある間は、保存が終わってから読む
          fileLastModified = f.lastModified;
          const next = fromJSON(await f.text());
          const cur = get().project;
          // 選択中のブロックが消えていたら選択を解除する
          const sel = get().selection;
          const keep = sel.blockId && next.blocks[sel.blockId] ? sel : sel.blockId ? NO_SELECTION : sel;
          set({ project: next, past: cur ? [...get().past.slice(-HISTORY_LIMIT + 1), cur] : get().past, future: [], selection: keep, saveState: "saved" });
        } catch {
          /* 一時的に読めないときは次の周期で */
        }
      }, WATCH_INTERVAL);
      return true;
    }

  , openFromServer: async () => {
      let text: string;
      let name = "boxglow.json";
      try {
        const r = await fetch(serveApi("api/project"), { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        text = await r.text();
        name = decodeURIComponent(r.headers.get("x-boxglow-file") ?? name);
      } catch (e) {
        set({ toast: t("サーバから読めません (npx boxglow serve が動いていますか): {error}", { error: String(e) }) });
        return false;
      }
      let p: Project;
      try {
        p = fromJSON(text);
      } catch (e) {
        set({ toast: e instanceof Error ? e.message : String(e) });
        return false;
      }
      stopWatching();
      serveLastText = text;
      set({ project: p, ephemeral: false, source: "serve", fileName: name, past: [], future: [], selection: NO_SELECTION, viewCollapsed: {}, viewScope: loadScope(p), saveState: "saved", meId: loadMe(p), editMode: loadEditMode(p) });
      rememberInUrl(null);
      // サーバからの変更通知 (CLI や AI が書いたとき): 読み直す。自分の未保存の変更がある間は後回し
      const reload = async () => {
        if (saveTimer) { setTimeout(reload, SAVE_DELAY + 300); return; }
        try {
          const r = await fetch(serveApi("api/project"), { cache: "no-store" });
          const t = await r.text();
          if (t === serveLastText) return;
          serveLastText = t;
          const next = fromJSON(t);
          const cur = get().project;
          const sel = get().selection;
          const keep = sel.blockId && next.blocks[sel.blockId] ? sel : sel.blockId ? NO_SELECTION : sel;
          set({ project: next, past: cur ? [...get().past.slice(-HISTORY_LIMIT + 1), cur] : get().past, future: [], selection: keep, saveState: "saved" });
        } catch {
          /* 次の通知で */
        }
      };
      serveEvents = new EventSource(serveApi("api/events"));
      serveEvents.addEventListener("change", () => { void reload(); });
      return true;
    }

  , openFromVsCode: () => {
      if (!window.acquireVsCodeApi) return;
      vscodeApi = vscodeApi ?? window.acquireVsCodeApi();
      // 拡張からの通知: load (最初の中身) / update (ファイルが外で変わった)
      const applyText = (text: string, name: string, first: boolean) => {
        if (!first && text === vscodeLastText) return; // 自分の書き込みの反映
        if (!first && saveTimer) { setTimeout(() => applyText(text, name, false), SAVE_DELAY + 300); return; } // 自分の未保存の変更がある間は後回し
        let p: Project;
        try {
          p = fromJSON(text);
        } catch (e) {
          set({ toast: e instanceof Error ? e.message : String(e) });
          return;
        }
        vscodeLastText = text;
        if (first) {
          stopWatching();
          set({ project: p, ephemeral: false, source: "vscode", fileName: name, past: [], future: [], selection: NO_SELECTION, viewCollapsed: {}, viewScope: loadScope(p), saveState: "saved", meId: loadMe(p), editMode: loadEditMode(p) });
          return;
        }
        const cur = get().project;
        const sel = get().selection;
        const keep = sel.blockId && p.blocks[sel.blockId] ? sel : sel.blockId ? NO_SELECTION : sel;
        set({ project: p, past: cur ? [...get().past.slice(-HISTORY_LIMIT + 1), cur] : get().past, future: [], selection: keep, saveState: "saved" });
      };
      window.addEventListener("message", (ev: MessageEvent) => {
        const msg = ev.data as { type?: string; text?: string; name?: string } | undefined;
        if (!msg || typeof msg.text !== "string") return;
        if (msg.type === "load") applyText(msg.text, msg.name ?? "boxglow.json", get().source !== "vscode");
        else if (msg.type === "update") applyText(msg.text, msg.name ?? "boxglow.json", false);
      });
      vscodeApi.postMessage({ type: "ready" });
    }

  , importJSON: async (text) => {
      const p = fromJSON(text);
      await saveProject(p);
      get().openProjectObject(p, false);
      await get().refreshList();
      set({ toast: t("「{name}」を読み込みました", { name: p.name }) });
    }

  , openSample: () => {
      get().openProjectObject(buildSampleProject(), true); // サンプルも View から (Edit は上の帯で切り替える)
    }
  , openExample: () => {
      // ビルドに同梱した例 (3 階層の Logic DAW の計画)。記事の埋め込みと ?demo=daw で使う
      get().openProjectObject(fromJSON(exampleText), true);
    }

  , copyToMine: async () => {
      const { project } = get();
      if (!project) return;
      const p = structuredClone(project);
      p.id = crypto.randomUUID().slice(0, 10);
      p.name = t("{name} (複製)", { name: p.name });
      await saveProject(p);
      get().openProjectObject(p, false);
      await get().refreshList();
      set({ toast: t("自分のプロジェクトとして保存しました") });
    }

  , deleteProject: async (id) => {
      await deleteProject(id);
      if (get().project?.id === id) get().closeProject();
      await get().refreshList();
    }

  , closeProject: () => {
      stopWatching();
      set({ project: null, past: [], future: [], selection: NO_SELECTION, viewCollapsed: {}, viewScope: null, saveState: "none", ephemeral: false, source: "idb", fileName: null });
      rememberInUrl(null);
    }

  , setMode: (opts) => set({ ...opts })
  };
});

/**
 * 「+ ブロック」でタスクを置く階層: 選んでいる箱があればその中 (下の階層)、何も選んでいなければ最初のプロジェクトの箱
 * Input : project, selection
 * Output: 親ブロックの id
 */
export function parentForNewBlock(project: Project, selection: Selection, scope: string | null = null): string {
  if (selection.blockId && project.blocks[selection.blockId]) return selection.blockId;
  // 大項目のタブを開いているときは、何も選んでいなければその大項目の中に置く
  if (scope && project.blocks[scope]) return scope;
  return defaultTaskParent(project);
}

/**
 * View モードで畳んだ / 展開した状態を重ねたプロジェクトを返す (描画用)
 * Input : project = ファイルの内容, viewCollapsed = 画面だけの状態
 * Output: collapsed だけ上書きした複製 (上書きが無ければ project そのもの)
 */
export function withViewCollapsed(project: Project, viewCollapsed: Record<string, boolean>): Project {
  const ids = Object.keys(viewCollapsed).filter((id) => project.blocks[id] && project.blocks[id].collapsed !== viewCollapsed[id]);
  if (ids.length === 0) return project;
  const blocks = { ...project.blocks };
  for (const id of ids) blocks[id] = { ...blocks[id], collapsed: viewCollapsed[id] };
  return { ...project, blocks };
}

/** 描画用のプロジェクト (All では大項目を畳み、開いているタブの大項目だけ展開。View の畳みも重ねる。画面だけで、ファイルは変えない) を返すフック */
export function useShownProject(): Project | null {
  const project = useProjectStore((s) => s.project);
  const viewCollapsed = useProjectStore((s) => s.viewCollapsed);
  const viewScope = useProjectStore((s) => s.viewScope);
  return useMemo(() => {
    if (!project) return null;
    let shown = normalizeCollapsed(withViewCollapsed(project, viewCollapsed));
    if (viewScope && shown.blocks[viewScope]?.collapsed) {
      shown = { ...shown, blocks: { ...shown.blocks, [viewScope]: { ...shown.blocks[viewScope], collapsed: false } } };
    }
    // 箱の間隔は画面で保証する: ファイルの配置が詰まっていても (間隔を広げる前に保存した計画、外のツールが書いた位置など)、
    // 線の通路 (箱から 36px x 2) が無いと線が箱を貫くしかなくなる。表示の時点で重なり・間隔を解消しておく (ファイルは変えない。
    // 編集すれば apply が同じ解消を保存する)。畳んだ箱は畳んだ大きさで、開いた箱は開いた大きさで計算する
    // 索引は ports だけ (箱は押し出しで差し替わるので childrenOf の索引は使わない)
    const base = shown;
    return withIndex(base, () => resolveAllOverlaps(base, blockSize), { children: false });
  }, [project, viewCollapsed, viewScope]);
}
