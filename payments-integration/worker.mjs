const SITE = 'https://playfortgrozny.ru';
const ORIGINS = new Set([SITE, 'https://www.playfortgrozny.ru']);
const PROVIDER = 'https://api.yookassa.ru/v3';
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const PROVIDER_ID = /^[0-9a-z-]{1,64}$/i;
const CATALOG = Object.freeze({
  'coins-1000': { name: '1 000 FG Coins', amount: 9900, coins: 1000 },
  'coins-2500': { name: '2 500 FG Coins', amount: 19900, coins: 2500 },
});

class APIError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}

function enabled(env) {
  return env.STORE_ENABLED === 'true' && env.RECEIPTS_CONFIRMED === 'true' &&
    env.FULFILLMENT_VERIFIED === 'true' && env.SITE_AUTH_VERIFIED === 'true' &&
    Boolean(env.DB && env.ACCOUNTS && env.YOOKASSA_SHOP_ID && env.YOOKASSA_SECRET_KEY) &&
    ['live', 'test'].includes(env.PAYMENTS_MODE);
}

async function jsonBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new APIError(400, 'Требуется JSON.');
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 16384) {
      await reader.cancel();
      throw new APIError(413, 'Запрос слишком большой.');
    }
    body += decoder.decode(value, { stream: true });
  }
  try {
    const parsed = JSON.parse(body + decoder.decode());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error();
    return parsed;
  } catch {
    throw new APIError(400, 'Некорректный JSON.');
  }
}

function sql(env, query, ...values) {
  return env.DB.prepare(query).bind(...values);
}

async function hash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function minor(amount) {
  if (amount?.currency !== 'RUB' || typeof amount.value !== 'string' ||
      !/^\d{1,9}\.\d{2}$/.test(amount.value)) return null;
  return Number(amount.value.replace('.', ''));
}

async function provider(env, path, body, key) {
  if (!env.YOOKASSA_SHOP_ID || !env.YOOKASSA_SECRET_KEY) throw new APIError(503, 'Платёжный сервис недоступен.');
  const headers = { Authorization: 'Basic ' + btoa(env.YOOKASSA_SHOP_ID + ':' + env.YOOKASSA_SECRET_KEY) };
  if (body) Object.assign(headers, { 'Content-Type': 'application/json', 'Idempotence-Key': key });
  const response = await fetch(PROVIDER + path, {
    method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new APIError(response.status === 404 && !body ? 404 : 502, 'ЮKassa не подтвердила операцию.');
  return response.json();
}

function confirmationUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password &&
        !url.port && url.hostname === 'yoomoney.ru') return url.href;
  } catch {}
  return null;
}

async function savePayment(env, order, payment) {
  const status = payment.status === 'waiting_for_capture' ? 'pending' : payment.status;
  if (!PROVIDER_ID.test(payment.id || '') || payment.metadata?.order_id !== order.id ||
      minor(payment.amount) !== order.amount_minor || order.mode !== env.PAYMENTS_MODE ||
      payment.test !== (order.mode === 'test') ||
      String(payment.recipient?.account_id) !== String(env.YOOKASSA_SHOP_ID) ||
      !['pending', 'succeeded', 'canceled'].includes(status) ||
      (status === 'succeeded' && (payment.status !== 'succeeded' || payment.paid !== true))) {
    throw new APIError(409, 'Данные платежа не совпадают с заказом.');
  }
  const url = confirmationUrl(payment.confirmation?.confirmation_url);
  await env.DB.batch([
    sql(env, `INSERT INTO payments (id, order_id, status, confirmation_url) VALUES (?, ?, ?, ?)
      ON CONFLICT(order_id) DO UPDATE SET status=excluded.status, updated_at=unixepoch(),
      confirmation_url=COALESCE(excluded.confirmation_url, payments.confirmation_url)
      WHERE payments.id=excluded.id AND payments.status='pending'`, payment.id, order.id, status, url),
    sql(env, `INSERT OR IGNORE INTO payment_events (resource_id, event, order_id)
      SELECT id, 'payment.' || status, order_id FROM payments WHERE id=? AND order_id=? AND status=?`,
    payment.id, order.id, status),
    sql(env, `INSERT OR IGNORE INTO entitlement_ledger (order_id, state)
      SELECT order_id, ? FROM payments WHERE id=? AND order_id=? AND status='succeeded'`,
    minor(payment.refunded_amount) > 0 ? 'refund_review' : 'pending', payment.id, order.id),
    sql(env, `UPDATE entitlement_ledger SET state='refund_review'
      WHERE order_id=? AND ?>0 AND EXISTS (SELECT 1 FROM payments WHERE id=? AND order_id=? AND status='succeeded')`,
    order.id, minor(payment.refunded_amount) || 0, payment.id, order.id),
  ]);
  const saved = await sql(env, 'SELECT * FROM payments WHERE order_id=?', order.id).first();
  if (saved?.id !== payment.id) throw new APIError(409, 'Для заказа уже зарегистрирован другой платёж.');
  return saved;
}

