# FORT GROZNY — платёжная интеграция (план реализации)

**Статус:** техническое задание подготовлено; боевые платежи **не включены**. Этот документ не означает, что интеграция развёрнута или прошла тесты.

## Проверенные существующие части

- Домен: https://playfortgrozny.ru, статический сайт в GitHub Pages.
- Главная страница `index.html`: магазин FG Donate использует `GET /api/config`, `POST /api/orders`, `GET /api/orders/{orderId}?access={token}`.
- GitHub Pages не выполняет `/api` backend: нужен HTTPS адрес отдельного Cloudflare Worker и CORS для точных Origin.
- Cloudflare: `fort-grozny-payments-test` создан, пока шаблон Hello World (со слов пользователя/скриншота); отдельно `fort-grozny-identity-development` (FG-ID) и D1 `fort-grozny-dev`.
- Unity Cloud Code `FortGroznyAccount`: существующий игровой профиль и авторитетная экономика. **Взаимодействие с системой необходимо проверять по реальному исходному коду**, не предполагать API.
- Самозанятый: условия продаж, оферта, порядок возвратов, чеки/НПД требуют проверки перед стартом.

## Структура

```
Web checkout (GitHub Pages)
     └─HTTPS + CORS─> Cloudflare Payments Worker
                       ├─ D1 payment orders (ОТДЕЛЬНО от fort-grozny-dev)
                       ├─ YooKassa API (shopId и Secret только серверные)
                       ├─ webhook: GET payment status from YooKassa
                       └─ защищённая server-to-server выдача
                            └─ существующий Unity/Cloudflare FG-ID и балансы
```

**Не подменять клиентом результат**: только подтверждённый `payment.succeeded` (сверить amount, currency, merchant shopId, paymentId, order metadata, test-mode, captured/paid) может создать поручение на выдачу. Не доверять возврату покупателя на сайт.

## Краткий контракт API для front-end (проверить и адаптировать, не менять blindly)

- `GET /api/config` → `{"storeEnabled":false,"supportEnabled":false}`; активировать только когда доступны production shop, receipts, identity и выдача.
- `GET /api/catalog` → серверный каталог (фиксированная цена RUB/денежная награда). Клиент не задаёт цену.
- `POST /api/orders`: `{"playerId":"FG-123456","packageId":"coins-1000","method":"bank_card"}`
  - перед вызовом в ЮKassa ОБЯЗАТЕЛЬНО проверять существование FG-ID и достоверность привязки к Unity Player ID, а при покупке на свой аккаунт — право инициатора; вариант подарка отдельно.
  - ответ `{"orderId":"<uuid>","access":"<opaque-random-status-token>","confirmationUrl":"https://<REAL-YOOKASSA-HOST>/..."}`.
  - не разглашать `access` в аналитике, логах, ссылках сторонних страниц; защитить endpoint от перебора. В идеале использовать токен в authorization header вместо query.
- `GET /api/orders/{uuid}?access=...` → `{"orderId":"...","status":"pending|succeeded|canceled|error","grantStatus":"pending|delivered|failed","package":"1 000 FG Coins"}`; не раскрывать информацию о заказах без секрета.
- `POST /api/webhooks/yookassa` → принимает уведомления ЮKassa, получает актуальное состояние платежа через **GET** на сервере ЮKassa; не верит данным body, выполняет идемпотентную запись и постановку задачи выдачи.
- Рекомендуется отдельная асинхронная очередь с повторными попытками выдачи и журналом ошибок. `succeeded` плюс `grantStatus=pending` допустим до завершения выдачи; нельзя «терять» подтверждённую оплату.

**URL для возврата** должен указывать на этот же официальный сайт и страницу заказа; показывать «проверяем платёж», не «оплачено» до серверного подтверждения. Существующий JS ждёт `order`/`access` в query; публичную checkout-страницу нужно отдельно адаптировать под фактический redirect flow, не рассчитывать на автоматическую передачу этих значений ЮKassa.

## Каталог

| Код | RUB | Выдача |
|---|---:|---|
| `coins-1000` | 99 | +1000 premium FG Coins |
| `coins-2500` | 199 | +2500 premium FG Coins |
| `all-cars` | 500 | Открыть заранее определённые carId, две DPS-ливереи, одну комплектацию |

