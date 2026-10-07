import { categoryOf } from "./categories";
/**
 * ブロック単位の競合確認を CLI・MCP・保存画面・同期画面で共有する純粋な処理。
 * 入力は検証済みの基準・手元・相手と mergeProjects の競合。ファイルや通信には触れない。
 * 競合しない変更は従来の3方向マージに任せ、ここでは「一緒に選ぶ範囲」と選択の完全性を決める。
 */
import { t } from "../i18n/core";
import { ROOT_ID, type Project } from "./types";
import { mergeProjects, type ConflictChoices, type MergeConflict } from "./merge";

export type ResolutionSide = "local" | "remote";
/** 同じ形を全入口で使う。groups はグループ ID → 選択、fields は詳細で選んだ競合 ID → 選択。 */
export interface ConflictResolution {
  version: 1;
  token: string;
  groups: Record<string, ResolutionSide>;
  fields?: Record<string, ResolutionSide>;
}
/** 旧 --prefer も入口では受け取り、現在のグループ一覧を確かめてから共通形式へ展開する。 */
export type ResolutionInput =
  | ConflictResolution
  | { token: string; prefer: ResolutionSide };

export interface ConflictField {
  id: string;
  path: string;
  label: string;
  /** 名前の部分は翻訳せず、項目名だけ画面側の言語で表示する。 */
  labelKey?: string;
  labelPrefix?: string;
  wire?: boolean;
  localDisplay?: ConflictValue;
  remoteDisplay?: ConflictValue;
  /** 削除されるメンバーを担当するボックスの上限。別の競合の選択で減る場合がある。 */
  unassigned?: { local: number; remote: number };
  localText: string;
  remoteText: string;
  /** 生の値・内部パスは詳細でだけ示す。undefined は、その側では削除されたという意味。 */
  local?: unknown;
  remote?: unknown;
}
export interface ConflictGroup {
  id: string;
  blocks: { id: string; key?: string; title: string }[];
  settings: boolean;
  /** 削除・親変更を含むときは、影響する子孫・境界配線の相手もまとめて知らせる。 */
  structural: boolean;
  /** グループ全体でその側を選んだ実結果の削除数。追加保護による親の復元も計算に含める。 */
  deleted?: { local: number; remote: number };
  /** グループ全体でその側を選んでも、追加を保護するため残る親・子の名前。 */
  retained?: { local: string[]; remote: string[] };
  fields: ConflictField[];
}
export interface ConflictReview {
  version: 1;
  token: string;
  groups: ConflictGroup[];
}

const SETTINGS = "settings";
/** 入力: ブロック内部 ID。出力: JSONのキーにも使える名前空間付きの選択キー。B番号は使わない。 */
export const blockResolutionKey = (id: string): string => "block:" + id;

/** 入力: unknown。出力: 共通形式と厳密に一致する値、または null。余分なキーや不正な側を受け付けない。 */
export function parseConflictResolution(
  value: unknown,
): ConflictResolution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (
    Object.keys(o).some(
      (k) => !["version", "token", "groups", "fields"].includes(k),
    )
  )
    return null;
  if (
    o.version !== 1 ||
    typeof o.token !== "string" ||
    !o.token ||
    o.token.length > 4096
  )
    return null;
  const selections = (
    input: unknown,
  ): input is Record<string, ResolutionSide> =>
    !!input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.entries(input).every(
      ([key, side]) =>
        key.length > 0 &&
        key.length <= 4096 &&
        (side === "local" || side === "remote"),
    );
  if (
    !selections(o.groups) ||
    (o.fields !== undefined && !selections(o.fields))
  )
    return null;
  return {
    version: 1,
    token: o.token,
    groups: { ...o.groups },
    ...(o.fields !== undefined ? { fields: { ...o.fields } } : {}),
  };
}