async function createOrder(request, env) {
  if (!enabled(env)) throw new APIError(503, 'Магазин пока закрыт.');
  const { orderId, access, playerId, packageId, method } = await jsonBody(request);
  const item = Object.hasOwn(CATALOG, packageId) && CATALOG[packageId];
  const authorization = request.headers.get('Authorization');
  if (!UUID.test(orderId || '') || !TOKEN.test(access || '') ||
      !/^FG-\d{6}$/.test(playerId || '') || !item || !['bank_card', 'sbp', 'smart'].includes(method)) {
    throw new APIError(400, 'Проверьте данные заказа.');
  }
  if (!authorization?.startsWith('Bearer ')) throw new APIError(401, 'Войдите в игровой аккаунт.');
  const verification = await env.ACCOUNTS.fetch('https://accounts.internal/verify-purchase-account', {
    method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId }),
  });
  if (!verification.ok) throw new APIError(verification.status >= 500 ? 503 : 403, 'Не удалось подтвердить игровой аккаунт.');
  const identity = await verification.json();
  if (identity.playerId !== playerId || typeof identity.unityPlayerId !== 'string' || !identity.unityPlayerId) {
    throw new APIError(403, 'Игровой аккаунт не подтверждён.');
  }
  const accessHash = await hash(access);
  await env.DB.batch([
    sql(env, `INSERT INTO orders (id, access_hash, player_id, unity_player_id, sku, amount_minor, currency, mode, method)
      VALUES (?, ?, ?, ?, ?, ?, 'RUB', ?, ?) ON CONFLICT(id) DO NOTHING`,
    orderId, accessHash, playerId, identity.unityPlayerId, packageId, item.amount, env.PAYMENTS_MODE, method),
    sql(env, `INSERT OR IGNORE INTO payment_events (resource_id, event, order_id)
      SELECT id, 'order.created', id FROM orders WHERE id=? AND access_hash=?`, orderId, accessHash),
  ]);
  const order = await sql(env, 'SELECT * FROM orders WHERE id=? AND access_hash=?', orderId, accessHash).first();
  if (!order || order.player_id !== playerId || order.unity_player_id !== identity.unityPlayerId ||
      order.sku !== packageId || order.method !== method || order.mode !== env.PAYMENTS_MODE) {
    throw new APIError(409, 'Заказ уже оформляется с другими параметрами.');
  }
  let payment = await sql(env, 'SELECT * FROM payments WHERE order_id=?', order.id).first();
  if (!payment) {
    if (Date.now() / 1000 - order.created_at > 23 * 3600) {
      throw new APIError(409, 'Срок оформления истёк. Для сверки платежа сообщите поддержке номер заказа: ' + order.id);
    }
    const reply = await provider(env, '/payments', {
      amount: { value: (order.amount_minor / 100).toFixed(2), currency: order.currency },
      capture: true,
      ...(order.method === 'smart' ? {} : { payment_method_data: { type: order.method } }),
      confirmation: { type: 'redirect', return_url: SITE + '/?order=' + order.id + '#donate' },
      description: 'Fort Grozny · ' + item.name,
      metadata: { order_id: order.id },
    }, order.id);
    payment = await savePayment(env, order, reply);
  }
  if (payment.status === 'pending' && !payment.confirmation_url) {
    throw new APIError(502, 'ЮKassa не вернула ссылку для оплаты.');
  }
  return { orderId: order.id, access, confirmationUrl: payment.status === 'pending' ? payment.confirmation_url : null };
}

