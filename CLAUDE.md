# Boxglow

AI エージェントとチームの作業を、箱と線で一目で分かるようにするタスク管理アプリ (React + Vite、CLI は bin/boxglow.js)。
このリポジトリ自身の開発計画と進捗は、同じ仕組み (`boxglow.json`) で管理する (dogfooding)。この計画ファイルは公開対象外 (.gitignore)。公開用の例は `examples/logic-daw/boxglow.json`。

## 作業の約束 (必ず守る)

- 新しい計画 (boxglow.json が無い) なら、方針から最上位の大項目を 3〜7 個作って `ask` で確認を取る。確認前に細かく分解しない
- 作業を始める前に `node bin/boxglow.js status` を読み、該当する箱を `start` する。無ければ `add` してから始める
- 終わったら `done <block> --artifact "<名前>=<パス>"` で成果物 (変更したファイル) を付ける
- 人の判断が要ることは `ask <block> "<質問>" --options "A|B"` で記録して先へ進む (勝手に決めない)
- 使っていて不便だった点 (CLI の書式、画面の分かりにくさ) は、箱「運用で見つかった改善」の中に `add` して残し、小さいものはその場で直す
- 詳しい手順は `.claude/skills/boxglow/SKILL.md`。CLI は `node bin/boxglow.js help`

## 開発

- `npm run build` (型検査 + Web + CLI)、`npx vitest run` (単体)、e2e は Playwright (scratchpad の e2e*.cjs)
- 公開は livedoor_blog_auto の `scripts/deploy_app.py --name boxglow --dist dist`
- git の add / commit / push はユーザーが行う
- 文言は New / In Progress / Done。記号より文字。線は 2 種類。デザインの数値は 8px 単位
