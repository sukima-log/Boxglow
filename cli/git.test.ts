import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { findGitRef, gitRefFor } from "./git";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
it("pins only content actually present in HEAD; changed and untracked deliverables stay local", () => {
  const root = mkdtempSync(join(tmpdir(), "boxglow-artifact-")); dirs.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  const file = join(root, "code.txt"); writeFileSync(file, "first\n");
  expect(gitRefFor(file)).toBeNull();
  git("add", "code.txt"); git("commit", "-m", "fixture");
  expect(gitRefFor(file)?.commit).toMatch(/^[a-f0-9]{40}$/);
  writeFileSync(file, "edited\n"); expect(gitRefFor(file)).toBeNull();
  const untracked = join(root, "new.txt"); writeFileSync(untracked, "new\n"); expect(gitRefFor(untracked)).toBeNull();
});
it("未コミットで記録した成果物 (ローカル参照) は、コミット後の check で Git 参照に補完される", () => {
  const root = mkdtempSync(join(tmpdir(), "boxglow-artifact-")); dirs.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  const plan = join(root, "boxglow.json");
  const bin = resolve("bin/boxglow.js");
  // 計画のあるフォルダで CLI を実行する (成果物のパスは相対で渡す)
  const cli = (...args: string[]) => spawnSync(process.execPath, [bin, ...args, "--file", plan, "--actor", "codex", "--lang", "en"], { cwd: root, encoding: "utf8" });
  const artifactOf = () => Object.values(JSON.parse(readFileSync(plan, "utf8")).ports as Record<string, { artifacts: { title: string; kind: string; path?: string; commit?: string; blob?: string; state?: string }[] }>).flatMap((p) => p.artifacts).find((a) => a.title === "Code")!;
  expect(cli("init", "--name", "Fixture").status).toBe(0);
  expect(cli("add", "Task", "--out", "Code").status).toBe(0);
  writeFileSync(join(root, "code.txt"), "first\n");
  const done = cli("done", "Task", "--artifact", "Code=code.txt"); expect(done.status, done.stderr).toBe(0);
  expect(artifactOf().kind).toBe("file");
  // 未コミットの間は、check をしてもローカル参照のまま
  expect(cli("check").status).toBe(0); expect(artifactOf().kind).toBe("file");
  expect(findGitRef("code.txt", [root])).toBeNull();
  git("add", "code.txt"); git("commit", "-m", "deliverable");
  const checked = cli("check"); expect(checked.status, checked.stderr).toBe(0);
  expect(checked.stdout).toContain("code.txt");
  const a = artifactOf();
  expect(a.kind).toBe("git"); expect(a.path).toBe("code.txt"); expect(a.state).toBe("ok");
  expect(a.commit).toMatch(/^[a-f0-9]{40}$/); expect(a.blob).toMatch(/^[a-f0-9]{40}$/);
  // コミット後に中身を変えた別の成果物は、補完されない (HEAD と中身が違う)
  writeFileSync(join(root, "code.txt"), "edited\n");
  expect(findGitRef("code.txt", [root])).toBeNull();
}, 30000);
