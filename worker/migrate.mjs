// Переносит состояние из state.json (GitHub Actions) в D1 (Cloudflare).
// Печатает SQL для `wrangler d1 execute flight-monitor --remote --file=-`.
//
//   TELEGRAM_TOKEN=... node worker/migrate.mjs > migrate.sql
//
// Подписчики в state.json зашифрованы ключом из токена бота — расшифровываем здесь.

import { readFileSync } from "node:fs";
import { createDecipheriv, createHash } from "node:crypto";

const token = process.env.TELEGRAM_TOKEN;
if (!token) throw new Error("Нужен TELEGRAM_TOKEN");
const s = JSON.parse(readFileSync(process.env.STATE_FILE || "state.json", "utf8"));

let subs = {};
if (s.subscribers) {
  const buf = Buffer.from(s.subscribers, "base64");
  const key = createHash("sha256").update(`subscribers:${token}`).digest();
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  const data = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
  subs = Array.isArray(data) ? Object.fromEntries(data.map((id) => [id, {}])) : data;
}

const { config, subscribers, updateOffset, announce, descriptionKey, cloudflareReminderSent, ...state } = s;
const rows = { state, subs, ...(config ? { config } : {}) };
const q = (v) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
for (const [key, value] of Object.entries(rows))
  console.log(`INSERT INTO kv (key, value) VALUES ('${key}', ${q(value)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`);
console.error(`Подписчиков: ${Object.keys(subs).length}, рейс: ${state.flight?.flight || "—"}`);
