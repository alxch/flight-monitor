// Мониторинг рейса на табло вылета Пулково с уведомлениями в Telegram.
//
// Табло (https://pulkovoairport.ru/passengers/departure/?when=0) рисуется JS'ом
// из JSON API: /api/?type=departure&when=N (N=0 — сегодня, 1 — завтра по Москве).
// WAF отдаёт 403 на запросы без браузерного User-Agent.
//
// Переменные окружения:
//   TELEGRAM_TOKEN, TELEGRAM_CHAT_ID — Bot API (обязательны, если не DRY_RUN)
//   FLIGHT_NUMBER — номер рейса, по умолчанию "WZ 709"
//   FLIGHT_DATE   — дата вылета YYYY-MM-DD по Москве; пусто — ближайший рейс
//   STATE_FILE    — файл состояния, по умолчанию state.json
//   DRY_RUN=1     — печатать сообщения вместо отправки в Telegram

import { readFile, writeFile } from "node:fs/promises";

const FLIGHT_NUMBER = (process.env.FLIGHT_NUMBER || "WZ 709").trim();
const FLIGHT_DATE = (process.env.FLIGHT_DATE || "").trim();
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

async function sendTelegram(text) {
  if (DRY_RUN) {
    console.log(`[dry-run] Telegram:\n${text}\n`);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok)
    throw new Error(`Telegram: HTTP ${res.status} ${body.description || ""}`);
  console.log("Отправлено в Telegram:\n" + text + "\n");
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// Выбор рейса: нужная дата, иначе ближайший ещё не улетевший, иначе последний.
function pickFlight(flights, now) {
  const snaps = flights.map((f) => snapshot(f, now)).sort((a, b) => a.std.localeCompare(b.std));
  if (FLIGHT_DATE) return snaps.find((s) => s.date === FLIGHT_DATE) || null;
  return snaps.find((s) => !s.atd && !s.offblock && s.statusCode !== "XLD")
    || snaps.at(-1) || null;
}

async function main() {
  if (!DRY_RUN && (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID))
    throw new Error("Не заданы TELEGRAM_TOKEN / TELEGRAM_CHAT_ID (или DRY_RUN=1)");

  const now = moscowNow();
  const prev = await loadState();
  const target = normFlight(FLIGHT_NUMBER);
  const dateNote = FLIGHT_DATE ? ` на ${FLIGHT_DATE}` : "";

  const results = await Promise.allSettled([0, 1].map(fetchBoard));
  const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason.message);
  const all = results.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
  const flight = pickFlight(
    all.filter((f) => normFlight(str(f.OD_FLIGHT_NUMBER)) === target),
    now,
  );
  errors.forEach((e) => console.warn("Ошибка загрузки:", e));

  let state;
  let message = null;

  if (flight) {
    state = { problem: null, flight, checkedAt: now };
    if (!prev) {
      message = `Мониторинг запущен.\n\n${describe(flight)}`;
    } else if (prev.flight?.id !== flight.id) {
      message = `Отслеживается рейс ${ddmm(flight.std)}.\n\n${describe(flight)}`;
    } else {
      const changes = diff(prev.flight, flight);
      if (changes.length) message = `Изменения по рейсу:\n${changes.join("\n")}\n\n${describe(flight)}`;
      else if (prev.problem) {
        const back = prev.problem === "unavailable" ? "Табло снова доступно" : "Рейс снова на табло";
        message = `${back}, изменений нет.\n\n${describe(flight)}`;
      }
    }
  } else {
    const problem = all.length === 0 ? "unavailable" : "not_found";
    state = { ...(prev || {}), problem, checkedAt: now };
    if (prev?.problem !== problem) {
      message = problem === "unavailable"
        ? `⚠️ Табло Пулково недоступно: ${errors.join("; ")}\nСообщу, когда оно снова заработает.`
        : `⚠️ Рейс ${target}${dateNote} не найден на табло Пулково (сегодня/завтра).\nСообщу, когда он появится.`;
    }
  }

  console.log(`[${now} МСК] ${flight ? `${flight.flight}: ${flight.boardStatus}` : state.problem}`);
  if (message) await sendTelegram(message);
  else console.log("Изменений нет.");

  // Время проверки в файл не пишем: иначе коммит на каждый запуск.
  const { checkedAt, ...persist } = state;
  const prevPersist = prev ? (({ checkedAt, ...r }) => r)(prev) : null;
  if (JSON.stringify(persist) !== JSON.stringify(prevPersist))
    await writeFile(STATE_FILE, JSON.stringify(persist, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