`all-cars` **НЕ ВКЛЮЧАТЬ** до согласования точного перечня carId, liveryId и trimId. Обычные монеты и premium FG Coins различаются. Покупка стробоскопов за 1000 FG Coins — внутриигровая расходная операция; не обращаться в ЮKassa.

## D1: минимальные сущности

- `orders`: UUID primary key, recipient FG-ID, Unity player identity (verified), catalog sku, amount_minor, currency, env, unique provider_payment_id, client status token hash, created_at, status.
- `payment_events`: provider/event identifier, checksum/dedupe, received_at, payload fields без чувствительных PII.
- `fulfillment_jobs`: one per confirmed order, state pending/processing/delivered/failed, retry state.
- `entitlement_ledger`: unique(order_id,grant_type,grant_item_id), catalog version, recipient.
- D1 constraints and idempotency alone do not guarantee atomicity across D1 and Unity: Unity/FG-ID grant API MUST additionally enforce an operation-level unique idempotency key (order_id). If acknowledgment lost, retry is safe.
- При возврате/чарджбэке нужна отдельная корректная процедура, не слепое списание уже потраченных FG Coins.

## Секреты

Существующие `FG_GATEWAY_SECRET` и текущую базу FG-ID не копировать в публичный репозиторий.
У тестового Worker — тестовый `YOOKASSA_TEST_SHOP_ID`, `YOOKASSA_TEST_SECRET_KEY` (Cloudflare Secret); `STORE_ENABLED=false` до завершения тестов.
Production магазин: ОТДЕЛЬНЫЙ Worker/окружение, ключи `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY`, серверный токен связи с игровым API и allowlisted origins.
Секрет ЮKassa **никогда** не запрашивать в чате и не помещать в GitHub/Unity.

## Unity: интеграция только с действующими сервисами

1. Unity после авторизованного логина читает свой Unity Player ID и существующий FG-ID из `FortGroznyAccount`/Cloud Code.
2. Внутриигровой UI показывает server-authoritative premium balance и состояние прав через уже существующий API экономических данных.
3. Любая покупка за премиальные FG Coins вызывается через защищённый игровым аккаунтом **серверный** метод списания и выдачи.
4. Веб-покупка: server-to-server grant `grantOnce(orderId, verifiedPlayerId, sku, amount)`, а не команда Unity-клиента. В идеале одно событие/поручение от Workers с серверной подписью / service binding.
5. После новой оплаты Unity запрашивает обновлённый snapshot, а не добавляет +1000 локально.
6. Все ранее купленные автомобили/ливреи/стейджи остаются после переустановки и входа с другого устройства.
7. Для purchases внутри Google Play — Google Play Billing, где требуется правилами. Purchase tokens валидируются сервером Google; после подтверждения вызывается **тот же** `grantOnce`. Для RuStore — только допустимый по правилам канала сценарий, задекларировать используемые платёжные инструменты.

## Минимальный тест-план (до боевого ключа)

1. Создать тестовый FG-ID и проверить связку с Unity Player ID, не менять рабочие аккаунты.
2. Через тестовые `shopId`/Secret создать платёж `coins-1000`.
3. Подтвердить тестовый платёж, проверить server-side `succeeded` и сумму 99.00 RUB.
4. Проверить ровно одну выдачу `+1000`, повторный webhook и параллельные повторы не увеличивают баланс.
5. Проверить временный отказ Unity/Cloudflare и автоматическую повторную доставку.
6. Проверить повторный вход/переустановку: FG Coins сохранены.
7. Проверить неверный FG-ID, отмену оплаты, изменения суммы через DevTools, двойное нажатие, подделку webhook.
8. Не начинать приём настоящих денег до готовности возвратов, чеков НПД, статуса аккаунтов и полного теста.

## Следующее действие

Открыть Cloudflare Workers → `fort-grozny-payments-test` → Edit code и проверить, действительно ли там Hello World. Затем D1 (изолированная БД заказов), Secrets для ТЕСТОВОГО магазина, реализация по контракту. Код `FortGroznyAccount` требуется аудировать в Unity/Codex перед написанием server-to-server grant.

Список и цены на сайте — действующий дизайн витрины, **но НЕ доказательство того, что платежи работают**.
