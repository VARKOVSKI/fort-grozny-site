import test from 'node:test';
import assert from 'node:assert/strict';

test('disabled storefront and strict CORS', async () => {
  const { default: worker } = await import('./worker.mjs').catch(() => ({}));
  assert.ok(worker, 'payments Worker is missing');
  const url = 'https://worker.example/api/';
  const origin = 'https://playfortgrozny.ru';
  const env = { STORE_ENABLED: 'false' };
  const config = await worker.fetch(new Request(url + 'config', { headers: { Origin: origin } }), env);
  assert.equal(config.headers.get('Access-Control-Allow-Origin'), origin);
  assert.deepEqual(await config.json(), { storeEnabled: false, supportEnabled: false });
  assert.equal((await worker.fetch(new Request(url + 'orders', { method: 'POST' }), env)).status, 503);
  assert.equal((await worker.fetch(new Request(url + 'config', { headers: { Origin: 'https://elsewhere.example' } }), env)).status, 403);
});

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from './worker.mjs';

test('server pricing, retries, verified notifications and refund review', async t => {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(query) {
      return { bind(...args) {
        const statement = sqlite.prepare(query);
        return { first: async () => statement.get(...args), run: () => statement.run(...args) };
      } };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        statements.forEach(statement => statement.run());
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const env = {
    STORE_ENABLED: 'true', RECEIPTS_CONFIRMED: 'true', PAYMENTS_MODE: 'test',
    FULFILLMENT_VERIFIED: 'true', SITE_AUTH_VERIFIED: 'true',
    YOOKASSA_SHOP_ID: 'local-shop', YOOKASSA_SECRET_KEY: 'local-fixture', DB: db,
    ACCOUNTS: { fetch: async (_url, { headers }) => headers.Authorization === 'Bearer fixture-session'
      ? Response.json({ playerId: 'FG-123456', unityPlayerId: 'local-unity-player' })
      : new Response(null, { status: 403 }) },
  };
  let creates = 0;
  let payment;
  let refund;
  let failCreate = true;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(url.startsWith('https://api.yookassa.ru/v3/'));
    if (options.method === 'POST') {
      creates++;
      const body = JSON.parse(options.body);
      assert.equal(options.headers['Idempotence-Key'], body.metadata.order_id);
      assert.equal(body.amount.value, '99.00');
      assert.equal(body.amount.currency, 'RUB');
      assert.ok(['sbp', 'bank_card'].includes(body.payment_method_data.type));
      payment = {
        id: body.metadata.order_id, status: 'pending', amount: body.amount,
        metadata: body.metadata, recipient: { account_id: 'local-shop' }, test: true,
        confirmation: { confirmation_url: 'https://yoomoney.ru/checkout/test' },
      };
      if (failCreate) return new Response(null, { status: 503 });
      return Response.json(payment);
    }
    if (url.includes('/refunds/')) return Response.json(refund);
    return Response.json(payment);
  });
  const call = (path, method = 'GET', body, token) => worker.fetch(new Request('https://worker.example/api/' + path, {
    method, body: body && JSON.stringify(body), headers: token ? { Authorization: 'Bearer ' + token } : {},
  }), env);
  const order = { orderId: crypto.randomUUID(), access: 'a'.repeat(64),
    playerId: 'FG-123456', packageId: 'coins-1000', method: 'sbp', amount: 1, currency: 'USD' };
  const create = (body = order, token = 'fixture-session') => call('orders', 'POST', body, token);
  const status = (token = order.access) => call('orders/' + order.orderId, 'GET', undefined, token);
  const event = (name, id = payment.id) => call('webhooks/yookassa', 'POST', {
    event: name, object: { id, paid: true, amount: { value: '99.00', currency: 'RUB' } },
  });
  assert.equal((await create(order, 'wrong')).status, 403);
  assert.equal((await create({ ...order, packageId: 'all-cars' })).status, 400);
  assert.equal(creates, 0);
  assert.equal((await create()).status, 502);
  failCreate = false;
  assert.equal((await create()).status, 201);
  assert.equal((await create()).status, 201);
  assert.equal(creates, 2);
  assert.equal((await create({ ...order, method: 'bank_card' })).status, 409);
  assert.equal((await status('b'.repeat(64))).status, 404);
  assert.equal((await event('payment.succeeded')).status, 409);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM entitlement_ledger').get().n, 0);
  payment.status = 'succeeded';
  payment.paid = true;
  payment.amount = { value: '1.00', currency: 'RUB' };
  assert.equal((await event('payment.succeeded')).status, 409);
  payment.amount.value = '99.00';
  payment.test = false;
  assert.equal((await event('payment.succeeded')).status, 409);
  payment.test = true;
  const confirmations = await Promise.all([event('payment.succeeded'), event('payment.succeeded')]);
  assert.deepEqual(confirmations.map(response => response.status), [200, 200]);
  assert.equal((await (await status()).json()).status, 'succeeded');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM entitlement_ledger').get().n, 1);
  payment.refunded_amount = { value: '99.00', currency: 'RUB' };
  refund = { id: 'refund-1', payment_id: payment.id, status: 'succeeded', amount: { value: '25.00', currency: 'RUB' } };
  assert.equal((await event('refund.succeeded', refund.id)).status, 200);
  assert.equal((await event('refund.succeeded', refund.id)).status, 200);
  assert.equal((await (await status()).json()).status, 'partially_refunded');
  refund = { ...refund, id: 'refund-2', amount: { value: '74.00', currency: 'RUB' } };
  assert.equal((await event('refund.succeeded', refund.id)).status, 200);
  assert.equal((await (await status()).json()).grantStatus, 'refund_review');
  assert.equal((await (await status()).json()).status, 'refunded');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM refunds').get().n, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM payment_events WHERE event='refund.succeeded'").get().n, 2);
  const card = { ...order, orderId: crypto.randomUUID(), method: 'bank_card' };
  assert.equal((await create(card)).status, 201);
  payment.status = 'canceled';
  assert.equal((await event('payment.canceled')).status, 200);
  assert.equal((await (await call('orders/' + card.orderId, 'GET', undefined, card.access)).json()).status, 'canceled');
});

