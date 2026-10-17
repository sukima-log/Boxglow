/** node:os の代替 (Workers)。ホームや一時フォルダは無い (資格情報の置き場などは使われない) */
export const homedir = (): string => "/";
export const tmpdir = (): string => "/tmp";
export const platform = (): string => "linux";
export const hostname = (): string => "worker";
export const EOL = "\n";
export default { homedir, tmpdir, platform, hostname, EOL };
