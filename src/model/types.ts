/**
 * Boxglow のデータモデル
 *
 * プロジェクト 1 つが「ブロック図」の全体。ブロックは parentId で階層を作る。
 * 最上位は id が ROOT_ID の特別なブロックで、その入力/出力ポートが「プロジェクト全体の入力/出力ノード」になる。
 *
 * 結線 (Edge) は「ポート + 面 (side)」の組 (Endpoint) どうしをつなぐ。
 *   outer = ブロックの外から見た面 (兄弟ブロックや親と結線するときに使う)
 *   inner = ブロックの中から見た面 (そのブロックの子と結線するときに使う)
 * たとえば「親の入力ポートを子の入力につなぐ」線は、from = {親の入力, inner}, to = {子の入力, outer}。
 */

/** 最上位ブロック (プロジェクト全体) の id */
export const ROOT_ID = "root";

/** データ形式の版。読み込み時に照合する (1 = 初版, 2 = AI の活動・判断・ログ, 3 = プロジェクトのボックスと再利用のテンプレート) */
export const SCHEMA_VERSION = 5; // 4: 入力の required が意味を持つ (既定は必須) / 5: updatedAt と version をファイルに書かない (Git の差分を汚さない)

/** ブロックの状態: black = 出力だけ決めた (中身は未定), gray = 分解中・着手中, white = 完了 (入力から出力が得られることが確定) */
export type BlockStatus = "black" | "gray" | "white";

/** 成果物・入力物の種類 (git = Git で管理されたファイル。コミット + パス + blob で記録し、移動に追従する) */
export type ArtifactKind = "url" | "file" | "note" | "redmine_issue" | "git";

/** Git の成果物の確認結果 (CLI の check が書く) */
export type ArtifactState = "ok" | "moved" | "missing";

/**
 * 成果物・入力物
 * どこにもアップロードしない。URL か、Git の参照 (コミットに固定したパス) だけを持つ。
 */
export interface Artifact {
  id: string;
  title: string;
  /** リンク (git の場合はリモートがあればコミット固定の URL) */
  url: string;
  kind: ArtifactKind;
  note: string;
  /** git: リポジトリ (リモート URL か名前) */
  repo?: string;
  /** git: リポジトリ直下からのパス (check が移動を検出したら更新される) */
  path?: string;
  /** git: 記録したときのコミット */
  commit?: string;
  /** git: 中身のハッシュ (blob)。ファイルが移動しても中身で追える */
  blob?: string;
  /** git: 最後の確認の結果と日時 */
  state?: ArtifactState;
  checkedAt?: string;
}

/** メンバー (段階 1 はログインなしなので、プロジェクト内の名前リスト) */
export interface Member {
  id: string;
  name: string;
  /** アバターの色 (16 進表記) */
  color: string;
}

/** 入出力ポート */
export interface Port {
  id: string;
  /** 所属するブロックの id (ROOT_ID ならプロジェクト全体の入力/出力ノード) */
  blockId: string;
  direction: "in" | "out";
  name: string;
  /** 形式・制約などの説明 (他人や AI が読んでも分かるように書く欄) */
  description: string;
  /** 入力の必須フラグ (出力は常に必須) */
  required: boolean;
  artifacts: Artifact[];
  /** 下の階層の未接続の入力を自動で引き上げて作ったポートなら、元のポートの id */
  promotedFrom?: string;
  /** 最上位の入力を分けるグループ (Project.inputGroups の id)。無ければ既定の入力ノード */
  groupId?: string;
}

/** 最上位の入力のグループ (例: PCIe 仕様書、DDR 仕様書)。それぞれ別の入力ノードとして描く */
export interface InputGroup {
  id: string;
  name: string;
  description: string;
  position: { x: number; y: number };
}

/** 活動の状態: working = 作業中, blocked = 詰まっている, needs_decision = 人間の判断待ち, waiting_review = 確認待ち */
export type ActivityState = "working" | "blocked" | "needs_decision" | "waiting_review";

