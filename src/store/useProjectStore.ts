import type { PeerVersion } from "../model/version";
import { validateProjectText } from "../model/validate-file";
import type { ConflictChoices, MergeResult } from "../model/merge";
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
import { ensurePermission, readLocalFile } from "../lib/localfile";
import { mergeProjects } from "../model/merge";
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
  /** View モードで畳んだ / 展開したボックス (画面だけの状態。ファイルには書かない)。id -> collapsed */
  viewCollapsed: Record<string, boolean>;
  /** ボックスを畳む / 展開する。All で大項目なら、そのタブを開く。Edit なら共有の配置として保存、View なら画面だけ */
  toggleCollapsed: (blockId: string) => void;
  /** 開いているタブ (大項目のボックスの id)。null なら All (大項目の一覧)。画面だけの状態で、プロジェクトごとにブラウザに記憶 */
  viewScope: string | null;
  /** 表示範囲を切り替える (null = All)。範囲の外にあるボックスの選択は解除する */
  setViewScope: (blockId: string | null) => void;
  /** 今すぐ保存する (Save ボタン。自動保存を待たずに書く) */
  saveNow: () => void;
  /**
   * 手動の更新: つながっているファイルを、今すぐ読み直して画面に反映する (自動の更新を待たずに取り直す)。
   * ブラウザ内の計画 (つながっているファイルが無い) では、何もしない。未保存の編集があるときは、自動の更新と同じく、競合として両方を残す
   */
  reload: () => Promise<void>;
  /** 手動の更新の最中か (ボタンを押せなくする) */
  reloading: boolean;
  peerVersion: PeerVersion | null;
  saveError: string | null;
  /** VS Code の中で、保存できない理由 (拡張がファイルを直接読み書きできない窓など)。あれば閲覧専用にして、この文を帯に出す */
  readonlyReason: string | null;
  /** VS Code の中で、拡張からファイルの中身をまだ受け取れていないときの案内 (Home 画面に出す)。受け取れたら null */
  hostNotice: string | null;
  conflict: { text: string; revision: string; paths: string[] } | null;
  previewConflict: () => MergeResult | null;
  resolveConflict: (choice: "merge" | "remote", choices?: ConflictChoices, revision?: string) => boolean;

  embed: boolean;
  projects: ProjectMeta[];
  selection: Selection;
  /** 直前まで選んでいた線の id (ボックスをダブルクリックしてタブを開くとき、最初のクリックで外れた線の選択を戻すため) */
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
 * Output: 大項目のボックスの id (無い・消えていれば null = All)
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
let serveEvents: EventSource | null = null;
/** VS Code の webview の API (拡張の中だけで定義される)。postMessage で拡張とやり取りする */
type VsCodeApi = { postMessage: (msg: unknown) => void };
declare global { interface Window { acquireVsCodeApi?: () => VsCodeApi } }
let vscodeApi: VsCodeApi | null = null;

/** サーバの API の場所 (アプリは相対パスで配信されるので、ページの場所から解く) */
const serveApi = (path: string): string => new URL(path, document.baseURI).toString();
let baseText = "";
let serveRevision = "";
let vscodeVersion = 0;
let epoch = 0;
let inFlight = false;
let inFlightText = "";
let refreshExternal: (() => Promise<void>) | null = null;
/**
 * 手動の更新で呼ぶ「今すぐ読み直す」処理 (開き方ごとに差し替える。ブラウザ内の計画では null)。
 * Output: なし。読めなかったら例外 (理由を画面に出す)
 */
let reloadNow: (() => Promise<void>) | null = null;
/** VS Code の中: 読み直しを頼んだ後、拡張から中身が届くのを待っている処理 (届いたら呼ぶ) */
let vscodeReloadWaiter: (() => void) | null = null;
let messageHandler: ((ev: MessageEvent) => void) | null = null;
const pendingSaves = new Map<string, { resolve: (version: number) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
function saveToVsCode(text: string): Promise<number> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingSaves.delete(requestId); reject(new Error(t("保存の応答がありません。編集は画面に残っています。再試行してください。"))); }, 10000);
    pendingSaves.set(requestId, { resolve, reject, timer });
    vscodeApi!.postMessage({ type: "save", requestId, text, baseText, version: vscodeVersion });
  });
}
/** ファイルの監視間隔 (ms) */
const WATCH_INTERVAL = 1500;

