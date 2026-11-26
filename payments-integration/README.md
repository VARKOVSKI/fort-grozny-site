# FORT GROZNY — платёжная интеграция (план реализации)

**Статус:** код Worker и схема D1 подготовлены и проверены локально. Развёртывание и проверка боевого магазина ещё не выполнены.

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
- `POST /api/orders` с Bearer-токеном игровой сессии: `{"orderId":"<uuid>","access":"<64 hex>","playerId":"FG-123456","packageId":"coins-1000","method":"bank_card"}`
  - перед вызовом в ЮKassa ОБЯЗАТЕЛЬНО проверять существование FG-ID и достоверность привязки к Unity Player ID, а при покупке на свой аккаунт — право инициатора; вариант подарка отдельно.
  - ответ `{"orderId":"<uuid>","access":"<opaque-random-status-token>","confirmationUrl":"https://<REAL-YOOKASSA-HOST>/..."}`.
  - не разглашать `access` в аналитике, логах, ссылках сторонних страниц; защитить endpoint от перебора. Токен передаётся в заголовке Authorization.
- `GET /api/orders/{uuid}` с токеном статуса в `Authorization: Bearer …` → `{"orderId":"...","status":"pending|succeeded|canceled|error","grantStatus":"pending|delivered|failed","package":"1 000 FG Coins"}`; не раскрывать информацию о заказах без секрета.
- `POST /api/webhooks/yookassa` → принимает уведомления ЮKassa, получает актуальное состояние платежа через **GET** на сервере ЮKassa; не верит данным body, выполняет идемпотентную запись и постановку задачи выдачи.
- Рекомендуется отдельная асинхронная очередь с повторными попытками выдачи и журналом ошибок. `succeeded` плюс `grantStatus=pending` допустим до завершения выдачи; нельзя «терять» подтверждённую оплату.

**URL для возврата** должен указывать на этот же официальный сайт и страницу заказа; показывать «проверяем платёж», не «оплачено» до серверного подтверждения. В URL возврата передаётся UUID заказа. Токен статуса остаётся в sessionStorage вкладки.

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
Worker `fort-grozny-payments-test` предназначен для боевого магазина несмотря на суффикс. В отдельном тестовом Worker используются те же имена секретов с тестовыми значениями и отдельной базой.
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

## Подготовленный Worker

- `worker.mjs` реализует API витрины и проверку событий через ЮKassa. Заказ
  использует UUID клиента как ключ идемпотентности ЮKassa. Токен статуса
  передаётся в заголовке и хранится в D1 в виде SHA-256.
- `schema.sql` применяется только к отдельной базе `fort-grozny-payments-live`.
  Перед удалёнными командами внесите выданный Cloudflare ID в `wrangler.toml`.
  Конфигурация сохраняет переменные из панели через `keep_vars`.
- Локальная проверка без внешних запросов и списаний: из этой директории
  выполните `node --test worker.test.mjs` на Node.js 24.

### Условия развёртывания

Проверьте в Cloudflare имена и типы `YOOKASSA_SHOP_ID` и
`YOOKASSA_SECRET_KEY`, а также значения обычных переменных
`PAYMENTS_MODE=live` и `STORE_ENABLED=false`. С рабочего окружения с доступом
к секретам выполните аутентифицированный `GET /v3/payments?limit=1` к
`api.yookassa.ru` и проверьте только HTTP-код, без вывода тела и заголовков.
Платёж этот запрос не создаёт.

После публикации Worker укажите в кабинете ЮKassa URL
`https://fort-grozny-payments-test.fort-grozny-dev.workers.dev/api/webhooks/yookassa`
и события `payment.succeeded`, `payment.canceled`, `refund.succeeded`.
Результат HTTP-проверки в кабинете требует события из соответствующего
окружения. Для имитации используйте отдельный Worker, отдельную D1 и
секреты тестового магазина с `PAYMENTS_MODE=test`.

`RECEIPTS_CONFIRMED=true` допустимо только после проверки, что личный
кабинет поддерживает и автоматически формирует чеки НПД для данного
магазина и обоих способов оплаты. Запрос создания платежа не передаёт
данные отдельного кассового чека. Если кабинету нужна передача данных
чека, этот сценарий нужно реализовать до открытия витрины.

### Подключение FG-ID и Unity

В репозитории отсутствуют реализация авторизации FG-ID для сайта и
исходники `FortGroznyAccount`. Worker ожидает приватный Cloudflare
Service Binding `ACCOUNTS`. Его адаптер должен реализовать
`POST /verify-purchase-account`, принять Bearer-токен игровой сессии и
`{playerId}`, проверить право владельца и вернуть
`{playerId, unityPlayerId}`. Это контракт нового адаптера. Вызов пока
не подтверждён для действующего FG-ID. Перед открытием витрины сайт
должен получить токен через действующий поток входа FG-ID и передать его
в `POST /api/orders`. Токен статуса заказа для этого не подходит.

Запись `entitlement_ledger` создаётся один раз на заказ. Подключите
обработчик выдачи к существующей серверной экономике после сверки исходников
Unity. Серверный вызов выдачи должен быть идемпотентным по `orderId` даже
при сбое после начисления и до записи результата в D1. Unity после оплаты
обновляет серверный баланс. Для возврата Worker сохраняет подтверждённую
операцию и отмечает запись для сверки без автоматического изменения баланса.
`STORE_ENABLED` остаётся `false` до отдельного теста этого процесса.
Флаги `SITE_AUTH_VERIFIED` и `FULFILLMENT_VERIFIED` включаются после
проверки входа на витрине и фактической серверной выдачи соответственно.
