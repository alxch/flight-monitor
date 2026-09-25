// Мониторинг рейса на табло Пулково с уведомлениями в Telegram.
//
// Табло вылета (https://pulkovoairport.ru/passengers/departure/) и прилёта
// (https://pulkovoairport.ru/passengers/arrival/) рисуются JS'ом из JSON API:
// /api/?type=departure|arrival&when=N (N=0 — сегодня, 1 — завтра по Москве).
// WAF отдаёт 403 на запросы без браузерного User-Agent.
//
// Рейс ищется на обоих табло: нашёлся на вылете — «Провожаем», на прилёте — «Встречаем».
// Бот принимает /start и /stop от любых пользователей и рассылает изменения всем
// подписчикам. Владелец (TELEGRAM_CHAT_ID) меняет рейс командой /flight и смотрит
// список подписчиков командой /subscribers. Запуск длится RUN_SECONDS: всё это время
// бот слушает Telegram (long polling), а табло проверяет раз в BOARD_INTERVAL секунд.
// После вылета/прилёта бот присылает финальное сообщение и больше не проверяет табло,
// но продолжает отвечать на команды.
//
// Переменные окружения:
//   TELEGRAM_TOKEN   — токен бота (обязателен, если не DRY_RUN)
//   TELEGRAM_CHAT_ID — владелец: первый подписчик, админ-команды, уведомления о новых
//   FLIGHT_NUMBER    — рейс по умолчанию, "WZ 709" (команда /flight его перекрывает)
//   FLIGHT_DATE      — дата по умолчанию YYYY-MM-DD по Москве; пусто — ближайший рейс
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

const PERSON = "Элю"; // «Провожаем Элю», «Встречаем Элю»
const HOME = "Санкт-Петербург";

const BOARD_URLS = {
  departure: "https://pulkovoairport.ru/passengers/departure/",
  arrival: "https://pulkovoairport.ru/passengers/arrival/",
};
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

