# Feature-Voting: self-hosted survey for ranking app features, with a live result view

Participants sort features into "Das will ich! / Das wäre nett / Brauche ich nicht",
the organizer watches a Mentimeter-style live view.
Plain Node (>= 22.13, built-in `node:sqlite`), no framework, SortableJS as the only dependency.
Read `README.md` (pages, `config.json`, scoring, privacy) before changing behavior.

## Commands

```sh
npm install
npm run dev                      # ADMIN_TOKEN=dev, node --watch; overview http://localhost:3000/?token=dev
docker compose up -d --build     # production (needs ADMIN_TOKEN in .env)
```

No lint or test suite yet.

## Commit & release rules

- **Commit incrementally and atomically**:
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
  (jscodeshift / ts-morph / `gofmt -r`), not hand edits;
  write it, run it, review the diff.

## Architecture

- `server.js`: routing only. Pages `/` (= `/admin`, survey overview), `/<survey>`, `/<survey>/live`;
  JSON API under `/api/surveys/<survey>/…` plus `/api/responses/<id>` (contact PATCH, admin DELETE); per-survey SSE.
- `lib/db.js`: SQLite (`$DATA_DIR/responses.db`), tables `surveys` (id + JSON data) and `responses` (`survey_id`),
  plus the one-off migration of the original single survey from `migrations/semino.json`.
- `lib/survey.js`: pure logic: survey/response validation, scoring (`aggregate`), CSV.
- `lib/http.js`: send/readBody, admin token check, in-memory rate limit.
- `public/index.html` + `survey.js` + `style.css`: the survey (drag & drop, 💬 comment per option, own ideas, DE/EN UI, local draft per survey).
- `public/live.html` + `live.js` + `live.css`: public live view for the projector (tabs in the URL hash: bars, d3-force cluster, QR join screen until the first answer, survey editor and response list behind the token; own ideas).
- `public/admin.html` + `admin.js` + `admin.css`: survey list and "new survey", behind the token.
- `config.json`: global settings only (privacy text, idea limit).

## Invariants

- Option `id`s never change once a survey has responses: answers reference them.
- Survey content is plain strings in the survey's own language; only the UI chrome is DE/EN.
- No external requests from the pages (no CDN, no Google Fonts): GDPR promise in the README.
- No IP addresses persisted; the IP lives only in memory for the rate limit.
- Live view and stream are public (aggregates and idea texts only);
  names and emails leave the server only via the token-protected response list and CSV export.
- The SSE stream must not be buffered by a proxy in front.

## Deployment

- Production: poly1 (`/srv/feature-voting`), behind the Caddy container `srv-caddy-1`
  via the external Docker network `noas-shared`; https://vote.polygon.gmbh.
- Deploy: `git push poly1 main`; the server checkout (`receive.denyCurrentBranch=updateInstead`)
  updates its tree and a `post-receive` hook runs `docker compose up -d --build` + `/healthz`.
  Push to `origin` (GitHub) too; the server's `origin` fetches from there.
- `.env` (ADMIN_TOKEN) and `data/` exist only on the server, never in git.
- Server-side history lives in heinzel (`memory/servers/poly1/`).

## Extended docs

- Decisions, rationale, and major turning points live in `docs/`, not inline; this file points.
- `docs/history.md`: how the app came to be (Janek's input verbatim, turning points, how the PHP port came about).
- `docs/open-points.md`: undecided questions and pending work; read before changing the live view.
- **One fact, one home**: each topic owned by exactly one doc;
  narrative docs (history, status, plans) link into it, never restate it.
- **Delete plan docs once shipped**; don't leave a stale third copy.
- Before editing any `.md` file, read its first three lines (heading, scope, neighbors) and keep them true in the same edit,
  put what the scope excludes where the neighbors point, and keep file-describing prose to those lines.
