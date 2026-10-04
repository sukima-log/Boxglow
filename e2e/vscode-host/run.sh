#!/usr/bin/env bash
# 実際の VS Code (Windows) の拡張ホストでの確認 (B138)。WSL の中から実行する。
# 何をするか: 拡張と確認用のスクリプトをビルドして Windows の一時フォルダへ置き、zip 版の VS Code を
#             専用の設定フォルダで起動して e2e/vscode-host/suite.ts を走らせ、続けて WSL 側の CLI の挙動を確かめる。
# 前提:
#   CODE_EXE = zip 版 (インストール不要) の Code.exe の場所 (WSL から見たパス)。
#              既定: <Windows の TEMP>/boxglow-exthost/vscode-portable/Code.exe
#              用意: https://update.code.visualstudio.com/latest/win32-x64-archive/stable を展開する
#              (インストール済みの VS Code は、更新の待機中だと 2 つ目を起動できないため使わない)
# 利用者のふだんの VS Code の設定・拡張には触らない (--user-data-dir / --extensions-dir を専用にする)。
set -euo pipefail
cd "$(dirname "$0")/../.."

WIN_TEMP_WIN="$(cd /mnt/c && cmd.exe /c "echo %TEMP%" 2>/dev/null | tr -d '\r')"
WIN_TEMP="$(wslpath "$WIN_TEMP_WIN")"
W="$WIN_TEMP/boxglow-exthost"; WT="$WIN_TEMP_WIN\\boxglow-exthost"
CODE_EXE="${CODE_EXE:-$W/vscode-portable/Code.exe}"
[ -f "$CODE_EXE" ] || { echo "Code.exe がありません: $CODE_EXE (このスクリプトの先頭の説明を参照)"; exit 2; }

# 確認用の計画 (WSL の中。Windows からは UNC パスで見える)
T="$HOME/boxglow-locktest"; mkdir -p "$T"; rm -rf "$T/boxglow.json" "$T/boxglow.json.boxglow-lock"
node bin/boxglow.js init --file "$T/boxglow.json" --lang ja --name "ロックの確認用" >/dev/null
node bin/boxglow.js add "確認用のボックス" --file "$T/boxglow.json" --actor human >/dev/null
TARGET_WIN="$(wslpath -w "$T/boxglow.json")"

# 拡張と確認用スクリプトをビルドして置く
npm run build:vscode >/dev/null 2>&1
rm -rf "$W/ext" "$W/out" "$W/suite.js"; mkdir -p "$W/ext" "$W/out"
cp -r vscode/package.json vscode/out vscode/media "$W/ext/"
npx esbuild e2e/vscode-host/suite.ts --bundle --platform=node --format=cjs --external:vscode --loader:.md=text --outfile="$W/suite.js" --log-level=warning

# 1 回分の起動: $1 = phase (blocked / allowed), $2 = 設定 (security.allowedUNCHosts)
launch() {
  mkdir -p "$W/ud-$1/User"
  echo "{\"security.allowedUNCHosts\":$2,\"security.workspace.trust.enabled\":false,\"update.mode\":\"none\",\"telemetry.telemetryLevel\":\"off\"}" > "$W/ud-$1/User/settings.json"
  node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ target: process.argv[2], phase: process.argv[3] }))' "$W/config.json" "$TARGET_WIN" "$1"
  (cd /mnt/c && timeout 180 "$CODE_EXE" --user-data-dir="$WT\\ud-$1" --extensions-dir="$WT\\exts" --extensionDevelopmentPath="$WT\\ext" --extensionTestsPath="$WT\\suite.js" --disable-workspace-trust --skip-welcome --skip-release-notes --disable-gpu >/dev/null 2>&1) || true
  echo "== $1"; cat "$W/out/result-$1.json"; echo
}
launch blocked '[]'
launch allowed '["wsl.localhost"]'

# WSL 側: Windows の書き手が残したロックは「確かめられない」ので奪わない。人が解除すれば書ける
echo "== WSL 側の CLI"
node bin/boxglow.js add "奪って書いた" --file "$T/boxglow.json" --actor codex 2>&1 | sed -n 1,4p || true
TOKEN="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1]+".boxglow-lock/owner.json","utf8")).token)' "$T/boxglow.json")"
node bin/boxglow.js unlock --remove --lock-token "$TOKEN" --actor human --file "$T/boxglow.json"
node bin/boxglow.js add "解除のあとで書いた" --file "$T/boxglow.json" --actor codex
node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log("計画の名前:", p.name, "/ ボックス:", Object.values(p.blocks).map(b=>b.title).join(", "))' "$T/boxglow.json"
