# PATCH — Terac expert_validate splices

Owned Terac path is implemented in `packages/providers/src/terac/**` and
`packages/services/src/research/expert.ts`. These edits were out of scope
(catalog / queue / runtime / webhook processor / loop). Do not claim
`live_verified`: org credit is still **$0**.

## 1. `packages/services/src/tools/catalog.ts`

`expert.request_review` already exists (`authority: 'expert.engage_paid'`,
`capability: 'expert.structured_review'`). Add `expert.poll` next to it.
Poll can launch after feasibility `RESPONDED`, so it is consequential spend.

```ts
import { expertJobOutcome } from '../research/expert.js';

tool(
  {
    name: 'expert.poll',
    description:
      'Poll a Terac expert review until RESPONDED/submissions. Missing capability or $0 credit returns blocked, never a fabricated verdict.',
    authority: 'expert.engage_paid',
    capability: 'expert.structured_review',
    consequential: true,
    input: z.object({ expertReviewId: Id }),
    execute: async (input) => expertJobOutcome(await s.experts.poll(input.expertReviewId)),
  },
  s,
),
```

Optional: add `'expert.poll'` to the org-chart tool lists that already include
`'expert.request_review'` in `packages/core/src/domain/org.ts`. Catalog may
define a tool the chart does not use; the reverse throws at boot.

`packages/services/test/tools-catalog.test.ts` already expects
`expert.request_review`. Extend that list with `expert.poll` if you add the tool.

## 2. `packages/services/src/commerce/webhook-processor.ts`

`POST /webhooks/terac` already verifies HMAC, returns 400/503/200 duplicate, and
enqueues `commerce.webhook`. `#map` has no Terac case, so the job is currently
`unhandled`. Ingest is a refresh, not a money transition:

```ts
import { ExpertReviewService } from '../research/expert.js';

// inside process(), after the linq branch, before this.#map:
if (event.provider === 'terac') {
  const experts = new ExpertReviewService(this.deps);
  const ingested = await experts.ingestWebhook(event.payload);
  if (ingested.blockedOn && ingested.status === 'ignored') {
    await this.deps.repos.webhooks.markIgnored(webhookEventId, ingested.blockedOn.reason);
    return { outcome: 'ignored', reason: ingested.blockedOn.reason };
  }
  await this.deps.repos.webhooks.markProcessed(webhookEventId, event.company_id ?? undefined);
  return {
    outcome: 'ingested',
    reason: ingested.verdict
      ? `terac review ${ingested.reviewId} verdict ${ingested.verdict}`
      : `terac review ${ingested.reviewId} status ${ingested.status}`,
  };
}
```

`ingestWebhook` re-fetches submissions and records a row only when critique +
expert identity + timestamp exist. It does not invent a verdict.

## 3. `packages/services/src/loop/orchestrator.ts`

Replace `#assessExpertValidate` so the cycle re-derives from the review
artefact. Today's body completes with `performed: false` when the capability
is unusable, and ignores a `killed` opportunity whose review verdict is
`rejected`.

```ts
async #assessExpertValidate(companyId: string): Promise<PhaseAssessment> {
  const experts = new ExpertReviewService(this.deps);
  const assessment = await experts.assessForLoop(companyId);
  return {
    complete: assessment.complete,
    detail: assessment.detail,
    blockedOn: assessment.blockedOn
      ? { capability: assessment.blockedOn.capability, remediation: assessment.blockedOn.reason }
      : undefined,
    outputs: {
      expert_validate: {
        performed: assessment.performed,
        verdict: assessment.verdict,
        ...(assessment.blockedOn ? { reason: assessment.blockedOn.reason } : {}),
      },
    },
  };
}
```

`drive('expert_validate')` already calls `experts.request` and enqueues
`expert.poll`. No queue-contract change.

## 4. `apps/worker/src/handlers.ts`

`expert.poll` already wraps `tolerateMissingCapability` (thrown missing key →
`{ status: 'blocked' }`). The service now *returns* `blockedOn` instead of
throwing on missing key / $0 credit. Map that so BullMQ does not record a
successful job that is still waiting on credit:

```ts
import { expertJobOutcome } from '@foundry/services';

'expert.poll': async (payload) =>
  tolerateMissingCapability(async () => {
    const run = async (id: string) => expertJobOutcome(await services.experts.poll(id));
    if (payload.expertReviewId) return { polls: [await run(payload.expertReviewId)] };
    const polls = [];
    for (const companyId of await companyIds(payload.companyId)) {
      for (const review of await ctx.repos.research.expertReviews.listOpen(companyId)) {
        polls.push(await run(review.id));
      }
    }
    return { polls };
  }),
```

## 5. Do not splice

- `packages/queue/src/contracts.ts` — `expert.poll` already exists.
- `packages/runtime/src/services.ts` — `experts: new ExpertReviewService(deps)` already exists.
- `render.yaml` — no new service.
- Do not mark Terac `live_verified`. `TERAC_STUDY_BLOCKER` remains the live fact
  (`Available: $0.00`). `apps/verifier` has not written a launch row.
