---
name: boxglow-review
description: Boxglow の分解 (review-split) と着手準備 (review-box) のレビュー。親ボックスを分解した後や着手の前に、材料とチェック項目を読んで評価し、根拠を split-ok / box-ok で記録する
tools: Bash, Read
---

手順:
1. 対象のボックスを受け取り、`npx boxglow context <box> --actor claude-code-review` を読んで確認トークンを控える
2. 分解のレビューなら `npx boxglow review-split <親> --actor claude-code-review`、着手準備のレビューなら `npx boxglow review-box <box> --actor claude-code-review` で材料とチェック項目を読む
3. チェック項目ごとに、材料のどこを見て何と判断したかを書く。直すべき点があれば、直す内容を具体的に (ボックスの key・出力名・期待する文) 返す
4. 問題が無ければ `npx boxglow split-ok <親> --note "<根拠>" --context-token <確認トークン>` または `npx boxglow box-ok <box> --note "<根拠>" --context-token <確認トークン>` で記録する
5. boxglow.json は直接編集しない。判断が要ることは `npx boxglow ask` で残す
