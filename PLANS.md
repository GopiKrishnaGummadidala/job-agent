# Automated job discovery and CV matching

## Foundation

Extend the existing NestJS, PostgreSQL and React application. Keep existing job IDs, board subscriptions, applications, approvals and Gmail statuses. Add job source references, discovery runs and nullable posting metadata with additive migrations. Match exact provider identities first, then normalized posting URLs. Send ambiguous company, title, location and description matches to duplicate review. Audit manual merges and block merges with conflicting applications or drafts.

## Providers and workflow

Reuse the seven board adapters and the Gmail OAuth connection. Add paginated Arbeitnow discovery, then StepStone email parsing with fixtures and incremental Gmail checkpoints. Keep mailbox labels unchanged by default for scheduled discovery and expose an explicit mark-read setting. Share posting data with authorized workspace delegates while keeping mail provenance, recruiting replies and calendar events private. Preserve the existing manual screens alongside the migration to unified discovery.

Extend Job Explorer and Sources & Settings with source details, filters, run controls and logs. Use Firecrawl only for approved public targets, with validated URLs and redirects, sanitized output and a budget approved before live usage. Defer TinyFish, Adzuna and semantic matching to the optional-provider milestone.

## Matching

Add the opt-in Germany search preset from the request using named preferences. Include the requested roles and technologies, Hamburg and Germany-wide search, remote and hybrid roles, optional European results, English and German B1, and a negotiable €80,000 annual target. Retain undisclosed salaries and distinguish German work authorization from eligibility elsewhere.

Reuse rule-based scoring, CV tags, immutable CV versions and the AI service. Separate mandatory conflicts from relevance. Return structured compatibility, skill gaps, recommendation and the suggested CV. Cache by posting content, CV version, model, profile and prompt version. Keep automatic AI off by default. Reserve paid usage against daily and monthly limits before a call.

## Scheduling and rollout

Use PostgreSQL for durable queue claims, provider checkpoints and run statistics. Run at 08:00, 13:00 and 18:00 Berlin time while the host is awake, with one catch-up run per provider and profile after wake-up. Support retries, cancellation, recovery, usage reporting and in-app notifications.

Verify each milestone with mocked providers and database tests. Cover cross-source duplicates, concurrent ingestion, removed postings, status preservation, tenant isolation, OAuth behavior, cache invalidation, budget enforcement and daylight-saving transitions. Commit, push, deploy and use paid APIs only with separate authorization.
