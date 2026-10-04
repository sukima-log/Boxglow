/**
 * Git 連携 (CLI 専用): 成果物を「コミット + パス + blob」で記録し、移動に追従する
 * どこにもアップロードしない。参照だけを boxglow.json に書く。
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

/** git コマンドを実行して標準出力を返す (失敗したら null) */
function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export interface GitRef {
  /** リポジトリ直下 (絶対パス) */
  root: string;
  /** リモート URL (無ければ空) */
  repo: string;
  /** リポジトリ直下からのパス */
  path: string;
  commit: string;
  blob: string;
  /** リモートが GitHub / GitLab 形式なら、コミット固定の閲覧 URL */
  url: string;
}

/** リモート URL をブラウザで開ける https の形にする (git@github.com:org/repo.git -> https://github.com/org/repo) */
export function remoteToWeb(remote: string): string | null {
  let m = remote.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = remote.match(/^(https?:\/\/[^/]+\/.+?)(\.git)?$/);
  if (m) return m[1];
  m = remote.match(/^ssh:\/\/git@([^/]+)\/(.+?)(\.git)?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  return null;
}

/**
 * ファイルの Git 参照を取る (Git 管理下でなければ null)
 * Input : filePath = 相対または絶対パス
 * Output: GitRef
 */
export function gitRefFor(filePath: string): GitRef | null {
  const abs = resolve(filePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  const root = git(["rev-parse", "--show-toplevel"], dirname(abs));
  if (!root) return null;
  const rel = relative(root, abs).replace(/\\/g, "/");
  const commit = git(["rev-parse", "HEAD"], root) ?? "";
  // 作業ツリーの中身のハッシュ (--path で、そのパスの改行変換などの設定を当てた値にする)
  const blob = git(["hash-object", "--path", rel, "--", abs], root) ?? "";
  // HEAD にコミット済みで、中身が同じときだけ Git の参照にする。
  // 未コミット・未追跡・変更中のファイルは null を返す (呼び出し側はローカルのファイル参照として記録する。コミットに無い中身を「コミット + パス」で指さないため)
  const committedBlob = commit ? git(["rev-parse", `${commit}:${rel}`], root) : null;
  if (!blob || !committedBlob || blob !== committedBlob) return null;
  const repo = git(["config", "--get", "remote.origin.url"], root) ?? "";
  const web = repo ? remoteToWeb(repo) : null;
  const url = web && commit ? `${web}/blob/${commit}/${rel}` : "";
  return { root, repo, path: rel, commit, blob, url };
}

/**
 * 記録済みのパスから Git 参照を探す (ローカル参照として記録した成果物を、後から Git の参照に補完するとき用)
 * Input : recorded = 記録したときのパス (相対または絶対), bases = 相対パスの基準にするフォルダの候補 (先頭から順に試す)
 * Output: 今 HEAD にコミット済みで中身が一致していれば GitRef、そうでなければ null (未コミット・変更中・ファイルが無い)
 */
export function findGitRef(recorded: string, bases: string[]): GitRef | null {
  for (const base of bases) {
    const ref = gitRefFor(resolve(base, recorded));
    if (ref) return ref;
  }
  return null;
}

/** いまの HEAD でのパス・コミット・blob・URL */
function currentRef(root: string, rel: string): { path: string; commit: string; blob: string; url: string } {
  const commit = git(["rev-parse", "HEAD"], root) ?? "";
  // gitRefFor と同じく、そのパスの改行変換などの設定を当てたハッシュにする (記録した blob と比べられるように)
  const blob = git(["hash-object", "--path", rel, "--", resolve(root, rel)], root) ?? "";
  const repo = git(["config", "--get", "remote.origin.url"], root) ?? "";
  const web = repo ? remoteToWeb(repo) : null;
  return { path: rel, commit, blob, url: web && commit ? `${web}/blob/${commit}/${rel}` : "" };
}

/**
 * 記録済みの Git 参照が今も有効か確かめ、移動していればパスを探す
 * Input : ref = { path, blob, commit }, cwd = リポジトリ内のどこか
 * Output: { state, path } (moved なら新しいパス)
 */
export function checkGitRef(ref: { path?: string; blob?: string; commit?: string }, cwd: string): { state: "ok" | "moved" | "missing"; path?: string; commit?: string; blob?: string; url?: string } {
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  if (!root || !ref.path) return { state: "missing" };
  if (existsSync(resolve(root, ref.path))) return { state: "ok", path: ref.path };
  // 1. 中身 (blob) が同じファイルを HEAD の木から探す (移動・改名で中身が変わっていない場合)
  if (ref.blob) {
    const tree = git(["ls-tree", "-r", "HEAD"], root) ?? "";
    for (const line of tree.split("\n")) {
      const m = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
      if (m && m[1] === ref.blob) return { state: "moved", ...currentRef(root, m[2]) };
    }
  }
  // 2. 記録したコミットから HEAD までの各コミットで改名 (R) を追い、現在のパスにたどり着く (中身が変わっていても追える)
  if (ref.commit) {
    const commits = (git(["rev-list", "--reverse", `${ref.commit}..HEAD`], root) ?? "").split("\n").filter(Boolean).slice(0, 2000);
    let cur = ref.path;
    for (const c of commits) {
      const diff = git(["diff-tree", "-M", "--name-status", "-r", `${c}^`, c], root) ?? "";
      for (const line of diff.split("\n")) {
        const m = line.match(/^R\d+\t(.+)\t(.+)$/);
        if (m && m[1] === cur) cur = m[2];
      }
    }
    if (cur !== ref.path && existsSync(resolve(root, cur))) return { state: "moved", ...currentRef(root, cur) };
  }
  return { state: "missing" };
}
