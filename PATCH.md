# PATCH — runtime BAND wiring

Do not treat this file as a completed company-loop change. It is the BAND-owned
instruction for `packages/runtime`, which this branch must not edit.

## Required: pass `{ band }` only when configured

`packages/runtime/src/context.ts` currently does:

```ts
const dispatcher = new OrgDispatcher(repos, queues, band ? { band } : undefined);
```

That is wrong for the dispatch / `enqueueSystem` split. An unconfigured
`BandAdapter` is still a truthy object, so `enqueueSystem` (support inbound)
would attempt a room post, throw `CredentialsMissingError`, and retry-burn.

Change both call sites to the same predicate the executor already uses:

```ts
const band = providers.adapter('band') as BandAdapter | undefined;
const coordination = band?.isConfigured ? { band } : undefined;

const executor = new AgentExecutor({
  repos,
  llm,
  tools,
  gate,
  band: coordination?.band,
});
const dispatcher = new OrgDispatcher(repos, queues, coordination);
```

Effects after the patch:

- Agent-to-agent `OrgDispatcher.dispatch` still requires BAND. Unconfigured →
  `ValidationError`, no enqueue.
- `enqueueSystem` may proceed DB-only when BAND is unconfigured.
- When BAND *is* configured, both paths post the room assignment before enqueue.
- A specialist run with no `bandChatId` / `bandMessageId` still ends `failed`,
  not `running`.

Delete the comment that says "Always wire the adapter so a missing BAND key
fails dispatch." That comment describes the old, broken coupling.

## Required: reuse the live Zero Human Co room

`packages/runtime/src/bootstrap.ts` `ensureBandCoordinationRoom` currently
`createChat`s when `config.integrations.bandChatId` is empty. That can open a
decorative second room and call the mesh done.

After this branch, call:

```ts
import { ZERO_HUMAN_CO_COORDINATION_ROOM_ID } from '@foundry/providers';

const resolved = await band.resolveCoordinationRoom({
  configuredChatId: config.integrations?.bandChatId ?? ZERO_HUMAN_CO_COORDINATION_ROOM_ID,
  companyName: company.name,
});
```

`resolveCoordinationRoom` returns the live room
`a70129cc-0663-4090-86b5-c5a98025532e` from `listChats` when it is present, and
only `createChat`s if that room is genuinely absent. Persist `resolved.chatId`
as `integrations.bandChatId`. Do not create one room per function and call
that "channels."

## Do not claim

- `GET /agent/me` probe is identity confirmation, not "mesh complete."
- `coordination.governance` remains `marketing_claim_only`.
- Company loop is **not DONE**.
