const API = 'https://api.yookassa.ru/v3/payments';
export const CATALOG = Object.freeze({
  'coins-1000': Object.freeze({ amount: '99.00', fgDonate: 1000 }),
  'coins-2500': Object.freeze({ amount: '199.00', fgDonate: 2500 })
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function testConfigured(env) {
  return env.PAYMENTS_MODE === 'test' && /^\d+$/.test(env.YOOKASSA_TEST_SHOP_ID ?? '') &&
    /^test_[A-Za-z0-9_-]+$/.test(env.YOOKASSA_TEST_SECRET_KEY ?? '');
}
function checkOrder(order) {
  if (!UUID.test(order?.orderId ?? '') || !Object.hasOwn(CATALOG, order?.sku ?? '')) throw Error('INVALID_ORDER');
  return CATALOG[order.sku];
}
async function call(env, path, options, fetcher) {
  if (!testConfigured(env)) throw Error('TEST_PAYMENTS_DISABLED');
  const response = await fetcher(API + path, { ...options, redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: {...options.headers, Authorization: 'Basic ' + btoa(env.YOOKASSA_TEST_SHOP_ID + ':' + env.YOOKASSA_TEST_SECRET_KEY)} });
  if (!response.ok) throw Error('PAYMENT_PROVIDER_UNAVAILABLE');
  return response.json();
}
export function verifyPayment(env, order, payment) {
  const sku = checkOrder(order);
  if (!testConfigured(env) || !UUID.test(payment?.id ?? '') ||
      (order.paymentId && order.paymentId !== payment.id) ||
      payment.test !== true || payment.recipient?.account_id !== env.YOOKASSA_TEST_SHOP_ID ||
      payment.amount?.value !== sku.amount || payment.amount?.currency !== 'RUB' ||
      payment.metadata?.order_id !== order.orderId || payment.metadata?.sku !== order.sku ||
      !['pending','canceled','succeeded'].includes(payment.status) ||
      (payment.status === 'succeeded' && payment.paid !== true)) throw Error('PAYMENT_MISMATCH');
  return { paymentId: payment.id, status: payment.status };
}
// The caller must load an immutable order bound to a verified QA player from D1.
// Never invoke this with raw browser input. Persist creation time before this call.
export async function createTestPayment(env, order, fetcher = fetch) {
  const sku = checkOrder(order);
  const elapsed = Date.now() - order.creationStartedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 23 * 3600 * 1000)
    throw Error('CREATION_WINDOW_EXPIRED');
  const payment = await call(env, '', { method: 'POST',
    headers: {'Content-Type':'application/json','Idempotence-Key':order.orderId},
    body: JSON.stringify({amount:{value:sku.amount,currency:'RUB'},capture:true,
      payment_method_data:{type:'bank_card'},
      confirmation:{type:'redirect',return_url:'https://playfortgrozny.ru/'},
      description:'Fort Grozny QA: ' + order.sku,
      metadata:{order_id:order.orderId,sku:order.sku}})}, fetcher);
  const result = verifyPayment(env, order, payment);
  if (result.status === 'pending') {
    let url;
    try { url = new URL(payment.confirmation?.confirmation_url); } catch { throw Error('INVALID_CONFIRMATION'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !['yoomoney.ru','yookassa.ru'].includes(url.hostname)) throw Error('INVALID_CONFIRMATION');
    result.confirmationUrl = url.href;
  }
  return result;
}
// A notification merely triggers this authenticated provider lookup.
// Its body never determines payment status or the reward.
export async function readTestPayment(env, order, fetcher = fetch) {
  checkOrder(order);
  if (!UUID.test(order.paymentId ?? '')) throw Error('INVALID_PAYMENT_ID');
  return verifyPayment(env, order, await call(env, '/' + order.paymentId, {method:'GET'}, fetcher));
}
