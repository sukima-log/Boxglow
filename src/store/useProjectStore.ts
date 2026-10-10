import { preserveClaimHistory, onlyClaimsChanged } from "../model/claims";
import { externalHistoryPatch, combineHistoryPatch, applyHistoryPatch, historyPatchMasksChanges, type HistoryPatch } from "./history-rebase";
import { groupConflicts, resolveGroupChoices, type ConflictReview, type ConflictResolution } from "../model/conflict-groups";
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
import { readingLayout } from "../model/readingLayout";
import { create } from "zustand";
import { createProject, defaultTaskParent, fromJSON, isInScope, majorOf, normalizeCollapsed, normalizeInputNames, resolveChangedOverlaps, resolveAllOverlaps, scopeFor, toJSON, wireNetTabs, withIndex } from "../model/graph";
export { isInScope, majorBlocks } from "../model/graph";
import { blockSize } from "../model/size";
import { ensurePermission, readLocalFile } from "../lib/localfile";
import { mergeProjects } from "../model/merge";
import { applyRestore, editorCaughtUp, prepareRestore, readRecovery, type Recovery, type RestoreConflict, type RestorePicks, type RestoreStep } from "../sync/recovery";
import { buildSampleProject } from "../model/sample";
import exampleText from "../../examples/logic-daw/boxglow.json?raw";
import type { Project } from "../model/types";
import type { AssigneeTarget } from "../model/assignments";
import type { HostAction, SyncStatus } from "../sync/status";
import { deleteProject, listProjects, loadProject, saveProject, type ProjectMeta } from "../lib/storage";
import { t, useLang } from "../i18n"; // 画面に出す文言 (toast など) の言語切替

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
  /** 右パネルで開いてほしいタブ (図の札を押したときなど)。パネルが読んだら消す */
  panelTab?: "status" | "io" | "owner" | "dates" | "more";
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
  /** 縦表示の並行タスクを複数行に折り返すか。画面専用で、既定は無効 */
  verticalWrap: boolean;
  setVerticalWrap: (wrap: boolean) => void;
  /** View の流れる方向。Edit の保存座標やポート方向には反映しない */
  flowDirection: "horizontal" | "vertical";
  setFlowDirection: (direction: "horizontal" | "vertical") => void;
  /** View を依存関係に沿う工程順で表示するか。保存した位置は変えない */
  readingView: boolean;
  setReadingView: (enabled: boolean) => void;
  /** ボックスを畳む / 展開する。Top で大項目なら、そのタブを開く。Edit なら共有の配置として保存、View なら画面だけ */
  toggleCollapsed: (blockId: string) => void;
  /** 開いているタブ (大項目のボックスの id)。null なら Top (大項目の一覧)。画面だけの状態で、プロジェクトごとにブラウザに記憶 */
  viewScope: string | null;
  /** 表示範囲を切り替える (null = Top)。範囲の外にあるボックスの選択は解除する */
  setViewScope: (blockId: string | null) => void;
  /** 今すぐ保存する (Save ボタン。自動保存を待たずに書く) */
  saveNow: () => void;
  /**
   * 手動の更新: つながっているファイルを、今すぐ読み直して画面に反映する (自動の更新を待たずに取り直す)。
   * ブラウザ内の計画は、このブラウザの保存先から読み直す (サンプルは、読み直す先が無いので変わらない)。
   * 未保存の編集があるときは、自動の更新と同じく、競合として両方を残す
   */
  reload: () => Promise<void>;
  /** 手動の更新の最中か (ボタンを押せなくする) */
  reloading: boolean;
  /**
   * 画面からの同期の状態 (boxglow serve --sync / VS Code の拡張が裏方から流す)。無ければ、同期の表示は出さない。
   * 画面は表示と操作の送信だけを行う (判断・通信・資格情報は裏方)
   */
  syncStatus: SyncStatus | null;
  /**
   * serve との接続が切れている (通知の接続が切れた・保存が通信で失敗した)。この間の syncStatus は、最後に受け取った古い状態なので、
   * 同期の印は「接続なし」にする (古い「同期済み」を出し続けない)。つながり直すと false に戻り、状態を取り直す
   */
  syncLost: boolean;
  /** 同期の操作を裏方へ送る (serve は POST /api/sync、VS Code は postMessage)。応答の状態で syncStatus を更新する */
  syncAct: (action: HostAction) => Promise<void>;
  /** 裏方から届いた状態を受ける (古いセッションや古い通し番号の状態で、新しい状態を上書きしない) */
  acceptSyncStatus: (status: SyncStatus) => void;
  /**
   * VS Code のエディタが、ディスクの最新 (同期の受け取り) に追い付いていない (設計書 4 章 / R36-05)。
   * この間は、受け取った中身は確認用にだけ持ち、保存は通らない。画面にだけある編集は、退避してから開き直す (R37-02)
   */
  editorBehind: { text: string } | null;
  /**
   * 退避済み: 退避した画面の中身のハッシュ・エディタの版・場所。今の画面の中身がこのハッシュと違う、またはエディタの版が進んだら、まだ退避していない編集がある
   */
  evacuated: { hash: string; path: string; editorVersion: number | null } | null;
  /**
   * 退避した編集を、今開いている最新の中身に取り込む (R39-06)。退避したときの基準を共通の元にして、退避した画面の編集とエディタ側の編集を、
   * 今の中身 (保存の基準) に統合する。結果は未保存の編集として持ち、保存の完了の通知が来るまで「保存済み」にしない
   * Output: 取り込みの結果 (統合した数と、両側で違う値になっていた項目)
   */
  restoreEvacuated: (recovery: unknown) => { applied: boolean; conflicts: number } | { error: string };
  /** 取り込みの途中 (競合があり、利用者の選択を待っている)。選ぶまで画面にも保存にも反映しない */
  restorePending: { recovery: Recovery; step: RestoreStep; conflicts: RestoreConflict[]; basis: string } | null;
  /** 自動保存を一時停止している (退避した編集を取り込んだ後。Save を押すか、開き直すまで。R41-03 / レビュー 42 の回答 1) */
  saveHeld: boolean;
  /**
   * 退避した編集の取り込みの結果の案内 (編集画面の帯に出す。保存の失敗とは別の種類。R44-01 / R44-02)
   *   info = 取り込めた・次の段の確認へ・段をやめた / partial = 一部の段だけ取り込めた
   */
  restoreNotice: { kind: "info" | "partial"; text: string } | null;
  /** 取り込みの案内を閉じる */
  dismissRestoreNotice: () => void;
  /** 競合ごとの選択で取り込む (取り消しの履歴に、取り込む前の画面を積む)。Output: エラーの文 (成功なら null) */
  applyRestorePicks: (picks: RestorePicks) => string | null;
  /** 取り込みをやめる (画面は元のまま) */
  cancelRestore: () => void;
  /** 画面の今の中身を、拡張の保存ダイアログで別のファイルに退避する。書けたことを確かめてから「退避済み」にする */
  evacuate: () => Promise<boolean>;
  /**
   * 保存の衝突のとき、VS Code で使う「手元を退避して最新のファイルを開く」:
   * 画面とエディタの未保存の編集を退避し、退避できて、その後に画面も衝突も変わっていないときだけ、画面を最新の中身にする。
   * Input : なし (今の衝突と画面の中身を使う)
   * Output: なし。結果は restoreNotice の案内に出す (退避しなかった・退避の後に変わったときは、画面を変えない。R49-04)。
   *         エディタに未保存の編集があるときの衝突 (editorDirty) では何もしない (退避と開き直しへ案内する。R49-01 / R49-02)
   */
  evacuateAndTakeLatest: () => Promise<void>;
  /** 退避した編集を読み込んで、衝突として見比べる (拡張のファイル選択) */
  loadEvacuated: () => void;
  /** 今の中身のハッシュ (退避済みかの判定に使う) */
  contentHash: () => Promise<string>;
  peerVersion: PeerVersion | null;
  saveError: string | null;
  /** VS Code の中で、保存できない理由 (拡張がファイルを直接読み書きできない窓など)。あれば閲覧専用にして、この文を帯に出す */
  readonlyReason: string | null;
  /** VS Code の中で、拡張からファイルの中身をまだ受け取れていないときの案内 (Home 画面に出す)。受け取れたら null */
  hostNotice: string | null;
  /**
   * VS Code の中で、まだ計画を表示できていないときの、ファイルの状態 (Home の画面が、これに合わせた案内を出す)。計画を表示できたら null
   *   waiting = 拡張からの中身を待っている, empty = ファイルが空 (名前を付けて、このファイルに計画を作れる),
   *   invalid = 中身はあるが、計画として読めない (error = 理由), timeout = 拡張から中身が届かない
   */
  vscodeFile: { state: "waiting" | "empty" | "invalid" | "timeout"; name: string; error?: string } | null;
  /** VS Code の中: 空のファイルに、名前を付けて計画を作る (作った計画は、そのファイルに保存される) */
  createInVsCode: (name: string) => void;
  /** 保存の衝突 (editorDirty = VS Code のエディタに未保存の編集があるときに受け取った。画面の基準がエディタの中身まで進んでいるので、画面では統合しない。R49-02) */
  conflict: { text: string; revision: string; paths: string[]; editorDirty?: boolean } | null;
  previewConflict: () => MergeResult | null;
  /** 共通比較と選択。tokenは手元・相手・基準の組が変わるたびに失効する。 */
  previewConflictReview: () => ConflictReview | null;
  resolveConflictGroups: (request: ConflictResolution) => boolean;
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
  /**
   * 担当の一覧 (表) を図の代わりに出しているか。値は最初に出す対象 (メンバー / 未担当)。null なら図を出す。
   * 画面だけの状態で、ファイルには書かない (開き直すと図に戻る)
   */
  taskTable: AssigneeTarget | null;
  setTaskTable: (target: AssigneeTarget | null) => void;
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
  /** 右パネルのタブの要求を消す (パネルが読んだ後) */
  clearPanelTab: () => void;
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
 * Output: 大項目のボックスの id (無い・消えていれば null = Top)
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
/** 退避の応答を待つ (requestId → 受け取る関数) */
const evacuateWaiters = new Map<string, (result: { hash: string; path: string; editorVersion: number | null } | null, detail: string) => void>();
/** 文字列の SHA-256 (16 進) */
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
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
/**
 * 保存を止めておく (退避した編集を取り込んだ後、利用者が明示的に Save を押すまで、何も送らない。R41-03)。
 * 予約した保存は取り消し、進行中の保存は、その 1 回が終わったら続きを送らない。通常の編集の予約も、この間は作らない (Save で全部まとめて送る)
 */
