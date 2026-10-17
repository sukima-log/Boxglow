/** サーバー上の計画管理。確認の控えに送り先・利用者・世代・版・操作IDを固定し、手元の計画や同期状態は変更しない。 */
import { syncAudienceFor } from "../actor";
import { randomUUID } from "node:crypto";
import { resolveToken } from "./credentials";
import { normalizeServer, hashOf } from "./state-store";
import { serverProblem } from "./login";
import { unquote } from "./client";
import { t } from "../../src/i18n/core";
import { applyRevert, parseVersionList, planNameOf, type VersionEntry } from "../../src/sync/versions";
import { nodeSyncIO } from "./node-io";
export interface LifecycleOptions { server:string; fetch?:typeof fetch; allowEnvironmentToken?:boolean }
export interface TrashProject {id:string;name:string;revision:string;deletedAt:string;expiresAt:string;restoredId:string|null;restorable:boolean}
export interface LifecyclePreview {kind:"delete"|"restore"|"revert";server:string;account:string;epoch:string;id:string;name:string;revision:string;expiresAt?:string;targetId?:string;opId:string;credential:string;
 /** revert のとき: 戻す版の中身 (画面の状態には出さない) */
 text?:string}
/** 設定を確かめてから資格情報を読む。転送・無期限の待機は許さない。 */
function connection(o:LifecycleOptions) {
  const server=normalizeServer(o.server), problem=serverProblem(server);
  if(problem) throw new Error(problem);
  const credential=resolveToken(server,o.allowEnvironmentToken);
  if(!credential) throw new Error(t("先にサインインしてください"));
  const request=async(path:string,init:RequestInit={})=>{
    const res=await (o.fetch ?? fetch)(server+path,{...init,headers:{authorization:`Bearer ${credential.token}`,...init.headers},redirect:"error",signal:AbortSignal.timeout(30000)});
    if(!res.ok) {
      const message=res.status === 412 ? t("確認後に計画が更新されました。確認を閉じて、最新の内容を読み直してください。")
        : res.status === 409 ? t("サーバーの状態が変わりました。確認を閉じて、対象を選び直してください。")
        : res.status === 507 ? t("サーバーの保存上限に達しています。管理者に確認してください。")+" "+t("削除した計画も30日間は保存量に含まれます。")
        : res.status === 404 ? t("このサーバーは操作に対応していないか、対象の計画がありません。")
        : t("計画の操作を完了できませんでした。状態を確認してください。");
      throw new Error(message+` (HTTP ${res.status})`);
    }
    return res;
  };
  return {server,credential:hashOf(credential.token),request};
}
/** 一覧は読み取りのみ。ページ単位で返す。 */
export async function listTrash(o:LifecycleOptions,cursor?:string):Promise<{projects:TrashProject[];nextCursor:string|null}> {
  const c=connection(o),res=await c.request(`/v1/trash?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  const data=await res.json();
  if(!Array.isArray(data.projects) || data.projects.length > 100 || !(data.nextCursor === null || typeof data.nextCursor === "string" && data.nextCursor.length <= 256)) throw new Error(t("削除済み一覧に対応していないサーバーです。"));
  for(const p of data.projects) if(!p || typeof p.id !== "string" || !p.id || p.id.length > 256 || typeof p.name !== "string" || typeof p.revision !== "string" || typeof p.expiresAt !== "string" || typeof p.deletedAt !== "string" || typeof p.restorable !== "boolean" || !(p.restoredId === null || typeof p.restoredId === "string")) throw new Error(t("削除済み一覧に対応していないサーバーです。"));
  return data;
}
/** 履歴の一覧 (新しい順)。読み取りのみ */
export async function listVersions(o:LifecycleOptions,id:string):Promise<VersionEntry[]> {
  const c=connection(o),res=await c.request(`/v1/projects/${encodeURIComponent(id)}/versions`);
  return parseVersionList(await res.json());
}
/** 戻す前に、その版の中身を読む (確認の控えに中身を持つ。手元のファイルはまだ変えない) */
export async function previewRevert(o:LifecycleOptions,id:string,revision:string):Promise<LifecyclePreview> {
  if(!/^[A-Za-z0-9._-]{1,64}$/.test(revision)) throw new Error(t("版の指定が正しくありません: {rev}",{rev:revision}));
  const c=connection(o),res=await c.request(`/v1/projects/${encodeURIComponent(id)}/versions/${encodeURIComponent(revision)}`);
  const text=await res.text();
  const account=res.headers.get("x-boxglow-account"),epoch=res.headers.get("x-boxglow-epoch");
  if(!account || !epoch) throw new Error(t("計画の操作を完了できませんでした。状態を確認してください。"));
  return {kind:"revert",server:c.server,account,epoch,id,name:planNameOf(text,id),revision,opId:randomUUID(),credential:c.credential,text};
}
/**
 * 版の中身を手元のファイルへ戻す (控えを取ってから)。サーバーの履歴は変えない
 * Input : file = 計画のファイル, p = previewRevert の控え。Output: { backup } (控えの場所)
 */
export async function commitRevert(o:LifecycleOptions,file:string,p:LifecyclePreview):Promise<{backup:string|null}> {
  const c=connection(o);
  if(p.kind !== "revert" || typeof p.text !== "string") throw new Error(t("計画の操作を完了できませんでした。状態を確認してください。"));
  if(c.server !== p.server || c.credential !== p.credential) throw new Error(t("表示したときから、状態が変わっています。選び直してください"));
  return applyRevert(nodeSyncIO(file,c.server),p.text);
}
/** 削除・復元の前に対象を読む。取得した版以外は後で削除できない。 */
export async function previewLifecycle(o:LifecycleOptions,kind:"delete"|"restore",id:string):Promise<LifecyclePreview> {
  const c=connection(o);let name=id,revision="",expiresAt:string|undefined, res:Response;
  if(kind === "delete") {
    res=await c.request(`/v1/projects/${encodeURIComponent(id)}`);
    // 版は ETag から取る。弱い印 (W/"…"。Cloudflare が圧縮のときに付ける) も、同期と同じ規則で外す
    revision=unquote(res.headers.get("etag")) ?? "";
    const body=await res.json(); if(typeof body.name === "string") name=body.name.slice(0,512);
  } else {
    // IDで始まるページを直接取得せず、公開一覧と同じ境界を通す。
    let cursor:string|undefined; let found:TrashProject|undefined;
    const seen=new Set<string>();
    for(let page=0;page<1000;page++) {
      res=await c.request(`/v1/trash?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      const data=await res.json();if(!Array.isArray(data.projects)) break;
      found=data.projects.find((p:TrashProject)=>p.id===id);if(found || !data.nextCursor) break;
      if(typeof data.nextCursor !== "string" || seen.has(data.nextCursor)) break;
      seen.add(data.nextCursor);cursor=data.nextCursor;
    }
    if(!found?.restorable) throw new Error(t("この計画は復元できません。期限または復元済みの記録を確認してください。"));
    name=found.name;revision=found.revision;expiresAt=found.expiresAt;
  }
  const account=res!.headers.get("x-boxglow-account"),epoch=res!.headers.get("x-boxglow-epoch");
  if(!account || !epoch || !revision) throw new Error(t("計画の操作を完了できませんでした。状態を確認してください。"));
  return {kind,server:c.server,account,epoch,id,name,revision,expiresAt,opId:randomUUID(),credential:c.credential,...(kind === "restore" ? {targetId:randomUUID()} : {})};
}
/** 同じ控えで再試行するので、応答が失われても復元先が増えない。 */
export async function commitLifecycle(o:LifecycleOptions,p:LifecyclePreview):Promise<{kind:string;projectId?:string;expiresAt?:string}> {
  const c=connection(o);
  if(c.server !== p.server || c.credential !== p.credential) throw new Error(t("表示したときから、状態が変わっています。選び直してください"));
  const res=await c.request(`/v1/projects/${encodeURIComponent(p.id)}${p.kind === "restore" ? "/restore" : "/trash"}`,{
    method:p.kind === "delete" ? "DELETE" : "POST",headers:{"x-boxglow-epoch":p.epoch,"x-boxglow-op":p.opId,"if-match":`"${p.revision}"`,"content-type":"application/json"},
    ...(p.kind === "restore" ? {body:JSON.stringify({targetId:p.targetId})} : {})});
  if(res.headers.get("x-boxglow-account") !== p.account || res.headers.get("x-boxglow-epoch") !== p.epoch) throw new Error(t("表示したときから、状態が変わっています。選び直してください"));
  const result=await res.json();
  if(p.kind === "delete" ? result.deleted !== true && result.kind !== "deleted" : result.kind !== "restored" || result.projectId !== p.targetId) throw new Error(t("計画の操作を完了できませんでした。状態を確認してください。"));
  return result;
}
/** CLIは初回に読むだけ。表示した確認文字列を人が返したときだけ送信する。 */
export async function runLifecycle(o:LifecycleOptions & {command:string;id?:string;confirm?:string;actor?:string;cursor?:string;revision?:string;file?:string},out:(s:string)=>void):Promise<number> {
  try {
    if(o.command === "trash") {out(JSON.stringify(await listTrash(o,o.cursor),null,2));return 0;}
    // 履歴の一覧: 読むだけ
    if(o.command === "versions") {
      if(!o.id) throw new Error("boxglow remote versions <ID> [--server URL]");
      out(JSON.stringify(await listVersions(o,o.id),null,2));return 0;
    }
    // 履歴の版へ戻す: 手元のファイルを置き換える (控えを取る)。人の明示が要る。サーバーの履歴は変えず、次の同期で新しい版として送られる
    if(o.command === "revert") {
      if(!o.id || !o.revision || !o.file) throw new Error("boxglow remote revert <ID> <版> --file <計画のファイル> --actor human [--server URL]");
      if(!o.actor || !/^human(?::.+)?$/.test(o.actor)) throw new Error(t("履歴の版へ戻す操作は、人が --actor human を明示して実行してください。"));
      const p=await previewRevert(o,o.id,o.revision);
      const {backup}=await commitRevert(o,o.file,p);
      out(t("版 {rev} の中身を手元のファイルに戻しました: {file}",{rev:o.revision,file:o.file}));
      if(backup) out(t("置き換える前の中身の控え: {path}",{path:backup}));
      out(t("サーバーの履歴は変わりません。次の同期で、新しい版として送られます。"));
      return 0;
    }
    if((o.command !== "delete" && o.command !== "restore") || !o.id) throw new Error("boxglow remote delete|restore <ID> | trash [--server URL]");
    if(!o.confirm) {
      const p=await previewLifecycle(o,o.command,o.id);
      out(JSON.stringify({...p,credential:undefined},null,2));
      out(t("削除は30日間復元できます。手元のファイルは残ります。復元は新しいサーバーIDになり、一覧から開き直します。"));
      if(syncAudienceFor(o.actor) === "ai") {out(t("この操作は人の確認が必要です。対象と影響を要約し、人に画面またはCLIで確認を依頼してください。"));return 0;}
      out(t("対象を確認して、人が --actor human --confirm <確認文字列> を付けて再実行してください。"));
      out("CONFIRM "+Buffer.from(JSON.stringify(p)).toString("base64url"));return 0;
    }
    if(!o.actor || !/^human(?::.+)?$/.test(o.actor)) throw new Error(t("削除と復元の確定は、人が --actor human を明示して実行してください。"));
    if(o.confirm.length > 8192) throw new Error("Invalid confirmation");
    const p=JSON.parse(Buffer.from(o.confirm,"base64url").toString("utf8")) as LifecyclePreview;
    if(p.kind !== o.command || p.id !== o.id || ![p.opId,p.epoch,p.revision,p.account,p.server,p.credential].every(v=>typeof v === "string" && v.length > 0) || (p.kind === "restore" && typeof p.targetId !== "string")) throw new Error("Invalid confirmation");
    out(JSON.stringify(await commitLifecycle(o,p),null,2));return 0;
  } catch(e) {out(e instanceof Error ? e.message : String(e));return 1;}
}
