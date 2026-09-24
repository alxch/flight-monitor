// Мониторинг рейса на табло вылета Пулково с уведомлениями в Telegram.
//
// Табло (https://pulkovoairport.ru/passengers/departure/?when=0) рисуется JS'ом
// из JSON API: /api/?type=departure&when=N (N=0 — сегодня, 1 — завтра по Москве).
// WAF отдаёт 403 на запросы без браузерного User-Agent.
//
// Бот принимает /start, /stop, /status от любых пользователей и рассылает
// изменения всем подписчикам. Запуск длится RUN_SECONDS: всё это время бот
// слушает Telegram (long polling), а табло проверяет раз в BOARD_INTERVAL секунд.
// После вылета рейса бот присылает финальное сообщение и больше не проверяет табло.
//
// Переменные окружения:
//   TELEGRAM_TOKEN   — токен бота (обязателен, если не DRY_RUN)
//   TELEGRAM_CHAT_ID — владелец: первый подписчик, получает уведомления о новых
//   FLIGHT_NUMBER    — номер рейса, по умолчанию "WZ 709"
//   FLIGHT_DATE      — дата вылета YYYY-MM-DD по Москве; пусто — ближайший рейс
//   RUN_SECONDS      — сколько работать за запуск, по умолчанию 0 (одна проверка)
//   BOARD_INTERVAL   — период проверки табло в секундах, по умолчанию 60
//   STATE_FILE       — файл состояния, по умолчанию state.json
//   DRY_RUN=1        — без Telegram: печатать сообщения в консоль

import { readFile, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const FLIGHT_NUMBER = (process.env.FLIGHT_NUMBER || "WZ 709").trim();
const FLIGHT_DATE = (process.env.FLIGHT_DATE || "").trim();
const RUN_SECONDS = Number(process.env.RUN_SECONDS || 0);
const BOARD_INTERVAL = Number(process.env.BOARD_INTERVAL || 60);
const STATE_FILE = process.env.STATE_FILE || "state.json";
const DRY_RUN = process.env.DRY_RUN === "1";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BOARD_URL = "https://pulkovoairport.ru/passengers/departure/";
const API_URL = "https://pulkovoairport.ru/api/";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const normFlight = (s) => s.replace(/\s+/g, " ").trim().toUpperCase();

// Пустые поля API приходят как {} — приводим всё к строкам.
const str = (v) => (typeof v === "string" ? v.trim() : "");

// Текущее московское время в формате полей API ("2026-09-25T07:40:00").
const moscowNow = () =>
  new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 19);

const hhmm = (ts) => (ts ? ts.slice(11, 16) : "");
const ddmm = (ts) => (ts ? `${ts.slice(8, 10)}.${ts.slice(5, 7)}` : "");

async function fetchBoard(when) {
  const url = `${API_URL}?type=departure&when=${when}&_=${Date.now()}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${BOARD_URL}?when=${when}`,
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`when=${when}: HTTP ${res.status}`);
  const data = JSON.parse(await res.text());
  if (!Array.isArray(data)) throw new Error(`when=${when}: ответ не массив`);
  return data;
}

// Статус так, как его показывает табло (повторяет логику script.js сайта).
function boardStatus(f, now) {
  const counterStart = f.OD_COUNTER_BEGIN_ACTUAL || f.OD_COUNTER_BEGIN_PLAN;
  const counterEnd = f.OD_COUNTER_END_ACTUAL || f.OD_COUNTER_END_PLAN;
  const boardingStart = f.OD_BOARDING_BEGIN_ACTUAL || f.OD_BOARDING_BEGIN_PLAN;
  const boardingEnd = f.OD_BOARDING_END_ACTUAL || f.OD_BOARDING_END_PLAN;
  const within = (a, b) => a && b && now > a.slice(0, 19) && b.slice(0, 19) > now;

  if (f.OD_STATUS_EN === "Departed" || f.OD_OFFBLOCK)
    return `Отправлен в ${hhmm(f.OD_OFFBLOCK || f.OD_STD)}`;
  if (f.OD_STATUS_EN === "Delayed") return "Задержан";
  if (within(counterStart, counterEnd))
    return `Регистрация${f.OD_COUNTERS ? ` ${f.OD_COUNTERS}` : ""}`;
  if (f.OD_STATUS_EN === "Canceled") return "Отмена";
  if (within(boardingStart, boardingEnd))
    return `Идет посадка${f.OD_GATES ? `, выход ${f.OD_GATES}` : ""}`;
  if (boardingEnd && now > boardingEnd.slice(0, 19))
    return `Посадка закончена в ${hhmm(f.OD_BOARDING_END_PLAN || boardingEnd)}`;
  return f.OD_STATUS_RU || "По расписанию";
}

