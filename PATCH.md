# Dodo routing splices

Dodo-owned code lives in `packages/providers/src/dodo/**`, `packages/providers/test/dodo*`, and `packages/services/src/commerce/dodo.ts`. Stripe-owned files were not edited. Apply these splices so digital MoR actually ships.

Physical goods stay on Stripe. Eligible digital add-on / membership / data product / subscription uses Dodo as Merchant of Record. `assertPaymentRoute('physical_good', 'dodo_merchant_of_record')` throws — do not fall through to Stripe as a silent "fix", and do not claim Dodo MoR for a bottle.

## 1. `packages/services/src/commerce/collect.ts`

In `#ensureCheckoutUrl`, after loading the order, branch on `order.payment_route` (or the line items' product `payment_route`):

```ts
import { DodoCommerceService } from './dodo.js';

if (order.payment_route === 'dodo_merchant_of_record') {
  const dodo = await new DodoCommerceService(this.deps).startDigitalCheckout({
    companyId: order.company_id,
    orderId: order.id,
    returnUrl: `${this.deps.publicBaseUrl}/?paid=1`,
    cancelUrl: `${this.deps.publicBaseUrl}/#pricing`,
    idempotencyKey: `${idempotencyKey}:dodo-checkout`,
  });
  if (!dodo.ok) return null; // caller already maps blockedOn
  return dodo.data?.checkoutUrl ?? null;
}
// existing Stripe physical path unchanged
```

Do not send a Dodo order through `StripeAdapter.createCheckoutSession`.

## 2. `apps/api/src/routes/commerce.ts` (`POST /api/checkout`)

Replace the `paymentRoute !== 'stripe_direct'` hard-throw with:

```ts
if (paymentRoute === 'dodo_merchant_of_record') {
  const started = await new DodoCommerceService(deps).startDigitalCheckout({
    companyId,
    orderId: order.order.id,
    returnUrl: body.successUrl,
    cancelUrl: body.cancelUrl,
    customerEmail: body.email,
    idempotencyKey: idempotencyKey('dodo', order.order.id, 'checkout'),
  });
  if (!started.ok) {
    throw new ValidationError(started.blockedOn?.reason ?? 'Dodo checkout blocked', {
      orderId: order.order.id,
      paymentRoute,
    });
  }
  return { orderId: order.order.id, checkoutUrl: started.data?.checkoutUrl };
}
if (paymentRoute !== 'stripe_direct') {
  throw new ValidationError(`Payment route "${paymentRoute}" has no active adapter…`);
}
```

Physical checkout stays on Stripe. Mixing Stripe + Dodo line items in one cart is already rejected (`routes.size > 1`).

## 3. `packages/services/src/commerce/refunds.ts`

When `order.payment_route === 'dodo_merchant_of_record'` (or `order.external_refs.dodo_payment_id` is set), do not read `stripe_payment_intent`. Delegate:

```ts
if (order.payment_route === 'dodo_merchant_of_record') {
  const dodo = await new DodoCommerceService(this.deps).issueRefund({
    companyId: order.company_id,
    orderId: order.id,
    amountMinor: request.amountMinor,
    reason: request.reason,
    actorId: request.actorId,
  });
  if (!dodo.ok) return { outcome: 'refused', reason: dodo.blockedOn?.reason ?? 'Dodo refund blocked' };
  return { outcome: 'refunded', refundId: dodo.data.refundId, amountMinor: dodo.data.amountMinor };
}
```

Keep the policy gate / kill-switch / ceiling checks in `RefundService.issue` *before* this branch. Dodo has no Idempotency-Key header — `issueRefund` keys the local ledger `refund:${orderId}:${amount}`.

## 4. `packages/services/src/commerce/webhook-processor.ts` `#onApplied`

The Dodo `#map` arm already aliases `refund` = `refund_id` (`re_*`). Persist money rows:

```ts
if (provider === 'dodo') {
  const dodo = new DodoCommerceService(this.deps);
  if (intent.orderStatus === 'PAID') await dodo.recordCapturedPayment(order, intent);
  if (intent.kind === 'refund_issued') await dodo.recordWebhookRefund(order, intent);
}
```

Ledger lookup must use `dodoRefundLedgerId(intent.externalIds)` (refund id), never `payment_id`.

## 5. `apps/worker/src/handlers.ts` `finance.reconcile`

`payments.byExternalId('stripe', payload.refundExternalId)` will not find a Dodo `re_*` refund. After recording the refunds row, look up by **refund** external id and provider `dodo` when `order.payment_route === 'dodo_merchant_of_record'`. Do not treat the payment id as the refund id.

`tolerateMissingCapability` currently catches `CredentialsMissingError` but not `ProviderAuthError`. Dodo HTTP 401 is classified as auth. `DodoCommerceService` converts 401 to `blockedOn` so a Dodo job does not burn retries. Optionally also catch `ProviderAuthError` in the wrapper.

## 6. `packages/runtime/src/services.ts`

Optional: `dodo: new DodoCommerceService(deps)` on the container. Call sites can also `new DodoCommerceService(deps)` until that lands.

## Status (Dodo only)

Live `GET /products` remains **HTTP 401** — credential blocker, not `live_verified`, not a Stripe test-mode launder. Physical goods stay refused. Local unit tests cover: `assertPaymentRoute` throw, digital signed-webhook state machine, 401 classified as failed probe, refund ledger by `re_*`.
