/**
 * 画面からの同期で、裏方 (cli/sync/host.ts) と画面 (src/store / src/panels) が共有する型
 * 画面は、この状態を表示し、操作を送るだけ (同期の判断・通信・資格情報は裏方にある。トークンの値は、この状態に入らない)
 * 設計: docs/private/SYNC_GUI_DESIGN.md 2.3 〜 2.5
 */

import type { ConflictResolution, ConflictReview } from "../model/conflict-groups";

/** 人が選べる操作 (CLI の引数と 1 対 1。印は CLI と同じ値) */
export type SyncAction =
  | { kind: "resolve"; token: string; prefer: "local" | "remote" }
  | { kind: "link"; token: string; prefer: "local" | "remote" }
  | { kind: "relink"; token: string; prefer?: "local" | "remote" }
  | { kind: "recover"; token: string; applied: boolean }
  | { kind: "adopt"; approval: string }
  | { kind: "restore"; approval: string }
  | { kind: "account"; account: string };

/** 止まったときの表示の 1 項目: 文章か、人が選べる操作 (CLI のコマンド / 画面のボタン) */
export type HaltItem =
  | { kind: "text"; text: string }
  | { kind: "choice"; id: string; label: string; command: string; action: SyncAction };

/** 止まったときの表示の構造 (文章の順番は、CLI の表示の順番) */
export interface HaltView {
  target: { file: string; server: string; remoteId: string };
  reason: string;
  done: { pulled: number; pushed: number; edited: number; backup?: string };
  items: HaltItem[];
  /** 共通のブロック比較。古い裏方から届かない場合は従来の表示を使う。 */
  review?: ConflictReview;
  resolutionError?: string;
  /** 選べる操作が無いときに、直す場所 */
  fix: "local-file" | "sync-state" | "server-content" | "credentials" | "rerun" | "none";
}

/** 画面に知らせる、同期の状態 */
export interface SyncStatus {
  /** 裏方のセッション ID (起動ごとの乱数) と、そのセッションの中の通し番号 (画面は、セッションが変わったら通し番号を初期化する) */
  session: string;
  seq: number;
  /** この環境で、サインインを保存できるか (Windows で動く裏方は、まだ保存できない) */
  support: "ok" | "unsupported-platform";
  /** 資格情報の出どころと、確かめた利用者 (トークンの値は入れない) */
  credentials: { source: "env" | "stored" | "none"; account?: { accountId: string; display: string; signedInWith: "github" | "google" | "unknown" } };
  /** 常駐の同期の所有者: self = この裏方 / external = 別のプロセス / unknown = ロックの持ち主を判定できない / none = まだ取っていない */
  owner: "self" | "external" | "unknown" | "none";
  /** 今の画面のファイル (開いていなければ null) */
  file: { path: string; enabled: boolean; binding: { server: string; remoteId: string } | null } | null;
  state: "off" | "signed-out" | "unbound" | "synced" | "unsent" | "syncing" | "halted" | "problem" | "offline" | "paused" | "external" | "unsupported";
  /** 最後にそろえたサーバーの版 (詳細の欄にだけ出す) */
  revision: string | null;
  /** 確認が要る場面 (選べる操作つき。choiceIds = 項目の id → 選択 ID) */
  halt?: HaltView & { choiceIds: Record<string, string>; resolutionChoiceId?: string };
  /** 選べる操作の無い問題と、直す場所 */
  problem?: { kind: "auth" | "network" | "rejected" | "state-unreadable" | "busy"; text: string; fix: "credentials" | "wait" | "local-file" | "sync-state" | "rerun" };
  /** サインインの途中 (コードを表示している間) */
  signIn?: { provider: "github"; userCode: string; verificationUrl: string; expiresAt: string }
         | { provider: "google"; url: string; expiresAt: string };
  /** 送信先は開始前にも表示する。省略は旧ホスト。 */
  server?: string;
  isDefaultServer?: boolean;
  destinationPicker?: "dialog" | "sibling";
  startup?: {
    operationId:string;
    stage:"choose" | "signin" | "list" | "working" | "opened";
    opened?: {path:string; url?:string};
    intent?:"new" | "existing";
    projects?: {id:string;name:string;revision:string;updatedAt:string|null;bytes:number}[];
    nextCursor?:string|null;
    unsupported?:boolean;
    error?:string;
  };
  /** 1 行の補足 */
  message?: string;
}

/** 画面からの操作 */
export type HostAction =
  | { kind:"beginSync" } | {kind:"cancelBegin"}
  | { kind:"continueStart"; operationId:string; intent:"new"|"existing" }
  | { kind:"listProjects"; operationId:string; cursor?:string }
  | { kind:"openProject"; operationId:string; projectId:string; destination?:"current"|"new"; name?:string }

  | { kind: "enable" } | { kind: "disable" }
  | { kind: "signIn"; provider: "github" | "google" } | { kind: "cancelSignIn" } | { kind: "signOut" }
  | { kind: "bind" } | { kind: "syncNow" }
  | { kind: "choose"; choiceId: string }
  | { kind: "resolveGroups"; choiceId: string; resolution: ConflictResolution }
  | { kind: "pause" } | { kind: "resume" };