async function fetchBoard(type, when) {
  const url = `${API_URL}?type=${type}&when=${when}&_=${Date.now()}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${BOARD_URLS[type]}?when=${when}`,
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${type} when=${when}: HTTP ${res.status}`);
  const data = JSON.parse(await res.text());
  if (!Array.isArray(data)) throw new Error(`${type} when=${when}: ответ не массив`);
  return data.map((row) => ({ type, row }));
}

// ---------- Строка рейса ----------

// Статус вылета так, как его показывает табло (повторяет логику script.js сайта).
function departureStatus(f, now) {
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

// Статус прилёта: как на табло («Прибыл», «Задержан», иначе «Ожидается»),
// плюс «В полёте», если самолёт уже вылетел из пункта отправления.
function arrivalStatus(f) {
  if (f.OA_STATUS_RU) return f.OA_STATUS_RU;
  if (f.OA_RAP_CODE_ORIGIN_ATD) return "В полёте";
  return "Ожидается";
}

// Снимок строки рейса: всё, изменение чего стоит сообщить.
function snapshot({ type, row }, now) {
  const f = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, str(v)]));
  if (type === "departure") {
    return {
      kind: "departure",
      id: f.OD_ID,
      flight: normFlight(f.OD_FLIGHT_NUMBER),
      date: f.OD_STD.slice(0, 10),
      from: HOME,
      to: f.OD_RAP_DESTINATION_NAME_RU,
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
      boardStatus: departureStatus(f, now),
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
  return {
    kind: "arrival",
    id: `A${f.OA_ID}`, // id вылетов и прилётов из разных таблиц
    flight: normFlight(f.OA_FLIGHT_NUMBER),
    date: f.OA_STA.slice(0, 10),
    from: f.OA_RAP_ORIGIN_NAME_RU,
    to: HOME,
    airline: f.OA_RAL_NAME_RUS,
    aircraft: f.OA_RACT_ICAO_CODE,
    registration: f.OA_RAC_CODE,
    terminal: f.OA_RTRM_CODE,
    sta: f.OA_STA,
    eta: f.OA_ETA,
    originAtd: f.OA_RAP_CODE_ORIGIN_ATD,
    ata: f.OA_ATA,
    onblock: f.OA_ONBLOCK,
    statusCode: f.OA_RFS_CODE,
    statusRu: f.OA_STATUS_RU,
    boardStatus: arrivalStatus(f),
    belt: f.OA_BAGGAGEBELTS,
    beltStart: f.OA_BAGGAGEBELT_BEGIN,
    beltEnd: f.OA_BAGGAGEBELT_END,
    cancelled: f.OA_CANCELLATION_TIME,
  };
}

// Старые снимки (до поддержки прилёта) — это вылеты без kind/from/to.
const kindOf = (s) => s.kind || "departure";
const schedOf = (s) => s.std || s.sta;
const fromOf = (s) => s.from || HOME;
const toOf = (s) => s.to || s.destination;
const isArrival = (s) => kindOf(s) === "arrival";

// Рейс завершён: вылетел (для вылета) или приземлился (для прилёта).
const isDone = (s) => isArrival(s)
  ? Boolean(s.ata || s.onblock || s.statusCode === "ONB")
  : Boolean(s.offblock || s.atd || s.statusCode === "OFF" || s.statusCode === "OFB");

const LABELS = {
  boardStatus: "Статус",
  etd: "Расчётное время",
  eta: "Расчётное время прилёта",
  originAtd: "Вылетел из пункта отправления",
  atd: "Фактический вылет",
  ata: "Фактический прилёт",
  offblock: "Уход со стоянки",
  onblock: "Прибыл на стоянку",
  counters: "Стойки регистрации",
  checkinPlan: "Регистрация (план)",
  checkinStarted: "Регистрация началась",
  checkinEnded: "Регистрация закончилась",
  gate: "Выход",
  boardingPlan: "Посадка (план)",
  boardingStarted: "Посадка началась",
  boardingEnded: "Посадка закончилась",
  belt: "Лента выдачи багажа",
  beltStart: "Выдача багажа началась",
  beltEnd: "Выдача багажа закончилась",
  statusCode: "Код статуса",
  statusRu: "Статус (API)",
  aircraft: "Самолёт",
  registration: "Борт",
  terminal: "Терминал",
  cancelled: "Отменён",
  std: "Время по расписанию",
  sta: "Время прилёта по расписанию",
};
const TIME_FIELDS = new Set([
  "etd", "eta", "originAtd", "atd", "ata", "offblock", "onblock", "checkinStarted",
  "checkinEnded", "boardingStarted", "boardingEnded", "beltStart", "beltEnd",
  "cancelled", "std", "sta",
]);
const fmt = (k, v) => (!v ? "—" : TIME_FIELDS.has(k) ? hhmm(v) : v);

function describe(s) {
  const sched = schedOf(s);
  const lines = [
    `✈️ ${s.flight} ${ddmm(sched)} ${hhmm(sched)} ${fromOf(s)} → ${toOf(s)}`,
    `${s.airline}, ${s.aircraft}${s.registration ? ` (${s.registration})` : ""}`,
    `Статус: ${s.boardStatus}`,
  ];
  if (isArrival(s)) {
    if (s.eta && s.eta !== s.sta && !s.ata) lines.push(`Расчётное время прилёта: ${hhmm(s.eta)}`);
    if (s.originAtd) lines.push(`Вылет из пункта отправления: ${hhmm(s.originAtd)}`);
    if (s.ata) lines.push(`Фактический прилёт: ${hhmm(s.ata)}`);
    if (s.belt) lines.push(`Лента выдачи багажа: ${s.belt}`);
  } else {
    if (s.etd && s.etd !== s.std) lines.push(`Расчётное время: ${hhmm(s.etd)}`);
    if (s.counters) lines.push(`Стойки регистрации: ${s.counters}${s.checkinPlan !== "–" ? ` (${s.checkinPlan})` : ""}`);
    if (s.gate) lines.push(`Выход: ${s.gate}${s.boardingPlan !== "–" ? ` (посадка ${s.boardingPlan})` : ""}`);
    if (s.atd) lines.push(`Фактический вылет: ${hhmm(s.atd)}`);
  }
  return lines.join("\n");
}

function diff(prev, cur) {
  return Object.keys(LABELS)
    .filter((k) => (prev[k] || "") !== (cur[k] || ""))
    .map((k) => `• ${LABELS[k]}: ${fmt(k, prev[k])} → ${fmt(k, cur[k])}`);
}

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

// Возвращает отправленное сообщение (нужен message_id для будильника) или null.
async function send(chatId, text, extra = {}) {
  if (DRY_RUN) {
    console.log(`[dry-run] → ${chatId}${extra.reply_markup ? " [кнопка]" : ""}:\n${text}\n`);
    return { message_id: Date.now() };
  }
  try {
    const m = await tg("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...extra });
    console.log(`→ ${chatId}: ${text.split("\n")[0]}`);
    return m;
  } catch (e) {
    // 403 — пользователь заблокировал бота, 400 chat not found — чата больше нет.
    if (e.code === 403 || (e.code === 400 && /chat not found/i.test(e.message))) {
      console.warn(`Отписываю ${chatId}: ${e.message}`);
      subscribers.delete(String(chatId));
    } else {
      sendErrors++;
      console.error(`Не отправлено ${chatId}: ${e.message}`);
    }
    return null;
  }
}

// Вызов API, ошибка которого не критична (удалить/отредактировать старое сообщение).
const tgQuiet = (method, params) =>
  DRY_RUN ? Promise.resolve(null) : tg(method, params).catch((e) => console.warn(e.message));

async function broadcast(text) {
  console.log(`Рассылка ${subscribers.size} подписчикам:\n${text}\n`);
  for (const id of [...subscribers.keys()]) await send(id, text);
}

// ---------- Состояние ----------
// state.json лежит в публичном репозитории, поэтому подписчики (chat_id, имена)
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
// chat_id → { name, username } — имена нужны для /subscribers.
let subscribers = new Map();
let savedJson = "";
let savedSubs = "";
// Активный будильник: { id, text, sent, nextAt, pending: Map(chat_id → message_id) }.
// В state.json pending хранится зашифрованным, как подписчики.
let alarm = null;
let alarmPendingJson = "";
let alarmPendingEnc = "";

async function loadState() {
  try {
    state = JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    state = {};
  }
  savedJson = JSON.stringify(state);

  let data = null;
  if (state.subscribers && TELEGRAM_TOKEN) {
    try {
      data = decryptSubs(state.subscribers);
    } catch {
      console.warn("Не удалось расшифровать подписчиков (сменился токен?) — начинаю заново");
    }
  }
  data ??= [TELEGRAM_CHAT_ID || "dry-run"];
  // Старый формат — массив chat_id без имён.
  const entries = Array.isArray(data) ? data.map((id) => [id, {}]) : Object.entries(data);
  subscribers = new Map(entries.map(([id, info]) => [String(id), info]));
  savedSubs = subsJson();

  alarm = null;
  if (state.alarm) {
    try {
      alarm = { ...state.alarm, pending: new Map(Object.entries(decryptSubs(state.alarm.pending))) };
      alarmPendingEnc = state.alarm.pending;
      alarmPendingJson = JSON.stringify([...alarm.pending]);
    } catch {
      console.warn("Не удалось расшифровать будильник — сбрасываю");
    }
  }
}

const subsJson = () => JSON.stringify([...subscribers].sort(([a], [b]) => a.localeCompare(b)));

async function saveState() {
  const subsNow = subsJson();
  if (TELEGRAM_TOKEN && (subsNow !== savedSubs || !state.subscribers)) {
    state.subscribers = encryptSubs(Object.fromEntries(subscribers));
    savedSubs = subsNow;
  }
  if (alarm) {
    const pendingJson = JSON.stringify([...alarm.pending]);
    if (pendingJson !== alarmPendingJson || !alarmPendingEnc) {
      alarmPendingEnc = encryptSubs(Object.fromEntries(alarm.pending));
      alarmPendingJson = pendingJson;
    }
    const { id, text, sent, nextAt } = alarm;
    state.alarm = { id, text, sent, nextAt, pending: alarmPendingEnc };
  } else {
    delete state.alarm;
  }
  const json = JSON.stringify(state);
  if (json === savedJson) return;
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  savedJson = json;
}

// ---------- Цель мониторинга ----------
// Рейс и дата из /flight (state.config) перекрывают FLIGHT_NUMBER / FLIGHT_DATE.

const target = () => normFlight(state.config?.flight || FLIGHT_NUMBER);
const targetDate = () => (state.config ? state.config.date : FLIGHT_DATE) || "";
const targetKey = () => `${target()}|${targetDate()}`;

// Сбрасывает всё, что относится к прежнему рейсу.
function resetFlight() {
  delete state.flight;
  delete state.finished;
  delete state.finishedAt;
  delete state.flightReminderSent;
  delete state.problem;
  alarm = null;
}

// ---------- Табло ----------

// Выбор рейса: тот, что уже отслеживаем; иначе нужная дата; иначе ближайший
// ещё не завершённый; иначе последний.
function pickFlight(rows, now) {
  const snaps = rows.map((r) => snapshot(r, now)).sort((a, b) => schedOf(a).localeCompare(schedOf(b)));
  const tracked = state.flight && snaps.find((s) => s.id === state.flight.id);
  if (tracked) return tracked;
  const date = targetDate();
  if (date) return snaps.find((s) => s.date === date) || null;
  return snaps.find((s) => !isDone(s) && s.statusCode !== "XLD") || snaps.at(-1) || null;
}

async function checkBoard() {
  const now = moscowNow();
  const prev = state;
  const prevFlight = prev.flight;
  const announce = Boolean(state.announce);
  delete state.announce;

  const requests = ["departure", "arrival"].flatMap((type) => [0, 1].map((w) => fetchBoard(type, w)));
  const results = await Promise.allSettled(requests);
  const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason.message);
  const all = results.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
  errors.forEach((e) => console.warn("Ошибка загрузки:", e));
  const wanted = target();
  const rows = all.filter(({ type, row }) =>
    normFlight(str(type === "departure" ? row.OD_FLIGHT_NUMBER : row.OA_FLIGHT_NUMBER)) === wanted);
  const flight = pickFlight(rows, now);

  let message = null;
  let alarmText = null;
  let justFinished = false;
  if (flight) {
    let header = null;
    if (announce) header = `🔄 Теперь слежу за рейсом ${flightLabel(flight)}.`;
    else if (!prevFlight) header = prev.target ? `✈️ Рейс ${flightLabel(flight)} появился на табло.` : "Мониторинг запущен.";
    else if (prevFlight.id !== flight.id) header = `Теперь отслеживается рейс ${flightLabel(flight)}.`;
    const changes = header ? [] : diff(prevFlight, flight);

    if (isDone(flight)) {
      const body = changes.length ? `Изменения по рейсу:\n${changes.join("\n")}\n\n` : "";
      message = isArrival(flight)
        ? `🛬 Рейс ${flightLabel(flight)} прибыл.\n\n${body}${describe(flight)}\n\nМониторинг рейса завершён. С возвращением!`
        : `🛫 Рейс ${flightLabel(flight)} вылетел.\n\n${body}${describe(flight)}\n\nМониторинг рейса завершён. Хорошего полёта!`;
      if (header && header !== "Мониторинг запущен.") message = `${header}\n\n${message}`;
      state.finished = true;
      justFinished = true;
      alarm = null; // рейс улетел/прилетел — будильник о задержке больше не нужен
    } else if (header) {
      message = `${header}\n${greeting(flight)}\n\n${describe(flight)}`;
    } else if (changes.length && alarmHeader(prevFlight, flight)) {
      alarmText = `${alarmHeader(prevFlight, flight)}\n\nИзменения по рейсу:\n${changes.join("\n")}\n\n${describe(flight)}`;
    } else if (changes.length) {
      message = `Изменения по рейсу:\n${changes.join("\n")}\n\n${describe(flight)}`;
    } else if (prev.problem === "unavailable") {
      message = `Табло снова доступно, изменений нет.\n\n${describe(flight)}`;
    }
    state.flight = flight;
    state.problem = null;
  } else {
    const problem = all.length === 0 ? "unavailable" : "not_found";
    if (announce) {
      message = `🔄 Теперь слежу за рейсом ${flightLabel()}.\n` +
        "На табло Пулково его пока нет — там показаны рейсы на сегодня и завтра. " +
        "Пришлю статус, как только он появится.";
    } else if (prev.problem !== problem) {
      message = problem === "unavailable"
        ? `⚠️ Табло Пулково недоступно: ${errors.join("; ")}\nСообщу, когда оно снова заработает.`
        : `⚠️ Рейс ${flightLabel()} не найден на табло Пулково.\nСообщу, когда он появится.`;
    }
    state.problem = problem;
  }
  state.target = targetKey();

  console.log(`[${now} МСК] ${flight ? `${flight.flight} (${kindOf(flight)}): ${flight.boardStatus}` : state.problem}`);
  if (message) await broadcast(message);
  if (alarmText) await startAlarm(alarmText);
  await syncProfile(now);
  if (justFinished) {
    state.finishedAt = now;
    // Эля прилетела — задача выполнена, останавливаемся, чтобы не нагружать GitHub.
    if (isArrival(flight)) await shutdown("Эля прилетела, мониторинг завершён.");
  }
}

// Через сколько дней после завершённого рейса без нового /flight бот останавливается.
const IDLE_DAYS = 5;

// Остановка бота: сообщение владельцу, флаг shutdown в state.json —
// по нему workflow отключает себя и не ставит следующий запуск.
async function shutdown(reason) {
  state.shutdown = true;
  console.log(`Остановка: ${reason}`);
  if (TELEGRAM_CHAT_ID) {
    await send(TELEGRAM_CHAT_ID, `🛑 ${reason}\nБот остановлен, чтобы не нагружать GitHub Actions.\n\n` +
      "Включить снова — попроси Claude или выполни:\n" +
      "gh workflow enable monitor.yml -R alxch/flight-monitor\n" +
      "gh workflow run monitor.yml -R alxch/flight-monitor");
  }
}

// ---------- Будильник: задержка или отмена ----------
// Критичное изменение рассылается 10 раз с интервалом в минуту, пока подписчик
// не нажмёт кнопку «Понятно». Каждый повтор заменяет
// предыдущий: звук уведомления звучит снова, а в чате висит одно сообщение.

const ALARM_REPEATS = 10;
const ALARM_INTERVAL = Number(process.env.ALARM_INTERVAL || 60) * 1000;
const ackKeyboard = (id) => ({ inline_keyboard: [[{ text: "✅ Понятно", callback_data: `ack:${id}` }]] });

// Заголовок будильника, если изменение критичное: отмена, статус «Задержан»
// или расчётное время сдвинулось на более позднее (позже расписания).
function alarmHeader(prev, cur) {
  const label = flightLabel(cur);
  if (cur.statusCode === "XLD" && prev.statusCode !== "XLD") return `🚨 Рейс ${label} ОТМЕНЁН!`;
  const delayed = (s) => s.statusCode === "DLY" || /задерж/i.test(s.statusRu || "");
  const est = (s) => (isArrival(s) ? s.eta : s.etd) || "";
  const sched = schedOf(cur);
  const later = est(cur) > sched && est(prev) && est(cur) > est(prev);
  if (!(delayed(cur) && !delayed(prev)) && !later) return null;
  const what = isArrival(cur) ? "Прилёт" : "Вылет";
  const time = est(cur) > sched ? `\n${what} ожидается в ${hhmm(est(cur))} (по расписанию ${hhmm(sched)}).` : "";
  return `🚨 Рейс ${label} задержан!${time}`;
}

async function startAlarm(text) {
  alarm = {
    id: Date.now().toString(36),
    text,
    sent: 0,
    nextAt: 0,
    pending: new Map([...subscribers.keys()].map((id) => [id, null])),
  };
  console.log(`Будильник: ${text.split("\n")[0]}`);
  await ringAlarm();
}

async function ringAlarm() {
  alarm.sent++;
  const last = alarm.sent >= ALARM_REPEATS;
  const text = `${alarm.text}\n\n` + (last
    ? `Последнее напоминание (${alarm.sent}/${ALARM_REPEATS}).`
    : `Напоминание ${alarm.sent}/${ALARM_REPEATS} — нажмите «Понятно», чтобы остановить.`);
  for (const [chatId, prevMsg] of [...alarm.pending]) {
    if (!subscribers.has(chatId)) {
      alarm.pending.delete(chatId);
      continue;
    }
    if (prevMsg) await tgQuiet("deleteMessage", { chat_id: chatId, message_id: prevMsg });
    const m = await send(chatId, text, last ? {} : { reply_markup: ackKeyboard(alarm.id) });
    alarm.pending.set(chatId, m?.message_id ?? null);
  }
  alarm.nextAt = Date.now() + ALARM_INTERVAL;
  if (last || !alarm.pending.size) alarm = null;
}

// Подтверждение от подписчика нажатием кнопки «Понятно».
async function ackAlarm(chatId, alarmId) {
  if (!alarm || (alarmId && alarm.id !== alarmId) || !alarm.pending.has(chatId)) return false;
  const msgId = alarm.pending.get(chatId);
  alarm.pending.delete(chatId);
  console.log(`Будильник подтверждён: ${chatId}`);
  if (msgId) await tgQuiet("editMessageText", { chat_id: chatId, message_id: msgId, text: `${alarm.text}\n\n✅ Вы подтвердили.` });
  if (!alarm.pending.size) alarm = null;
  return true;
}

async function handleCallback(cq) {
  const [kind, id] = (cq.data || "").split(":");
  const chatId = String(cq.message?.chat?.id);
  if (kind !== "ack") return;
  const ok = await ackAlarm(chatId, id);
  await tgQuiet("answerCallbackQuery", { callback_query_id: cq.id, text: ok ? "Принято 👍" : "Уже неактуально" });
  // Кнопка от старого будильника — просто убираем её.
  if (!ok && cq.message) await tgQuiet("editMessageReplyMarkup", { chat_id: chatId, message_id: cq.message.message_id });
}

// ---------- Тексты ----------

// "WZ 709 25.09 в 07:40, Санкт-Петербург → Батуми" — по последним данным табло.
// Без данных табло — номер и заданная дата (или «ближайший»).
function flightLabel(f = state.flight) {
  if (!f) {
    const date = targetDate();
    return date ? `${target()} ${ddmm(date)}` : `${target()} (ближайший, сегодня/завтра)`;
  }
  const sched = schedOf(f);
  return `${f.flight} ${ddmm(sched)} в ${hhmm(sched)}, ${fromOf(f)} → ${toOf(f)}`;
}

// «Провожаем Элю» для рейса из Петербурга, «Встречаем Элю» — в Петербург.
const verb = (f = state.flight) => (!f ? null : isArrival(f) ? "Встречаем" : "Провожаем");
const greeting = (f = state.flight) =>
  verb(f) ? `${verb(f)} ${PERSON} ✈️ ${fromOf(f)} → ${toOf(f)}` : `Следим за рейсом ✈️ ${target()}`;

// Текущий статус для ответов на сообщения — по последней проверке табло.
function statusText() {
  if (state.flight && state.finished) {
    const done = isArrival(state.flight) ? "уже прибыл" : "уже вылетел";
    return `Рейс ${flightLabel()} ${done}, мониторинг завершён.\n\n${describe(state.flight)}`;
  }
  if (state.problem === "unavailable") return "⚠️ Табло Пулково сейчас недоступно.";
  if (state.problem === "not_found") return `⚠️ Рейс ${flightLabel()} пока не найден на табло Пулково.`;
  if (state.flight) return describe(state.flight);
  return "Статус ещё не получен, попробуйте через минуту.";
}

// Профиль бота (имя, короткое описание, описание «What can this bot do?»)
// под текущий рейс. Каждое поле обновляется, только когда меняется его текст.
async function syncProfile(now) {
  if (DRY_RUN || !TELEGRAM_TOKEN) return;
  const f = state.flight;
  state.profile ??= {};

  let current;
  if (state.finished && f) current = isArrival(f) ? `прибыл в ${hhmm(f.ata || f.onblock)}` : f.boardStatus;
  else if (state.problem === "unavailable") current = "табло Пулково недоступно";
  else if (state.problem === "not_found" || !f) current = "рейс пока не найден на табло";
  else if (isArrival(f)) {
    current = f.boardStatus;
    if (f.eta && f.eta !== f.sta) current += `, прилёт ожидается в ${hhmm(f.eta)}`;
    if (f.belt) current += `, лента ${f.belt}`;
  } else {
    current = f.boardStatus;
    if (f.etd && f.etd !== f.std && !isDone(f)) current += `, вылет ожидается в ${hhmm(f.etd)}`;
    if (f.counters && !f.gate) current += `, стойки ${f.counters}`;
    if (f.gate && !isDone(f)) current += `, выход ${f.gate}`;
  }

  const sched = f && schedOf(f);
  const v = verb(f);
  const what = f && isArrival(f)
    ? "вылет, задержки, прилёт, лента выдачи багажа"
    : "регистрация, выход, посадка, задержки, вылет";
  const board = f && isArrival(f) ? "табло прилёта" : "табло";
  const name = (f
    ? isArrival(f)
      ? `${v} ${PERSON} · ${f.flight} ${ddmm(sched)} ${fromOf(f)} → СПб`
      : `${v} ${PERSON} · ${f.flight} ${ddmm(sched)} → ${toOf(f)}`
    : `Рейс ${flightLabel()}`).slice(0, 64);
  const short = (f
    ? `${greeting(f)}. Рейс ${f.flight}, ${ddmm(sched)} ${hhmm(sched)} — статус с ${board} Пулково`
    : `Рейс ${flightLabel()} — статус с табло Пулково`).slice(0, 120);
  const description = (at) => [
    greeting(f),
    "",
    `Я слежу за рейсом ${flightLabel()} по ${board} аэропорта Пулково и присылаю изменения: ${what}.`,
    "",
    `Сейчас: ${current}${at}.`,
    "",
    "Нажмите «Старт», чтобы получать уведомления.",
  ].join("\n").slice(0, 512);

  // Описание сравниваем без метки времени, чтобы не обновлять его зря.
  const fields = [
    ["name", name, () => tg("setMyName", { name })],
    ["short", short, () => tg("setMyShortDescription", { short_description: short })],
    ["description", description(""), () => tg("setMyDescription", { description: description(` (на ${hhmm(now)} МСК)`) })],
  ];
  for (const [key, text, update] of fields) {
    if (state.profile[key] === text) continue;
    try {
      await update();
      state.profile[key] = text;
      console.log(`Профиль бота (${key}) обновлён`);
    } catch (e) {
      console.warn(e.message);
    }
  }
}

// ---------- Команды бота ----------

// Ответ на сообщение: текущий статус и команда. Вводный текст — в описании бота.
function welcome(chatId, intro) {
  const subscribed = subscribers.has(chatId);
  return [
    ...(intro ? [intro, ""] : []),
    statusText(),
    "",
    subscribed ? "/stop — отписаться" : "/start — подписаться на уведомления",
  ].join("\n");
}

const isOwner = (chatId) => Boolean(TELEGRAM_CHAT_ID) && chatId === String(TELEGRAM_CHAT_ID);

// Имя и username чата (для групп — название).
const chatInfo = (chat) => ({
  name: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" "),
  username: chat.username || "",
});

const whoLabel = (id, info = {}) =>
  `${info.name || id}${info.username ? ` (@${info.username})` : ""}`;

// Список подписчиков для владельца. Имена тех, кого ещё не знаем
// (подписались до появления имён), подтягиваем через getChat.
async function subscribersText(ownerId) {
  for (const [id, info] of subscribers) {
    if (info.name || DRY_RUN) continue;
    try {
      subscribers.set(id, chatInfo(await tg("getChat", { chat_id: id })));
    } catch (e) {
      console.warn(`getChat ${id}: ${e.message}`);
    }
  }
  const lines = [...subscribers].map(([id, info], i) =>
    `${i + 1}. ${whoLabel(id, info)}${id === ownerId ? " — вы" : ""}`);
  return lines.length ? `👥 Подписчики (${lines.length}):\n${lines.join("\n")}` : "Подписчиков нет.";
}

const FLIGHT_HELP = [
  "Смена рейса (только для владельца):",
  "/flight WZ 710 28.09 — рейс на дату",
  "/flight WZ 710 — ближайший рейс (сегодня/завтра)",
  "Дата: 28.09, 28.09.2026, 2026-09-28, сегодня, завтра.",
  "Рейс ищется на табло вылета и прилёта Пулково; подписчики получат уведомление.",
].join("\n");

// Разбор даты по Москве: "28.09", "28.09.2026", "2026-09-28", "сегодня", "завтра".
// Год без указания — текущий, а если дата прошла больше месяца назад — следующий.
function parseDate(text, now) {
  const today = now.slice(0, 10);
  const shift = (days) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const t = text.trim().toLowerCase();
  if (t === "сегодня") return today;
  if (t === "завтра") return shift(1);
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return t;
  m = t.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const pad = (n) => String(n).padStart(2, "0");
  let year = y ? (y.length === 2 ? `20${y}` : y) : today.slice(0, 4);
  let date = `${year}-${pad(mo)}-${pad(d)}`;
  // «5.01» в сентябре — это следующий год; недавняя прошедшая дата — скорее опечатка.
  if (!y && date < shift(-31)) date = `${Number(year) + 1}-${pad(mo)}-${pad(d)}`;
  return date;
}

// Существующая дата: 31.02 и подобные отбрасываем.
const isValidDate = (date) => {
  const t = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === date;
};

async function handleFlightCommand(chatId, args) {
  if (!args) {
    await send(chatId, `Сейчас отслеживается: ${flightLabel()}.\n\n${FLIGHT_HELP}`);
    return;
  }
  // Код авиакомпании — 2 символа, хотя бы одна латинская буква (WZ, 5N, U6).
  const m = args.match(/^([a-z0-9]{2})\s*-?\s*(\d{1,4})\s*(.*)$/i);
  if (!m || !/[a-z]/i.test(m[1])) {
    await send(chatId, `Не понял номер рейса «${args}».\n\n${FLIGHT_HELP}`);
    return;
  }
  const now = moscowNow();
  const flight = normFlight(`${m[1]} ${Number(m[2])}`);
  let date = "";
  if (m[3]) {
    date = parseDate(m[3], now);
    if (!date || !isValidDate(date)) {
      await send(chatId, `Не понял дату «${m[3]}».\n\n${FLIGHT_HELP}`);
      return;
    }
    if (date < now.slice(0, 10)) {
      await send(chatId, `Дата ${ddmm(date)} уже прошла.`);
      return;
    }
  }
  if (flight === target() && date === targetDate()) {
    await send(chatId, `Уже слежу за рейсом ${flightLabel()}.`);
    return;
  }

  console.log(`Владелец сменил рейс: ${targetKey()} → ${flight}|${date}`);
  state.config = { flight, date };
  resetFlight();
  state.announce = true;
  await checkBoard(); // сразу ищем рейс и рассылаем подписчикам «Теперь слежу за…»
  await send(chatId, `✅ Рейс изменён: ${flightLabel()}. Подписчики (${subscribers.size}) уведомлены.`);
}

async function handleUpdate(u) {
  const msg = u.message;
  if (!msg?.text || !msg.chat) return;
  const chatId = String(msg.chat.id);
  const [first, ...rest] = msg.text.trim().split(/\s+/);
  const cmd = first.split("@")[0].toLowerCase();
  const info = chatInfo(msg.chat);
  console.log(`← ${chatId} ${cmd}`);

  // Обновляем имя, если подписчик его сменил.
  if (subscribers.has(chatId)) subscribers.set(chatId, info);

  if (cmd === "/start") {
    const isNew = !subscribers.has(chatId);
    subscribers.set(chatId, info);
    await send(chatId, welcome(chatId, isNew ? "✅ Вы подписаны на уведомления." : "✅ Вы уже подписаны на уведомления."));
    if (isNew && !isOwner(chatId) && TELEGRAM_CHAT_ID)
      await send(TELEGRAM_CHAT_ID, `👤 Новый подписчик: ${whoLabel(chatId, info)}`);
  } else if (cmd === "/stop") {
    subscribers.delete(chatId);
    alarm?.pending.delete(chatId);
    await send(chatId, "Вы отписались от уведомлений. /start — подписаться снова.");
  } else if (cmd === "/subscribers" && isOwner(chatId)) {
    await send(chatId, await subscribersText(chatId));
  } else if (cmd === "/flight" && isOwner(chatId)) {
    await handleFlightCommand(chatId, rest.join(" "));
  } else if (msg.chat.type === "private") {
    await send(chatId, welcome(chatId));
  }
}

// Для локальной проверки в DRY_RUN: TEST_UPDATES='[{...}]' — апдейты вместо Telegram.
let testUpdates = DRY_RUN && process.env.TEST_UPDATES ? JSON.parse(process.env.TEST_UPDATES) : null;

async function pollUpdates(timeoutSec) {
  let updates;
  if (testUpdates) {
    [updates, testUpdates] = [testUpdates, null];
  } else if (DRY_RUN || !TELEGRAM_TOKEN) {
    return;
  } else {
    try {
      updates = await tg("getUpdates", {
        offset: state.updateOffset || 0,
        timeout: timeoutSec,
        allowed_updates: ["message", "callback_query"],
      }, (timeoutSec + 15) * 1000);
    } catch (e) {
      console.warn(e.message);
      await new Promise((r) => setTimeout(r, 5000));
      return;
    }
  }
  for (const u of updates) {
    state.updateOffset = u.update_id + 1;
    try {
      if (u.callback_query) await handleCallback(u.callback_query);
      else await handleUpdate(u);
    } catch (e) {
      console.error("Ошибка обработки сообщения:", e);
    }
    await saveState();
  }
}

// ---------- Главный цикл ----------

async function main() {
  if (!DRY_RUN && !TELEGRAM_TOKEN) throw new Error("Не задан TELEGRAM_TOKEN (или DRY_RUN=1)");
  await loadState();

  // После остановки workflow отключён, значит этот запуск — ручное включение.
  // Даём новый срок ожидания /flight, иначе страховка сразу остановит бота снова.
  if (state.shutdown) {
    console.log("Бот включён снова после остановки");
    delete state.shutdown;
    if (state.finishedAt) state.finishedAt = moscowNow();
  }

  // Сменили FLIGHT_NUMBER / FLIGHT_DATE в настройках — начинаем мониторинг заново.
  if (state.target && state.target !== targetKey()) {
    console.log(`Новая цель ${targetKey()} (была ${state.target})`);
    resetFlight();
    delete state.target;
  }

  const deadline = Date.now() + RUN_SECONDS * 1000;
  let nextBoard = 0;
  do {
    if (Date.now() >= nextBoard) {
      nextBoard = Date.now() + BOARD_INTERVAL * 1000;
      if (state.finished) {
        if (!RUN_SECONDS) console.log("Рейс завершён, табло не проверяю.");
        const idleSince = state.finishedAt && Date.parse(`${state.finishedAt}Z`);
        const idleMs = idleSince ? Date.parse(`${moscowNow()}Z`) - idleSince : 0;
        // Через сутки после вылета без нового /flight — напоминаем владельцу про обратный рейс.
        if (idleMs > 86400000 && !state.flightReminderSent && TELEGRAM_CHAT_ID && !isArrival(state.flight || {})) {
          await send(TELEGRAM_CHAT_ID, "🔔 Не забудь поставить обратный рейс Эли:\n" +
            "/flight <номер> <дата>, например /flight WZ 710 28.09\n\n" +
            `Без этого бот остановится через ${IDLE_DAYS - 1} дня.`);
          state.flightReminderSent = true;
        }
        // Страховка: после завершённого рейса долго нет нового /flight — останавливаемся.
        if (!state.shutdown && idleMs > IDLE_DAYS * 86400000)
          await shutdown(`${IDLE_DAYS} дней после рейса ${flightLabel()} не было команды /flight.`);
      } else {
        try {
          await checkBoard();
        } catch (e) {
          console.error("Ошибка проверки табло:", e);
        }
      }
      await saveState();
    }
    if (state.shutdown) break;
    if (alarm && Date.now() >= alarm.nextAt) {
      await ringAlarm();
      await saveState();
    }
    const wakeAt = Math.min(nextBoard, deadline, alarm ? alarm.nextAt : Infinity);
    const waitSec = Math.floor((wakeAt - Date.now()) / 1000);
    await pollUpdates(Math.max(0, Math.min(50, waitSec)));
    await saveState();
  } while (Date.now() < deadline && !state.shutdown);
  await saveState();

  if (sendErrors) throw new Error(`Не удалось отправить ${sendErrors} сообщений`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
