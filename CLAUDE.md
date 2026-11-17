# Feature-Voting — self-hosted survey for ranking app features, with a live result view

Participants sort features into "Das will ich! / Das wäre nett / Brauche ich nicht",
the organizer watches a Mentimeter-style live view.
Plain Node (>= 22.13, built-in `node:sqlite`), no framework, SortableJS as the only dependency.
Read `README.md` (pages, `config.json`, scoring, privacy) before changing behavior.

## Commands

```sh
npm install
npm run dev                      # ADMIN_TOKEN=dev, node --watch; survey on :3000, live view /live?token=dev
docker compose up -d --build     # production (needs ADMIN_TOKEN in .env)
```

No lint or test suite yet.

## Commit & release rules

- **Commit incrementally and atomically** —
  one cohesive change per commit, never bundle unrelated changes or defer commits into one late batch.
- **Every commit green**: lint + tests clean before each commit, not just at session end.
- **Conventional Commits** (`feat:`, `fix:`, `test:`, `docs:`, `chore:` …).
- Keep `README.md` / `docs/` in step with behavior changes in the same series.
- **`CHANGELOG.md` is curated, not per-commit**:
  user-observable deltas only, grouped by version, curated at bump time.
- **Version bumps** (pre-1.0 `0.x`, breaking → minor):
  propose after a major change or once small ones pile up; never bump silently mid-feature.

## Code standards

- Max ~300 lines per file; split at natural boundaries. Modularity over bloat.
- Comments only for non-obvious constraints;
  side-effectful effects get a one-line `// why:` (trigger + observable result).
- **Semantic linebreaks** in Markdown/docs: one clause per line.
- Tests: behavior over implementation detail;
  extract pure logic so it's testable without the framework.

## Working with subagents & tools

- Offload research and large implementations to subagents rather than crowding one session:
  a **Sonnet** subagent for scoped research or mechanical work,
  an **Opus** subagent for design-heavy or cross-cutting implementation.
  Hand each the full spec + the relevant `docs/` pointer.
- For "where does X live" questions, prefer a code-graph tool over growing Architecture below.
- Large mechanical refactors go through a codemod
  (jscodeshift / ts-morph / `gofmt -r`), not hand edits —
  write it, run it, review the diff.

## Architecture

- `server.js` — the whole backend: SQLite (`$DATA_DIR/responses.db`), hot-reloaded `config.json`,
  aggregation/scoring, JSON API (`/api/config`, `/api/responses`), SSE (`/api/stream`), CSV export, `/healthz`.
- `public/index.html` + `survey.js` + `style.css` — the survey (drag & drop, own ideas, DE/EN, local draft).
- `public/live.html` + `live.js` + `live.css` — token-protected live view (bars, cluster, own ideas).
- `config.json` — texts, TestFlight link, feature list; mounted read-only in Docker.
- `public/backend.js`: endpoint URLs and live transport (SSE for Node, polling for PHP), switched by `<meta name="fv-backend">`.
- `php/`: PHP port (`api.php`) and `build.sh`, which assembles a HestiaCP layout from `public/`; see `php/README.md`.

## Invariants

- Feature `id`s in `config.json` never change once responses exist — answers reference them.
- No external requests from the pages (no CDN, no Google Fonts) — GDPR promise in the README.
- No IP addresses persisted; the IP lives only in memory for the rate limit.
- The admin token is stripped from the address bar after load, so it never shows on a projector.
- `/api/stream` is SSE: any proxy in front must not buffer it.
- Scoring and validation exist twice, in `server.js` and `php/api.php`: change both in the same commit.
- `public/` stays backend-agnostic: no hardcoded API paths outside `public/backend.js`.

## Deployment

- Production: poly1 (`/srv/feature-voting`), behind the Caddy container `srv-caddy-1`
  via the external Docker network `noas-shared`; https://vote.polygon.gmbh.
- Deploy: `git push poly1 main` — the server checkout (`receive.denyCurrentBranch=updateInstead`)
  updates its tree and a `post-receive` hook runs `docker compose up -d --build` + `/healthz`.
  Push to `origin` (GitHub) too; the server's `origin` fetches from there.
- `.env` (ADMIN_TOKEN) and `data/` exist only on the server, never in git.
- Server-side history lives in heinzel (`memory/servers/poly1/`).

## Extended docs

- Decisions, rationale, and major turning points live in `docs/`, not inline; this file points.
- **One fact, one home**: each topic owned by exactly one doc;
  narrative docs (history, status, plans) link into it, never restate it.
- **Delete plan docs once shipped** — don't leave a stale third copy.
- Before editing any `.md` file, read its first three lines — heading, scope, neighbors — keep them true in the same edit,
  put what the scope excludes where the neighbors point, and keep file-describing prose to those lines.
