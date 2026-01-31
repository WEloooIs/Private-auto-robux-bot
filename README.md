# Playerok Starvell Bot

Node.js (TypeScript) сервис-бот для Playerok с режимами поставщика: `http` (supplier-service) или `operator` (ручная покупка + мониторинг Starvell чата).

## Возможности
- Идемпотентная обработка сделок по `deal_id`.
- FSM состояния заказа и хранение в SQLite через Prisma.
- Запрос у покупателя `roblox_username`, `gamepass_url` и `gamepass_id`.
- Покупка через Supplier Service (`/purchase`) или ручной операторский режим.
- Ретраи покупки (3 попытки) и таймаут поллинга (20 минут).

## Структура
- `src/index.ts` — точка входа.
- `src/playerok/handlers.ts` — обработка событий Playerok.
- `src/orders/fsm.ts` — состояния и переходы.
- `prisma/schema.prisma` — схема БД.
- `src/supplier/client.ts`, `src/supplier/httpClient.ts`, `src/supplier/operatorClient.ts` — клиент поставщика.
- `src/worker/queue.ts` — очередь и ретраи.
- `supplier-service/` — отдельный сервис-заглушка Starvell Supplier Service.

## Конфиг
`.env` (см. `.env.example`):
```
PLAYEROK_TOKEN=...
PLAYEROK_UNIVERSAL_PATH=
PLAYEROK_USE_NODE_SDK=false
PLAYEROK_WEBHOOK_PORT=3100
PLAYEROK_WEBHOOK_PATH=/playerok/events
PLAYEROK_WEBHOOK_TOKEN=
PLAYEROK_PROXY_URL=http://localhost:3201
PLAYEROK_PROXY_TOKEN=
SUPPLIER_BASE_URL=http://localhost:4000
SUPPLIER_MODE=http
OPERATOR_CHAT_IDS=
OPERATOR_NOTIFY_CHAT_ID=
STARVELL_COOKIE=
DEFAULT_OFFER_URL=https://starvell.com/offers/72878
DATABASE_URL="file:./dev.db"
LOG_LEVEL=info
AUTO_MIGRATE=true
```
- Если `DEFAULT_OFFER_URL` не задан, используется `https://starvell.com/offers/115374`.

`config/products.json`:
```
{
  "defaultOfferUrl": "https://starvell.com/offers/72878",
  "products": {}
}
```
`products` может задавать количество робуксов, если оно не приходит в событии:
```
{
  "defaultOfferUrl": "https://starvell.com/offers/72878",
  "products": {
    "ITEM_ID": { "offerUrl": "https://starvell.com/offers/72878", "robuxAmount": 100 }
  }
}
```
- `offer_url` приоритетно берётся из payload сделки.
- Если `offer_url` нет, используется `products[product_id].offerUrl`.
- Если в `products.json` указан `defaultOfferUrl`, он имеет приоритет над `DEFAULT_OFFER_URL`.
- Если `config/products.json` отсутствует или некорректен, бот не падает: берётся дефолт из `DEFAULT_OFFER_URL` (или `https://starvell.com/offers/49155`), выводится предупреждение, а файл создаётся автоматически.
- Пример структуры: `config/products.example.json`.

## FSM (состояния)
`PAID_RECEIVED -> WAIT_USERNAME -> WAIT_GAMEPASS_URL -> WAIT_GAMEPASS_ID -> READY_TO_BUY -> WAIT_TOPUP -> SUPPLIER_PENDING -> DONE`.
Ошибки переводят заказ в `FAILED`.

## Процессы
Обязательные процессы для webhook-only пути:
1) Node-бот `playerok-starvell-bot` — основной обработчик и покупка у поставщика.
2) Python `playerok-universal` — мост событий Playerok -> webhook.
3) Supplier Service — mock поставщика (из `supplier-service/`) если `SUPPLIER_MODE=http`.

## Operator supplier mode
Если `SUPPLIER_MODE=operator`, бот не покупает автоматически. Он создаёт операторскую задачу, оператор вручную покупает на Starvell, бот мониторит Starvell-чат и переводит статус в READY_TO_CONFIRM.

Переменные окружения:
- `SUPPLIER_MODE=operator`
- `STARVELL_COOKIE=...` (cookie для чтения Starvell order/chat; не коммитить)
- `TELEGRAM_BOT_TOKEN=...`
- `TELEGRAM_OPERATOR_CHAT_ID=...`

Команды оператора:
- `!supplier bought <taskId> <starvellOrderIdOrUrl>`
- `!supplier done <taskId> <proof>`
- `!supplier fail <taskId> <reason>`
- `!supplier status <taskId>`
- `/chatid` (узнать chat_id в Telegram)
- `/balance <available> <pending> <frozen>` (ручной баланс)