/** いま誰がそのブロックで何をしているか (AI エージェントや人が書く) */
export interface Activity {
  /** "claude-code" | "codex" | "human:<名前>" など */
  actor: string;
  state: ActivityState;
  /** 今やっていること / 困っていること (1〜2 文) */
  note: string;
  /** 始めた日時 (ISO) */
  since: string;
}

/** 人間への質問と回答 */
export interface Decision {
  id: string;
  question: string;
  /** 選択肢 (無ければ自由記述) */
  options: string[];
  /** 判断材料 (質問だけで判断できるように、前提・比較・影響をここに書く。「これ」「上記」で外を指さない) */
  context?: string;
  answer?: string;
  askedBy: string;
  askedAt: string;
  answeredBy?: string;
  answeredAt?: string;
  /** 回答を AI (エージェント) が読んで引き取った記録。無ければ「回答済み・AI 未確認」として画面と status に残る */
  ackedBy?: string;
  ackedAt?: string;
  /** やり直す前の答え (方針転換の履歴)。選ばなかった候補は options に残る */
  history?: { answer: string; by: string; at: string; note?: string }[];
}

/** 時系列ログの種類 */
export type LogKind = "added" | "split" | "started" | "done" | "blocked" | "asked" | "answered" | "status" | "note";

/** 時系列ログ 1 件 */
export interface LogEvent {
  id: string;
  at: string;
  actor: string;
  kind: LogKind;
  blockId?: string;
  message: string;
}

/** ブロックの種類: project = 最上位に置くプロジェクトの包み (中にタスクを置く), task = 通常のタスク */
export type BlockKind = "project" | "task";

/** どのテンプレートから作ったか (再利用の出所) */
export interface TemplateOrigin {
  id: string;
  name: string;
  version: number;
}

/** ブロック (= タスク、またはプロジェクトの包み) */
/** 今回の作業範囲。空欄は制約を増やさない (古い計画では項目自体が無い)。 */
export interface WorkScope {
  goal?: string;
  nonGoals?: string;
  acceptance?: string;
  consult?: string;
}

/** AI の着手・完了確認。省略は warn (人の操作は拒否しない)。 */
export interface WorkflowPolicy {
  startWithoutInputs?: "warn" | "reject";
  doneWithoutArtifacts?: "warn" | "reject";
}

export interface Block {
  scope?: WorkScope;
  /** 説明を実際に変えた日時。古い記録には推測で補わない。 */
  descriptionUpdatedAt?: string;
  /** New / In Progress / Done を最後に変えた日時。 */
  statusChangedAt?: string;
  id: string;
  /** 人が読める短い ID (B1, B2, ...)。検索や CLI の指定に使う */
  key?: string;
  /** 省略時は task */
  kind?: BlockKind;
  /** テンプレートから挿入した場合の出所 */
  template?: TemplateOrigin;
  /** 親ブロックの id (最上位ブロック ROOT_ID だけ null) */
  parentId: string | null;
  title: string;
  description: string;
  status: BlockStatus;
  assigneeIds: string[];
  /** 親の座標系での位置 (最上位直下はキャンバスの座標) */
  position: { x: number; y: number };
  /** true なら下の階層を畳んで 1 枚のブロックとして表示 */
  collapsed: boolean;
  artifacts: Artifact[];
  /** 手で入れた進捗 (0〜100)。無ければ下の階層から計算 (WhiteBox は 100) */
  progress?: number;
  /** 開始日 (YYYY-MM-DD) */
  startDate?: string;
  /** 期日 (YYYY-MM-DD) */
  dueDate?: string;
  /** 見積時間 (時間) */
  estimateHours?: number;
  /** 実績時間 (時間) */
  actualHours?: number;
  /** カテゴリ (何の種類の仕事か)。categories.ts のキー。無ければ未分類 */
  category?: string;
  /** プロジェクトのボックス: 対応するリポジトリ (パスや URL)。複数リポジトリを 1 つの boxglow.json で管理するときの目印 */
  repo?: string;
  /** 外部の課題 (JIRA / Redmine / GitHub Issue など) の URL。画面には URL から取り出したキー (PROJ-123, #45) を札で出す */
  issue?: string;
  /** いまの活動 (無ければ null) */
  activity: Activity | null;
  /** 人間への質問と回答 (古い順) */
  decisions: Decision[];
}

