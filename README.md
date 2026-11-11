# Job Agent

[![CI](https://github.com/GopiKrishnaGummadidala/job-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/GopiKrishnaGummadidala/job-agent/actions/workflows/ci.yml)

Finds jobs on company job boards, ranks them against your profile, prepares applications, and
pre-fills employer forms, but **only after you approve each application, and you always click Submit yourself**.
Resumes are read-only here; you edit them in the separate Resume Builder.

Plan review and the reasoning behind the cost choices: [docs/PLAN-REVIEW.md](docs/PLAN-REVIEW.md).

## Run locally

Requires Node 24+ and Docker Desktop.

```bash
cp .env.example .env
npm install
npm run db:up
npm run migrate
```

Then, in two terminals:

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Open http://localhost:5173, create an account, then:

1. **Profile & Preferences**: add skills, target roles and locations.
2. **Resume Library**: upload your existing PDF/DOCX CVs and tag each one, e.g. `.NET`, `Node`, `Angular`.
   In the Job Explorer, the **CV tags** filter shows jobs mentioning any (or all) chosen tags, and
   each application starts with the CV whose tags the job mentions. Common spellings count too:
   `.NET` also finds C#, `Node` finds Node.js.
3. **Sources & Settings**: paste board URLs, e.g. `https://job-boards.greenhouse.io/gitlab`,
   `https://jobs.ashbyhq.com/ramp`, `https://jobs.lever.co/<company>`.
4. **Job Explorer**: open a job and choose **Prepare application**.
5. **Approval Queue**: check the resume, cover letter and answers, then **Approve**.
   **Open & pre-fill apply form** opens a browser window with the employer's form filled in;
   review it, submit it there, then click **I submitted it**.

Browser pre-fill (`ASSIST=local`) opens Chromium on the machine running the API. If Playwright's
browser is not installed yet: `npx playwright install chromium`.

## AI providers (optional, per user)

Choose in **Sources & Settings**. Without one, matching is rule-based and cover letters use a template; both cost nothing.

| Provider | Setup | Cost |
| --- | --- | --- |
| Ollama | Install from ollama.com, `ollama pull llama3.2` | Free (local) |
| OpenAI-compatible | `OPENAI_API_KEY`, optional `OPENAI_BASE_URL` | Metered, set `OPENAI_PRICE_IN/OUT` for budget tracking |
| Anthropic Claude | `ANTHROPIC_API_KEY` | Metered; Haiku is the cheapest model |

AI is only called when you click **AI assessment** or **Prepare application**, results are cached
per job version, and paid calls stop at the monthly budget you set.

## Tests

```bash
npm test
```

21 tests run against the local database: cross-user isolation (API and row-level security),
byte-identical read-only resumes, approval invalidation on edit, idempotent submission records,
and form pre-fill on Greenhouse/Lever/Ashby-style forms without submitting.

## Layout

```
apps/api   NestJS + PostgreSQL (row-level security), no Redis
  migrations/001_init.sql   schema, RLS policies, role grants
  src/sources               Greenhouse / Lever / Ashby adapters + scheduler
  src/matching              free rule-based scoring with explanations
  src/ai                    provider abstraction (Ollama / OpenAI-compatible / Claude), prompts, budget
  src/drafts.ts             prepare → approve → assist/hand-off → submitted
  src/assist.ts             Playwright pre-fill, never submits
apps/web   React 19 + Vite + MUI + MUI X Data Grid (community) + Tailwind
```