export const useProjectStore = create<State>((set, get) => {
  const markConflict = (text: string, revision: string) => {
    const current = get().project;
    if (!current || text === baseText) return;
    const remote = fromJSON(text);
    const result = mergeProjects(baseText ? fromJSON(baseText) : null, current, remote);
    set({ conflict: { text, revision, paths: result.conflicts.map((c) => c.path) }, saveState: "unsaved", saveError: t("他の編集と競合しました。両方の変更を保持しているので、統合方法を選んでください。") });
  };
  const acceptRemote = (text: string, revision = "") => {
    const current = get().project;
    if (text === baseText || text === inFlightText) return;
    if (get().saveState !== "saved" && current) { markConflict(text, revision); return; }
    const next = fromJSON(text);
    baseText = text;
    if (get().source === "serve") serveRevision = revision;
    set({ project: next, past: current ? [...get().past.slice(-HISTORY_LIMIT + 1), current] : [], future: [], selection: get().selection.blockId && !next.blocks[get().selection.blockId!] ? NO_SELECTION : get().selection });
  };
  const persist = async () => {
    const initial = get();
    if (!initial.project || initial.ephemeral || initial.readonly || initial.conflict || inFlight) return;
    const generation = epoch, source = initial.source;
    inFlight = true;
    try {
      do {
        const project = get().project!;
        const text = toJSON(project) + "\n";
        inFlightText = text;
        set({ saveState: "saving", saveError: null });
        if (source === "serve") {
          const response = await fetch(serveApi("api/project"), { method: "PUT", headers: { "content-type": "application/json", "if-match": serveRevision }, body: text });
          if (generation !== epoch) return;
          if (response.status === 412) {
            const latest = await fetch(serveApi("api/project"), { cache: "no-store" });
            if (!latest.ok) throw new Error(t("最新のファイルを取得できません。接続を確認して保存を再試行してください。"));
            const remote = await latest.text();
            if (generation !== epoch) return;
            if (remote === text) serveRevision = latest.headers.get("etag") ?? ""; // 前の書き込みは成功していて、応答だけが届かなかった (ディスクは今の中身と同じ)
            else { markConflict(remote, latest.headers.get("etag") ?? ""); throw new Error(t("他の編集と競合しました。両方の変更を保持しているので、統合方法を選んでください。")); }
          }
          if (response.status === 423) throw new Error(t("別の保存処理が進行中です。編集は保持しています。少し待って保存を再試行してください。"));
          if (response.status === 400) throw new Error(t("計画の形式や参照に問題があり、保存できません。編集を JSON で退避して確認してください。"));
          if (response.status === 413) throw new Error(t("計画が保存可能なサイズ（5 MiB）を超えています。編集を JSON で退避してください。"));
          if (!response.ok && response.status !== 412) throw new Error(t("サーバに書けません ({status})", { status: response.status }));
          if (response.ok) serveRevision = response.headers.get("etag") ?? "";
        } else if (source === "vscode") {
          vscodeVersion = await saveToVsCode(text);
        } else if (source === "file") {
          throw new Error(t("共同編集は npx boxglow serve --open または VS Code 拡張で開いてください。"));
        } else { await saveProject(project); void get().refreshList(); }
        if (generation !== epoch) return;
        baseText = text;
        if (get().conflict) { set({ saveState: "unsaved" }); return; }
        // 保存中に次の編集が入っていたら「保存済み」にしない。新しい中身を続けて (1 つずつ順に) 保存する
        if (get().project === project) { set({ saveState: "saved", saveError: null }); break; }
      } while (generation === epoch && get().project);
    } catch (error) {
      if (generation === epoch) set({ saveState: "unsaved", saveError: error instanceof TypeError ? t("接続できません。編集は保持しています。サーバーを確認して保存を再試行してください。") : error instanceof Error ? error.message : String(error) });
    } finally {
      if (generation === epoch) { inFlight = false; inFlightText = ""; if (get().saveState === "saved") void refreshExternal?.(); }
    }
  };
  const scheduleSave = () => {
    const { project, ephemeral, readonly } = get();
    if (!project || ephemeral || readonly) return;
    set({ saveState: "unsaved" });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; void persist(); }, SAVE_DELAY);
  };
  const canLeave = () => !["unsaved", "saving"].includes(get().saveState) || confirm(t("未保存の編集があります。必要なら先に JSON を書き出してください。編集を破棄して移動しますか？"));
  const stopWatching = () => {
    epoch++; inFlight = false; inFlightText = ""; refreshExternal = null; reloadNow = null; vscodeReloadWaiter = null;
    if (saveTimer) clearTimeout(saveTimer); saveTimer = null;
    if (watchTimer) clearInterval(watchTimer); watchTimer = null; fileHandle = null;
    serveEvents?.close(); serveEvents = null;
    if (messageHandler) window.removeEventListener("message", messageHandler); messageHandler = null;
    for (const save of pendingSaves.values()) { clearTimeout(save.timer); save.reject(new Error("Project closed")); } // (計画を閉じた後なので、この失敗は画面には出ない) pendingSaves.clear();
    set({ conflict: null, saveError: null, peerVersion: null });
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
      // タブになるのは大項目だけ (中のボックスは入れ子で見せる)。大項目以外を指定されたら、そのボックスが属する大項目のタブにする
      const scope = blockId && project.blocks[blockId] ? majorOf(project, blockId) : null;
      try {
        if (scope) localStorage.setItem(`boxglow:scope:${project.id}`, scope);
        else localStorage.removeItem(`boxglow:scope:${project.id}`);
      } catch {
        /* 記憶できなくても動く */
      }
      // 範囲の外のボックスを選んだままだと、詳細パネルに見えない物が出て混乱するので外す (Summary などの選択は保つ)。
      // 線の選択は保つ: 線は境界を越えて別のタブへ続くので、選んだままタブを移って接続先を追えるようにする
      const keepSel = scope && selection.blockId && !isInScope(project, scope, selection.blockId) ? { ...selection, blockId: null } : selection;
      set({ viewScope: scope, selection: keepSel });
    }
  , saveNow: () => { if (saveTimer) clearTimeout(saveTimer); saveTimer = null; void persist(); }
  , reloading: false
  , reload: async () => {
      // つながっているファイルが無い (ブラウザ内の計画)・すでに読み直している最中なら、何もしない
      if (!reloadNow || get().reloading) return;
      const before = get().project;
      set({ reloading: true });
      try {
        await reloadNow();
        // 競合になったときは、競合の帯が出るので、ここでは知らせない。それ以外は、変わったかどうかを短く知らせる
        if (!get().conflict) set({ toast: get().project === before ? t("最新です (ファイルに変更はありません)") : t("最新の内容を読み込みました") });
      } catch (e) {
        set({ toast: t("最新の内容を読み込めませんでした: {error}", { error: e instanceof Error ? e.message : String(e) }) });
      } finally {
        set({ reloading: false });
      }
    }
  , peerVersion: null
  , readonlyReason: null
  , hostNotice: null
  , saveError: null
  , conflict: null
  , previewConflict: () => {
      const { conflict, project } = get();
      return conflict && project ? mergeProjects(baseText ? fromJSON(baseText) : null, project, fromJSON(conflict.text)) : null;
    }
  , resolveConflict: (choice, choices = {}, revision) => {
      const conflict = get().conflict, current = get().project;
      if (!conflict || !current || inFlight || (revision !== undefined && revision !== conflict.revision)) return false;
      const remote = fromJSON(conflict.text);
      const result = mergeProjects(baseText ? fromJSON(baseText) : null, current, remote, choices);
      if (choice === "merge" && result.conflicts.some((item) => !item.automatic && !choices[item.id])) return false;
      const next = choice === "remote" ? remote : result.project;
      try { validateProjectText(toJSON(next)); }
      catch (e) { set({ saveError: t("この組み合わせでは参照がつながりません。選択を見直すか、手元を退避して最新のファイルを開いてください。") + " " + String(e) }); return false; }
      if (choice === "merge") for (const item of result.conflicts) next.log.push({ id: crypto.randomUUID(), at: new Date().toISOString(), actor: "human", kind: "note", message: t("競合を統合: {path} (採用: {selected} / 手元: {ours} / 相手: {theirs})", { path: item.path, selected: item.automatic ? "automatic" : choices[item.id], ours: JSON.stringify(item.ours), theirs: JSON.stringify(item.theirs) }) });
      baseText = conflict.text;
      if (get().source === "serve") serveRevision = conflict.revision;
      if (get().source === "vscode") vscodeVersion = Number(conflict.revision);
      set({ project: next, conflict: null, saveError: null, saveState: "saved", past: [...get().past.slice(-HISTORY_LIMIT + 1), current], future: [] });
      if (choice === "merge") scheduleSave();
      return true;
    }
  , toggleCollapsed: (blockId) => {
      const { project, editMode, readonly, viewCollapsed, viewScope } = get();
      if (!project || !project.blocks[blockId]) return;
      // All の図では大項目は展開しない (中はタブで見る)。畳む / 展開の操作はその大項目のタブを開く操作にする
      if (viewScope === null && majorOf(project, blockId) === blockId) {
        // ダブルクリックの 1 回目でボックスが選ばれ、直前まで選んでいた線の選択が外れている。
        // その線がこのタブへ続いているなら、線を選んだままタブを開く (線を選んで接続先のボックスをダブルクリックする流れ)
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
      // ボックスが見える画面に切り替えてから寄せる: 親のボックスを開く (親がプロジェクトのボックスや最上位なら All)。
      // scope: false なら画面は変えない (キャンバスでクリックして選んだときは、クリック側がボックスを開くのでここでは切り替えない)
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
      // 大項目は畳んだ状態でそろえる (All は大項目までしか出さない)。ボックスは重ねない: 変更のたびに同じ階層の重なりを押し出す (ドラッグ中は呼び出し側が history=false で呼ぶので除く)
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
      if (get().readonly) return;
      const { project, past, future } = get();
      if (!project || past.length === 0) return;
      const prev = past[past.length - 1];
      set({ project: prev, past: past.slice(0, -1), future: [project, ...future] });
      scheduleSave();
    }

  , redo: () => {
      if (get().readonly) return;
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
      // 「線を選んでいた → ボックスを選んだ」の直後だけ、その線を覚える (同じボックスを続けて選ぶダブルクリックの 2 回目では保つ)。
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
      if (!canLeave()) return;
      stopWatching();
      baseText = toJSON(p) + "\n";
      set({ readonlyReason: null, project: p, ephemeral, source: "idb", readonly: (new URLSearchParams(location.search).get("readonly") === "1" || new URLSearchParams(location.search).get("view") === "article"), fileName: null, past: [], future: [], selection: NO_SELECTION, viewCollapsed: {}, viewScope: loadScope(p), saveState: ephemeral ? "none" : "saved", meId: loadMe(p), editMode: loadEditMode(p) });
      rememberInUrl(ephemeral ? null : p.id);
    }

  , openLocalFile: async (handle) => {
      if (!canLeave()) return false;
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
      baseText = text;
      set({ project: p, ephemeral: false, source: "file", readonly: true, fileName: handle.name, past: [], future: [], selection: NO_SELECTION, viewCollapsed: {}, viewScope: loadScope(p), saveState: "saved", meId: loadMe(p), editMode: loadEditMode(p) });
      rememberInUrl(null);
      const generation = epoch;
      watchTimer = setInterval(async () => {
        if (!fileHandle) return;
        try { const f = await fileHandle.getFile(); if (f.lastModified === fileLastModified) return; const text = await f.text(); if (generation !== epoch) return; acceptRemote(text); fileLastModified = f.lastModified; } catch { /* Try on the next poll. */ }
      }, WATCH_INTERVAL);
      // 手動の更新: 更新時刻に関係なく、今のファイルを読み直す
      reloadNow = async () => {
        if (!fileHandle) return;
        const f = await fileHandle.getFile();
        const text = await f.text();
        if (generation !== epoch) return;
        acceptRemote(text); fileLastModified = f.lastModified;
      };
      return true;
    }

  , openFromServer: async () => {
      if (!canLeave()) return false;
      let revision = "";
      let peerVersion: PeerVersion = { app: null, protocol: null };
      let text: string;
      let name = "boxglow.json";
      try {
        const r = await fetch(serveApi("api/project"), { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        text = await r.text();
        revision = r.headers.get("etag") ?? "";
        peerVersion = { app: r.headers.get("x-boxglow-version"), protocol: r.headers.has("x-boxglow-protocol") ? Number(r.headers.get("x-boxglow-protocol")) : null };
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
      baseText = text; serveRevision = revision;
      set({ project: p, ephemeral: false, source: "serve", peerVersion, readonly: (new URLSearchParams(location.search).get("readonly") === "1" || new URLSearchParams(location.search).get("view") === "article"), fileName: name, past: [], future: [], selection: NO_SELECTION, viewCollapsed: {}, viewScope: loadScope(p), saveState: "saved", meId: loadMe(p), editMode: loadEditMode(p) });
      rememberInUrl(null);
      const generation = epoch;
      let sequence = 0;
      const reload = async () => {
        const read = ++sequence;
        try {
          const response = await fetch(serveApi("api/project"), { cache: "no-store" });
          if (!response.ok) return;
          const text = await response.text();
          if (generation !== epoch || read !== sequence) return;
          set({ peerVersion: { app: response.headers.get("x-boxglow-version"), protocol: response.headers.has("x-boxglow-protocol") ? Number(response.headers.get("x-boxglow-protocol")) : null } });
          acceptRemote(text, response.headers.get("etag") ?? "");
        } catch { /* Reconnect and the next event retry. */ }
      };
      refreshExternal = reload;
      // 手動の更新: 自動の更新と同じ読み直しだが、読めなかったときは理由を伝える (自動の更新は、黙って次の通知を待つ)
      reloadNow = async () => {
        const read = ++sequence;
        const response = await fetch(serveApi("api/project"), { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (generation !== epoch || read !== sequence) return;
        acceptRemote(text, response.headers.get("etag") ?? "");
      };
      serveEvents = new EventSource(serveApi("api/events"));
      serveEvents.addEventListener("change", () => { void reload(); });
      serveEvents.addEventListener("hello", () => { void reload(); });
      return true;
    }

  , openFromVsCode: () => {
      if (!window.acquireVsCodeApi) return;
      vscodeApi = vscodeApi ?? window.acquireVsCodeApi();
      stopWatching();
      const generation = epoch;
      messageHandler = (ev: MessageEvent) => {
        if (generation !== epoch) return;
        if (!ev.data || typeof ev.data !== "object") return;
        // 拡張から届く中身の改行を LF にそろえる (CRLF のファイルでも、画面が保存した LF の中身と同じものとして比べられるようにする。
        // そろえないと、自分の保存の反映を「外からの変更」とみなして、読み直しや競合が起きる)
        const msg = typeof ev.data.text === "string" ? { ...ev.data, text: ev.data.text.replace(/\r\n/g, "\n") } : ev.data;
        if (msg.type === "saved" || msg.type === "save-error") {
          const pending = pendingSaves.get(msg.requestId);
          if (!pending) return;
          clearTimeout(pending.timer); pendingSaves.delete(msg.requestId);
          if (msg.type === "saved") pending.resolve(msg.version);
          else {
            if (msg.conflict && typeof msg.text === "string") { markConflict(msg.text, String(msg.version)); if (msg.text === baseText) vscodeVersion = msg.version; }
            pending.reject(new Error(msg.error || t("保存に失敗しました")));
          }
          return;
        }
        if ((msg.type !== "load" && msg.type !== "update") || typeof msg.text !== "string") return;
        // 手動の更新で頼んだ読み直しの応答が届いた (この後の処理で、中身が画面に反映される)
        const waiter = vscodeReloadWaiter; vscodeReloadWaiter = null;
        queueMicrotask(() => waiter?.());
        if (typeof msg.version === "number" && msg.version < vscodeVersion) return;
        try {
          set({ peerVersion: { app: typeof msg.appVersion === "string" ? msg.appVersion : null, protocol: typeof msg.protocol === "number" ? msg.protocol : null, extension: typeof msg.extensionVersion === "string" ? msg.extensionVersion : undefined } });
          // 拡張がファイルを直接読み書きできない窓では、閲覧専用にする (理由は帯に出す)。読み書きできるようになれば戻る
          const readonlyReason = typeof msg.readonlyReason === "string" ? msg.readonlyReason : null;
          set({ readonlyReason, readonly: readonlyReason !== null, hostNotice: null });
          if (get().source !== "vscode") {
            const p = fromJSON(msg.text); baseText = msg.text; vscodeVersion = msg.version ?? 0;
            set({ project: p, ephemeral: false, source: "vscode", fileName: msg.name ?? "boxglow.json", past: [], future: [], selection: NO_SELECTION, viewCollapsed: {}, viewScope: loadScope(p), saveState: "saved", meId: loadMe(p), editMode: loadEditMode(p) });
          } else { acceptRemote(msg.text, String(msg.version)); if (get().saveState === "saved") vscodeVersion = msg.version ?? vscodeVersion; }
        } catch (e) { set({ saveError: String(e) }); }
      };
      window.addEventListener("message", messageHandler);
      // 手動の更新: 拡張に、今のファイルの中身を送り直してもらう (最初の読み込みと同じ合図。拡張は、開いている文書の今の中身を返す)。
      // 応答が届くまで待つ (届かなければ、3 秒で失敗として伝える)
      reloadNow = () => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { vscodeReloadWaiter = null; reject(new Error(t("VS Code から応答がありません"))); }, 3000);
        vscodeReloadWaiter = () => { clearTimeout(timer); resolve(); };
        vscodeApi!.postMessage({ type: "ready" });
      });
      vscodeApi.postMessage({ type: "ready" });
      // 拡張から中身が届かないまま時間が経ったら、その旨を Home 画面に出す
      // (黙って空の画面にすると、一覧にある「VS Code 内のコピー」をファイルだと思って開いてしまう)
      set({ hostNotice: null });
      setTimeout(() => {
        if (generation === epoch && get().source !== "vscode") set({ hostNotice: t("VS Code からファイルの中身を受け取れていません。下の一覧の計画は VS Code 内のコピーで、開いても boxglow.json には保存されません。拡張を最新にして窓を読み込み直すか、WSL のファイルは WSL の窓で開いてください") });
      }, 4000);
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
      if (!canLeave()) return;
      stopWatching();
      set({ project: null, past: [], future: [], selection: NO_SELECTION, viewCollapsed: {}, viewScope: null, saveState: "none", ephemeral: false, source: "idb", fileName: null });
      rememberInUrl(null);
    }

  , setMode: (opts) => set({ ...opts })
  };
});

/**
 * 「+ ブロック」でタスクを置く階層: 選んでいるボックスがあればその中 (下の階層)、何も選んでいなければ最初のプロジェクトのボックス
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
    // ボックスの間隔は画面で保証する: ファイルの配置が詰まっていても (間隔を広げる前に保存した計画、外のツールが書いた位置など)、
    // 線の通路 (ボックスから 36px x 2) が無いと線がボックスを貫くしかなくなる。表示の時点で重なり・間隔を解消しておく (ファイルは変えない。
    // 編集すれば apply が同じ解消を保存する)。畳んだボックスは畳んだ大きさで、開いたボックスは開いた大きさで計算する
    // 索引は ports だけ (ボックスは押し出しで差し替わるので childrenOf の索引は使わない)
    const base = shown;
    return withIndex(base, () => resolveAllOverlaps(base, blockSize), { children: false });
  }, [project, viewCollapsed, viewScope]);
}
