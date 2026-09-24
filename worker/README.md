# Бот на Cloudflare Workers

Та же логика, что в `monitor.mjs`, но без GitHub Actions:
Telegram присылает сообщения через webhook (ответ мгновенный), табло проверяется
по расписанию Cloudflare раз в минуту, состояние хранится в D1.

Статус: **код готов, не задеплоен.** Бот пока работает на GitHub Actions.

## Переезд

Нужен API-токен Cloudflare (`wrangler login` из изолированной оболочки не работает):
dash.cloudflare.com → My Profile → API Tokens → Create Token → шаблон **Edit Cloudflare Workers**
+ права **D1: Edit**. Дальше `export CLOUDFLARE_API_TOKEN=...` и из папки `worker/`:

1. База: `npx wrangler d1 create flight-monitor` → вписать `database_id` в `wrangler.toml`;
   `npx wrangler d1 execute flight-monitor --remote --file=schema.sql`.
2. Секреты: `npx wrangler secret put TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, `WEBHOOK_SECRET` (случайная строка).
3. Деплой без расписания: `npx wrangler deploy`.
4. Проверка доступа к табло: `https://<worker>.workers.dev/probe?key=<WEBHOOK_SECRET>` —
   должно быть 4 строки «N рейсов». Если WAF Пулково режет Cloudflare — переезд отменяется.
5. Остановить GitHub-бота: `gh workflow disable monitor.yml`, дождаться конца текущего запуска.
6. Перенести состояние: `TELEGRAM_TOKEN=... node migrate.mjs > /tmp/m.sql`,
   `npx wrangler d1 execute flight-monitor --remote --file=/tmp/m.sql`.
7. Включить `[triggers] crons` в `wrangler.toml`, `npx wrangler deploy`.
8. Webhook: `setWebhook` с `url=https://<worker>.workers.dev/telegram`,
   `secret_token=<WEBHOOK_SECRET>`, `allowed_updates=["message"]`.
9. Проверить: написать боту, `/subscribers`, логи — `npx wrangler tail`.
