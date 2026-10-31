/**
 * 作成中 (作りかけ) の資料と「作成中で着手可」の画面 (利用者の指摘 2026-10-31: 作りかけの資料を箱に付けられなかった)
 *   - 作成中の資料が届いた入力は、図の箱で「作成中」と出て、入力のカードに「作成中あり」が出る (まだそろっていない)
 *   - 入力のカードの「作成中で着手可」に印を付けると、その入力はそろう
 *   - 出力の資料の「確定にする」で作成中が外れる
 * 使い方: node e2e/draft.cjs (run.sh から。preview は 4173 番)
 */
const { chromium, open, check, result } = require('./lib.cjs');

/** 計画: 「デザイン」の出力「体形」に作成中の資料、「モデリング」がそれを入力に使う */
function plan() {
  return {
    schema: 'boxglow', schemaVersion: 1, id: 'p', name: '作成中の検査', lang: 'ja', createdAt: '2026-10-31T00:00:00Z', updatedAt: '2026-10-31T00:00:00Z',
    terminals: { in: { x: 0, y: 100 }, out: { x: 1200, y: 100 } },
    blocks: {
      root: { id: 'root', parentId: null, title: 'root', description: '', status: 'black', position: { x: 0, y: 0 }, collapsed: false, assigneeIds: [], decisions: [] },
      pj: { id: 'pj', parentId: 'root', kind: 'project', title: '作成中の検査', description: '', status: 'black', position: { x: 260, y: 40 }, collapsed: false, assigneeIds: [], decisions: [] },
      d: { id: 'd', parentId: 'pj', title: 'デザイン', description: '', status: 'gray', position: { x: 80, y: 120 }, collapsed: false, assigneeIds: [], decisions: [] },
      m: { id: 'm', parentId: 'pj', title: 'モデリング', description: '', status: 'black', position: { x: 520, y: 120 }, collapsed: false, assigneeIds: [], decisions: [] },
    },
    ports: {
      dout: { id: 'dout', blockId: 'd', direction: 'out', name: '体形', description: '', required: true, artifacts: [{ id: 'a1', title: 'body.png', url: '', kind: 'file', note: '', path: 'docs/body.png', draft: true }] },
      min: { id: 'min', blockId: 'm', direction: 'in', name: '体形', description: '', required: true, artifacts: [] },
      mout: { id: 'mout', blockId: 'm', direction: 'out', name: '胴体', description: '', required: true, artifacts: [] },
    },
    edges: { e1: { id: 'e1', from: { portId: 'dout', side: 'outer' }, to: { portId: 'min', side: 'outer' }, kind: 'sibling', auto: false } },
    members: [], log: [],
  };
}

(async () => {
  const browser = await chromium.launch();
  const { page, errors } = await open(browser, { query: '?lang=ja' });
  await page.evaluate(async (text) => { await window.boxglow.store.getState().importJSON(text); }, JSON.stringify(plan()));
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.boxglow.store.getState().setEditMode(true));
  await page.waitForTimeout(400);
  const ready = () => page.evaluate(() => { const s = window.boxglow.store.getState(); return !Object.values(s.project.ports).some(() => false) && s.project.ports.min && window.boxglow.store.getState().project.ports.min; });
  const label = page.locator('.react-flow__node[data-id="m"] .bg-block__waiting').first();
  check('図: 作成中の資料だけが届いた入力は「作成中」と出る', (await label.textContent()) === '作成中');
  await page.evaluate(() => window.boxglow.store.getState().select({ blockId: 'm', panelTab: 'io' }));
  await page.waitForTimeout(700);
  check('入力のカード: 「作成中あり」が出る', (await page.locator('.panel.right .meta-chip', { hasText: '作成中あり' }).count()) === 1);
  await page.locator('.panel.right button', { hasText: '作成中で着手可にする' }).first().click();
  await page.waitForTimeout(500);
  check('「作成中で着手可にする」を押すと、入力の acceptDraft が付き、図の「作成中」が消える', (await page.evaluate(() => window.boxglow.store.getState().project.ports.min.acceptDraft)) === true && (await page.locator('.react-flow__node[data-id="m"] .bg-block__waiting').count()) === 0);
  // 出力の側: 作成中の札と「確定にする」
  await page.evaluate(() => window.boxglow.store.getState().select({ blockId: 'd', panelTab: 'io' }));
  await page.waitForTimeout(700);
  check('出力の資料に「作成中」の札が出る', (await page.locator('.panel.right .artifact-draft').count()) === 1);
  await page.locator('.panel.right button', { hasText: '確定にする' }).first().click();
  await page.waitForTimeout(400);
  check('「確定にする」で作成中が外れる', (await page.evaluate(() => window.boxglow.store.getState().project.ports.dout.artifacts[0].draft)) === undefined && (await page.locator('.panel.right .artifact-draft').count()) === 0);
  check('コンソールにエラーが無い', errors.length === 0, errors.slice(0, 2).join(' | '));
  void ready;
  await browser.close();
  const r = result();
  console.log(`${r.passed}/${r.passed + r.failed} passed`);
  process.exit(r.failed ? 1 : 0);
})();
