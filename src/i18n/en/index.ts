import { claims } from "./claims";
import { conflicts } from "./conflicts";
import { treeSync } from "./treeSync";
import { workflow } from "./workflow";
import { sync } from "./sync";
import { canvasReview } from "./canvasReview";
import { gui } from "./gui";
/**
 * 英語の辞書: 「日本語の文 → 英語」。画面の部位ごとのファイルを 1 つにまとめる
 * 書き方: キーはソースに書いた日本語の文と完全に同じ。{name} は値の差し込み位置 (英語側にも同じ名前で残す)
 */
import { common } from "./common";
import { inspector } from "./inspector";
import { parts } from "./parts";
import { canvas } from "./canvas";
import { app } from "./app";
import { cli } from "./cli";
import { model } from "./model";
import { report } from "./report";

export const en: Record<string, string> = { ...common, ...inspector, ...parts, ...canvas, ...app, ...cli, ...model, ...report, ...gui, ...canvasReview, ...workflow, ...sync, ...treeSync, ...conflicts, ...claims };
