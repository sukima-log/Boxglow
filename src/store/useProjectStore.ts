/**
 * アプリの状態 (Zustand)
 *
 * project を単一の正とし、変更はすべて apply(純粋関数) を通す。apply は履歴 (元に戻す / やり直す) を積み、
 * 保存は変更から少し遅らせて IndexedDB に書く。
 */
import { useMemo } from "react";
import { create } from "zustand";
import { createProject, defaultTaskParent, fromJSON, resolveAllOverlaps, toJSON } from "../model/graph";
import { blockSize } from "../model/size";
import { ensurePermission, readLocalFile, writeLocalFile } from "../lib/localfile";
import { buildSampleProject } from "../model/sample";
import type { Project } from "../model/types";
import { deleteProject, listProjects, loadProject, saveProject, type ProjectMeta } from "../lib/storage";

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
  source: "idb" | "file";
  /** ローカルファイルの名前 (source = file のとき) */
  fileName: string | null;
  readonly: boolean;
  /** View モードで畳んだ / 展開した箱 (画面だけの状態。ファイルには書かない)。id -> collapsed */
  viewCollapsed: Record<string, boolean>;
  /** 箱を畳む / 展開する。Edit なら共有の配置として保存、View なら画面だけ */
  toggleCollapsed: (blockId: string) => void;
  /** 今すぐ保存する (Save ボタン。自動保存を待たずに書く) */
  saveNow: () => void;

  embed: boolean;
  projects: ProjectMeta[];
  selection: Selection;
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
  focusBlock: (blockId: string) => void;
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
  /** ローカルの boxglow.json を開く (監視と書き戻しを始める) */
  openLocalFile: (handle: FileSystemFileHandle) => Promise<boolean>;
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
function loadEditMode(_p: Project): boolean {
  return false;
}

/** ローカルファイル連携の状態 (ハンドルは保存できないのでモジュール変数に持つ) */
let fileHandle: FileSystemFileHandle | null = null;
let fileLastModified = 0;
let watchTimer: ReturnType<typeof setInterval> | null = null;
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
      const p = get().project;
      if (!p) return;
      set({ saveState: "saving" });
      try {
        if (get().source === "file" && fileHandle) {
          // 最初の保存のときに書き込み権限を求める (開くときは読み取りだけ)
          if (!(await ensurePermission(fileHandle, "readwrite"))) {
            set({ saveState: "unsaved", toast: "ファイルへの書き込みが許可されていません (Save を押すともう一度確認します)" });
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
        set({ saveState: "unsaved", toast: `保存に失敗しました: ${String(e)}` });
      }
    }, SAVE_DELAY);
  };

  /** URL のハッシュに開いているプロジェクト id を書く (再読み込みで戻れるように) */
  /** ローカルファイルの監視を止める */
  const stopWatching = () => {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
    fileHandle = null;
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
          if (get().source === "file" && fileHandle) {
            if (!(await ensurePermission(fileHandle, "readwrite"))) { set({ saveState: "unsaved", toast: "ファイルへの書き込みが許可されていません" }); return; }
            fileLastModified = await writeLocalFile(fileHandle, toJSON(get().project!) + "\n");
          } else {
            await saveProject(get().project!);
            void get().refreshList();
          }
          set({ saveState: "saved" });
        } catch (e) {
          set({ saveState: "unsaved", toast: `保存に失敗しました: ${e instanceof Error ? e.message : String(e)}` });
        }
      })();
    }
  , toggleCollapsed: (blockId) => {
      const { project, editMode, readonly, viewCollapsed } = get();
      if (!project || !project.blocks[blockId]) return;
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
  , focusBlock: (blockId) => set({ focus: { blockId, nonce: Date.now() } })
  , saveState: "none"

  , apply: (fn, opts) => {
      const { project, past, readonly } = get();
      if (!project || readonly) return;
      let next = fn(project);
      if (next === project) return;
      // 箱は重ねない: 変更のたびに同じ階層の重なりを押し出す (ドラッグ中は呼び出し側が history=false で呼ぶので除く)
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
  , select: (sel) => set({ selection: { ...NO_SELECTION, ...sel } })
  , setToast: (msg) => set({ toast: msg })

  , refreshList: async () => set({ projects: await listProjects() })

  , newProject: async (name) => {
      const p = createProject(name || "無題のプロジェクト");
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
      set({ project: p, ephemeral, source: "idb", fileName: null, past: [], future: [], selection: NO_SELECTION, viewCollapsed: {}, saveState: ephemeral ? "none" : "saved", meId: loadMe(p), editMode: loadEditMode(p) });
      rememberInUrl(ephemeral ? null : p.id);
    }

  , openLocalFile: async (handle) => {
      if (!(await ensurePermission(handle, "read"))) {
        set({ toast: "ファイルの読み書きが許可されませんでした" });
        return false;
      }
      let text: string;
      try {
        const r = await readLocalFile(handle);
        text = r.text;
        fileLastModified = r.lastModified;
      } catch (e) {
        set({ toast: `ファイルを読めません: ${String(e)}` });
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
      set({ project: p, ephemeral: false, source: "file", fileName: handle.name, past: [], future: [], selection: NO_SELECTION, viewCollapsed: {}, saveState: "saved", meId: loadMe(p), editMode: loadEditMode(p) });
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

  , importJSON: async (text) => {
      const p = fromJSON(text);
      await saveProject(p);
      get().openProjectObject(p, false);
      await get().refreshList();
      set({ toast: `「${p.name}」を読み込みました` });
    }

  , openSample: () => {
      get().openProjectObject(buildSampleProject(), true); // サンプルも View から (Edit は上の帯で切り替える)
    }

  , copyToMine: async () => {
      const { project } = get();
      if (!project) return;
      const p = structuredClone(project);
      p.id = crypto.randomUUID().slice(0, 10);
      p.name = `${p.name} (複製)`;
      await saveProject(p);
      get().openProjectObject(p, false);
      await get().refreshList();
      set({ toast: "自分のプロジェクトとして保存しました" });
    }

  , deleteProject: async (id) => {
      await deleteProject(id);
      if (get().project?.id === id) get().closeProject();
      await get().refreshList();
    }

  , closeProject: () => {
      stopWatching();
      set({ project: null, past: [], future: [], selection: NO_SELECTION, viewCollapsed: {}, saveState: "none", ephemeral: false, source: "idb", fileName: null });
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
export function parentForNewBlock(project: Project, selection: Selection): string {
  if (selection.blockId && project.blocks[selection.blockId]) return selection.blockId;
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

/** 描画用のプロジェクト (View モードの畳む / 展開を反映したもの) を返すフック */
export function useShownProject(): Project | null {
  const project = useProjectStore((s) => s.project);
  const viewCollapsed = useProjectStore((s) => s.viewCollapsed);
  return useMemo(() => (project ? withViewCollapsed(project, viewCollapsed) : null), [project, viewCollapsed]);
}
