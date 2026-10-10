/**
 * 計画の検査 (lint): 機械で分かる欠落と、見直し候補を分けて出す
 *
 *   error  (必ず直す):   親出力の担当の未定・重複、同じ分岐の排他の道の両方を 1 つのボックスが必須にしている (両方が届くことは無い)、
 *                        作業中 (In Progress) なのに予定成果物・完了条件・出力が無い (具体化せずに始めている)、検査の対象そのものの欠落
 *   later  (着手の前に): まだ始めていないボックスの予定成果物・完了条件・出力の欠落。今回着手する分だけ具体化すればよいので、先の仕事の分は
 *                        「必ず直す」ではなく「着手の前に埋める」として分けて出す (形だけの記入を先まで書かせない)
 *   review (見直し候補): 子が 1 個だけ、どこにもつながらない出力、形だけの記入 (expect の見当が広すぎる、完了条件が題名と同じ・短すぎる)、
 *                        分岐の道の先にボックスが無い、合流の入力が 1 本、兄弟で同じ予定成果物
 *
 * 文字数や禁止語で拒否はしない (誤判定と形だけの記入を招く)。review は AI か人が内容を見て判断する材料。
 * 完了済み (white) と見送り (選ばなかった道) のボックスは検査しない (終わった仕事、やらない仕事)。
 */
import { childrenOf, descendantsOf, kindOf, outgoingEdges, portsOf } from "./graph";
import { isSkipped } from "./branch";
import { unpreparedReasons, reasonText } from "./readiness";
import { ROOT_ID, type Block, type Port, type Project } from "./types";
import { t } from "../i18n/core";

/** 検査の結果 1 件 */
export interface LintIssue {
  /** error = 必ず直す / later = 着手の前に埋める (まだ始めていないボックスの具体化) / review = 見直し候補 */
  severity: "error" | "later" | "review";
  /** 種類 (機械で扱うための短い名前) */
  kind: string;
  blockId: string;
  /** ボックスの短い ID (無ければ題名) */
  ref: string;
  portId?: string;
  /** 人が読む文 */
  text: string;
}

/**
 * 計画 (またはボックスの配下) を検査する
 * Input : p = 計画, rootId = 省略すると計画全体。指定するとそのボックスと子孫
 * Output: 問題の一覧 (error → later → review の順。同じ重さの中はボックスの順)
 */
export function lint(p: Project, rootId?: string): LintIssue[] {
  const scope = rootId ? [p.blocks[rootId], ...descendantsOf(p, rootId)].filter((b): b is Block => !!b) : Object.values(p.blocks);
  const issues: LintIssue[] = [];
  const ref = (b: Block) => b.key ?? b.title;
  const push = (severity: LintIssue["severity"], kind: string, b: Block, text: string, portId?: string) => issues.push({ severity, kind, blockId: b.id, ref: ref(b), text, ...(portId ? { portId } : {}) });
  const tags = pathTags(p);

  for (const b of scope) {
    if (b.id === ROOT_ID || b.status === "white" || isSkipped(p, b.id)) continue;
    const isProject = kindOf(b) === "project";
    const kids = childrenOf(p, b.id);

    // ---- 必ず直す ----
    if (!isProject && !b.merge && !b.branch) {
      // 具体化の欠落 (画面と同じ理由。子に任せきりの親は含めない)。
      // 担当の未定・重複は構造の誤りなので常に error。予定成果物・完了条件・出力の欠落は、作業中のボックスと検査の対象そのものなら error、
      // まだ始めていないボックスなら later (着手の番で埋める)
      for (const r of unpreparedReasons(p, b.id)) {
        const kind = r.kind === "undecided" ? "undecided-output" : r.kind === "conflict" ? "conflict-output" : r.kind;
        const structural = r.kind === "undecided" || r.kind === "conflict";
        const now = structural || b.status === "gray" || b.id === rootId;
        push(now ? "error" : "later", kind, b, reasonText(p, r), "port" in r ? r.port.id : undefined);
      }
    }
    // 同じ分岐の排他の道の両方から来る入力を、両方とも必須にしている (どちらか一方しか届かない)
    if (!b.merge) {
      const required = portsOf(p, b.id, "in").filter((q) => q.required && !q.anyOf);
      const seen = new Map<string, { option: string; port: Port }>();
      for (const q of required) {
        for (const tag of tags.get(`${q.id}:outer`) ?? []) {
          const [branchId, option] = tag.split("|");
          if (option === "*") continue; // 合流を通った道は、どれが来ても届く
          const other = seen.get(branchId);
          if (other && other.option !== option) {
            const branch = p.blocks[branchId];
            push("error", "branch-exclusive-and", b, t("入力「{a}」と「{b}」は分岐「{branch}」の別の道から来ますが、両方とも必須です (両方が届くことはありません。片方を任意にするか、合流でまとめてください)", { a: other.port.name, b: q.name, branch: branch?.title ?? branchId }), q.id);
            break;
          }
          if (!other) seen.set(branchId, { option, port: q });
        }
      }
    }

    // ---- 見直し候補 ----
    if (!isProject && kids.length === 1) push("review", "single-child", b, t("子が 1 個だけです (分解の途中なら、残りの子を足すか、親と 1 つにまとめます)"));
    for (const q of portsOf(p, b.id, "out")) {
      // どこにもつながらない出力 (プロジェクトのボックスの出力は最上位の出力につながる前提。合流・分岐の出力も同じ)
      if (outgoingEdges(p, { portId: q.id, side: "outer" }).length === 0) {
        if (b.branch && q.branchOption !== undefined) push("review", "branch-empty-path", b, t("分岐の道「{name}」の先にボックスがありません", { name: q.name }), q.id);
        else push("review", "dangling-output", b, t("出力「{name}」がどこにもつながっていません", { name: q.name }), q.id);
      }
      // 形だけの記入: 予定成果物の見当が広すぎる
      if (q.expect && broadHint(q.expect.hint)) push("review", "broad-expect", b, t("出力「{name}」の予定成果物の見当「{hint}」は広すぎます (ファイルや題名まで書きます)", { name: q.name, hint: q.expect.hint }), q.id);
    }
    if (!isProject && !b.merge && !b.branch && b.scope?.acceptance?.trim()) {
      const a = b.scope.acceptance.trim();
      if (a === b.title.trim() || a.length < 6) push("review", "thin-acceptance", b, t("完了条件「{text}」が短すぎるか題名と同じです (何をどう確かめるかを書きます)", { text: a }));
    }
    if (b.merge && portsOf(p, b.id, "in").length < 2) push("review", "merge-single-input", b, t("合流の入力が {n} 本です (2 本以上の道をまとめる部品です)", { n: portsOf(p, b.id, "in").length }));
    // 兄弟で同じ予定成果物 (責任の重複の兆候)
    if (kids.length > 1) {
      const byHint = new Map<string, Block[]>();
      for (const k of kids) for (const o of portsOf(p, k.id, "out")) if (o.expect?.hint.trim()) byHint.set(o.expect.hint.trim(), [...(byHint.get(o.expect.hint.trim()) ?? []), k]);
      for (const [hint, list] of byHint) if (new Set(list.map((x) => x.id)).size > 1) push("review", "duplicate-expect", b, t("子の {names} が同じ予定成果物「{hint}」を持っています (責任が重なっていないか見直します)", { names: [...new Set(list.map(ref))].join(", "), hint }));
    }
  }
  const order = (x: LintIssue) => (x.severity === "error" ? 0 : x.severity === "later" ? 1 : 2);
  return issues.sort((x, y) => order(x) - order(y));
}

