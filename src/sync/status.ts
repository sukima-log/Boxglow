import type { Billing } from "./billing";
/**
 * 画面からの同期で、裏方 (cli/sync/host.ts) と画面 (src/store / src/panels) が共有する型
 * 画面は、この状態を表示し、操作を送るだけ (同期の判断・通信・資格情報は裏方にある。トークンの値は、この状態に入らない)
 * 設計: docs/private/SYNC_GUI_DESIGN.md 2.3 〜 2.5
 */

import type { ConflictResolution, ConflictReview } from "../model/conflict-groups";

/** 人が選べる操作 (CLI の引数と 1 対 1。印は CLI と同じ値) */
export type SyncAction =
  | { kind:"reconnectRestored"; token:string }
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
  credentials: { source: "env" | "stored" | "none"; account?: { accountId: string; display: string; signedInWith: "github" | "google" | "unknown"
    /** このアカウントに付いているサインインの手段 (サーバーが答えたときだけ。2 つ目を足す操作の表示に使う) */
    identities?: ("github" | "google")[]
    /** 課金の状態 (サーバーが答えたときだけ) */
    billing?: Billing } };
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
  problem?: { kind: "configuration" | "auth" | "payment" | "network" | "rejected" | "state-unreadable" | "busy"; text: string; fix: "server-setting" | "credentials" | "billing" | "wait" | "local-file" | "sync-state" | "rerun" };
  /** 申し込み / 契約の管理の画面の URL (操作 billingCheckout / billingPortal の結果。画面はリンクとして出す。次の操作やサインアウトで消える) */
  billingLink?: { kind: "checkout" | "portal"; url: string; plan?: string };
  /** サインインの途中 (コードを表示している間) */
  signIn?: ({ provider: "github"; userCode: string; verificationUrl: string; expiresAt: string }
         | { provider: "google"; url: string; expiresAt: string }) & { link?: boolean };
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
  lifecycle?: {
    choiceId:string; busy:boolean; error?:string; message?:string;
    projects?:{id:string;name:string;revision:string;deletedAt:string;expiresAt:string;restoredId:string|null;restorable:boolean}[];
    nextCursor?:string|null;
    /** 履歴 (版の一覧。新しい順) と、その計画の ID */
    versions?:{revision:string;at:string}[];
    versionsOf?:string;
    /** 共有リンク (閲覧専用) の一覧と、その計画の ID。newShare = 今作ったリンク (URL はこのときだけ分かる) */
    shares?:{id:string;createdAt:string;expiresAt:string|null;revoked:boolean;expired:boolean}[];
    sharesOf?:string;
    newShare?:{id:string;url:string;expiresAt:string|null};
    /** 確認中の操作 (revert = 履歴の版の中身を手元のファイルに戻す。サーバーの履歴は変えず、次の同期で新しい版として送られる) */
    preview?:{kind:"delete"|"restore"|"revert";id:string;name:string;account:string;revision:string;expiresAt?:string;targetId?:string};
  };
  /** このホストで作成した、置き換え前のローカルファイルの控え。 */
  localBackup?: string;
  /** このホストで使えない機能 (省略 = 全部使える)。trash = ゴミ箱 (削除・復元) */
  features?: { trash?: boolean };
  /** 1 行の補足 */
  message?: string;
  /**
   * 直前のサインインで、サーバーが「招待されていない」と答えた (同期は招待制の試験中)。
   * 画面はやり直しを促さず、理由と順番待ちのページ (waitlist。サーバーが https で教えたときだけ) を出す。次のサインインを始めると消える
   */
  notInvited?: { provider: "github" | "google"; waitlist?: string };
}

/** 画面からの操作 */
export type HostAction =
  | { kind:"beginSync" } | {kind:"cancelBegin"}
  | { kind:"continueStart"; operationId:string; intent:"new"|"existing" }
  | { kind:"listProjects"; operationId:string; cursor?:string }
  | { kind:"openProject"; operationId:string; projectId:string; destination?:"current"|"new"; name?:string }

  | { kind:"listTrash"; cursor?:string } | {kind:"cancelLifecycle"}
  | { kind:"listVersions"; projectId:string } | { kind:"previewRevert"; projectId:string; revision:string }
  /** 共有リンク (閲覧専用): 一覧 / 作る (期限は日数。無ければ無期限) / 失効 */
  | { kind:"listShares"; projectId:string } | { kind:"createShare"; projectId:string; expiresInDays?:number } | { kind:"revokeShare"; projectId:string; shareId:string }
  | {kind:"previewDelete"|"previewRestore";projectId:string}
  | {kind:"confirmLifecycle";choiceId:string}
  | { kind: "enable" } | { kind: "disable" }
  | { kind: "signIn"; provider: "github" | "google" } | { kind: "cancelSignIn" } | { kind: "signOut" }
  /** 本人によるアカウントの削除 (サーバーが止めてトークンを全部失効させ、30 日後に保存データを消す。手元はサインアウトと同じ片付け) */
  | { kind: "deleteAccount" }
  /** 課金: 申し込みの画面 (Stripe Checkout) / 契約の管理 (Customer Portal) の URL をもらう (結果は status.billingLink) */
  | { kind: "billingCheckout"; plan: "personal" | "team"; seats?: number } | { kind: "billingPortal" } | { kind: "billingDismiss" }
  /** 2 つ目のサインイン手段を、サインイン済みのアカウントに足す (コードや URL は signIn と同じ欄に出る) */
  | { kind: "linkIdentity"; provider: "github" | "google" }
  | { kind: "bind" } | { kind: "syncNow" }
  | { kind: "choose"; choiceId: string }
  | { kind: "resolveGroups"; choiceId: string; resolution: ConflictResolution }
  | { kind: "pause" } | { kind: "resume" };
