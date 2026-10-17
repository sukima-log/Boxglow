/**
 * node:fs の代替 (Workers で CLI の処理を束ねるときに差し込む)。ファイルは無いので、読むと「無い」、書くと失敗にする
 * ホスト型の MCP では計画の読み書きは plan-io (メモリ版) を通るので、ここに来るのは Node 専用の機能 (資格情報・テンプレート・git など) だけ
 */
const unavailable = (name: string) => () => { throw new Error(`${name} is not available in the hosted environment`); };
export const existsSync = (): boolean => false;
export const readFileSync = unavailable("readFileSync");
export const writeFileSync = unavailable("writeFileSync");
export const appendFileSync = unavailable("appendFileSync");
export const mkdirSync = (): string | undefined => undefined;
export const mkdtempSync = unavailable("mkdtempSync");
export const readdirSync = (): string[] => [];
export const statSync = unavailable("statSync");
export const lstatSync = unavailable("lstatSync");
export const fstatSync = unavailable("fstatSync");
export const realpathSync = (p: string): string => p;
export const readlinkSync = unavailable("readlinkSync");
export const renameSync = unavailable("renameSync");
export const rmSync = (): void => {};
export const unlinkSync = (): void => {};
export const copyFileSync = unavailable("copyFileSync");
export const linkSync = unavailable("linkSync");
export const symlinkSync = unavailable("symlinkSync");
export const chmodSync = (): void => {};
export const fchmodSync = (): void => {};
export const utimesSync = (): void => {};
export const openSync = unavailable("openSync");
export const closeSync = (): void => {};
export const writeSync = unavailable("writeSync");
export const fsyncSync = (): void => {};
export const watch = unavailable("watch");
export default { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync };
