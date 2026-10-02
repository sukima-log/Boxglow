/**
 * 箱の状態 (BlackBox / GrayBox / WhiteBox) の画面上の文言
 * 「未定」のような言い方は避け、タスク管理らしい短い英語にする (ユーザーの要望)。
 * 画面・CLI の表示はすべてここから引く (文言を変えるときはここだけ直す)。
 */
import type { BlockStatus } from "./types";

/** 札やボタンに出す短い名前 */
export const STATUS_LABEL: Record<BlockStatus, string> = {
  black: "New"
, gray: "In Progress"
, white: "Done"
};

/** ツールチップなどの説明 */
export const STATUS_HELP: Record<BlockStatus, string> = {
  black: "New: 出力 (何を作るか) は決めたが、まだ手を付けていない (BlackBox)"
, gray: "In Progress: 分解中、または作業中 (GrayBox)"
, white: "Done: 出力に成果物が付いて完了 (WhiteBox)"
};
