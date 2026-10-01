# CLAUDE.md

Media processing pipeline (Aragon Part 2). Read `docs/ARCHITECTURE.md` before changing behaviour. It is the spec, and code that diverges must update it.

## Runtime
- **Node 22 only** (`.nvmrc`): sharp 0.35's ESM build breaks on Node 20.9. pnpm workspaces, run with `tsx`, no build step.
- Postgres 16 locally (brew). No Docker, no Redis: the queue is the `tasks` table.

## Rules
- Migrations: `pnpm db:migrate` (Claude may run it in this repo). Raw SQL Prisma can't express (CHECKs, partial indexes) is listed in schema comments and must be appended to the generated migration (`--create-only` first).
- Every queue transition goes through `packages/core/src/queue.ts` and must stay fenced (`locked_by` + `run`). Handlers never touch the DB.
- Handlers wrap decode of *user input* in `PermanentError`; everything else is transient. Never classify by error message text.
- S3 keys come only from `core/keys.ts` (ids only, stage-first prefixes). User-facing error text comes only from `core/errors.ts`.
- Every DB read in the API is scoped by `userId`. Another user's id returns 404.
- Use `log()` (JSON `console.log`), no logging framework.
- Before finishing: `pnpm typecheck`, `pnpm test`, and `pnpm check` after any pipeline run.
