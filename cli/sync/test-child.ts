/**
 * 試験専用: 同期を 1 回実行する子プロセス。処理の境目ごとに親へ知らせ、親が「続けてよい」と送ってくるまで待つ
 * (実際の複数プロセスで、割り込みの順序を固定して確かめるため。製品の CLI からは使わない)
 * 使い方 (親から fork する): node test-child.mjs <計画のファイル> <サーバーの URL> [サーバー側の計画の ID]
 *   子 → 親: { phase: "<境目の名前>" } (その境目に着いた)、{ done: <同期の結果> }、{ error: "<例外の文>" }
 *   親 → 子: 何か 1 つ送ると、その境目から先へ進む
 */
import { syncOnce } from "./client";

const [file, server, remoteId] = process.argv.slice(2);
syncOnce({
  file, server, remoteId: remoteId || undefined
, onStep: async (kind) => {
    process.send!({ phase: kind });
    await new Promise<void>((resume) => process.once("message", () => resume()));
  }
}).then(
  (result) => { process.send!({ done: result }, () => process.exit(0)); }
, (error) => { process.send!({ error: String(error) }, () => process.exit(1)); }
);
