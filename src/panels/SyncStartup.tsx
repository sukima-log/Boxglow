import { useProjectStore } from "../store/useProjectStore";
import { SignInButtons } from "./SignInButtons";
/** 同期開始の入口。送り先・保存先を先に示し、実際の処理は許可リスト付きホストへ渡す。 */
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import type { HostAction, SyncStatus } from "../sync/status";
import { SignInCode } from "./SyncPanel";
/**
 * 入力: 公開状態・ホスト操作・未保存の有無。receive = 受け取り専用 (ファイルがまだ無い / 空のときに Home から使う:
 *       選択肢を出さずにサーバーの一覧へ進み、選んだ計画を今のファイルに保存する。サインインが要るときはここに出す)
 * 出力: 開始、一覧、保存先選択の画面。
 */
export function SyncStartup({ status, act, unsaved, receive = false }: {
  status: SyncStatus;
  act: (a: HostAction) => Promise<unknown>;
  unsaved: boolean;
  receive?: boolean;
}) {
  const [id, setId] = useState("");
  // ブラウザ内の保存はファイルではない。内部IDでなく利用者が付けた計画名を示す。
  const source = useProjectStore(s => s.source);
  const projectName = useProjectStore(s => s.project?.name);
  const [destination, setDestination] = useState<"current" | "new">(receive || status.file?.binding ? "current" : "new");
  const [name, setName] = useState("remote.boxglow.json");
  const op = status.startup;
  // 置く先 / 受け取る元: "" = 個人、それ以外 = チームの ID (候補は開始の手順が読む。無ければ個人だけ)
  const [team, setTeam] = useState("");
  const teamOptions = op?.teams ?? status.teams?.list?.map((x) => ({ teamId: x.teamId, name: x.name, role: x.role })) ?? [];
  useEffect(() => { if (status.credentials.account && status.teams?.list === undefined && !status.teams?.busy) void act({ kind: "listTeams" }); }, [status.credentials.account, status.teams?.list === undefined, status.teams?.busy, act]);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  /** Input: ホスト操作。Output: 同じ操作の連打を抑え、応答まで処理中を示す。送受信の意味はホストに委ねる。 */
  const request = async (action: HostAction) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try { return await act(action); }
    finally { pendingRef.current = false; setPending(false); }
  };
  // 受け取り専用: 「選ぶ」段階を飛ばして、サーバーの一覧 (サインインが要ればその手順) へ進む
  useEffect(() => {
    if (receive && op?.stage === "choose" && !op.error) void act({ kind: "continueStart", operationId: op.operationId, intent: "existing", team });
  }, [receive, op?.stage, op?.operationId, op?.error, act]);
  /** 開始の手順を始めて、そのまま選んだ道へ進む (「同期を始める」を押してから選ぶ 2 段を 1 段に) */
  const startWith = async (intent: "new" | "existing") => {
    await request({ kind: "beginSync" });
    // 開始の手順の ID が状態に届くまで待つ (VS Code では拡張への操作が応答を待たずに戻るので、少し遅れて届く)
    let opId: string | undefined;
    for (let i = 0; i < 50 && !opId; i++) {
      opId = useProjectStore.getState().syncStatus?.startup?.operationId;
      if (!opId) await new Promise((r) => setTimeout(r, 100));
    }
    if (opId) await request({ kind: "continueStart", operationId: opId, intent, team });
  };
  if (!op)
    return receive ? <>
      {teamOptions.length > 0 && <label className="sync-startup__team">{t("受け取る元")}: <select className="input" value={team} aria-label={t("受け取る元")} onChange={(e) => setTeam(e.target.value)}><option value="">{t("自分 (個人)")}</option>{teamOptions.map((x) => <option key={x.teamId} value={x.teamId}>{x.name}</option>)}</select></label>}
      <button className="btn btn-primary btn-sm" disabled={unsaved || pending} onClick={() => void request({ kind: "beginSync" })}>{pending ? t("準備中…") : t("サーバーの計画を受け取る")}</button>
      {/* Boxglow の同期サーバーは招待制の試験中: 押す前に分かるよう 1 行だけ添える (自分のサーバーでは出さない) */}
      {status.isDefaultServer && !status.credentials.account && <p className="muted">{t("Boxglow の同期サーバーは招待制の試験中です")}</p>}
    </> : <section className="sync-startup" aria-label={t("同期を始める")}>
      <p>{t("送り先")}: <span className="break-all">{status.isDefaultServer ? t("Boxglow の同期サーバー") : status.server}</span></p>
      {teamOptions.length > 0 && <label className="sync-startup__team">{t("置く先")}: <select className="input" value={team} aria-label={t("置く先")} onChange={(e) => setTeam(e.target.value)}><option value="">{t("自分 (個人)")}</option>{teamOptions.map((x) => <option key={x.teamId} value={x.teamId}>{x.name}</option>)}</select></label>}
      <div className="sync-panel__choices sync-startup__choices">
        <button aria-label={t("この計画を新しくサーバーに置く")} className="btn btn-primary btn-sm" disabled={unsaved || pending} onClick={() => void startWith("new")}><strong>{t("この計画を新しくサーバーに置く")}</strong><span>{t("今の計画を送り、ほかの端末でも続きを開けます")}</span></button>
        <button aria-label={t("サーバーの計画を開く")} className="btn btn-sm" disabled={unsaved || pending} onClick={() => void startWith("existing")}><strong>{t("サーバーの計画を開く")}</strong><span>{t("保存済みの計画を一覧から選んで受け取ります")}</span></button>
      </div>
      {unsaved && <p className="muted">{t("先に保存してください")}</p>}
      {status.isDefaultServer && !status.credentials.account && <p className="muted">{t("Boxglow の同期サーバーは招待制の試験中です")}</p>}
    </section>;
  const filename = status.file?.path.split(/[\\/]/).pop();
  const busy = pending || op.stage === "working";
  return <section className="sync-startup" aria-label={t("同期を始める")}>
  {!(receive && status.isDefaultServer) && <p>{t("送り先")}: <span className="break-all">{status.isDefaultServer ? t("Boxglow の同期サーバー") : status.server}</span></p>}
  {op.stage !== "list" && op.stage !== "opened" && !receive && <p>{source === "idb" ? t("今の計画") : t("今開いているファイル")}: <span className="break-all">{source === "idb" ? projectName : filename}</span></p>}
  {op.error && <p role="alert">{op.error}</p>}
  {/* 招待されていないときは、やり直しではなく順番待ちを案内する */}
  {status.notInvited?.waitlist && <a className="btn btn-sm" href={status.notInvited.waitlist} target="_blank" rel="noreferrer">{t("順番待ちに登録する")}</a>}
  {op.stage === "choose" && !receive && <>      {teamOptions.length > 0 && <label className="sync-startup__team">{t("置く先")}: <select className="input" value={team} aria-label={t("置く先")} onChange={(e) => setTeam(e.target.value)}><option value="">{t("自分 (個人)")}</option>{teamOptions.map((x) => <option key={x.teamId} value={x.teamId}>{x.name}</option>)}</select></label>}
  <div className="sync-panel__choices sync-startup__choices">
   <button aria-label={t("この計画を新しくサーバーに置く")} className="btn btn-primary btn-sm" disabled={unsaved || pending} onClick={() => void request({ kind: "continueStart", operationId: op.operationId, intent: "new", team })}><strong>{t("この計画を新しくサーバーに置く")}</strong><span>{t("今の計画を送り、ほかの端末でも続きを開けます")}</span></button>
   <button aria-label={t("サーバーの計画を開く")} className="btn btn-sm" disabled={unsaved || pending} onClick={() => void request({ kind: "continueStart", operationId: op.operationId, intent: "existing", team })}><strong>{t("サーバーの計画を開く")}</strong><span>{t("保存済みの計画を一覧から選んで受け取ります")}</span></button>
  </div></>}
  {/* サインインの段階: ボタンは中止より前のここに出す。コードは、受け取り専用 (同期パネルが無い Home) のときだけここに出す (ふつうは同期パネルが出す) */}
  {op.stage === "signin" && (receive && status.signIn
    ? <SignInCode code={status.signIn} onCancel={() => void act({ kind: "cancelSignIn" })} />
    : !status.signIn && <div className="sync-startup__signin">
        <p>{receive ? t("サインインすると、サーバーにある自分の計画を選べます。") : t("サインイン後、選んだ手順を続けます。")}</p>
        <SignInButtons act={act} />
      </div>)}
  {busy && <p role="status">{t("処理しています…")}</p>}
  {op.stage === "opened" && op.opened && <>
   <p>{t("計画を保存しました。")}</p><p className="break-all">{op.opened.path.split(/[\\/]/).pop()}</p>
   {op.opened.url && <a className="btn btn-primary btn-sm" href={op.opened.url} target="_blank" rel="noreferrer">{t("保存した計画を開く")}</a>}
  </>}
  {op.stage === "list" && <>
   {status.destinationPicker && !receive && <fieldset>
    <legend>{t("保存先")}</legend>
    <label><input name="sync-destination" type="radio" checked={destination === "current"} onChange={() => setDestination("current")}/>{t("今開いているファイル")}: {filename}</label>
    <label><input name="sync-destination" type="radio" checked={destination === "new"} onChange={() => setDestination("new")}/>{t("新しいファイル")}</label>
    {destination === "new" && (status.destinationPicker === "sibling"
          ? <label>{t("同じフォルダ内のファイル名")}<input className="input" aria-label={t("保存ファイル名")} value={name} onChange={e => setName(e.target.value)} maxLength={128}/></label>
          : <p>{t("計画を選んだ後、保存ダイアログを開きます。")}</p>)}
   </fieldset>}
   {op.team && <p className="muted">{t("ワークスペース")}: {op.team.name}</p>}
   <p>{receive ? t("受け取る計画を選んでください。ここに保存して開きます。") : destination === "current" ? t("開く計画を選んでください。手元と内容が違う場合は、比較してから進みます。") : t("開く計画を選んでください。")}</p>
   {op.unsupported && <p>{t("このサーバーは計画一覧に対応していません。計画IDを指定してください。")}</p>}
   {op.projects?.map(p => <div key={p.id} className="sync-panel__row"><button className="sync-project-row btn" disabled={unsaved || pending} onClick={() => void request({ kind: "openProject", operationId: op.operationId, projectId: p.id, destination, name })}>
    <strong>{p.name || p.id}</strong><span>{p.updatedAt ? new Date(p.updatedAt).toLocaleString() : t("更新日時不明")} · {Math.ceil(p.bytes / 1024)} KB</span>
   </button><button className="btn btn-ghost btn-sm" aria-label={t("サーバーから削除…")+" "+p.name} title={t("サーバーから削除…")} onClick={()=>void act({kind:"previewDelete",projectId:p.id})}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></svg></button></div>)}
   {!op.unsupported && op.projects?.length === 0 && !op.error && <p>{t("このアカウントの計画はありません。")}</p>}
   <div className="sync-panel__row">
    <button className="btn btn-ghost btn-sm" onClick={() => void request({ kind: "listProjects", operationId: op.operationId })}>{t("再読み込み")}</button>
    {op.nextCursor && <button className="btn btn-sm" onClick={() => void request({ kind: "listProjects", operationId: op.operationId, cursor: op.nextCursor! })}>{t("次のページ")}</button>}
   </div>
   <details><summary>{t("計画IDを指定")}</summary><p>{t("別の送り先は --server または VS Code の boxglow.sync.server で指定できます。")}</p>
    <input className="input" aria-label={t("計画ID")} value={id} onChange={e => setId(e.target.value)} maxLength={256}/>
    <button className="btn btn-sm" disabled={!id.trim() || unsaved} onClick={() => void request({ kind: "openProject", operationId: op.operationId, projectId: id.trim(), destination, name })}>{t("開く")}</button>
   </details>
  </>}
  {/* コードや URL を出している間は、その欄の「中止」だけにする (同じ画面に 2 つ出さない) */}
  {!(receive && status.signIn) && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void request({ kind: "cancelBegin" })}>{t("中止")}</button>}
 </section>;
}
