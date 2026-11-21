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
3. **Sources & Settings**: paste the job board address (or any job link) of companies you like.
   Supported, via each system's public job feed:

   | System | Address | Example |
   | --- | --- | --- |
   | Greenhouse | `job-boards.greenhouse.io/<company>` | `https://job-boards.greenhouse.io/gitlab` |
   | Lever | `jobs.lever.co/<company>` | |
   | Ashby | `jobs.ashbyhq.com/<company>` | `https://jobs.ashbyhq.com/ramp` |
   | Personio | `<company>.jobs.personio.de` | `https://1komma5grad.jobs.personio.de` |
   | Recruitee | `<company>.recruitee.com` | `https://bunq.recruitee.com` |
   | Workable | `apply.workable.com/<company>` | `https://apply.workable.com/huggingface` |
   | SmartRecruiters | `jobs.smartrecruiters.com/<company>` | `https://jobs.smartrecruiters.com/BoschGroup` |

   SmartRecruiters needs one request per job description, so large employers load the newest
   1,000 postings and fill in descriptions 150 at a time on each refresh. LinkedIn, Indeed,
   StepStone and XING forbid automated access, and Workday has no public feed, so they are not supported.
4. **Job Explorer**: filter by country, city, date posted (24 hours to a month), employment type, workplace
   (remote/hybrid/on-site), seniority, source, company and CV tags. Countries are worked out from
   each posting's location (city names included, e.g. Göttingen → Germany). A country in your
   preferred locations (e.g. `Germany`) covers its cities and Europe-wide remote jobs, and remote
   jobs limited to other countries ("Remote - US") are filtered out. Filters are kept in the page
   address, so you can bookmark a search. Employment type and workplace come from Lever and Ashby
   directly and are inferred from the title and description for Greenhouse. Open a job and choose
   **Prepare application**.
5. **Approval Queue**: check the resume, cover letter and answers, then **Approve**.
   **Open & pre-fill apply form** opens a browser window with the employer's form filled in;
   review it, submit it there, then click **I submitted it**.

## Share jobs and resumes

In **Email Management → Manage workspace access**, create an invitation for the
delegate's Job Agent email and share the one-time code privately. The delegate
signs in with their own account, accepts the code there, and selects the shared
workspace. They can update imported job statuses. Gmail import stays in the
mailbox owner's workspace. After saving the recognized jobs, the importer marks
the alert as read. Alerts with no recognized jobs or failed saves remain unread.

Set `RESUME_BUILDER_ROOT` to the absolute path of the Resume Builder checkout
and restart Job Agent. Its menu opens a new tab with the same session and the
selected workspace. Editable documents are stored in Job Agent's PostgreSQL
database. Transfer existing Resume Builder documents using its JSON export and
import. The owner can revoke a delegate from Email Management.

## Connect Gmail locally

In the Google Cloud project with the Gmail API enabled, configure Google Auth Platform
for an external testing audience and add the mailbox owner as a test user. Add the
`https://www.googleapis.com/auth/gmail.modify` scope. Create a Web application OAuth
client with this authorized redirect URI:

```text
http://localhost:5173/api/me/gmail/callback
```

Set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI` and `GMAIL_TOKEN_KEY`
in the local `.env`. Generate the stable encryption key with
`node -p "require('node:crypto').randomBytes(32).toString('base64')"`.
Run the migrations, restart the API, then open the app at `http://localhost:5173` and
select **Sources & Settings → Gmail → Connect Gmail**. The connection is per signed-in
Job Agent account. This connection setup stores access for a future job-alert import.

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

39 tests run against the local database: cross-user isolation (API and row-level security),
byte-identical read-only resumes, approval invalidation on edit, idempotent submission records,
and form pre-fill on Greenhouse/Lever/Ashby-style forms without submitting.

## Layout

```
apps/api   NestJS + PostgreSQL (row-level security), no Redis
  migrations/001_init.sql   schema, RLS policies, role grants
  src/sources               job board adapters (7 systems), classification, scheduler
  src/matching              free rule-based scoring with explanations
  src/ai                    provider abstraction (Ollama / OpenAI-compatible / Claude), prompts, budget
  src/drafts.ts             prepare → approve → assist/hand-off → submitted
  src/assist.ts             Playwright pre-fill, never submits
apps/web   React 19 + Vite + MUI + MUI X Data Grid (community) + Tailwind
```