let holdSave = false;
let inFlight = false;
let refreshExternal: (() => Promise<void>) | null = null;
/**
 * 手動の更新で呼ぶ「今すぐ読み直す」処理 (開き方ごとに差し替える。計画を開いていないときは null)。
 * Output: なし。読めなかったら例外 (理由を画面に出す)
 */
let reloadNow: (() => Promise<void>) | null = null;
/** VS Code の中: 読み直しを頼んだ後、拡張から中身が届くのを待っている処理 (届いたら呼ぶ) */
let vscodeReloadWaiter: (() => void) | null = null;
/** VS Code の中: 拡張から届いた「空のファイル」の中身と版 (名前を付けて計画を作るときの、保存の基準にする) */
let vscodeEmpty: { text: string; version: number; name: string } | null = null;
let messageHandler: ((ev: MessageEvent) => void) | null = null;
const pendingSaves = new Map<string, { base: string; resolve: (version: number) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
function saveToVsCode(text: string): Promise<number> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingSaves.delete(requestId); reject(new Error(t("保存の応答がありません。編集は画面に残っています。再試行してください。"))); }, 10000);
    pendingSaves.set(requestId, { base: baseText, resolve, reject, timer });
    vscodeApi!.postMessage({ type: "save", requestId, text, baseText, version: vscodeVersion });
  });
}
/** ファイルの監視間隔 (ms) */
const WATCH_INTERVAL = 1500;

/** CASの失敗を安全に自動統合できた場合だけ、同じ保存ループを最新の版でやり直す。 */
class AutoMergeRetry extends Error {}