// Снимок строки рейса: всё, изменение чего стоит сообщить.
function snapshot(raw, now) {
  const f = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, str(v)]));
  return {
    id: f.OD_ID,
    flight: normFlight(f.OD_FLIGHT_NUMBER),
    date: f.OD_STD.slice(0, 10),
    destination: f.OD_RAP_DESTINATION_NAME_RU,
    airline: f.OD_RAL_NAME_RUS,
    aircraft: f.OD_RACT_ICAO_CODE,
    registration: f.OD_RAC_CODE,
    terminal: f.OD_RTRM_CODE,
    std: f.OD_STD,
    etd: f.OD_ETD,
    atd: f.OD_ATD,
    offblock: f.OD_OFFBLOCK,
    statusCode: f.OD_RFS_CODE,
    statusRu: f.OD_STATUS_RU,
    boardStatus: boardStatus(f, now),
    counters: f.OD_COUNTERS,
    checkinPlan: [f.OD_COUNTER_BEGIN_PLAN, f.OD_COUNTER_END_PLAN].map(hhmm).join("–"),
    checkinStarted: f.OD_COUNTER_BEGIN_ACTUAL,
    checkinEnded: f.OD_COUNTER_END_ACTUAL,
    gate: f.OD_GATES,
    boardingPlan: [f.OD_BOARDING_BEGIN_PLAN, f.OD_BOARDING_END_PLAN].map(hhmm).join("–"),
    boardingStarted: f.OD_BOARDING_BEGIN_ACTUAL,
    boardingEnded: f.OD_BOARDING_END_ACTUAL,
    cancelled: f.OD_CANCELLATION_TIME,
  };
}

const LABELS = {
  boardStatus: "Статус",
  etd: "Расчётное время",
  atd: "Фактический вылет",
  offblock: "Уход со стоянки",
  counters: "Стойки регистрации",
  checkinPlan: "Регистрация (план)",
  checkinStarted: "Регистрация началась",
  checkinEnded: "Регистрация закончилась",
  gate: "Выход",
  boardingPlan: "Посадка (план)",
  boardingStarted: "Посадка началась",
  boardingEnded: "Посадка закончилась",
  statusCode: "Код статуса",
  statusRu: "Статус (API)",
  aircraft: "Самолёт",
  registration: "Борт",
  terminal: "Терминал",
  cancelled: "Отменён",
  std: "Время по расписанию",
};
const TIME_FIELDS = new Set([
  "etd", "atd", "offblock", "checkinStarted", "checkinEnded",
  "boardingStarted", "boardingEnded", "cancelled", "std",
]);
const fmt = (k, v) => (!v ? "—" : TIME_FIELDS.has(k) ? hhmm(v) : v);

function describe(s) {
  const lines = [
    `✈️ ${s.flight} ${ddmm(s.std)} ${hhmm(s.std)} Санкт-Петербург → ${s.destination}`,
    `${s.airline}, ${s.aircraft}${s.registration ? ` (${s.registration})` : ""}`,
    `Статус: ${s.boardStatus}`,
  ];
  if (s.etd && s.etd !== s.std) lines.push(`Расчётное время: ${hhmm(s.etd)}`);
  if (s.counters) lines.push(`Стойки регистрации: ${s.counters}${s.checkinPlan !== "–" ? ` (${s.checkinPlan})` : ""}`);
  if (s.gate) lines.push(`Выход: ${s.gate}${s.boardingPlan !== "–" ? ` (посадка ${s.boardingPlan})` : ""}`);
  if (s.atd) lines.push(`Фактический вылет: ${hhmm(s.atd)}`);
  return lines.join("\n");
}

function diff(prev, cur) {
  return Object.keys(LABELS)
    .filter((k) => (prev[k] || "") !== (cur[k] || ""))
    .map((k) => `• ${LABELS[k]}: ${fmt(k, prev[k])} → ${fmt(k, cur[k])}`);
}

const isDeparted = (s) =>
  Boolean(s.offblock || s.atd || s.statusCode === "OFF" || s.statusCode === "OFB");

// ---------- Telegram ----------

let sendErrors = 0;

async function tg(method, params = {}, timeoutMs = 30000) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) {
    const err = new Error(`Telegram ${method}: ${body.error_code || res.status} ${body.description || ""}`);
    err.code = body.error_code || res.status;
    throw err;
  }
  return body.result;
}