## PowerShell env (пример)
```
$env:PLAYEROK_WEBHOOK_URL="http://localhost:3100/playerok/events"
$env:PLAYEROK_WEBHOOK_TOKEN=""
$env:DEFAULT_OFFER_URL="https://starvell.com/offers/72878"
```

## Запуск
1) Установить зависимости:
```
npm install
```

2) Prisma:
```
npx prisma generate
npx prisma migrate deploy
```

Автомиграция включена по умолчанию: при старте выполняется `prisma migrate deploy`.
Если нужно отключить, установите `AUTO_MIGRATE=false`.

3) Запустить supplier-service (нужно только при `SUPPLIER_MODE=http`):
```
cd supplier-service
npm install
npm start
```

4) Запустить бота:
```
cd ..
npm run dev
```

## Telegram (оператор)
1) Создайте бота через @BotFather и получите токен.
2) Напишите боту `/start`, затем `/chatid` — он ответит вашим chat_id.
3) Добавьте в `.env`:
```
TELEGRAM_BOT_TOKEN=ВАШ_ТОКЕН
TELEGRAM_OPERATOR_CHAT_ID=ВАШ_CHAT_ID
```

Проверка конфига продуктов:
```
npm run check-config
```

E2E локально:
```
npm run e2e:local
```
Перед запуском `npm run e2e:local` должен быть запущен `playerok-universal` с `PLAYEROK_WEBHOOK_URL`.

## Playerok SDK (локальная папка/архив)
Если `playerok-universal` не установлен через npm, можно указать локальный путь:
```
PLAYEROK_UNIVERSAL_PATH=path\to\playerok-universal
```
Путь может указывать на папку с `package.json`/`index.js` или на `.js` файл.
Если у вас архив (`.zip`, `.tgz`), распакуйте его и укажите путь к папке.

## Playerok Python -> Node webhook
Если вы используете Python-бот `playerok-universal`, события можно пересылать в Node по HTTP.
В Node-боте включён простой webhook:
- `PLAYEROK_WEBHOOK_PORT` (по умолчанию `3100`)
- `PLAYEROK_WEBHOOK_PATH` (по умолчанию `/playerok/events`)
- `PLAYEROK_WEBHOOK_TOKEN` (опционально, для защиты)
  - заголовок: `X-Webhook-Token`

В Python-боте добавлен модуль `playerok_webhook` (папка `playerok-universal/modules/playerok_webhook`),
который отправляет события `NEW_DEAL`, `ITEM_PAID`, `NEW_MESSAGE`.
Если переменные окружения не заданы, Python-бот берёт URL из `playerok-universal/bot_settings/webhook.json`.
Нужно задать переменные окружения для Python-бота (опционально):
```
PLAYEROK_WEBHOOK_URL=http://localhost:3100/playerok/events
PLAYEROK_WEBHOOK_TOKEN=
```

Python-бот также поднимает proxy для отправки сообщений и подтверждения сделок:
- `PLAYEROK_PROXY_URL` в Node (по умолчанию `http://localhost:3201`)
- конфиг: `playerok-universal/bot_settings/webhook.json` (`proxy_port`, `proxy_token`)

Проверка webhook (локально):
```
npm run test:webhook
```

Health check:
```
GET http://localhost:3100/healthz
```

## Starvell bot
В репозитории есть `starvell_bot1` (Python). Он не обязателен для работы Node-бота,
но может понадобиться для ваших дополнительных задач.
Запуск:
```
cd starvell_bot1
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\python run_bot.py
```

## Сообщения покупателю
В webhook-only режиме отправка сообщений идёт через stub‑клиент (логирует `Stub sendMessage`).
Для реальной отправки сообщений нужен JS‑SDK Playerok:
- `PLAYEROK_USE_NODE_SDK=true`
- `PLAYEROK_UNIVERSAL_PATH=path\to\js-sdk`

## Supplier Service
`supplier-service/index.js` — заглушка с памятью. Место для интеграции `exfador/starvell_api` отмечено `TODO`.

## Формат сообщений покупателя
- Ник: строка без пробелов по краям, 3..20 символов.
- Геймпасс: ссылка + ID пасса (числом).
- Можно в одном сообщении: `ник: MyUser геймпасс: https://roblox.com/game-pass/1234567/... id: 1234567`.

## E2E цепочка (локальная проверка)
Playerok -> `playerok-universal` -> webhook Node ->
создание заказа -> запрос данных -> получение `roblox_username`, `gamepass_url`, `gamepass_id` ->
`/purchase` -> `supplier_order_id` -> polling -> `DONE` -> сообщение покупателю -> подтверждение сделки (если доступен SDK).
