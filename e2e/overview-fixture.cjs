/**
 * 提案画像と同じ6タスクの計画を生成する。分岐・合流、同カテゴリ間の依存、入力待ちを含む比較用データ。
 * 使い方: const { fixture } = require("./overview-fixture.cjs"); fixture() で新しい計画を取得する。単独の試験ではない。
 */
exports.fixture = () => {
  const block = (id, title, category, status, x, y) => ({ id, key: id, kind: 'task', parentId: 'app', title, description: '', status, category, assigneeIds: [], position: { x, y }, collapsed: false, artifacts: [], activity: null, decisions: [] });
  const defs = [['r', '要件を整理する', 'research', 'white', 120, 300], ['d', '画面を設計する', 'design', 'white', 520, 96], ['a', 'APIを設計する', 'design', 'gray', 520, 456], ['u', '画面を実装する', 'build', 'black', 920, 96], ['b', 'APIを実装する', 'build', 'black', 920, 456], ['t', '結合テストする', 'verify', 'black', 1320, 300]];
  const p = { schemaVersion: 5, id: 'overview-reference', name: 'アプリ公開', description: 'デザイン比較用のサンプル', createdAt: '2026-10-09T00:00:00Z', visibility: 'private', members: [], blocks: {}, ports: {}, edges: {}, terminals: { in: { x: 0, y: 370 }, out: { x: 2120, y: 370 } }, log: [], agents: {}, nextKey: 9 };
  p.blocks.root = { ...block('root', 'アプリ公開', undefined, 'black', 0, 0), parentId: null };
  p.blocks.app = { ...block('app', 'アプリ公開', undefined, 'gray', 344, 40), parentId: 'root', kind: 'project' };
  for (const row of defs)
    p.blocks[row[0]] = block(...row);
  const port = (id, blockId, direction, name, ready = false) => {
    p.ports[id] = { id, blockId, direction, name, description: '', required: true, artifacts: ready ? [{ id: id + '-artifact', title: name, url: '', kind: 'note', note: '比較用の確定した入力' }] : [] };
  };
  port('root-input', 'root', 'in', 'ユーザーの要望', true);
  port('root-output', 'root', 'out', '検証結果');
  port('app-input', 'app', 'in', 'ユーザーの要望');
  port('app-output', 'app', 'out', '検証結果');
  for (const [id, name] of [['r', '要件'], ['d', '画面仕様'], ['a', 'API仕様'], ['u', '実装済み画面'], ['b', '動作するAPI'], ['t', '検証結果']])
    port(id + '-out', id, 'out', name);
  for (const [id, owner, name] of [['r-in', 'r', 'ユーザーの要望'], ['d-in', 'd', '要件'], ['a-in', 'a', '要件'], ['u-screen', 'u', '画面仕様'], ['u-api', 'u', 'API仕様'], ['b-api', 'b', 'API仕様'], ['t-screen', 't', '実装済み画面'], ['t-api', 't', '動作するAPI']])
    port(id, owner, 'in', name);
  const edge = (a, b, fromSide = 'outer', toSide = 'outer', kind = 'sibling') => {
    const id = a + '-' + b;
    p.edges[id] = { id, from: { portId: a, side: fromSide }, to: { portId: b, side: toSide }, kind, auto: false };
  };
  edge('root-input', 'app-input', 'inner', 'outer', 'down');
  edge('app-input', 'r-in', 'inner', 'outer', 'down');
  for (const [a, b] of [['r-out', 'd-in'], ['r-out', 'a-in'], ['d-out', 'u-screen'], ['a-out', 'u-api'], ['a-out', 'b-api'], ['u-out', 't-screen'], ['b-out', 't-api']])
    edge(a, b);
  edge('t-out', 'app-output', 'outer', 'inner', 'up');
  edge('app-output', 'root-output', 'outer', 'inner', 'up');
  return p;
};