async function send(chatId, text) {
  if (DRY_RUN) {
    console.log(`[dry-run] → ${chatId}:\n${text}\n`);
    return;
  }
  try {
    await tg("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
    console.log(`→ ${chatId}: ${text.split("\n")[0]}`);
  } catch (e) {
    // 403 — пользователь заблокировал бота, 400 chat not found — чата больше нет.
    if (e.code === 403 || (e.code === 400 && /chat not found/i.test(e.message))) {
      console.warn(`Отписываю ${chatId}: ${e.message}`);
      subscribers.delete(String(chatId));
    } else {
      sendErrors++;
      console.error(`Не отправлено ${chatId}: ${e.message}`);
    }
  }
}

async function broadcast(text) {
  console.log(`Рассылка ${subscribers.size} подписчикам:\n${text}\n`);
  for (const id of [...subscribers]) await send(id, text);
}

// ---------- Состояние ----------
// state.json лежит в публичном репозитории, поэтому chat_id подписчиков
// хранятся зашифрованными ключом, выведенным из токена бота.

const subsKey = () => createHash("sha256").update(`subscribers:${TELEGRAM_TOKEN}`).digest();

function encryptSubs(ids) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", subsKey(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(ids), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
}

function decryptSubs(blob) {
  const buf = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", subsKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
}

let state = {};
let subscribers = new Set();
let savedJson = "";
let savedSubs = "";

async function loadState() {
  try {
    state = JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    state = {};
  }
  savedJson = JSON.stringify(state);

  let ids = null;
  if (state.subscribers && TELEGRAM_TOKEN) {
    try {
      ids = decryptSubs(state.subscribers);
    } catch {
      console.warn("Не удалось расшифровать подписчиков (сменился токен?) — начинаю заново");
    }
  }
  subscribers = new Set((ids ?? [TELEGRAM_CHAT_ID || "dry-run"]).map(String));
  savedSubs = JSON.stringify([...subscribers].sort());
}

async function saveState() {
  const subsNow = JSON.stringify([...subscribers].sort());
  if (TELEGRAM_TOKEN && (subsNow !== savedSubs || !state.subscribers)) {
    state.subscribers = encryptSubs([...subscribers]);
    savedSubs = subsNow;
  }
  const json = JSON.stringify(state);
  if (json === savedJson) return;
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  savedJson = json;
}

// ---------- Табло ----------

const target = normFlight(FLIGHT_NUMBER);
const targetKey = `${target}|${FLIGHT_DATE}`;

// Выбор рейса: тот, что уже отслеживаем; иначе нужная дата; иначе ближайший
// ещё не улетевший; иначе последний.
function pickFlight(flights, now) {
  const snaps = flights.map((f) => snapshot(f, now)).sort((a, b) => a.std.localeCompare(b.std));
  const tracked = state.flight && snaps.find((s) => s.id === state.flight.id);
  if (tracked) return tracked;
  if (FLIGHT_DATE) return snaps.find((s) => s.date === FLIGHT_DATE) || null;
  return snaps.find((s) => !isDeparted(s) && s.statusCode !== "XLD") || snaps.at(-1) || null;
}

async function checkBoard() {
  const now = moscowNow();
  const prev = state;
  const firstRun = !prev.target && !prev.flight;

  const results = await Promise.allSettled([0, 1].map(fetchBoard));
  const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason.message);
  const all = results.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
  errors.forEach((e) => console.warn("Ошибка загрузки:", e));
  const flight = pickFlight(all.filter((f) => normFlight(str(f.OD_FLIGHT_NUMBER)) === target), now);

  let message = null;
  if (flight) {
    const header = firstRun ? "Мониторинг запущен."
      : prev.flight?.id !== flight.id ? `Отслеживается рейс ${ddmm(flight.std)}.`
      : null;
    const changes = header ? [] : diff(prev.flight, flight);
    if (isDeparted(flight)) {
      const body = changes.length ? `Изменения по рейсу:\n${changes.join("\n")}\n\n` : "";
      message = `🛫 Рейс вылетел.\n\n${body}${describe(flight)}\n\nМониторинг рейса завершён. Хорошего полёта!`;
      state.finished = true;
    } else if (header) {
      message = `${header}\n\n${describe(flight)}`;
    } else if (changes.length) {
      message = `Изменения по рейсу:\n${changes.join("\n")}\n\n${describe(flight)}`;
    } else if (prev.problem) {
      const back = prev.problem === "unavailable" ? "Табло снова доступно" : "Рейс снова на табло";
      message = `${back}, изменений нет.\n\n${describe(flight)}`;
    }
    state.flight = flight;
    state.problem = null;
  } else {
    const problem = all.length === 0 ? "unavailable" : "not_found";
    if (prev.problem !== problem) {
      const dateNote = FLIGHT_DATE ? ` на ${FLIGHT_DATE}` : "";
      message = problem === "unavailable"
        ? `⚠️ Табло Пулково недоступно: ${errors.join("; ")}\nСообщу, когда оно снова заработает.`
        : `⚠️ Рейс ${target}${dateNote} не найден на табло Пулково (сегодня/завтра).\nСообщу, когда он появится.`;
    }
    state.problem = problem;
  }
  state.target = targetKey;

  console.log(`[${now} МСК] ${flight ? `${flight.flight}: ${flight.boardStatus}` : state.problem}`);
  if (message) await broadcast(message);
}

