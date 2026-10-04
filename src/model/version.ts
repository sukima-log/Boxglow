/**
 * アプリの版と、保存のやり取り (画面 ⇔ サーバ / VS Code 拡張) の取り決めの版
 * 画面・CLI・拡張が同じ版かどうかを照合するために使う (serve のヘッダ、拡張のメッセージ、CLI の version)
 */
import { version } from "../../package.json";

/** アプリの版 (package.json の version) */
export const APP_VERSION = version;
/** 保存の要求 / 確認応答の取り決めを変えたら 1 つ上げる */
export const SAVE_PROTOCOL = 1;
/** 相手 (サーバや拡張) から受け取った版。app = アプリの版, protocol = 保存の取り決めの版, extension = VS Code 拡張の版 (分からなければ null / 省略) */
export interface PeerVersion { app: string | null; protocol: number | null; extension?: string }
