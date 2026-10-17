/**
 * Windows の DPAPI (Data Protection API) で、文字列を「同じ Windows ユーザーだけが復号できる形」にする (B187)
 *   Node 単体では呼べないので、Windows PowerShell (5.1。どの Windows にもある) を子プロセスで使う。
 *   秘密はコマンドラインに載せず、標準入力で渡す。ファイルを別の場所や別のユーザーにコピーされても復号できない
 * Input : 平文 / base64 の暗号文。Output: base64 の暗号文 / 平文。失敗は例外
 */
import { execFileSync } from "node:child_process";

const PS = "powershell.exe";
const PROTECT = "[Console]::InputEncoding=[Text.Encoding]::UTF8; $in=[Console]::In.ReadToEnd(); Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes($in); $p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($p))";
const UNPROTECT = "[Console]::InputEncoding=[Text.Encoding]::UTF8; $in=[Console]::In.ReadToEnd().Trim(); Add-Type -AssemblyName System.Security; $p=[Convert]::FromBase64String($in); $b=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,'CurrentUser'); [Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))";

function run(script: string, input: string): string {
  return execFileSync(PS, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { input, encoding: "utf8", windowsHide: true, timeout: 20_000, stdio: ["pipe", "pipe", "pipe"] });
}

/** 実装の差し替え口 (試験では PowerShell を呼ばずに、可逆な偽物を使う) */
export interface Dpapi { protect: (text: string) => string; unprotect: (sealed: string) => string }
let impl: Dpapi = {
  protect: (text) => run(PROTECT, text).trim()
, unprotect: (sealed) => run(UNPROTECT, sealed)
};
export function setDpapi(next: Dpapi | null): void { impl = next ?? { protect: (text) => run(PROTECT, text).trim(), unprotect: (sealed) => run(UNPROTECT, sealed) }; available = null; }
export const dpapi: Dpapi = { protect: (t) => impl.protect(t), unprotect: (s) => impl.unprotect(s) };

/** この環境で DPAPI が使えるか (1 度だけ試して覚える)。Windows 以外は false */
let available: boolean | null = null;
export function dpapiAvailable(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return false;
  if (available === null) { try { available = dpapi.unprotect(dpapi.protect("probe")) === "probe"; } catch { available = false; } }
  return available;
}