// Текущий статус для ответа на команды — по последней проверке табло.
function statusText() {
  if (state.flight && state.finished)
    return `Рейс уже вылетел, мониторинг завершён.\n\n${describe(state.flight)}`;
  if (state.problem === "unavailable") return "⚠️ Табло Пулково сейчас недоступно.";
  if (state.problem === "not_found") return `⚠️ Рейс ${target} пока не найден на табло Пулково.`;
  if (state.flight) return describe(state.flight);
  return "Статус ещё не получен, попробуйте через минуту.";
}

// ---------- Команды бота ----------

const HELP = [
  "Провожаем Элю в Батуми ✈️",
  "",
  `Я слежу за рейсом ${target} по табло аэропорта Пулково и присылаю изменения:`,
  "регистрация, выход, посадка, задержки, вылет.",
  "",
  "/start — подписаться на уведомления",
  "/status — текущий статус рейса",
  "/stop — отписаться",
].join("\n");

async function handleUpdate(u) {
  const msg = u.message;
  if (!msg?.text || !msg.chat) return;
  const chatId = String(msg.chat.id);
  const cmd = msg.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
  const who = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ")
    + (msg.from?.username ? ` (@${msg.from.username})` : "");
  console.log(`← ${chatId} ${cmd}`);

  if (cmd === "/start") {
    const isNew = !subscribers.has(chatId);
    subscribers.add(chatId);
    await send(chatId, `${isNew ? "Вы подписаны" : "Вы уже подписаны"} на рейс ${target}.\n\n${statusText()}\n\n/stop — отписаться`);
    if (isNew && TELEGRAM_CHAT_ID && chatId !== String(TELEGRAM_CHAT_ID))
      await send(TELEGRAM_CHAT_ID, `👤 Новый подписчик: ${who || chatId}`);
  } else if (cmd === "/stop") {
    subscribers.delete(chatId);
    await send(chatId, "Вы отписались от уведомлений. /start — подписаться снова.");
  } else if (cmd === "/status") {
    await send(chatId, statusText());
  } else if (msg.chat.type === "private") {
    await send(chatId, HELP);
  }
}

async function pollUpdates(timeoutSec) {
  if (DRY_RUN || !TELEGRAM_TOKEN) return;
  let updates;
  try {
    updates = await tg("getUpdates", {
      offset: state.updateOffset || 0,
      timeout: timeoutSec,
      allowed_updates: ["message"],
    }, (timeoutSec + 15) * 1000);
  } catch (e) {
    console.warn(e.message);
    await new Promise((r) => setTimeout(r, 5000));
    return;
  }
  for (const u of updates) {
    state.updateOffset = u.update_id + 1;
    try {
      await handleUpdate(u);
    } catch (e) {
      console.error("Ошибка обработки сообщения:", e);
    }
  }
}

// ---------- Главный цикл ----------

async function main() {
  if (!DRY_RUN && !TELEGRAM_TOKEN) throw new Error("Не задан TELEGRAM_TOKEN (или DRY_RUN=1)");
  await loadState();

  // Сменили рейс или дату в настройках — начинаем мониторинг заново.
  if (state.target && state.target !== targetKey) {
    console.log(`Новая цель ${targetKey} (была ${state.target})`);
    delete state.flight;
    delete state.finished;
    delete state.problem;
    delete state.target;
  }

  const deadline = Date.now() + RUN_SECONDS * 1000;
  let nextBoard = 0;
  do {
    if (Date.now() >= nextBoard) {
      nextBoard = Date.now() + BOARD_INTERVAL * 1000;
      if (state.finished) {
        if (!RUN_SECONDS) console.log("Рейс вылетел, мониторинг завершён.");
      } else {
        try {
          await checkBoard();
        } catch (e) {
          console.error("Ошибка проверки табло:", e);
        }
      }
      await saveState();
    }
    const waitSec = Math.floor((Math.min(nextBoard, deadline) - Date.now()) / 1000);
    await pollUpdates(Math.max(0, Math.min(50, waitSec)));
    await saveState();
  } while (Date.now() < deadline);

  if (sendErrors) throw new Error(`Не удалось отправить ${sendErrors} сообщений`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
