/**
 * 画面からの同期の検査用: boxglow serve --sync を、指定の dist と同期サーバーで起動する (子プロセス。設定フォルダは環境変数で分ける)
 * 引数: <計画のファイル> <dist> <ポート> <同期サーバーの URL>
 */
import { startServe } from "../../cli/serve";
const [file, dist, port, server] = process.argv.slice(2);
startServe({ file, dist, port: Number(port), open: false, log: (line) => console.log(line), sync: { server, autoEnable: false } });
