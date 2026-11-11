# Review of the AI Job Application Agent plan (v3)

The plan is strong on the right things: explicit per-job approval, read-only resumes, tenant
isolation, and compliant sources. The suggestions below focus on what it leaves open, on cost,
and on what changed when it was built. Items marked **(built)** are in this repository now.

## 1. Cost: what makes this cheap to run

| Decision | Plan | Now | Why |
| --- | --- | --- | --- |
| Queue | BullMQ + Redis | PostgreSQL is the queue (**built**: `boards_due()` + timer) | One stateful service to host instead of two. Move to pg-boss (still Postgres) when you run more than one API instance. |
| Matching | LLM score for relevance | Free rule-based score with explanations; AI only on click (**built**) | Most jobs are filtered out by location, title and skills before any model call. |
| AI caching | Not specified | Assessment cached per posting content hash (**built**) | Re-opening a job never pays twice; a changed posting is re-assessed only on request. |
| Spend limit | "Spend limits" | Per-user monthly USD budget enforced before each paid call (**built**) | Hard stop rather than an alert. Ollama is not counted. |
| Token size | Not specified | Posting clipped to 5k chars, resume to 4k, low effort (**built**) | Caps the cost of each call regardless of posting length. |
| Job fetching | Per user | Shared per board: one fetch serves every subscriber (**built**) | Cost grows with the number of boards, not the number of users. |
| Auth | Managed OIDC provider | Built-in email + password (scrypt), session cookies (**built**) | No auth bill. Swap to OIDC (e.g. Keycloak, Zitadel, Auth0 free tier) before a public launch, when MFA and social login matter. |
| Hosting | Not specified | One small VPS (~€5/month) running Postgres + API + static web | Enough for hundreds of users. Add managed Postgres only when backups/HA justify it. |

**Expected running cost for personal use:** €0 locally; about €5/month on a VPS. AI adds cents per day with
Claude Haiku or an OpenAI mini model, or nothing with Ollama.

## 2. Gaps in the plan, with suggestions

### Approval and submission
1. **Bind approval to what the user actually saw.** The plan binds approval to an immutable snapshot, but a
   stale browser tab could still approve newer content. The client now sends the content hash it displayed;
   the server rejects a mismatch (**built**).
2. **Private notes should not invalidate approval.** Only submitted content (resume version, cover letter,
   answers, destination) is hashed (**built**).
3. **"Submitted" cannot be observed when the user clicks Submit.** Record the user's confirmation with an
   idempotency key (**built**), then later confirm automatically by parsing the employer's confirmation email
   (Gmail/Outlook read-only scope, or a forwarding address).
4. **Closed postings.** Postings that disappear from a board are marked closed and cannot be approved (**built**).
   Add a warning when an approved but unsubmitted application's posting closes.

### Browser-assisted filling
5. **The assist runs on the API machine.** That works for personal use (**built**: Playwright, visible window,
   pre-fills, never clicks Submit, never touches CAPTCHAs or log-ins). For SaaS, move it to a **Chrome
   extension** that fetches the approved snapshot and fills the form in the user's own browser. This also
   replaces the "local companion agent" idea for resume folders, keeps the user's session cookies on their
   device, and avoids running browsers on your servers.
6. **Fill quality.** Field detection is heuristic (labels, names, autocomplete hints). Add per-ATS
   field maps for Greenhouse, Lever, Ashby, Workday and Personio, and record which fields were not
   found so the map improves over time (the report is already stored in the audit log).

### Sources
7. **Discovery needs company tokens.** Users rarely know a company's ATS. Suggestions: a curated directory of
   board tokens (start with your target cities and stacks), "paste any careers URL" detection (**built** for
   Greenhouse, Lever and Ashby URLs), and Personio's public XML feed next.
8. **LinkedIn, Indeed, StepStone and XING.** Automation is prohibited, but their **e-mail job alerts** are
   permitted: forward them to an ingest address, extract the employer and title, then find the same job on
   the employer's own board and apply there. This covers the biggest boards without scraping.
9. **Bundesagentur für Arbeit.** Its job search API is free and well-suited to German roles; add it as the
   fourth adapter.
10. **Cross-source duplicates.** The plan dedups by requisition ID and URL. Also match on normalized
    company + title + city, because the same job often appears on several boards with different IDs.
11. **Salary is rarely published.** Treat the salary floor as "unknown" rather than filtering on it
    (it is stored but not used for filtering now).

### Matching and AI
12. **Language requirements.** Many German postings require fluent German. Detect the posting language and
    flag "German required" against the profile's languages.
13. **Grounding check for cover letters.** Prompts forbid invented facts (**built**), but add a free
    deterministic check after generation: extract technology terms from the letter and flag any that are not
    in the profile or resume. This turns the acceptance test "cover letter does not claim absent skills" into
    an automated gate.
14. **The AI never acts.** Model output is only text that the user reviews; it has no tools and cannot trigger
    approval or submission. Keep this property; it is what makes prompt injection from postings low-risk.
15. **Screening answers.** Drafting them with AI needs the form's questions, which the board APIs do not expose
    (Greenhouse's per-job questions endpoint does, for public boards). For now answers are entered once and
    reused; next, keep a per-user answer bank ("work authorization", "notice period", "salary expectation")
    and auto-suggest by question similarity.

### Product
16. **Outcome tracking.** The tracker records submission; add stages (screening, interview, offer, rejected),
    follow-up reminders, and a "response rate by resume version" view, which helps decide which resume to use.
17. **Multiple preference profiles.** The schema keeps a named preference row per user, so "Hamburg hybrid .NET"
    and "EU remote React" only need the UI and a profile switcher.
18. **GDPR.** Deleting a user already cascades to all their data. Add self-service export (JSON + resume files)
    and account deletion endpoints, a retention job for closed postings and old drafts, and a privacy notice
    listing AI providers as processors.

## 3. Where the build differs from the plan

- No Redis or BullMQ; no Recharts, React Hook Form or client-side Zod (fewer dependencies; MUI progress bars
  and plain controlled forms are enough at this size). Tailwind is kept for layout, with MUI in its own CSS layer
  so the two don't conflict.
- Resumes are added by upload (stored byte-for-byte, SHA-256 versioned, database role cannot update them).
  Folder sync can come later via the Chrome extension or a OneDrive/Drive connector.
- One preference profile in the UI (schema supports more).
- Admin area not built yet; nothing in the API exposes another user's data.

## 4. Suggested next steps, in order

1. Try it with your real profile and 10–20 target companies; tune the scoring weights.
2. Test **Open & pre-fill apply form** on a real Greenhouse posting (only you can do this: it opens the
   employer's real form).
3. Install Ollama and compare its cover letters with a paid model on the same 5 jobs before choosing a default.
4. Add the cover-letter grounding check (item 13) and the answer bank (item 15).
5. Add Bundesagentur and Personio adapters (items 7 and 9).
6. Before inviting other users: OIDC with MFA, data export/deletion, HTTPS deployment, and the Chrome extension
   for pre-fill.
