# Boxglow development

Boxglow is a React/Vite diagram editor, a Node CLI/MCP server, and a VS Code custom editor. All surfaces share the model in `src/model/` and a schema-v5 `boxglow.json`.

- Read `CLAUDE.md` for the repository's development agreement. The local development plan is ignored by Git; public examples belong in `examples/`.
- Start with `node bin/boxglow.js resume` (or `status --brief`). Before working on a box, read `node bin/boxglow.js context <box>` and keep its `contextToken`; record `start <box> --context-token <token> --actor codex`, and finish with `done <box> --context-token <token> --artifact name=path --actor codex`. After your own change the CLI prints the new token; after a person answers or edits anything, read `context` again. The development plan has the context guard enabled (see below).
- Add findings under "運用で見つかった改善". Keep user decisions in `ask`/`answer`; a recorded decision does not grant publication or deployment permission.
- Edit sources under `cli/` and `src/`, then build the CLI. Do not hand-edit the development plan or generated bundles.
- User-facing text uses New / In Progress / Done. Japanese strings use `t()` with English entries in `src/i18n/en/`. Use the existing 8px spacing scale.
- Run `npm test` and `npm run build` for model/CLI changes. Browser checks: `npm run e2e` (external Playwright path is documented in `e2e/run.sh`). Extension build: `npm run build:vscode`.
- Existing settings and user instructions must survive `setup-agent`; malformed configuration must stop setup before any writes.
- A stored artifact must identify the actual output: unchanged committed files may use a Git reference; uncommitted files remain local references. Do not commit just to attach an artifact.
- Git add/commit/push and package/site publication are performed by the user unless explicitly requested. Keep private plans, credentials and `docs/private/` out of published packages.

## Context and handoff

When `contextGuard` is enabled, read `node bin/boxglow.js context <block>` before work and pass the returned `contextToken` via `--context-token` to guarded commands (including start/done). If rejected, reread and reconcile the current decisions. Save findings, next steps and open questions with `checkpoint <block> --note ... --context-token ...` before handoff or compaction. A checkpoint changes context; obtain a new token afterward. Keep the guard enabled while using it.

If a command reports that another Boxglow writer holds the file lock and waiting does not help, run `node bin/boxglow.js unlock` (read-only), show its output to the user and ask them to remove the lock. Do not pass `--actor human` yourself and do not delete the lock folder.
