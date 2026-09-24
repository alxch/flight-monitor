// Точка входа Cloudflare Worker.
//
//   POST /telegram  — webhook Telegram (проверяется секрет в заголовке)
//   GET  /probe     — служебная проверка доступа к табло Пулково (?key=WEBHOOK_SECRET)
//   cron            — проверка табло (расписание в wrangler.toml)
//
// Хранилище — D1, таблица kv (см. schema.sql).

import { createBot, fetchBoard } from "./bot.mjs";

const d1Store = (db) => ({
  async get(key) {
    const row = await db.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first();
    return row ? JSON.parse(row.value) : null;
  },
  async put(key, value) {
    await db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(key, JSON.stringify(value)).run();
  },
});

async function withBot(env, fn) {
  const bot = createBot(env, d1Store(env.DB));
  await bot.load();
  try {
    await fn(bot);
  } finally {
    await bot.save();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/telegram") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET)
        return new Response("forbidden", { status: 403 });
      const update = await request.json();
      try {
        await withBot(env, (bot) => bot.handleUpdate(update));
      } catch (e) {
        // 200 всё равно: иначе Telegram будет повторять это сообщение бесконечно.
        console.error("Ошибка обработки сообщения:", e);
      }
      return new Response("ok");
    }

    if (url.pathname === "/probe" && url.searchParams.get("key") === env.WEBHOOK_SECRET) {
      const results = await Promise.allSettled(
        ["departure", "arrival"].flatMap((type) => [0, 1].map((w) => fetchBoard(type, w).then((r) => `${type} when=${w}: ${r.length} рейсов`))),
      );
      const lines = results.map((r) => (r.status === "fulfilled" ? r.value : `ОШИБКА: ${r.reason.message}`));
      return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(withBot(env, (bot) => bot.checkBoard()).catch((e) => console.error("Ошибка проверки табло:", e)));
  },
};