async function orderStatus(request, env, id) {
  const access = request.headers.get('Authorization')?.slice(7);
  if (!request.headers.get('Authorization')?.startsWith('Bearer ') || !TOKEN.test(access || '')) {
    throw new APIError(404, 'Заказ не найден.');
  }
  const order = await sql(env, 'SELECT * FROM orders WHERE id=? AND access_hash=?', id, await hash(access)).first();
  if (!order) throw new APIError(404, 'Заказ не найден.');
  let payment = await sql(env, 'SELECT * FROM payments WHERE order_id=?', id).first();
  if (payment?.status === 'pending') payment = await savePayment(env, order, await provider(env, '/payments/' + payment.id));
  const grant = await sql(env, 'SELECT state FROM entitlement_ledger WHERE order_id=?', id).first();
  const refunds = payment && await sql(env, 'SELECT COALESCE(SUM(amount_minor), 0) AS total FROM refunds WHERE payment_id=?', payment.id).first();
  const refunded = refunds?.total || 0;
  return {
    orderId: id, status: refunded >= order.amount_minor ? 'refunded' : refunded > 0 ? 'partially_refunded' : payment?.status || 'creating',
    grantStatus: grant?.state || 'pending', package: CATALOG[order.sku]?.name || order.sku,
  };
}

async function webhook(request, env) {
  const { event, object } = await jsonBody(request);
  const id = object?.id;
  if (!['payment.succeeded', 'payment.canceled', 'refund.succeeded'].includes(event) || !PROVIDER_ID.test(id || '')) {
    throw new APIError(400, 'Неизвестное уведомление.');
  }
  if (event !== 'refund.succeeded') {
    const payment = await provider(env, '/payments/' + id);
    if (payment.id !== id || 'payment.' + payment.status !== event) throw new APIError(409, 'Статус не подтверждён.');
    const order = await sql(env, 'SELECT * FROM orders WHERE id=?', payment.metadata?.order_id || '').first();
    if (order) await savePayment(env, order, payment);
    return { received: true };
  }

  const refund = await provider(env, '/refunds/' + id);
  const amount = minor(refund.amount);
  if (refund.id !== id || refund.status !== 'succeeded' || !amount || !PROVIDER_ID.test(refund.payment_id || '')) {
    throw new APIError(409, 'Возврат не подтверждён.');
  }
  const payment = await provider(env, '/payments/' + refund.payment_id);
  if (payment.id !== refund.payment_id || payment.status !== 'succeeded') throw new APIError(409, 'Платёж не подтверждён.');
  const order = await sql(env, 'SELECT * FROM orders WHERE id=?', payment.metadata?.order_id || '').first();
  if (!order) return { received: true };
  if (amount > order.amount_minor || amount > (minor(payment.refunded_amount) ?? 0)) {
    throw new APIError(409, 'Сумма возврата не подтверждена.');
  }
  await savePayment(env, order, payment);
  await env.DB.batch([
    sql(env, `INSERT OR IGNORE INTO refunds (id, payment_id, amount_minor)
      SELECT ?, ?, ? WHERE ? + (SELECT COALESCE(SUM(amount_minor), 0) FROM refunds WHERE payment_id=?) <= ?`,
    id, payment.id, amount, amount, payment.id, order.amount_minor),
    sql(env, `INSERT OR IGNORE INTO payment_events (resource_id, event, order_id)
      SELECT id, 'refund.succeeded', ? FROM refunds WHERE id=? AND payment_id=?`, order.id, id, payment.id),
    sql(env, `UPDATE entitlement_ledger SET state='refund_review'
      WHERE order_id=? AND EXISTS (SELECT 1 FROM refunds WHERE id=? AND payment_id=?)`, order.id, id, payment.id),
  ]);
  const saved = await sql(env, 'SELECT id FROM refunds WHERE id=? AND payment_id=? AND amount_minor=?', id, payment.id, amount).first();
  if (!saved) throw new APIError(409, 'Не удалось сверить возврат.');
  return { received: true };
}


