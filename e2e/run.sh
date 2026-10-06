#!/usr/bin/env bash
# 画面の検査 (e2e) を実行する: ビルド → プレビューを起動 (無ければ) → e2e/checks.cjs
#
# Playwright と Chrome の不足ライブラリはこのリポジトリに入れていないので、場所を環境変数で渡す:
#   PLAYWRIGHT       = playwright の場所 (既定: ~/src/webgl/mg-core/node_modules/playwright)
#   BOXGLOW_E2E_LIBS = libnspr4 / libnss3 / libasound を展開したフォルダ (既定: ~/.cache/boxglow-e2e/libs/usr/lib/x86_64-linux-gnu)
#                      用意の仕方 (sudo 無し): apt-get download libnspr4 libnss3 libasound2t64 && dpkg-deb -x <deb> ~/.cache/boxglow-e2e/libs
#   SKIP_BUILD=1     = ビルドを省く (dist がプレビュー用にビルド済みのとき)
set -euo pipefail
cd "$(dirname "$0")/.."

export PLAYWRIGHT="${PLAYWRIGHT:-$HOME/src/webgl/mg-core/node_modules/playwright}"
LIBS="${BOXGLOW_E2E_LIBS:-$HOME/.cache/boxglow-e2e/libs/usr/lib/x86_64-linux-gnu}"
if [ -d "$LIBS" ]; then export LD_LIBRARY_PATH="$LIBS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; fi

# プレビューは /apps/boxglow/ で配信する (検査の URL と合わせる)
if [ "${SKIP_BUILD:-}" != "1" ]; then VITE_BASE=/apps/boxglow/ npm run build >/dev/null; fi

STARTED=""
if ! curl -s -o /dev/null http://localhost:4173/apps/boxglow/; then
  VITE_BASE=/apps/boxglow/ npx vite preview --port 4173 >/dev/null 2>&1 &
  STARTED=$!
  for _ in $(seq 1 40); do curl -s -o /dev/null http://localhost:4173/apps/boxglow/ && break; sleep 0.5; done
fi
# 自分で起動したプレビューだけ、終わったら止める
trap '[ -n "$STARTED" ] && kill "$STARTED" 2>/dev/null || true' EXIT

node e2e/home.cjs
node e2e/checks.cjs
node e2e/reliability.cjs

node e2e/gui.cjs
node e2e/canvas.cjs

node e2e/experience.cjs
# 自分の計画 (boxglow.json があるときだけ): 交差の合計とタブ切り替えの速さ
node e2e/own.cjs

# 着手・範囲・再開情報の画面検査 (サンプルのみ)
node e2e/workflow.cjs

# 状態と選択の分離・俯瞰表示
node e2e/design.cjs

# 画面からの同期 (serve --sync + 試験用の同期サーバー: サインイン・サーバーに置く・受け取り・競合の選択・サインアウト)
node e2e/sync.cjs

# 実際の VS Code (Linux 版。~/.cache/boxglow-e2e/vscode-linux に無ければ飛ばす) の中で、画面からの同期を通しで
npm run build:vscode >/dev/null 2>&1 && node e2e/vscode-sync.cjs