test('operator diagnostic is closed by default and uses a fixed uncaptured live payment', async t => {
  const h = 'a'.repeat(64);
  const env = { STORE_ENABLED: 'false', PAYMENTS_MODE: 'live',
    DIAGNOSTICS_ADMIN_TOKEN: h, DIAGNOSTICS_EXPIRES_AT: String(Math.floor(Date.now()/1000)+600),
    YOOKASSA_SHOP_ID: 'fixture-shop', YOOKASSA_SECRET_KEY: 'fixture-secret' };
  let calls = 0, key;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    const b = JSON.parse(options.body);
    assert.equal(b.capture, false);
    assert.equal(b.amount.value, '99.00');
    assert.equal(b.metadata.order_id, undefined);
    if (key) assert.equal(options.headers['Idempotence-Key'], key);
    key = options.headers['Idempotence-Key'];
    return Response.json({ id:'diagnostic-id', test:false, status:'pending', paid:false,
      amount:b.amount, recipient:{account_id:'fixture-shop'},
      confirmation:{confirmation_url:'https://yoomoney.ru/checkout/diagnostic'} });
  });
  const call = (token, e=env) => worker.fetch(new Request('https://worker.example/api/admin/yookassa/diagnostic',
    {method:'POST',body:JSON.stringify({requestId:'00000000-0000-4000-8000-000000000001'}),headers:token?{Authorization:'Bearer '+token}:{}}), e);
  assert.equal((await call(h, {...env, DIAGNOSTICS_ADMIN_TOKEN:undefined})).status, 404);
  assert.equal((await call(h, {...env, STORE_ENABLED:'true'})).status, 404);
  assert.equal((await call(h, {...env, DIAGNOSTICS_EXPIRES_AT:'1'})).status, 404);
  assert.equal((await call('b'.repeat(64))).status, 401);
  assert.equal(calls, 0);
  for(let i=0;i<2;i++) {
    const r=await call(h); assert.equal(r.status,200);
    const body=await r.json(); assert.equal(body.capture,false); assert.equal(body.status,'pending');
  }
  assert.equal(calls,2);
});
