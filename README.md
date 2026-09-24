# flight-monitor

Следит за рейсом на [табло вылета Пулково](https://pulkovoairport.ru/passengers/departure/?when=0)
и присылает изменения статуса и строки рейса в Telegram.

- Данные: JSON API табло `https://pulkovoairport.ru/api/?type=departure&when=0|1` (сегодня/завтра по Москве).
- Запуск: GitHub Actions каждые 5 минут и вручную (`Actions → Flight monitor → Run workflow`).
- Состояние между запусками хранится в `state.json` и коммитится ботом только при изменениях.

## Настройка

Секреты репозитория:

```sh
gh secret set TELEGRAM_TOKEN
gh secret set TELEGRAM_CHAT_ID
```

Необязательные переменные репозитория (`gh variable set ...`):

- `FLIGHT_NUMBER` — номер рейса, по умолчанию `WZ 709`;
- `FLIGHT_DATE` — дата вылета `YYYY-MM-DD` по Москве; если не задана, отслеживается ближайший рейс.

## Локальный запуск

```sh
DRY_RUN=1 node monitor.mjs   # печатает сообщения вместо отправки
```

Нужен Node.js 18+, зависимостей нет.