export const useProjectStore = create<State>((set, get) => {
  let mergeSerial = 0;
  let mergedNotice = false;
  // 保存の受理前後が未確定の通知は保留する。受理済みなら送った本文が共通の基準になる。
  let deferredRemote: { text: string; revision: string } | null = null;
  // 同じ予約を持つ履歴は新しい差分も共有する。予約は項目ごとの最新値だけで、全文や更新列は残さない。
  const historyRebases = new WeakMap<Project, HistoryPatch>();
  const rebaseHistories = (past: Project[], future: Project[], base: Project | null, remote: Project) => {
    const delta = externalHistoryPatch(base, remote);
    const combined = new Map<HistoryPatch | undefined, HistoryPatch>();
    const rebase = (history: Project[]) => history.map(snapshot => {
      const old = historyRebases.get(snapshot);
      let patch = combined.get(old);
      if (!patch) { patch = combineHistoryPatch(old, delta); combined.set(old, patch); }
      const copy = { ...snapshot }; historyRebases.set(copy, patch); return copy;
    });
    return { past: rebase(past), future: rebase(future) };
  };
  const materializeHistory = (snapshot: Project): Project | null => {
    const patch = historyRebases.get(snapshot);
    return patch ? applyHistoryPatch(snapshot, patch) : snapshot;
  };
  const historyNotice = (snapshot: Project): string | null => {
    const patch = historyRebases.get(snapshot);
    return patch && historyPatchMasksChanges(snapshot, patch)
      ? t("一部は相手の変更と重なるため戻せませんでした。相手の変更は保持しています。") : null;
  };
  let reviewBasis: { project: Project; conflict: State["conflict"]; base: string; token: string } | null = null;
  const markConflict = (text: string, revision: string, editorDirty = false, allowAuto = true) => {
    const current = get().project;
    if (!current || (text === baseText && !editorDirty)) return false;
    // 読めない最新も衝突として保持する。例外で保存Promiseを宙に浮かせない。
    let remote: Project, base: Project | null;
    let result: ReturnType<typeof mergeProjects>;
    let legacyBase = false;
    let sameLegacyPlan = false;
    try {
      remote = validateProjectText(text);
      base = baseText ? fromJSON(baseText) : null;
      // 古い本文にIDが無ければ、読み込みごとに補われる仮IDを比較しない。
      const rawBase = baseText ? JSON.parse(baseText) : null;
      legacyBase = !!rawBase && !rawBase.id;
      // 仮IDしかない旧形式は、本文の作成日時が一致する場合だけ同じ計画として扱う。
      sameLegacyPlan = legacyBase && typeof rawBase.createdAt === "string" && !!rawBase.createdAt
        && rawBase.createdAt === JSON.parse(text).createdAt;
      result = mergeProjects(base, current, remote, {}, new Date().toISOString());
      // 最初に外部が保存したIDを採用し、次の更新で別計画と誤判定しない。
      if (sameLegacyPlan && JSON.parse(text).id) result.project = { ...result.project, id: remote.id };
    } catch {
      mergedNotice = false;
      set({ conflict: { text, revision, paths: [], ...(editorDirty ? { editorDirty: true } : {}) }, saveState: "unsaved",
        saveError: t("受け取った計画の形式や参照を確認できません。編集は保持しています。退避してファイルを確認してください。") });
      return false;
    }
    // 入力: 外部の最新JSONと版。出力: 自動統合した場合だけtrue。
    // R49: エディタ側の未保存編集・追い付き待ち・手動確認待ちには自動保存を適用しない。
    const state = get();
    if ((sameLegacyPlan || (!legacyBase && remote.id === current.id && (!base || base.id === current.id))) && allowAuto && !editorDirty && !state.conflict?.editorDirty && !state.editorBehind && !holdSave && !state.readonly
      && (state.source === "serve" || state.source === "vscode")
      && !result.conflicts.some(c => !c.automatic)) {
      try {
        validateProjectText(toJSON(result.project));
        const { past, future } = rebaseHistories(state.past, state.future, base, remote);
        baseText = text;
        if (state.source === "serve") serveRevision = revision;
        else vscodeVersion = Number(revision);
        mergeSerial++;
        mergedNotice = mergedNotice || !onlyClaimsChanged(base,remote);
        set({ project: result.project, conflict: null, saveError: null, saveState: "unsaved",
          past, future });
        scheduleSave();
        return true;
      } catch { /* 競合ゼロでも循環参照などが生まれる。比較の案内を残し、保存は進めない。 */ }
    }
    mergedNotice = false;
    // (エディタに未保存の編集があるときは、統合ではなく退避と開き直しを案内する。R49-02)
    set({ conflict: { text, revision, paths: result.conflicts.map((c) => c.path), ...(editorDirty ? { editorDirty: true } : {}) }, saveState: "unsaved"
    , saveError: editorDirty
        ? t("同期で新しい中身を受け取りましたが、エディタに未保存の編集があるため、ここでは統合できません。手元の編集を退避してから、このファイルのタブを全部閉じて (保存しない) 開き直し、⋯ メニューの「退避した編集を読み込む」で取り込んでください。")
        : t("他の編集と競合しました。両方の変更を保持しているので、統合方法を選んでください。") });
    return false;
  };
  const acceptRemote = (text: string, revision = "") => {
    const current = get().project;
    if (inFlight) { deferredRemote = { text, revision }; return; }
    if (text === baseText) return;
    if (get().saveState !== "saved" && current) { markConflict(text, revision); return; }
    const next = fromJSON(text);
    const base = baseText ? fromJSON(baseText) : null;
    const { past, future } = rebaseHistories(get().past, get().future, base, next);
    baseText = text;
    if (get().source === "serve") serveRevision = revision;
    set({ project: next, past, future, selection: get().selection.blockId && !next.blocks[get().selection.blockId!] ? NO_SELECTION : get().selection });
  };
  const persist = async (explicit = false) => {
    // (止めている間は、明示的な Save だけが送る)
    if (holdSave && !explicit) return;
    const initial = get();
    if (!initial.project || initial.ephemeral || initial.readonly || initial.conflict || inFlight) return;
    const generation = epoch, source = initial.source;
    inFlight = true;
    let attempts = 0;
    let writes = 0;
    // この保存ループ内で受理済みの本文。遅れて届いた自己通知は統合しない。終了後は最新を再取得する。
    const written = new Set<string>(); // 全文ではなくSHA-256だけを保持する。
    try {
      do {
        if (get().conflict) { set({ saveState: "unsaved" }); return; }
        // 相手が連続で変わるときは無制限に送り続けない。中身は画面に残して再試行を案内する。
        if (attempts >= 8) throw new Error(t("変更が続いているため保存を待っています。編集は保持しています。保存を再試行してください。"));
        if (writes++ > 0 && holdSave) { set({ saveState: "unsaved" }); return; }
        const serial = mergeSerial;
        const project = get().project!;
        const text = toJSON(project) + "\n";
        set({ saveState: "saving", saveError: null });
        if (source === "serve") {
          const response = await fetch(serveApi("api/project"), { method: "PUT", headers: { "content-type": "application/json", "if-match": serveRevision }, body: text });
          if (generation !== epoch) return;
          if (response.status === 412) {
            attempts++;
            deferredRemote = null; // この後のGETで最新を取り直す。通知だけでは基準を進めない。
            const latest = await fetch(serveApi("api/project"), { cache: "no-store" });
            if (!latest.ok) throw new Error(t("最新のファイルを取得できません。接続を確認して保存を再試行してください。"));
            const remote = await latest.text();
            if (generation !== epoch) return;
            deferredRemote = null;
            if (remote === text) serveRevision = latest.headers.get("etag") ?? ""; // 前の書き込みは成功していて、応答だけが届かなかった (ディスクは今の中身と同じ)
            else {
              // SSEで先にこの版へ統合済みなら、412の読み直しを新しい競合として扱わず最新CASで続ける。
              if (remote === baseText && serial !== mergeSerial && !get().conflict) {
                serveRevision = latest.headers.get("etag") ?? "";
                continue;
              }
              if (markConflict(remote, latest.headers.get("etag") ?? "")) continue;
              throw new Error(t("他の編集と競合しました。両方の変更を保持しているので、統合方法を選んでください。"));
            }
          }
          if (response.status === 423) throw new Error(t("別の保存処理が進行中です。編集は保持しています。少し待って保存を再試行してください。"));
          if (response.status === 400) throw new Error(t("計画の形式や参照に問題があり、保存できません。編集を JSON で退避して確認してください。"));
          if (response.status === 413) throw new Error(t("計画が保存可能なサイズ（5 MiB）を超えています。編集を JSON で退避してください。"));
          if (!response.ok && response.status !== 412) throw new Error(t("サーバに書けません ({status})", { status: response.status }));
          if (response.ok && serial === mergeSerial) serveRevision = response.headers.get("etag") ?? "";
        } else if (source === "vscode") {
          // エディタがディスクの最新に追い付いていない間は保存しない (古い中身の上に書かない。退避して開き直す)
          if (get().editorBehind) throw new Error(t("VS Code のエディタが、同期で受け取った最新の中身をまだ読み込んでいません。編集を退避してから、ファイルを閉じて開き直してください"));
          try {
            const savedVersion = await saveToVsCode(text);
            if (serial === mergeSerial) vscodeVersion = savedVersion;
          } catch (error) {
            if (error instanceof AutoMergeRetry && generation === epoch) { attempts++; continue; }
            throw error;
          }
        } else if (source === "file") {
          throw new Error(t("共同編集は npx boxglow serve --open または VS Code 拡張で開いてください。"));
        } else { await saveProject(project); void get().refreshList(); }
        if (generation !== epoch) return;
        // 保存応答を待つ間に届いた新しい版を、古い保存の応答で巻き戻さない。
        if (serial !== mergeSerial) continue;
        written.add(await sha256(text));
        if (generation !== epoch) return;
        baseText = text;
        // 成功した要求の本文を基準にしてから保留通知を統合する。元に戻した変更も失わない。
        let received = deferredRemote as { text: string; revision: string } | null;
        let retryMerged = false;
        while (received) {
          deferredRemote = null;
          const ownEcho = written.has(await sha256(received.text));
          if (generation !== epoch) return;
          // ハッシュの待機中にも通知は届く。古い通知の判定で最新を捨てず、最後の本文を確かめる。
          if (deferredRemote) {
            if (++attempts >= 8) throw new Error(t("変更が続いているため保存を待っています。編集は保持しています。保存を再試行してください。"));
            received = deferredRemote;
            continue;
          }
          if (!ownEcho) {
            attempts++;
            retryMerged = markConflict(received.text, received.revision);
          }
          break;
        }
        if (retryMerged) continue;
        if (get().conflict) { set({ saveState: "unsaved" }); return; }
        // 保存中に次の編集が入っていたら「保存済み」にしない。新しい中身を続けて (1 つずつ順に) 保存する
        if (get().project === project) {
          set({ saveState: "saved", saveError: null });
          if (mergedNotice) { mergedNotice = false; set({ toast: t("両方の変更を統合して保存しました。") }); }
          break;
        }
        // (保存を止めている間に入った中身 = 取り込んだ退避の編集など は、続けて送らない。Save を待つ)
        if (holdSave) { set({ saveState: "unsaved" }); break; }
      } while (generation === epoch && get().project);
    } catch (error) {
      if (generation === epoch) {
        mergedNotice = false;
        const received = deferredRemote as { text: string; revision: string } | null;
        deferredRemote = null;
        // 成功か不明な保存の通知は、誤った祖先で自動統合せず確認に回す。
        if (received && !get().conflict) markConflict(received.text, received.revision, false, false);
      }
      if (generation === epoch && saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (generation === epoch) set({ saveState: "unsaved", saveError: error instanceof TypeError ? t("接続できません。編集は保持しています。サーバーを確認して保存を再試行してください。") : error instanceof Error ? error.message : String(error) });
      // (serve に届かなかった: 同期の印も「接続なし」にする)
      if (generation === epoch && error instanceof TypeError && get().source === "serve") set({ syncLost: true });
    } finally {
      if (generation === epoch) { inFlight = false; if (get().saveState === "saved") { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } void refreshExternal?.(); } }
    }
  };
  /**
   * 取り込みの 1 段を進める: 競合が無ければそのまま取り込み (次の段があれば続ける)、あれば欄を出して選択を待つ
   * Output: { applied = この呼び出しで取り込みが終わったか, conflicts = 欄に出した競合の数 } / { error }
   */
  /** 段の進み具合: applied = 全部の段が終わった / conflicts = 欄に出した競合の数 / done = この呼び出しで取り込めた段 / error (と、その段) */
  type StepResult = { applied: boolean; conflicts: number; done: RestoreStep[] } | { error: string; step?: RestoreStep; done: RestoreStep[] };
  const restoreStep = (recovery: Recovery, step: RestoreStep): StepResult => {
    const current = get().project;
    if (!current) return { error: t("取り込むものがありません"), done: [] };
    const prepared = prepareRestore(recovery, current, step);
    if ("error" in prepared) {
      if (prepared.error === "no-step") return { applied: true, conflicts: 0, done: [] };
      return { error: prepared.error === "different-plan" ? t("別の計画の退避ファイルです。取り込めません") : prepared.error, step, done: [] };
    }
    if (prepared.conflicts.length > 0) {
      // (欄を作ったときの今の中身。選ぶ間に変わったら、古い表示の選択は使わない。R41-01)
      set({ restorePending: { recovery, step, conflicts: prepared.conflicts, basis: toJSON(current) } });
      return { applied: false, conflicts: prepared.conflicts.length, done: [] };
    }
    const message = commitRestore(recovery, step, {});
    if (message) return { error: message, step, done: [] };
    if (step === "gui" && recovery.editor) { const next = restoreStep(recovery, "editor"); return { ...next, done: [step, ...next.done] }; }
    return { applied: true, conflicts: 0, done: [step] };
  };
  /**
   * 取り込みの結果を、欄を閉じても見える案内にまとめる (R43-01): 全部終わった / 次の段の確認へ / 一部だけ取り込めた / 取り込めなかった
   * Input : result = 段を進めた結果, before = この前までに取り込んだ段
   * Output: restoreEvacuated の戻り値の形
   */
  const finishRestore = (result: StepResult, before: RestoreStep[]): { applied: boolean; conflicts: number } | { error: string } => {
    const done = [...before, ...result.done];
    const names = (steps: RestoreStep[]) => steps.map((x) => x === "gui" ? t("画面側") : t("エディタ側")).join(t("と"));
    if ("error" in result) {
      // 一部の段は取り込めた: 成功の案内だけを残さず、どこまで取り込めたかを、続けて見える帯に出す
      if (done.length > 0) {
        set({ restoreNotice: { kind: "partial", text: t("{done}の編集は取り込みました。{failed}の編集は取り込めませんでした (反映していません): {reason}。Save の前に中身を確かめてください (取り消しで戻せます)", { done: names(done), failed: names([result.step ?? "editor"]), reason: result.error }) } });
        return { applied: false, conflicts: 0 };
      }
      return { error: result.error };
    }
    if (result.applied) set({ restoreNotice: { kind: "info", text: t("{done}の編集を取り込みました。自動保存を止めています。確かめてから Save で保存してください (取り消すこともできます)", { done: names(done) }) } });
    else if (done.length > 0) set({ restoreNotice: { kind: "info", text: t("{done}の編集は取り込みました。次に、エディタ側の編集を確かめてください", { done: names(done) }) } });
    return { applied: result.applied, conflicts: result.conflicts };
  };
  /**
   * 取り込みの 1 段を反映する (取り込む前の画面を取り消しの履歴に積む。自動保存を一時停止する)
   * Output: エラーの文 (成功なら null。失敗のときは何も変えない)
   */
  const commitRestore = (recovery: Recovery, step: RestoreStep, picks: RestorePicks): string | null => {
    const current = get().project;
    if (!current) return t("取り込むものがありません");
    const result = applyRestore(recovery, current, step, picks, new Date().toISOString());
    if ("error" in result) {
      return result.error === "unresolved" ? t("全部の項目について、どの値を採るかを選んでください")
        : result.error.startsWith("invalid:") ? t("取り込んだ結果が、計画として正しくなりません (親子の関係などが矛盾します)")
        : result.error;
    }
    // 結果は未保存 (保存の基準は今の中身のまま)。自動では保存しない: 予約した保存を取り消し、進行中の保存の続きも止める。Save で送る (R40-03 / R41-03)
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    holdSave = true; mergedNotice = false;
    set({ project: result.project, past: [...get().past.slice(-HISTORY_LIMIT + 1), current], future: [], saveState: "unsaved", saveHeld: true, evacuated: null, saveError: null });
    return null;
  };
  const scheduleSave = () => {
    const { project, ephemeral, readonly } = get();
    if (!project || ephemeral || readonly) return;
    set({ saveState: "unsaved" });
    if (holdSave) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; void persist(); }, SAVE_DELAY);
  };
  const canLeave = () => !["unsaved", "saving"].includes(get().saveState) || confirm(t("未保存の編集があります。必要なら先に JSON を書き出してください。編集を破棄して移動しますか？"));
  const stopWatching = () => {
    mergedNotice = false; deferredRemote = null; reviewBasis = null;
    epoch++; holdSave = false; set({ saveHeld: false, syncLost: false }); inFlight = false; refreshExternal = null; reloadNow = null; vscodeReloadWaiter = null; vscodeEmpty = null;
    if (saveTimer) clearTimeout(saveTimer); saveTimer = null;
    if (watchTimer) clearInterval(watchTimer); watchTimer = null; fileHandle = null;
    serveEvents?.close(); serveEvents = null;
    if (messageHandler) window.removeEventListener("message", messageHandler); messageHandler = null;
    for (const save of pendingSaves.values()) { clearTimeout(save.timer); save.reject(new Error("Project closed")); } // (計画を閉じた後なので、この失敗は画面には出ない) pendingSaves.clear();
    set({ conflict: null, saveError: null, peerVersion: null, editorBehind: null });
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
  , verticalWrap: false
  , setVerticalWrap: (verticalWrap) => set({ verticalWrap })
    // 幅の狭い画面 (900px 未満: スマホ、VS Code の狭いパネル) では縦の流れを既定にする (横に長い Top は幅に合わせると読めない。B158)
  , flowDirection: (typeof window !== "undefined" && window.innerWidth < 900) ? "vertical" : "horizontal"
  , setFlowDirection: (flowDirection) => set({ flowDirection })
  , readingView: true
  , setReadingView: (readingView) => set({ readingView })
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
  , saveNow: () => { if (saveTimer) clearTimeout(saveTimer); saveTimer = null; holdSave = false; set({ saveHeld: false, restoreNotice: null }); void persist(true); }
  , reloading: false
  , syncStatus: null
  , syncLost: false
  , editorBehind: null
  , evacuated: null
  , contentHash: async () => { const p = get().project; return p ? await sha256(toJSON(p)) : ""; }
  , evacuate: async () => {
      const p = get().project;
      if (!p || get().source !== "vscode") return false;
      const text = toJSON(p);
      const requestId = `evac-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await new Promise<{ hash: string; path: string; editorVersion: number | null } | null>((resolve) => {
        evacuateWaiters.set(requestId, (r) => resolve(r));
        // 復旧に要るものを全部渡す: 画面の中身 (G)・統合の基準 (画面が元にした中身)・受け取った最新の中身 (R)。エディタ側の未保存の中身は、拡張が足す (R39-05)
        // (受け取った最新の中身: エディタ待ちのときはその中身、保存の衝突のときは衝突の相手の中身)
        vscodeApi?.postMessage({ type: "evacuate", requestId, text, base: baseText, received: get().editorBehind?.text ?? get().conflict?.text ?? null });
        setTimeout(() => { if (evacuateWaiters.delete(requestId)) resolve(null); }, 120_000);
      });
      // (退避の成功は、退避したときの中身に対してだけ。その後の編集は、ハッシュの違いで分かる)
      if (result) set({ evacuated: result });
      return result !== null;
    }
  , evacuateAndTakeLatest: async () => {
      const conflict = get().conflict;
      // VS Code の中で、エディタに未保存の編集が無い衝突のときだけ (保存の途中は、応答と取り違えないよう何もしない)
      if (get().source !== "vscode" || !conflict || conflict.editorDirty || inFlight) return;
      // 1. 退避する (保存先を選ばない・書けなかった: 何も変えない)
      const ok = await get().evacuate();
      const evacuated = get().evacuated;
      if (!ok || !evacuated) { set({ restoreNotice: { kind: "info", text: t("退避しなかったので、画面の編集はそのままです") } }); return; }
      // 2. 退避を待つ間に、画面や衝突が変わっていたら置き換えない (退避に入っていない編集を外さない。R49-04)
      if (get().conflict !== conflict || (await get().contentHash()) !== evacuated.hash) {
        set({ restoreNotice: { kind: "info", text: t("退避しました ({path})。ただ、退避の後に画面か受け取った中身が変わったので、最新には切り替えていません。もう一度退避してください", { path: evacuated.path }) } });
        return;
      }
      // 3. 最新の中身にする (取り消しで、衝突の前の画面に戻れる)
      if (!get().resolveConflict("remote")) { set({ restoreNotice: { kind: "info", text: t("退避しました ({path})。最新には切り替えられませんでした", { path: evacuated.path }) } }); return; }
      set({ restoreNotice: { kind: "info", text: t("退避しました ({path})。最新のファイルを開きました。退避した編集は、⋯ メニューの「退避した編集を読み込む」で取り込めます", { path: evacuated.path }) } });
    }
  , loadEvacuated: () => { vscodeApi?.postMessage({ type: "load-evacuated" }); }
  , restorePending: null
  , saveHeld: false
  , restoreNotice: null
  , dismissRestoreNotice: () => set({ restoreNotice: null })
  , restoreEvacuated: (value) => {
      const current = get().project;
      const recovery = readRecovery(value);
      if (!current || !recovery) return { error: t("退避したファイルとして読めません") };
      if (get().editorBehind) return { error: t("先にファイルを閉じて開き直し、最新の中身にしてから読み込んでください") };
      // 別の取り込みを確認している間は、新しい退避ファイルを読まない (欄と取り込む対象を取り違えない。R43-02)
      if (get().restorePending) return { error: t("取り込みの確認の途中です。先に、表示中の欄で選ぶか、やめてください") };
      // 画面の退避から始める (エディタの退避があれば、その後で)
      return finishRestore(restoreStep(recovery, "gui"), []);
    }
  , applyRestorePicks: (picks) => {
      const current = get().project;
      const pending = get().restorePending;
      if (!current || !pending) return t("取り込むものがありません");
      // 欄を作った後で、今の中身が変わっていた (外からの更新・画面の編集): 今の中身から競合を作り直し、選び直してもらう (R41-01)
      if (toJSON(current) !== pending.basis) {
        const again = prepareRestore(pending.recovery, current, pending.step);
        if ("error" in again) { set({ restorePending: null }); return again.error; }
        set({ restorePending: { ...pending, conflicts: again.conflicts, basis: toJSON(current) } });
        return t("表示した後で、今の中身が変わりました。今の値で選び直してください");
      }
      const message = commitRestore(pending.recovery, pending.step, picks);
      // (この段の反映に失敗: 欄は残し、何も変えていない。欄の中にエラーを出す)
      if (message) return message;
      set({ restorePending: null });
      // 画面の退避を取り込んだら、エディタの退避の段へ (競合があれば、また欄が出る)。結果は、欄を閉じても見える案内に出す (R43-01)
      const next = pending.step === "gui" && pending.recovery.editor ? restoreStep(pending.recovery, "editor") : { applied: true, conflicts: 0, done: [] as RestoreStep[] };
      finishRestore(next, [pending.step]);
      return null;
    }
  , cancelRestore: () => {
      const pending = get().restorePending;
      set({ restorePending: null });
      // エディタの段をやめた: 画面の段の取り込みは残っている (取り消しで戻せる) ことを伝える
      if (pending?.step === "editor") set({ restoreNotice: { kind: "info", text: t("エディタ側の編集は取り込みませんでした。画面側の取り込みは残っています (取り消しで戻せます)。確かめてから Save で保存してください") } });
    }
  , acceptSyncStatus: (status) => {
      // (状態が届いた = つながっている)
      if (get().syncLost) set({ syncLost: false });
      const current = get().syncStatus;
      // セッションが変わった (裏方が起動し直した) ら、通し番号は初期化して受け入れる
      if (current && current.session === status.session && status.seq < current.seq) return;
      set({ syncStatus: status });
    }
  , syncAct: async (action) => {
      const { source } = get();
      if (source === "serve") {
        try {
          const response = await fetch(serveApi("api/sync"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action) });
          if (response.ok) get().acceptSyncStatus(await response.json() as SyncStatus);
        } catch { /* 通信の失敗は、次の状態の通知で分かる */ }
      } else if (source === "vscode") {
        vscodeApi?.postMessage({ type: "sync-action", action });
      }
    }
  , reload: async () => {
      // 計画を開いていない・すでに読み直している最中なら、何もしない
      if (!reloadNow || get().reloading) return;
      const before = get().project;
      set({ reloading: true });
      try {
        await reloadNow();
        // 競合になったときは、競合の帯が出るので、ここでは知らせない。それ以外は、変わったかどうかを短く知らせる
        if (!get().conflict) set({ toast: get().project === before ? t("最新です (変更はありません)") : t("最新の内容を読み込みました") });
      } catch (e) {
        set({ toast: t("最新の内容を読み込めませんでした: {error}", { error: e instanceof Error ? e.message : String(e) }) });
      } finally {
        set({ reloading: false });
      }
    }
  , peerVersion: null
  , readonlyReason: null
  , hostNotice: null
  , vscodeFile: null
  , createInVsCode: (name) => {
      // 拡張から受け取った「空のファイル」の中身と版を基準にして、新しい計画を、そのファイルへ保存する
      const pending = vscodeEmpty;
      if (!pending || get().vscodeFile?.state !== "empty" || get().readonly) return;
      const p = createProject(name || t("無題のプロジェクト"));
      baseText = pending.text; vscodeVersion = pending.version; vscodeEmpty = null;
      set({ project: p, ephemeral: false, source: "vscode", fileName: pending.name, vscodeFile: null, past: [], future: [], selection: NO_SELECTION, viewCollapsed: {}, viewScope: loadScope(p), saveState: "unsaved", meId: loadMe(p), editMode: true });
      // すぐに保存する (保存できるまでは Unsaved のまま。失敗したら、いつもの保存の失敗の帯が出る)
      void persist();
    }
  , saveError: null
  , conflict: null
  , previewConflict: () => {
      const { conflict, project } = get();
      try { return conflict && project ? mergeProjects(baseText ? fromJSON(baseText) : null, project, validateProjectText(conflict.text)) : null; } catch { return null; }
    }
  , previewConflictReview: () => {
      const { conflict, project } = get();
      if (!conflict || !project) return null;
      if (!reviewBasis || reviewBasis.project !== project || reviewBasis.conflict !== conflict || reviewBasis.base !== baseText) {
        reviewBasis = { project, conflict, base: baseText, token: crypto.randomUUID() };
      }
      let remote: Project;
      try { remote = validateProjectText(conflict.text); } catch { return null; }
      const base = baseText ? fromJSON(baseText) : null;
      return { version: 1, token: reviewBasis.token, groups: groupConflicts(base, project, remote, mergeProjects(base, project, remote).conflicts) };
    }
  , resolveConflictGroups: (request) => {
      const review = get().previewConflictReview();
      if (!review) return false;
      const result = resolveGroupChoices(review, request);
      if ("error" in result) { set({ saveError: result.error }); return false; }
      return get().resolveConflict("merge", result.choices, get().conflict?.revision);
    }
  , resolveConflict: (choice, choices = {}, revision) => {
      const conflict = get().conflict, current = get().project;
      if (!conflict || !current || inFlight || (revision !== undefined && revision !== conflict.revision)) return false;
      // (エディタに未保存の編集があるときの衝突は、画面では統合も置き換えもしない: 基準がエディタの中身まで進んでいて、その編集が落ちる。退避へ案内する。R49-02)
      if (conflict.editorDirty || get().editorBehind) return false;
      mergedNotice = false;
      let remote: Project;
      try { remote = validateProjectText(conflict.text); }
      catch { set({ saveError: t("受け取った計画の形式や参照を確認できません。編集は保持しています。退避してファイルを確認してください。") }); return false; }
      const result = mergeProjects(baseText ? fromJSON(baseText) : null, current, remote, choices, new Date().toISOString());
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
      // Top の図では大項目は展開しない (中はタブで見る)。畳む / 展開の操作はその大項目のタブを開く操作にする
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
  , taskTable: null
  , setTaskTable: (taskTable) => set({ taskTable })
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
      // ボックスが見える画面に切り替えてから寄せる: 親のボックスを開く (親がプロジェクトのボックスや最上位なら Top)。
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
      // 大項目は畳んだ状態でそろえる。保存時は追加・移動・拡大した箱だけ補正し、既存の兄弟を動かさない (ドラッグ中は除く)
      next = normalizeCollapsed(normalizeInputNames(next).project);
      if (opts?.history !== false) next = resolveChangedOverlaps(normalizeCollapsed(project), next, blockSize);
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
      const prev = materializeHistory(past[past.length - 1]);
      if (!prev) { set({ past: [], toast: t("これより前には戻せません。相手の変更と矛盾するため、古い履歴を終了しました。") }); return; }
      set({ project: preserveClaimHistory(prev,project), past: past.slice(0, -1), future: [project, ...future], toast: historyNotice(past[past.length - 1]) });
      scheduleSave();
    }

  , redo: () => {
      if (get().readonly) return;
      const { project, past, future } = get();
      if (!project || future.length === 0) return;
      const [snapshot, ...rest] = future;
      const next = materializeHistory(snapshot);
      if (!next) { set({ future: [], toast: t("これより先には進めません。相手の変更と矛盾するため、やり直しの履歴を終了しました。") }); return; }
      set({ project: preserveClaimHistory(next,project), past: [...past, project], future: rest, toast: historyNotice(snapshot) });
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
  , clearPanelTab: () => { const { panelTab: _t, ...rest } = get().selection; void _t; set({ selection: rest as Selection }); }
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
      // 手動の更新: ブラウザ内の計画は、このブラウザの保存先から読み直す (別のタブで変えた内容を取り込む)。
      // サンプル (保存しない計画) は、読み直す先が無いので、何も変えない (ボタンは、どの計画でも同じ場所に出す)
      const generation = epoch;
      reloadNow = async () => {
        if (ephemeral) return;
        const stored = await loadProject(p.id);
        if (generation !== epoch) return;
        if (!stored) throw new Error(t("このブラウザの保存先に、計画が見つかりません"));
        acceptRemote(toJSON(stored) + "\n");
      };
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
      serveEvents.addEventListener("hello", () => {
        // つながり直した: 接続なしの印を外し、同期の状態を取り直す (serve が --sync なしで起動し直されていたら、同期の印を消す)。
        // (--sync ありなら、serve は接続のたびに sync の通知も送る。取り直しは、その通知が無い場合に備える)
        if (get().syncLost) {
          set({ syncLost: false });
          void fetch(serveApi("api/sync"), { cache: "no-store" }).then(async (response) => {
            if (generation !== epoch) return;
            if (response.ok) get().acceptSyncStatus(await response.json() as SyncStatus);
            else if (response.status === 404) set({ syncStatus: null });
          }).catch(() => { if (generation === epoch) set({ syncLost: true }); });
        }
        void reload();
      });
      // 通知の接続が切れた (serve が止まった・通信が切れた): ブラウザが自動でつなぎ直す。それまで同期の印は「接続なし」
      serveEvents.addEventListener("error", () => { if (generation === epoch && get().syncStatus) set({ syncLost: true }); });
      // 画面からの同期の状態 (--sync で起動したときだけ流れる)
      serveEvents.addEventListener("sync", (e) => { try { get().acceptSyncStatus(JSON.parse((e as MessageEvent).data) as SyncStatus); } catch { /* 読めない通知は無視 */ } });
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
        // 退避の応答 (拡張が別のファイルに書けたか)。書けたときだけ「退避済み」にする (中身のハッシュで、その後の編集と区別する)
        if (msg.type === "evacuated") {
          const waiter = evacuateWaiters.get(msg.requestId); evacuateWaiters.delete(msg.requestId);
          waiter?.(msg.ok === true && typeof msg.hash === "string" && typeof msg.path === "string" ? { hash: msg.hash, path: msg.path, editorVersion: typeof msg.editorVersion === "number" ? msg.editorVersion : null } : null, typeof msg.detail === "string" ? msg.detail : "");
          return;
        }
        // 退避したファイルの中身 (拡張のファイル選択で選ばれた): 今の中身に取り込む
        if (msg.type === "restore-evacuated") {
          const result = get().restoreEvacuated(msg.recovery);
          if ("error" in result) set({ saveError: result.error });
          return;
        }
        if (msg.type === "saved" || msg.type === "save-error") {
          const pending = pendingSaves.get(msg.requestId);
          if (msg.editorBehind === true && typeof msg.text === "string") set({ editorBehind: { text: msg.text } });
          if (!pending) {
            if (msg.type === "save-error" && msg.conflict && typeof msg.text === "string") {
              if (inFlight && !msg.editorDirty && !msg.editorBehind) deferredRemote = { text: msg.text, revision: String(msg.version) };
              else markConflict(msg.text, String(msg.version), msg.editorDirty === true);
            }
            return;
          }
          clearTimeout(pending.timer); pendingSaves.delete(msg.requestId);
          if (msg.type === "saved") pending.resolve(msg.version);
          else {
            let failure: Error = new Error(msg.error || t("保存に失敗しました"));
            try {
              if (msg.conflict && typeof msg.text === "string") {
                deferredRemote = null;
                const alreadyMerged = msg.text === baseText && pending.base !== baseText && !msg.editorDirty && !get().conflict && !get().editorBehind;
                if (alreadyMerged || markConflict(msg.text, String(msg.version), msg.editorDirty === true)) {
                  if (alreadyMerged) vscodeVersion = Math.max(vscodeVersion, Number(msg.version));
                  failure = new AutoMergeRetry();
                } else if (get().saveError) failure = new Error(get().saveError!);
              }
            } catch {
              failure = new Error(t("受け取った計画の形式や参照を確認できません。編集は保持しています。退避してファイルを確認してください。"));
            } finally { pending.reject(failure); }
          }
          return;
        }
        // 画面からの同期の状態 (拡張の裏方から)
        if (msg.type === "sync-status" && msg.status && typeof msg.status === "object") { get().acceptSyncStatus(msg.status as SyncStatus); return; }
        if ((msg.type !== "load" && msg.type !== "update") || typeof msg.text !== "string") return;
        // 確認用の中身 (VS Code のエディタが、ディスクの最新に追い付いていない間)。編集用の基準は進めず、「エディタ待ち」として持つ
        if (msg.type === "update" && msg.fromDisk === true) { set({ editorBehind: { text: msg.text }, evacuated: null }); return; }
        // エディタ待ちは、エディタの中身が受け取った最新 (R) と同じになったと確かめたときだけ解く (load / update 共通。古い版の update では解かない。R39-07)
        if (get().editorBehind) {
          if (editorCaughtUp(get().editorBehind!.text, msg.text)) set({ editorBehind: null });
          // (エディタ側が編集された: 退避した後の変更なら、退避済みではなくなる)
          else if (get().evacuated && typeof msg.version === "number" && msg.version !== get().evacuated!.editorVersion) set({ evacuated: null });
        }
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
            const fileName = typeof msg.name === "string" ? msg.name : "boxglow.json";
            // 空のファイル: 読めないエラーにせず、「名前を付けて、このファイルに計画を作る」案内を出す
            if (msg.text.trim() === "") {
              vscodeEmpty = { text: msg.text, version: msg.version ?? 0, name: fileName };
              set({ vscodeFile: { state: "empty", name: fileName } });
              return;
            }
            vscodeEmpty = null;
            let p: Project;
            // 中身はあるが、計画として読めない: 理由を案内に出す (ブラウザ向けの Home の画面は出さない)
            try { p = fromJSON(msg.text); } catch (e) { set({ vscodeFile: { state: "invalid", name: fileName, error: e instanceof Error ? e.message : String(e) } }); return; }
            baseText = msg.text; vscodeVersion = msg.version ?? 0;
            set({ vscodeFile: null });
            set({ project: p, ephemeral: false, source: "vscode", fileName, past: [], future: [], selection: NO_SELECTION, viewCollapsed: {}, viewScope: loadScope(p), saveState: "saved", meId: loadMe(p), editMode: loadEditMode(p) });
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
      set({ hostNotice: null, vscodeFile: { state: "waiting", name: "boxglow.json" } });
      setTimeout(() => {
        // 4 秒たっても、拡張から何も届いていない (空・読めない、の案内も出ていない) ときだけ、届かない旨を出す
        if (generation === epoch && get().source !== "vscode" && get().vscodeFile?.state === "waiting") set({ vscodeFile: { state: "timeout", name: "boxglow.json" } });
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

/** 描画用のプロジェクト (Top では大項目を畳み、開いているタブの大項目だけ展開。View の畳みも重ねる。画面だけで、ファイルは変えない) を返すフック */
const shownCache = new WeakMap<Project, { collapsed: Record<string, boolean>; scope: string | null; reading: boolean; lang: string; shown: Project }>();
export function useShownProject(): Project | null {
  const lang = useLang();
  const reading = useProjectStore((s) => (s.readingView || s.flowDirection === "vertical") && (s.readonly || !s.editMode));
  const project = useProjectStore((s) => s.project);
  const viewCollapsed = useProjectStore((s) => s.viewCollapsed);
  const viewScope = useProjectStore((s) => s.viewScope);
  return useMemo(() => {
    if (!project) return null;
    const cached = shownCache.get(project);
    if (cached && cached.collapsed === viewCollapsed && cached.scope === viewScope && cached.reading === reading && cached.lang === lang) return cached.shown;
    let shown = normalizeCollapsed(withViewCollapsed(project, viewCollapsed));
    if (viewScope && shown.blocks[viewScope]?.collapsed) {
      shown = { ...shown, blocks: { ...shown.blocks, [viewScope]: { ...shown.blocks[viewScope], collapsed: false } } };
    }
    // ボックスの間隔は画面で保証する: ファイルの配置が詰まっていても (間隔を広げる前に保存した計画、外のツールが書いた位置など)、
    // 線の通路 (ボックスから 36px x 2) が無いと線がボックスを貫くしかなくなる。表示の時点で重なり・間隔を解消しておく (ファイルは変えない。
    // 編集時の保存は変更対象だけを補正する)。畳んだボックスは畳んだ大きさで、開いたボックスは開いた大きさで計算する
    // 索引は ports だけ (ボックスは押し出しで差し替わるので childrenOf の索引は使わない)
    const base = shown;
    const result = reading ? readingLayout(base, viewScope) : withIndex(base, () => resolveAllOverlaps(base, blockSize), { children: false });
    shownCache.set(project, { collapsed: viewCollapsed, scope: viewScope, reading, lang, shown: result });
    return result;
  }, [project, viewCollapsed, viewScope, reading, lang]);
}