/* Operator-only diagnostic: never creates an FG order or entitlement. */
async function liveDiagnostic(request, env) {
  const expiration = Number(env.DIAGNOSTICS_EXPIRES_AT);
  const now = Math.floor(Date.now() / 1000);
  const secret = env.DIAGNOSTICS_ADMIN_TOKEN;
  if (env.STORE_ENABLED !== 'false' || env.PAYMENTS_MODE !== 'live' ||
      !TOKEN.test(secret || '') || !Number.isSafeInteger(expiration) ||
      expiration <= now || expiration > now + 900) {
    throw new APIError(404, 'Маршрут не найден.');
  }
  const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) throw new APIError(401, 'Требуется авторизация.');
  const expected = await hash(secret);
  const given = await hash(token);
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  if (mismatch !== 0) throw new APIError(401, 'Требуется авторизация.');
  if (request.headers.has('Origin')) throw new APIError(404, 'Маршрут не найден.');
  const { requestId } = await jsonBody(request);
  if (!UUID.test(requestId || '')) throw new APIError(400, 'Укажите requestId в формате UUID.');
  const payment = await provider(env, '/payments', {
    amount: { value: '99.00', currency: 'RUB' },
    capture: false,
    save_payment_method: false,
    payment_method_data: { type: 'bank_card' },
    confirmation: { type: 'redirect', return_url: SITE + '/#donate' },
    description: 'Fort Grozny — диагностика оплаты (без начисления)',
    metadata: { purpose: 'admin_diagnostic', diagnostic_id: requestId },
  }, 'fgdiag-' + expected.slice(0, 48));
  const url = confirmationUrl(payment.confirmation?.confirmation_url);
  if (payment.test !== false || payment.status !== 'pending' || payment.paid !== false ||
      minor(payment.amount) !== 9900 ||
      String(payment.recipient?.account_id) !== String(env.YOOKASSA_SHOP_ID) ||
      !PROVIDER_ID.test(payment.id || '') || !url) {
    throw new APIError(409, 'Диагностический платёж не подтверждён.');
  }
  return { paymentId: payment.id, status: payment.status, amount: payment.amount,
    confirmation_url: url, capture: false };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const headers = { 'Cache-Control': 'no-store', Vary: 'Origin' };
    function reply(body, status = 200) {
      return Response.json(body, { status, headers });
    }
    if (origin && !ORIGINS.has(origin)) return reply({ detail: 'Источник запрещён.' }, 403);
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    }
    if (request.method === 'OPTIONS') return new Response(null, { headers, status: 204 });
    const path = new URL(request.url).pathname;
    try {
      if (request.method === 'POST' && path === '/api/admin/yookassa/diagnostic') return reply(await liveDiagnostic(request, env));
      if (request.method === 'GET' && path === '/api/config') return reply({ storeEnabled: enabled(env), supportEnabled: false });
      if (request.method === 'GET' && path === '/api/catalog') return reply(CATALOG);
      if (request.method === 'POST' && path === '/api/orders') return reply(await createOrder(request, env), 201);
      if (request.method === 'GET' && path.startsWith('/api/orders/') && UUID.test(path.slice(12))) {
        return reply(await orderStatus(request, env, path.slice(12)));
      }
      if (request.method === 'POST' && path === '/api/webhooks/yookassa') return reply(await webhook(request, env));
      return reply({ detail: 'Маршрут не найден.' }, 404);
    } catch (error) {
      return error instanceof APIError ? reply({ detail: error.message }, error.status) :
        reply({ detail: 'Платёжный сервис временно недоступен.' }, 503);
    }
  },
};