/** 入力: 保存上の項目名。出力: 翻訳した見出し。未知の追加項目も選べるよう、名前は失わない。 */
function conflictFieldKey(field: string): string {
  const names: Record<string, string> = {
    title: "題名",
    name: "名前",
    description: "説明",
    status: "状態",
    parentId: "親ボックス",
    blockId: "ボックス",
    from: "接続元",
    to: "接続先",
    category: "カテゴリ",
    position: "位置",
    collapsed: "折りたたみ",
    artifacts: "成果物",
    decisions: "判断と回答",
    activity: "活動",
    assigneeIds: "担当",
    progress: "進捗",
    startDate: "開始日",
    dueDate: "期日",
    members: "メンバー",
    inputGroups: "入力グループ",
    handoffs: "引き継ぎメモ",
    claims: "受け持ち",
    claimPolicy: "受け持ち制御",
    note: "引き継ぎメモ",
    visibility: "公開範囲",
    terminals: "入出力の位置",
    workflowPolicy: "作業方針",
    contextGuard: "コンテキストの確認",
    focusBlockId: "作業の範囲",
    lang: "言語",
    required: "必須",
    repo: "リポジトリ",
    issue: "課題",
    direction: "入出力",
    side: "面",
    kind: "種類",
  };
  return names[field] ?? field;
}

/** 入力: 保存上の項目名。出力: 現在の言語の見出し。 */
export function conflictFieldName(field: string): string {
  return t(conflictFieldKey(field));
}

/** 翻訳する語と利用者が書いた値を分け、CLIの言語と画面の言語が違っても内容を変えずに表示する。 */
export type ConflictValue =
  | { text: string }
  | { message: string }
  | { items: ConflictValue[]; separator: string }
  | { entries: { label: string; value: ConflictValue }[] };

/** 入力: 表示用の値の木。出力: 現在の表示言語で読める本文 (生のIDは詳細側へ残す)。 */
export function renderConflictValue(value: ConflictValue): string {
  if ("text" in value) return value.text;
  if ("message" in value) return t(value.message);
  if ("items" in value)
    return value.items.map(renderConflictValue).join(value.separator);
  return value.entries
    .map((e) => t(e.label) + ": " + renderConflictValue(e.value))
    .join("\n");
}

/** 入力: 生の値とその側の計画。出力: 翻訳可能な比較用の木。名前は利用者の入力としてそのまま保つ。 */
function presentValue(
  value: unknown,
  project: Project,
  field = "",
): ConflictValue {
  const message = (message: string): ConflictValue => ({ message });
  const text = (text: string): ConflictValue => ({ text });
  const blockName = (id: unknown): ConflictValue => {
    if (id === ROOT_ID) return message("プロジェクト");
    const b = typeof id === "string" ? project.blocks[id] : undefined;
    return b
      ? text([b.key, b.title].filter(Boolean).join(" "))
      : message("参照先がありません");
  };
  if (value === undefined) return message("削除済み");
  if (value === null) return message("なし");
  if (["parentId", "blockId", "focusBlockId"].includes(field))
    return blockName(value);
  if (field === "portId" || field === "promotedFrom") {
    const port = typeof value === "string" ? project.ports[value] : undefined;
    return port
      ? { items: [blockName(port.blockId), text(port.name)], separator: " · " }
      : message("参照先がありません");
  }
  if (field === "groupId") {
    const group = project.inputGroups?.find((g) => g.id === value);
    return group ? text(group.name) : message("参照先がありません");
  }
  if (field === "assigneeIds" && Array.isArray(value)) {
    return value.length
      ? {
          items: value.map((id) => {
            const member = project.members.find((m) => m.id === id);
            return member ? text(member.name) : message("参照先がありません");
          }),
          separator: ", ",
        }
      : message("なし");
  }
  if (field === "status") {
    const labels: Record<string, string> = { black: "未着手", gray: "作業中", white: "完了" };
    return labels[String(value)] ? message(labels[String(value)]) : text(String(value));
  }
  if (field === "category" && typeof value === "string") {
    const category = categoryOf(value); if (category) return message(category.label);
  }
  if (typeof value === "boolean") {
    if (field === "collapsed") return message(value ? "折りたたみ済み" : "展開済み");
    return message(value ? "はい" : "いいえ");
  }
  if (typeof value === "string") return value ? text(value) : message("空欄");
  if (typeof value !== "object") return text(String(value));
  if (Array.isArray(value))
    return value.length
      ? { items: value.map((v) => presentValue(v, project)), separator: "\n\n" }
      : message("なし");
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([key]) => !["id", "key"].includes(key),
  );
  return entries.length
    ? {
        entries: entries.map(([key, v]) => ({
          label: conflictFieldKey(key),
          value: presentValue(v, project, key),
        })),
      }
    : message("空欄");
}