/** 結線の端点 (ポート + 面) */
export interface Endpoint {
  portId: string;
  side: "outer" | "inner";
}

/**
 * 結線の種類
 *   sibling = 同じ階層のブロックの出力 -> 入力
 *   up      = 子の出力 -> 親の出力 (inner)
 *   down    = 親の入力 (inner) -> 子の入力
 *   through = 親の入力 (inner) -> 親の出力 (inner) (入力をそのまま出力に通す)
 */
export type EdgeKind = "sibling" | "up" | "down" | "through";

/** 結線 */
export interface Edge {
  id: string;
  from: Endpoint;
  to: Endpoint;
  kind: EdgeKind;
  /** 未接続の入力を最上位まで自動で伸ばした線なら true (点線で描き、手動の結線で置き換わる) */
  auto: boolean;
}

/** プロジェクトの公開範囲 (段階 1 は private のみ) */
export type Visibility = "private" | "link" | "public";

/** プロジェクト (= ブロック図の全体。JSON 書き出しの単位) */
export interface Project {
  workflowPolicy?: WorkflowPolicy;
  /** 今回優先するボックスの内部 id。この配下を候補一覧の先頭にする。 */
  focusBlockId?: string;
  /** true なら、CLI / MCP で作業を記録するコマンドが最新のコンテキストの確認トークンを要求する (guard)。無い古い計画は要求しない */
  contextGuard?: boolean;
  /** 引き継ぎメモ (ボックスの id → 分かったこと・次の手順など)。件数に上限のある活動ログとは別に残る。無い古い計画もそのまま読める */
  handoffs?: Record<string, { note: string; actor: string; at: string }>;
  schemaVersion: number;
  id: string;
  name: string;
  /** CLI が書く文言 (ログ・status・AI 向け手順) の言語。無ければ ja (この項目より前に作った計画は日本語)。画面の言語とは別 (画面はブラウザの言語) */
  lang?: "ja" | "en";
  description: string;
  createdAt: string;
  /** 最終更新 (v5 からファイルには書かない。ブラウザ内の一覧は保存時刻を別に持つ) */
  updatedAt?: string;
  /** 版番号 (v5 からファイルには書かない。Git のコミットが版になる) */
  version?: number;
  visibility: Visibility;
  members: Member[];
  blocks: Record<string, Block>;
  ports: Record<string, Port>;
  edges: Record<string, Edge>;
  /** 最上位の入力ノード・出力ノードのキャンバス上の位置 */
  terminals: { in: { x: number; y: number }; out: { x: number; y: number } };
  /** 時系列ログ (古い順。上限は graph.ts の LOG_LIMIT) */
  log: LogEvent[];
  /** 見かけたエージェント (actor -> 最後に見た日時) */
  agents: Record<string, { lastSeen: string }>;
  /** 次に付ける短い ID の番号 (B<番号>) */
  nextKey?: number;
  /** 最上位の入力のグループ */
  inputGroups?: InputGroup[];
}

/* ------------------------------------------------------------------ */
/* 再利用のテンプレート (ボックスを下の階層ごと別のプロジェクトへ持っていく)       */
/* ------------------------------------------------------------------ */

/** テンプレートの中の 1 ボックス (再帰)。ポートは名前で、結線は "題名.ポート名" で表す (id に依存しない) */
export interface TemplateNode {
  title: string;
  description: string;
  /** カテゴリのキー (任意) */
  category?: string;
  inputs: { name: string; description: string; required: boolean }[];
  outputs: { name: string; description: string }[];
  children: TemplateNode[];
  /** 子どうし・親子の結線 ("parent.<名前>" はこのボックス自身の入出力) */
  connections: { from: string; to: string }[];
}

/** 再利用のテンプレート (ファイル *.boxglow-block.json、またはブラウザ内のライブラリに保存) */
export interface BlockTemplate {
  schema: "boxglow-block";
  schemaVersion: 1;
  id: string;
  name: string;
  version: number;
  description: string;
  /** 探すための札 (例: "画像処理", "認証") */
  tags: string[];
  createdAt: string;
  updatedAt: string;
  root: TemplateNode;
}
