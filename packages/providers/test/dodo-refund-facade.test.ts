/**
 * Dodo refund facade.
 *
 * RefundService talks to `refund()`. Dodo has no Idempotency-Key header, so
 * callers key the local ledger `refund:${orderId}:${amount}`. The refund row
 * is stored under the provider refund id (`re_*`), never the payment id.
 */

import { describe, expect, it } from 'vitest';
import { ProviderContractError, SecretStore } from '@foundry/core';
import { DodoAdapter } from '../src/dodo/index.js';
import { dodoRefundLedgerId } from '../src/dodo/events.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function adapter(fetchImpl: typeof fetch): DodoAdapter {
  return new DodoAdapter(
    {
      secrets: new SecretStore({
        get: (name) => (name === 'DODO_API_KEY' ? 'dodo_test_key_not_live' : undefined),
      }),
      environment: 'preview',
      publicBaseUrl: 'https://example.test',
    },
    { fetchImpl },
  );
}

describe('DodoAdapter.refund facade', () => {
  it('exposes refund() so RefundService can call a unified method', () => {
    expect(typeof DodoAdapter.prototype.refund).toBe('function');
  });

  it('returns the provider refund id (re_*), not the payment id', async () => {
    const dodo = adapter(async () =>
      jsonResponse(200, {
        refund_id: 're_dodo_test_a1',
        payment_id: 'pay_test_a1',
        status: 'succeeded',
        amount: 1500,
      }),
    );
    const result = await dodo.refund({
      paymentExternalId: 'pay_test_a1',
      amountMinor: 1500,
      reason: 'requested_by_customer',
      idempotencyKey: 'refund:ord_01ABC:1500',
    });
    expect(result.refundId).toBe('re_dodo_test_a1');
    expect(result.refundId.startsWith('re_')).toBe(true);
    expect(result.refundId).not.toBe('pay_test_a1');
    expect(result.amountMinor).toBe(1500);
    expect(result.status).toBe('succeeded');
  });

  it('does not send Idempotency-Key on POST /refunds', async () => {
    const seen: string[] = [];
    const dodo = adapter(async (_url, init) => {
      const headers = new Headers(init?.headers);
      const value = headers.get('Idempotency-Key') ?? headers.get('idempotency-key');
      if (value) seen.push(value);
      return jsonResponse(200, {
        refund_id: 're_dodo_test_a1',
        payment_id: 'pay_test_a1',
        status: 'succeeded',
        amount: 1500,
      });
    });
    await dodo.refund({
      paymentExternalId: 'pay_test_a1',
      amountMinor: 1500,
      reason: 'requested_by_customer',
      idempotencyKey: 'refund:ord_01ABC:1500',
    });
    expect(seen).toEqual([]);
  });

  it('refuses to treat a missing refund id as success', async () => {
    const dodo = adapter(async () =>
      jsonResponse(200, { payment_id: 'pay_test_a1', status: 'succeeded', amount: 1500 }),
    );
    await expect(
      dodo.refund({
        paymentExternalId: 'pay_test_a1',
        amountMinor: 1500,
        reason: 'requested_by_customer',
        idempotencyKey: 'refund:ord_01ABC:1500',
      }),
    ).rejects.toBeInstanceOf(ProviderContractError);
  });
});

describe('dodoRefundLedgerId', () => {
  it('looks up the ledger by re_* refund id, never the payment id', () => {
    expect(
      dodoRefundLedgerId({ refund_id: 're_dodo_test_a1', payment_id: 'pay_test_a1' }),
    ).toBe('re_dodo_test_a1');
    expect(dodoRefundLedgerId({ refund: 're_dodo_test_a1', payment_id: 'pay_test_a1' })).toBe(
      're_dodo_test_a1',
    );
  });

  it('returns undefined when the only id present is the payment id', () => {
    expect(dodoRefundLedgerId({ payment_id: 'pay_test_a1' })).toBeUndefined();
    expect(dodoRefundLedgerId({ refund_id: 'pay_test_a1', payment_id: 'pay_test_a1' })).toBeUndefined();
  });
});
