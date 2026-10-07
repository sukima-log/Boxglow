/**
 * 保存と同期で共用するブロック比較。入力は共通review、出力はversion付きresolution。
 * 初期選択を置かず、削除を含む変更も人が明示してから進める。未選択のグループがあれば一切反映しない。
 */
import { useId, useState } from "react";
import { t } from "../i18n";
import {
  renderConflictValue,
  resolveGroupChoices,
  type ConflictResolution,
  type ConflictReview,
  type ResolutionSide,
} from "../model/conflict-groups";

interface Props {
  review: ConflictReview;
  remoteLabel: string;
  disabled?: boolean;
  onSubmit: (request: ConflictResolution) => void;
}

/** 入力: 比較内容と実行先。出力: 比較フォーム。tokenの変更時は子を作り直し、古い選択を捨てる。 */
export function ConflictGroups(props: Props) {
  return <GroupForm key={props.review.token} {...props} />;
}

/** 入力: 最新の比較。出力: 全グループを検証できた場合だけonSubmitへ共通要求を送るフォーム。 */
function GroupForm({ review, remoteLabel, disabled, onSubmit }: Props) {
  const prefix = useId();
  const [groups, setGroups] = useState<Record<string, ResolutionSide>>({});
  const [fields, setFields] = useState<Record<string, ResolutionSide>>({});
  const [detail, setDetail] = useState<Record<string, boolean>>({});
  const request: ConflictResolution = {
    version: 1,
    token: review.token,
    groups,
    fields,
  };
  const complete = "choices" in resolveGroupChoices(review, request);
  const remaining = review.groups.filter(
    (g) => !groups[g.id] && !g.fields.every((f) => fields[f.id]),
  ).length;
  // 詳細選択へ切り替えるときはグループ選択を捨てる。逆向きも同じで、二重指定を送らない。
  const toggle = (id: string) => {
    setDetail((d) => ({ ...d, [id]: !d[id] }));
    setGroups((g) => {
      const next = { ...g };
      delete next[id];
      return next;
    });
    setFields((f) => {
      const next = { ...f };
      for (const item of review.groups.find((g) => g.id === id)!.fields)
        delete next[item.id];
      return next;
    });
  };
  return (
    <div className="conflict-groups">
      <p className="conflict-groups__intro">
        {t(
          "別の項目の変更は両方残ります。同じ項目を変更した箇所だけ、残す内容を選んでください。",
        )}
      </p>
      {review.groups.map((group) => (
        <fieldset className="conflict-group" key={group.id}>
          <legend>
            {group.blocks
              .map((b) => [b.key, b.title].filter(Boolean).join(" "))
              .concat(group.settings ? [t("計画の設定")] : [])
              .join(" / ")}
          </legend>
          {group.structural && (
            <p className="conflict-group__warning">
              {t("削除・移動と関連する変更を一緒に確認してください。")}
            </p>
          )}
          {!!group.deleted?.local && (
            <p className="conflict-group__warning">
              {t("手元側をグループ全体に採用すると削除: {n} ボックス", {
                n: group.deleted.local,
              })}
            </p>
          )}
          {!!group.deleted?.remote && (
            <p className="conflict-group__warning">
              {t("相手側をグループ全体に採用すると削除: {n} ボックス", {
                n: group.deleted.remote,
              })}
            </p>
          )}
          {!!group.retained?.local.length && <p className="conflict-group__warning">{t("手元側を採用しても追加保護で残る: {names}", { names: group.retained.local.join(" / ") })}</p>}
          {!!group.retained?.remote.length && <p className="conflict-group__warning">{t("相手側を採用しても追加保護で残る: {names}", { names: group.retained.remote.join(" / ") })}</p>}
          {group.structural && detail[group.id] && <p>{t("項目別の選択では、削除数と残るボックスが変わる場合があります。")}</p>}
          {!detail[group.id] && (
            <div className="conflict-group__picks">
              {(["local", "remote"] as const).map((side) => (
                <label key={side} data-selected={groups[group.id] === side}>
                  <input
                    type="radio"
                    name={prefix + group.id}
                    disabled={disabled}
                    checked={groups[group.id] === side}
                    onChange={() =>
                      setGroups((g) => ({ ...g, [group.id]: side }))
                    }
                  />
                  {side === "local" ? t("手元の編集") : remoteLabel}
                </label>
              ))}
            </div>
          )}
          {group.fields.map((field) => (
            <div className="conflict-field" key={field.id}>
              <h4>
                {field.labelKey
                  ? (field.labelPrefix ?? "") +
                    (field.wire ? t("配線") + " · " : "") +
                    t(field.labelKey)
                  : field.label}
              </h4>
              <div className="conflict-columns">
                {(["local", "remote"] as const).map((side) => (
                  <label
                    className="conflict-choice"
                    key={side}
                    data-selected={
                      (detail[group.id]
                        ? fields[field.id]
                        : groups[group.id]) === side
                    }
                  >
                    <span>
                      {detail[group.id] && (
                        <input
                          type="radio"
                          name={prefix + field.id}
                          disabled={disabled}
                          checked={fields[field.id] === side}
                          onChange={() =>
                            setFields((f) => ({ ...f, [field.id]: side }))
                          }
                        />
                      )}
                      {side === "local" ? t("手元の編集") : remoteLabel}
                    </span>
                    {!!field.unassigned?.[side] && <p className="conflict-group__warning">{t("この選択で担当が外れるボックス: 最大 {n}（他の項目の選択によって変わります）", { n: field.unassigned[side] })}</p>}
                    <pre>
                      {side === "local"
                        ? field.localDisplay
                          ? renderConflictValue(field.localDisplay)
                          : field.localText
                        : field.remoteDisplay
                          ? renderConflictValue(field.remoteDisplay)
                          : field.remoteText}
                    </pre>
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div className="conflict-group__tools">
            <button
              className="btn btn-ghost btn-sm"
              disabled={disabled}
              aria-pressed={!!detail[group.id]}
              onClick={() => toggle(group.id)}
            >
              {detail[group.id] ? t("ブロック単位で選ぶ") : t("項目ごとに選ぶ")}
            </button>
            <details>
              <summary>{t("詳細")}</summary>
              <pre>
                {JSON.stringify(
                  {
                    group: group.id,
                    blocks: group.blocks.map((b) => ({ id: b.id, key: b.key })),
                    fields: group.fields.map((f) => ({
                      id: f.id,
                      path: f.path,
                      local: f.local,
                      remote: f.remote,
                    })),
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </div>
        </fieldset>
      ))}
      <div className="conflict-groups__submit">
        <span aria-live="polite">{t("未選択: {n}", { n: remaining })}</span>
        <button
          className="btn btn-primary btn-sm"
          disabled={disabled || !complete}
          onClick={() => onSubmit(request)}
        >
          {t("選択した内容で統合")}
        </button>
      </div>
    </div>
  );
}