/** 予定成果物の見当が広すぎるか (フォルダだけ、または短すぎる) */
function broadHint(hint: string): boolean {
  const h = hint.trim();
  return h.length < 3 || /^[\w./-]*\/$/.test(h) || /^(src|lib|app|docs|test|tests)$/i.test(h);
}

/**
 * 分岐の道の印を線に沿って広げる: どの入力・出力が、どの分岐のどの道から来ているか
 * Input : p
 * Output: "ポート id:面" → 印の集まり。印は "分岐の id|選択肢"。合流を通った道は "分岐の id|*" (どれが来ても届く)
 */
export function pathTags(p: Project): Map<string, Set<string>> {
  const tags = new Map<string, Set<string>>();
  const add = (key: string, tag: string) => { const s = tags.get(key) ?? new Set<string>(); const before = s.size; s.add(tag); tags.set(key, s); return s.size !== before; };
  // 分岐の出力に印を付ける
  for (const b of Object.values(p.blocks)) if (b.branch) for (const q of portsOf(p, b.id, "out")) if (q.branchOption !== undefined) add(`${q.id}:outer`, `${b.id}|${q.branchOption}`);
  // 線に沿って広げ、ボックスの中では入力 (outer) の印を出力 (outer) へ渡す。合流のボックスは印を "*" にまとめる。収束するまで繰り返す
  for (let changed = true, guard = 0; changed && guard < 100; guard++) {
    changed = false;
    for (const e of Object.values(p.edges)) {
      const from = tags.get(`${e.from.portId}:${e.from.side}`);
      if (!from) continue;
      for (const tag of from) if (add(`${e.to.portId}:${e.to.side}`, tag)) changed = true;
    }
    for (const b of Object.values(p.blocks)) {
      if (b.id === ROOT_ID) continue;
      const inTags = new Set<string>();
      for (const q of portsOf(p, b.id, "in")) for (const tag of tags.get(`${q.id}:outer`) ?? []) inTags.add(b.merge ? tag.split("|")[0] + "|*" : tag);
      // 親の内側: 入力 (inner) にも同じ印 (子へ配る線は edges で広がる)
      for (const q of portsOf(p, b.id, "in")) for (const tag of tags.get(`${q.id}:outer`) ?? []) if (add(`${q.id}:inner`, tag)) changed = true;
      for (const q of portsOf(p, b.id, "out")) {
        for (const tag of inTags) if (add(`${q.id}:outer`, tag)) changed = true;
        // 出力の内側 (子から来た印) も外側へ
        for (const tag of tags.get(`${q.id}:inner`) ?? []) if (add(`${q.id}:outer`, tag)) changed = true;
      }
    }
  }
  return tags;
}

/**
 * 検査の件数の要約 (resume / context 用)
 * Input : issues / Output: { errors, reviews }
 */
export function lintCounts(issues: LintIssue[]): { errors: number; later: number; reviews: number } {
  return { errors: issues.filter((x) => x.severity === "error").length, later: issues.filter((x) => x.severity === "later").length, reviews: issues.filter((x) => x.severity === "review").length };
}
