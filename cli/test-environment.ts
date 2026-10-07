/** テストを起動したエージェントの識別を子プロセスや直接呼出しへ持ち込まない。 */
const identityKeys = ["BOXGLOW_ACTOR", "CLAUDECODE", "CLAUDE_CODE", "CODEX_HOME", "CODEX_SANDBOX", "CODEX_THREAD_ID", "CODEX_SESSION_ID"];
for (const key of identityKeys) delete process.env[key];
