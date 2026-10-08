/**
 * サンプルプロジェクト (記事の体験版と「サンプルを開く」で使う)
 * 題材: 小さな Web アプリを公開するまで。SW 開発らしく、部品を組み合わせて最終成果物を作る流れにする。
 */
import { ackDecisions, addBlock, addInputGroup, addMember, addPort, answerDecision, askDecision, connect, createArtifact, createProject, portsOf, setActivity, setCategory, setInputGroup, setProgress, setSchedule, updateBlock, updatePort } from "./graph";
import { acquireClaim } from "./claims";
import { ROOT_ID, type Project } from "./types";
import { normalizeCollapsed, projectBlocks } from "./graph";
import { layoutAll } from "./autolayout";

/** サンプルを組み立てて返す */
export function buildSampleProject(): Project {
  let p = createProject("Web アプリを公開する");
  p.description = "小さな Web アプリを、要件の整理から公開までボックスに分けて進める例。ボックスが完了するごとに、右端の最終成果物に近づく。";
  // タスクはプロジェクトのボックス (最上位の包み) の中に置く
  const PJ = projectBlocks(p)[0].id;
  p.blocks[PJ].description = p.description;
  p.blocks[PJ].status = "gray";

  const m1 = addMember(p, "さとう", "#0d8080");
  p = m1.project;
  const m2 = addMember(p, "たなか", "#e8875e");
  p = m2.project;

  // 最上位の入力 (企画メモ) と出力 (公開 URL) を整える
  const rootOut = portsOf(p, PJ, "out")[0];
  p = updatePort(p, rootOut.id, { name: "公開した Web アプリ", description: "誰でも開ける URL と、使い方の説明" });
  p = updatePort(p, portsOf(p, ROOT_ID, "out")[0].id, { name: "公開した Web アプリ" });
  const rin = addPort(p, { blockId: PJ, direction: "in", name: "企画メモ" });
  p = updatePort(rin.project, rin.portId, { description: "何を作りたいかの箇条書き", artifacts: [createArtifact("企画メモ (Notion)", "https://example.com/plan")] });

  // 最上位のブロック
  const req = addBlock(p, { parentId: PJ, title: "要件を決める", position: { x: 48, y: 72 } });
  p = req.project;
  const design = addBlock(p, { parentId: PJ, title: "設計する", position: { x: 400, y: 72 } });
  p = design.project;
  const impl = addBlock(p, { parentId: PJ, title: "実装する", position: { x: 80, y: 320 } });
  p = impl.project;
  const release = addBlock(p, { parentId: PJ, title: "公開する", position: { x: 780, y: 420 } });
  p = release.project;
  // カテゴリ (色の帯と札): 何の種類の仕事かが一目で分かる
  p = setCategory(p, req.blockId, "study");
  p = setCategory(p, design.blockId, "design");
  p = setCategory(p, impl.blockId, "build");
  p = setCategory(p, release.blockId, "ops");

  // 要件を決める: 企画メモ -> 要件一覧 (完了)
  const reqIn = addPort(p, { blockId: req.blockId, direction: "in", name: "企画メモ" });
  p = reqIn.project;
  const reqOut = portsOf(p, req.blockId, "out")[0];
  p = updatePort(p, reqOut.id, { name: "要件一覧", artifacts: [createArtifact("要件一覧 v1", "https://example.com/requirements")] });
  p = updateBlock(p, req.blockId, { status: "white", assigneeIds: [m1.memberId], description: "企画メモを読み、機能を箇条書きにする。優先度を付ける。" });
  p = connect(p, { portId: rin.portId, side: "inner" }, { portId: reqIn.portId, side: "outer" }).project;

  // 設計する: 要件一覧 -> 設計書 (画面設計と API 仕様をまとめたもの。下の階層を持たないボックスの出力は 1 本) (完了)
  const desIn = addPort(p, { blockId: design.blockId, direction: "in", name: "要件一覧" });
  p = desIn.project;
  const desOut1 = portsOf(p, design.blockId, "out")[0];
  p = updatePort(p, desOut1.id, { name: "設計書", description: "画面設計 (Figma) と API 仕様 (OpenAPI) をまとめたもの", artifacts: [createArtifact("画面設計 (Figma)", "https://example.com/figma"), createArtifact("OpenAPI 定義", "https://example.com/openapi.yaml")] });
  p = updateBlock(p, design.blockId, { status: "white", assigneeIds: [m1.memberId] });
  p = connect(p, { portId: reqOut.id, side: "outer" }, { portId: desIn.portId, side: "outer" }).project;

  // 実装する (分解中): 中に フロントエンド / バックエンド / 結合テスト
  const implIn1 = addPort(p, { blockId: impl.blockId, direction: "in", name: "設計書" });
  p = implIn1.project;
  const implOut = portsOf(p, impl.blockId, "out")[0];
  p = updatePort(p, implOut.id, { name: "動くアプリ一式", description: "テストが通ったビルド成果物" });
  p = updateBlock(p, impl.blockId, { status: "gray", assigneeIds: [m1.memberId, m2.memberId], description: "設計をもとに部品を作り、組み合わせて動く状態にする。" });
  p = connect(p, { portId: desOut1.id, side: "outer" }, { portId: implIn1.portId, side: "outer" }).project;

  const fe = addBlock(p, { parentId: impl.blockId, title: "フロントエンド", position: { x: 48, y: 72 } });
  p = fe.project;
  const be = addBlock(p, { parentId: impl.blockId, title: "バックエンド", position: { x: 48, y: 232 } });
  p = be.project;
  const it = addBlock(p, { parentId: impl.blockId, title: "結合テスト", position: { x: 360, y: 152 } });
  p = it.project;
  p = setCategory(p, it.blockId, "verify");
  p = setCategory(p, fe.blockId, "build");
  p = setCategory(p, be.blockId, "build");

  const feIn = addPort(p, { blockId: fe.blockId, direction: "in", name: "設計書" });
  p = feIn.project;
  const feOut = portsOf(p, fe.blockId, "out")[0];
  p = updatePort(p, feOut.id, { name: "画面の実装", artifacts: [createArtifact("PR #12", "https://example.com/pr/12")] });
  p = updateBlock(p, fe.blockId, { status: "white", assigneeIds: [m2.memberId] });
  p = connect(p, { portId: implIn1.portId, side: "inner" }, { portId: feIn.portId, side: "outer" }).project;

  const beIn = addPort(p, { blockId: be.blockId, direction: "in", name: "設計書" });
  p = beIn.project;
  const beOut = portsOf(p, be.blockId, "out")[0];
  p = updatePort(p, beOut.id, { name: "API の実装" });
  p = updateBlock(p, be.blockId, { status: "gray", assigneeIds: [m1.memberId], description: "OpenAPI 定義どおりに API を作る。認証はまだ未定。" });
  p = connect(p, { portId: implIn1.portId, side: "inner" }, { portId: beIn.portId, side: "outer" }).project;

  const itIn1 = addPort(p, { blockId: it.blockId, direction: "in", name: "画面の実装" });
  p = itIn1.project;
  const itIn2 = addPort(p, { blockId: it.blockId, direction: "in", name: "API の実装" });
  p = itIn2.project;
  const itIn3 = addPort(p, { blockId: it.blockId, direction: "in", name: "テストデータ" });
  p = itIn3.project; // これは誰も供給していない -> 自動で最上位の入力まで伸びる (浮いている入力の例)
  const itOut = portsOf(p, it.blockId, "out")[0];
  p = updatePort(p, itOut.id, { name: "テスト済みビルド" });
  p = connect(p, { portId: feOut.id, side: "outer" }, { portId: itIn1.portId, side: "outer" }).project;
  p = connect(p, { portId: beOut.id, side: "outer" }, { portId: itIn2.portId, side: "outer" }).project;
  p = connect(p, { portId: itOut.id, side: "outer" }, { portId: implOut.id, side: "inner" }).project;

  // 公開する (未定): 動くアプリ一式 -> 公開した Web アプリ
  const relIn = addPort(p, { blockId: release.blockId, direction: "in", name: "動くアプリ一式" });
  p = relIn.project;
  const relOut = portsOf(p, release.blockId, "out")[0];
  p = updatePort(p, relOut.id, { name: "公開 URL" });
  p = updateBlock(p, release.blockId, { description: "どこに置くかは未定。候補: 静的ホスティング。" });
  p = connect(p, { portId: implOut.id, side: "outer" }, { portId: relIn.portId, side: "outer" }).project;
  p = connect(p, { portId: relOut.id, side: "outer" }, { portId: rootOut.id, side: "inner" }).project;

  // AI の活動の例: バックエンドは Claude Code が作業中、公開するは判断待ち
  p = setActivity(p, be.blockId, "claude-code", "working", "OpenAPI 定義から API のひな形を生成中");
  p = setProgress(p, be.blockId, 40, "claude-code");
  p = askDecision(p, release.blockId, "codex", "公開先はどれにしますか?", ["静的ホスティング", "自前のサーバー"], "最初に公開するのは静的な紹介ページです。フォーム送信などのサーバー処理は、別の API を使う想定です。\n静的ホスティング: 運用の手間を抑えやすく、今回の範囲に合います。\n自前のサーバー: 自由度は高い一方、更新・監視も自分たちで行います。\nこの判断を記録してから公開作業へ進みます。").project;

  // ---- ここから: 画面の機能をひととおり見せるための例 (ボックスは増やさない。完了数 3 / 7 と記事の説明はそのまま) ----

  // 日付は、サンプルを開いた日を基準にする (いつ開いても「期日まであと何日」が自然に見えるように)
  // 入力: 今日からの日数 (負なら過去)。出力: YYYY-MM-DD
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  // 回答済みの判断 (履歴の例): 設計の途中で AI が聞き、人が答えた
  const asked = askDecision(p, design.blockId, "claude-code", "API の形式はどれにしますか?", ["REST", "GraphQL"], "画面は 2 つだけで、データの形も単純です。\nREST: 定義 (OpenAPI) とテストの道具がそろっていて、今回の規模に合います。\nGraphQL: 画面が増えたときに柔軟ですが、最初の手間が増えます。");
  p = asked.project;
  // (設計はもう完了しているので、AI はこの回答を読み終えている = 確認済み)
  if (asked.decisionId) p = ackDecisions(answerDecision(p, design.blockId, asked.decisionId, "REST", "さとう"), design.blockId, "claude-code", asked.decisionId);

  // 日程: 実装するは期日が近い、公開するは来週
  p = setSchedule(p, impl.blockId, { startDate: day(-5), dueDate: day(3), estimateHours: 24 }, "human");
  p = setSchedule(p, release.blockId, { dueDate: day(10), estimateHours: 4 }, "human");

  // 作業の範囲 (目標・対象外・完了条件): AI に渡す文脈 (context) にも入る
  p.blocks[impl.blockId].scope = {
    goal: "設計書どおりに画面と API を作り、結合テストが通る状態にする"
  , nonGoals: "デザインの作り込み、多言語対応"
  , acceptance: "結合テストがすべて通り、ビルドが作れる"
  };

  // 外部の課題 (GitHub の issue など) へのリンク: ボックスに番号の札が出る
  p.blocks[be.blockId].issue = "https://github.com/example/notes/issues/12";

  // 結合テストは、別のサブエージェントが準備中だが、テストデータが無くて詰まっている
  p = setActivity(p, it.blockId, "claude-code", "blocked", "テストデータの置き場所が決まっていない");

  // 引き継ぎメモ (中断・交代のときに、次の担当が読む): 活動ログとは別に残る
  p.handoffs = {
    ...(p.handoffs ?? {})
  , [be.blockId]: { note: "ノートの一覧・作成・削除の API まで実装済み。次は認証 (方式は「公開する」の判断の後で決める)。テストは test/api に追加している。", actor: "claude-code", at: new Date().toISOString() }
  };

  // 最上位の入力のまとまり (入力グループ): 資料をまとめて扱う
  const group = addInputGroup(p, "資料");
  p = setInputGroup(group.project, rin.portId, group.groupId);

  // AI の受け持ち (計画ごとに有効にする): 並行して動く AI が、互いのボックスを書き換えないようにする
  // 同じ Claude Code でも、実行 ID (instanceId) が違えば別の書き手 (サブエージェント)。期限は開いた時刻から 30 分
  p.claimPolicy = { mode: "reject", leaseMinutes: 30 };
  const now = Date.now();
  p = acquireClaim(p, be.blockId, "block", { actor: "claude-code", instanceId: "api-worker", tokens: [] }, now - 5 * 60_000, "sample-claim-api");
  p = acquireClaim(p, it.blockId, "block", { actor: "claude-code", instanceId: "test-worker", tokens: [] }, now - 2 * 60_000, "sample-claim-test");
  p = acquireClaim(p, release.blockId, "block", { actor: "codex", instanceId: "release-worker", tokens: [] }, now - 10 * 60_000, "sample-claim-release");

  // 依存関係で並べ直す (線が読みやすい配置にする)
  return layoutAll(normalizeCollapsed(p)); // 大項目は畳んだ前提で並べる (Top は大項目までしか出さない)
}
