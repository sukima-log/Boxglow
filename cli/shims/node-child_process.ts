/** node:child_process の代替 (Workers)。子プロセス (git など) は使えない */
const unavailable = (name: string) => () => { throw new Error(`${name} is not available in the hosted environment`); };
export const execFileSync = unavailable("execFileSync");
export const execSync = unavailable("execSync");
export const spawnSync = unavailable("spawnSync");
export const spawn = unavailable("spawn");
export default { execFileSync, execSync, spawnSync, spawn };