/** 入力: 生の項目値と計画。出力: CLIの表示言語による比較の本文。 */
export function conflictValueText(
  value: unknown,
  project: Project,
  field = "",
): string {
  return renderConflictValue(presentValue(value, project, field));
}

/**
 * 入力: 3つの計画と実際の競合集合。出力: 安定した順序の依存グループ (token は呼び出し側で結び付ける)。
 * 通常はブロック1つ。ポート・引き継ぎは持ち主、配線は両端へ所属させる。
 * 削除・移動は子孫と境界配線も含めて結合し、同じ項目を複数グループへ重複表示しない。
 */
export function groupConflicts(
  base: Project | null,
  local: Project,
  remote: Project,
  conflicts: MergeConflict[],
): ConflictGroup[] {
  const projects = [base, local, remote].filter(
    (p): p is Project => p !== null,
  );
  const parents = new Map<string, string>();
  const structural = new Set<string>();
  const owner = (id: string): string =>
    id === ROOT_ID ? SETTINGS : blockResolutionKey(id);
  /** 入力: 所属キー。出力: 同じ依存集合の代表キー。経路を縮め、繰り返しの参照を軽くする。 */
  const find = (key: string): string => {
    if (!parents.has(key)) parents.set(key, key);
    const parent = parents.get(key)!;
    if (parent === key) return key;
    const root = find(parent);
    parents.set(key, root);
    return root;
  };
  /** 入力: 同じ判断が必要な所属キーの配列。出力: void。空なら計画設定に属させる。 */
  const join = (keys: string[]): void => {
    const sorted = [...new Set(keys.length ? keys : [SETTINGS])].sort();
    const first = find(sorted[0]);
    for (const key of sorted.slice(1)) parents.set(find(key), first);
  };
  /** 入力: ポートID。出力: 昇格元をたどった全所有者。壊れた循環でも走査は終了する。 */
  const promotionChanged = (id: string) => new Set(projects.map(p => {
    const port = p.ports[id]; return port ? JSON.stringify([port.blockId, port.promotedFrom]) : null;
  })).size > 1;
  const portOwners = (id: string): string[] => {
    const seen = new Set<string>(), keys = new Set<string>();
    const visit = (portId: string) => {
      if (seen.has(portId)) return;
      seen.add(portId);
      for (const p of projects) {
        const port = p.ports[portId];
        if (!port) continue;
        keys.add(owner(port.blockId));
        if (port.promotedFrom && promotionChanged(portId)) visit(port.promotedFrom);
      }
    };
    visit(id);
    return [...keys];
  };
  const edgeOwners = (id: string): string[] => projects.flatMap(p => {
    const e = p.edges[id];
    return e ? [...portOwners(e.from.portId), ...portOwners(e.to.portId)] : [];
  });
  const owners = (c: MergeConflict): string[] => {
    const [kind, id] = c.segments;
    // 古いファイルに所属先のないメモが残っていても比較を落とさない。所属を推測せず設定側で見比べる。
    if ((kind === "handoffs" || kind === "claims") && !projects.some((p) => p.blocks[id]))
      return [SETTINGS];
    if (kind === "blocks" || kind === "handoffs" || kind === "claims") return [owner(id)];
    if (kind === "ports") return portOwners(id);
    if (kind === "edges") return edgeOwners(id);
    return [SETTINGS];
  };
  const items = conflicts.filter((c) => !c.automatic);
  for (const c of items) join(owners(c));
  // 設定の削除で孤立する担当・入力グループは統合末尾で正規化するため、設定と全担当を連結しない。
  for (const p of projects) for (const port of Object.values(p.ports)) {
    if (port.promotedFrom) join(portOwners(port.id));
  }


  // 削除された親自身に項目競合が無くても、残る側の子の変更が競合していることがある。
  // 基準を含む全階層から子孫を集め、親を消しながら子だけ残す独立した選択に分けない。
  const ids = new Set(projects.flatMap((p) => Object.keys(p.blocks)));
  for (const id of ids) {
    const before = base?.blocks[id],
      left = local.blocks[id],
      right = remote.blocks[id];
    const deleted = !!before && !!left !== !!right;
    const moved = !!left && !!right && left.parentId !== right.parentId;
    if (!deleted && !moved) continue;
    const affected = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of projects)
        for (const b of Object.values(p.blocks)) {
          if (b.parentId && affected.has(b.parentId) && !affected.has(b.id)) {
            affected.add(b.id);
            grew = true;
          }
        }
    }
    const keys = [...affected].map(owner);
    if (moved)
      for (const p of projects) {
        const parent = p.blocks[id]?.parentId;
        if (parent) keys.push(owner(parent));
      }
    for (const p of projects)
      for (const e of Object.values(p.edges)) {
        if (
          [p.ports[e.from.portId]?.blockId, p.ports[e.to.portId]?.blockId].some(
            (id) => id && affected.has(id),
          )
        )
          keys.push(...edgeOwners(e.id));
      }
    // 依存関係は競合の有無にかかわらず先に結合する。列挙順で結合範囲が変わることを避ける。
    // 後段では実際の競合がある集合だけを出すので、競合のない変更は従来どおり自動統合される。
    join(keys);
    keys.forEach((key) => structural.add(key));
  }

  const grouped = new Map<string, MergeConflict[]>();
  for (const c of items) {
    const key = find(owners(c)[0] ?? SETTINGS);
    const list = grouped.get(key) ?? [];
    list.push(c);
    grouped.set(key, list);
  }
  return [...grouped.entries()]
    .map(([root, fields]) => {
      const keys = [...parents.keys()]
        .filter((key) => find(key) === root)
        .sort();
      const blockIds = keys
        .filter((key) => key.startsWith("block:"))
        .map((key) => key.slice(6));
      const blocks = blockIds.map((id) => {
        const b = local.blocks[id] ?? remote.blocks[id] ?? base!.blocks[id];
        return { id, ...(b.key ? { key: b.key } : {}), title: b.title };
      });
      const settings = keys.includes(SETTINGS);
      // グループIDは集合の最小内部IDで代表させる (集合は互いに素なので重複しない)。
      // 大きな依存集合でも要求キーを長大にしない。メンバーの変化は比較tokenの基準で検出する。
      const id = keys.length === 1 ? keys[0] : "dependency:" + keys[0];
      // 単なる左右の差の件数ではなく、従来の追加保護・親復元を通った実際の結果を示す。
      // 削除を含まない集合では再マージしない (通常の比較の負荷を増やさない)。
      const hasDeletion = blocks.some(b => !local.blocks[b.id] || !remote.blocks[b.id]);
      const impact = (side: "local" | "remote") => {
        if (!hasDeletion) return { deleted: 0, retained: [] as string[] };
        const selected = side === "local" ? local : remote;
        const choices = Object.fromEntries(fields.map(c => [c.id, side === "local" ? "ours" as const : "theirs" as const]));
        const result = mergeProjects(base, local, remote, choices).project;
        return {
          deleted: blocks.filter(b => !result.blocks[b.id]).length,
          retained: blocks.filter(b => !selected.blocks[b.id] && result.blocks[b.id]).map(b => [b.key, b.title].filter(Boolean).join(" ")),
        };
      };
      const leftImpact = impact("local"), rightImpact = impact("remote");
      return {
        id,
        blocks,
        settings,
        structural: keys.some((key) => structural.has(key)),
        deleted: { local: leftImpact.deleted, remote: rightImpact.deleted },
        retained: { local: leftImpact.retained, remote: rightImpact.retained },
        fields: fields
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((c) => {
            const [kind, entityId, field] = c.segments;
            const port =
              kind === "ports"
                ? (local.ports[entityId] ??
                  remote.ports[entityId] ??
                  base?.ports[entityId])
                : null;
            const nameKey =
              kind === "handoffs"
                ? "引き継ぎメモ"
                : field
                  ? conflictFieldKey(field)
                  : kind === "blocks"
                    ? "タスク全体"
                    : kind === "edges"
                      ? "配線"
                      : conflictFieldKey(kind);
            const name = t(nameKey);
            const block = blocks.find(
              (b) => b.id === (port?.blockId ?? entityId),
            );
            const ownerLabel =
              blocks.length > 1 && block
                ? [block.key, block.title].filter(Boolean).join(" ") + " · "
                : "";
            const assignmentCount = kind === "members" && !field
              ? new Set([local, remote].flatMap(p => Object.values(p.blocks).filter(b => b.assigneeIds.includes(entityId)).map(b => b.id))).size : 0;
            return {
              ...(assignmentCount ? { unassigned: { local: c.ours === undefined ? assignmentCount : 0, remote: c.theirs === undefined ? assignmentCount : 0 } } : {}),
              id: c.id,
              path: c.path,
              label:
                ownerLabel +
                (port
                  ? port.name + " · " + name
                  : kind === "edges" && field
                    ? t("配線") + " · " + name
                    : name),
              labelKey: nameKey,
              labelPrefix: ownerLabel + (port ? port.name + " · " : ""),
              wire: kind === "edges" && !!field,
              localDisplay: presentValue(c.ours, local, field ?? kind),
              remoteDisplay: presentValue(c.theirs, remote, field ?? kind),
              localText: conflictValueText(c.ours, local, field ?? kind),
              remoteText: conflictValueText(c.theirs, remote, field ?? kind),
              local: c.ours,
              remote: c.theirs,
            };
          }),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 入力: 現在の確認内容と選択 (旧preferを含む)。出力: mergeProjects用の完全な選択、または人向けエラー。
 * グループと項目の二重指定・未知ID・欠落は拒否し、指定の無い項目を既定の手元へ落とさない。
 */
export function resolveGroupChoices(
  review: ConflictReview,
  input: ResolutionInput,
): { choices: ConflictChoices } | { error: string } {
  const legacy = "prefer" in input;
  const request = legacy
    ? parseConflictResolution({
        version: 1,
        token: input.token,
        groups: Object.fromEntries(
          review.groups.map((g) => [g.id, input.prefer]),
        ),
      })
    : parseConflictResolution(input);
  if (!request || request.token !== review.token)
    return {
      error: t(
        "表示したときから内容が変わりました。比較し直して選んでください。",
      ),
    };
  const selected = new Map<string, ResolutionSide>();
  for (const [key, side] of Object.entries(request.groups)) {
    const group =
      review.groups.find((g) => g.id === key) ??
      review.groups.find((g) =>
        key === SETTINGS
          ? g.settings
          : g.blocks.some((b) => blockResolutionKey(b.id) === key),
      );
    if (!group || selected.has(group.id))
      return {
        error: t("選択に未知の項目、または同じ依存グループの重複があります。"),
      };
    selected.set(group.id, side);
  }
  const allFields = new Set(
    review.groups.flatMap((g) => g.fields.map((f) => f.id)),
  );
  if (Object.keys(request.fields ?? {}).some((id) => !allFields.has(id)))
    return {
      error: t("選択に未知の項目、または同じ依存グループの重複があります。"),
    };
  const choices: ConflictChoices = Object.create(null);
  for (const group of review.groups) {
    const side = selected.get(group.id);
    for (const field of group.fields) {
      const detail = request.fields?.[field.id];
      if (side && detail)
        return {
          error: t("同じ項目をグループと詳細の両方で選ぶことはできません。"),
        };
      const chosen = side ?? detail;
      if (!chosen)
        return {
          error: t("すべてのグループ、またはその中の全項目を選んでください。"),
        };
      choices[field.id] = chosen === "local" ? "ours" : "theirs";
    }
  }
  return { choices };
}
