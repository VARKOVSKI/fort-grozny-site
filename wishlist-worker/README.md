# Fort Grozny — Community Car Wishlist

Статус: **готов исходный код; НЕ развёрнуто в Cloudflare**. Сайт `https://playfortgrozny.ru/wishlist.html` уже размещён в GitHub Pages, но **приём заявок выключен**, пока не подключены API и Turnstile. Нельзя утверждать, что пользовательские голоса уже сохраняются.

## Архитектура

- `wishlist.html` — публичная страница с формой, списком моделей и голосованием.
- `wishlist-worker/worker.js` — API Cloudflare Worker без зависимостей.
- `wishlist-worker/schema.sql` — две таблицы Cloudflare D1.
- Платежи, FG-ID и Unity НЕ используются. Не подключать к `fort-grozny-dev` и `fort-grozny-payments-test`.

## Настройка в Cloudflare Dashboard

1. В **Storage & Databases → D1** создайте новую БД **`fort-grozny-wishlist`**. Не выбирайте существующую `fort-grozny-dev`.
2. В **D1 → fort-grozny-wishlist → Console** исполните файл `wishlist-worker/schema.sql`. Убедитесь, что таблицы `wishlist_cars` и `wishlist_votes` появились.
3. В **Workers & Pages → Create Worker** создайте **`fort-grozny-wishlist`**, и в **Edit code** замените шаблон `Hello World` содержимым `wishlist-worker/worker.js`; Deploy. Не изменяйте Worker идентификации или платежей.
4. В Settings → **Bindings**, добавьте **D1**: `WISHLIST_DB` → `fort-grozny-wishlist`.
5. В Settings → **Variables and Secrets** создайте ДВА **Secret**:
   - `WISHLIST_VOTER_SALT`: случайная секретная строка 32+ символа, отличная от всех платёжных ключей; генерируется локально.
   - `TURNSTILE_SECRET_KEY`: **секретный** ключ виджета Turnstile, созданного в Cloudflare.
6. В **Cloudflare Turnstile** создайте managed widget с доменами **`playfortgrozny.ru`** и (при необходимости) **`www.playfortgrozny.ru`**. Сохраните публичный **Site Key**.
7. В GitHub `VARKOVSKI/fort-grozny-site/wishlist.html` замените значения:
   ```js
   const API_BASE = 'https://fort-grozny-wishlist.fort-grozny-dev.workers.dev';
   const TURNSTILE_SITE_KEY = 'ВАШ_PUBLIC_SITE_KEY';
   ```
   API_BASE приведён как **ожидаемый адрес**, он должен точно совпадать с адресом вновь созданного Worker в вашем аккаунте; не считать его действующим, пока Worker не развёрнут. НИКОГДА не вставляйте `TURNSTILE_SECRET_KEY` в GitHub или HTML.
8. После публикации GitHub Pages откройте `https://playfortgrozny.ru/wishlist.html` без авторизации. Убедитесь, что API выдаёт `{"cars":[],"accepting":true}`, после успешного предложения появился реальный элемент, а голоса сохраняются после перезагрузки и с другого телефона.

## Функциональность

- `GET /api/wishlist`: открытый список **реальных** предложений (до 100 моделей), отсортированных по голосам.
- `POST /api/wishlist`: создать автомобиль с подтверждённым одноразовым токеном Turnstile; в случае дубликата добавляется голос к существующему автомобилю.
- `POST /api/wishlist/:id/vote`: голосование за понравившуюся модель.
- `GET /api/health`: сервисная проверка.
- Один голос на модель на псевдонимный идентификатор устройства/сети, сформированный HMAC из IP+User-Agent. IP/UA НЕ сохраняются как есть. **Это ограничение от простого накручивания, не строгая идентификация человека**: общая сеть и одинаковые браузеры могут совпасть, мотивированный пользователь может обойти защиту.
- Максимум три новые идеи и 30 голосов за последние 24 часа на такой идентификатор; Turnstile защищает от автоматизированных спам-запросов.
- Новая корректная идея появляется в общем списке сразу. **Модерация**: неподходящие записи владелец скрывает через D1 Console.

## Модерация через D1 Console

Просмотреть последние предложения:
```sql
SELECT id,name,status,created_at FROM wishlist_cars ORDER BY id DESC LIMIT 100;
```
Скрыть неподходящую запись (замените ID):
```sql
UPDATE wishlist_cars SET status='hidden' WHERE id=123;
```
Вернуть запись:
```sql
UPDATE wishlist_cars SET status='approved' WHERE id=123;
```
Не удаляйте всю базу ради модерации. При необходимости можно добавлять улучшенный контент-фильтр.

## Обязательные проверки

1. API доступен с `https://playfortgrozny.ru` (CORS); сторонний сайт не получает разрешения.
2. Неавторизованный POST или отсутствующий Turnstile должен отклоняться.
3. Предложение `BMW M3 E46` появляется и остаётся после перезагрузки.
4. Повторное предложение `bmw m3 e46` не создаёт второй строки и может добавить только один голос.
5. Голос виден с другого устройства; повторное голосование того же посетителя не увеличивает счётчик.
6. После скрытия записи в D1 она не должна отображаться.
7. При отключённой базе/ключе интерфейс показывает ошибку или временную недоступность, **не выдумывает** успешные предложения.
8. FG Donate и игровой Worker продолжают работать без изменений.

**Замечание по безопасности.** Клиент не должен считать CORS аутентификацией. Сервер проверяет одноразовые Turnstile токены через Siteverify. Не раскрывайте ни один Cloudflare Secret на скриншотах и в репозитории.
