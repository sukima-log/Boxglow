/**
 * サンプルプロジェクト (記事の体験版と「サンプルを開く」で使う)
 * 題材: 小さな Web アプリを公開するまで。SW 開発らしく、部品を組み合わせて最終成果物を作る流れにする。
 */
import { addBlock, addMember, addPort, askDecision, connect, createArtifact, createProject, portsOf, setActivity, setCategory, setProgress, updateBlock, updatePort } from "./graph";
import { ROOT_ID, type Project } from "./types";
import { projectBlocks } from "./graph";
import { layoutAll } from "./autolayout";

/** サンプルを組み立てて返す */
export function buildSampleProject(): Project {
  let p = createProject("Web アプリを公開する");
  p.description = "小さな Web アプリを、要件の整理から公開まで箱に分けて進める例。箱が完了するごとに、右端の最終成果物に近づく。";
  // タスクはプロジェクトの箱 (最上位の包み) の中に置く
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

  // 設計する: 要件一覧 -> 設計書 (画面設計と API 仕様をまとめたもの。下の階層を持たない箱の出力は 1 本) (完了)
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
  p = askDecision(p, release.blockId, "codex", "公開先はどれにしますか?", ["静的ホスティング", "自前のサーバー"]).project;

  // 依存関係で並べ直す (線が読みやすい配置にする)
  return layoutAll(p);
}
