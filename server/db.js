const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Хранилище базы данных (аккаунты, видео-метаданные, комментарии, настройки).
//
// Если заданы UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN — вся база
// хранится во внешнем Redis (Upstash, бесплатный и постоянный сервис), и
// переживает "засыпание"/пересборку контейнера на бесплатных хостингах вроде
// Render. Если переменные не заданы — используется локальный файл
// data/db.json, как раньше (удобно для запуска на своём компьютере/VPS).
//
// Внутри процесса всегда есть кэш в памяти (cache), поэтому readDb()/writeDb()
// остаются синхронными для всего остального кода сервера — ничего в
// server.js менять не пришлось. writeDb() обновляет кэш сразу и асинхронно
// (в фоне) сохраняет копию во внешнее хранилище.
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const REDIS_KEY = "mytube:db";

let Redis = null;
let redisClient = null;
if (USE_REDIS) {
  Redis = require("@upstash/redis").Redis;
  redisClient = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
}

const STORAGE_ROOT = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..");

const DATA_DIR = path.join(STORAGE_ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

function defaultSettings() {
  return {
    siteName: "MyTube",
    donateLinks: {
      boosty: "",
      donationalerts: "",
      yoomoney: "",
      paypal: "",
      crypto: "",
      custom: ""
    },
    adSnippets: { header: "", inFeed: "", sidebar: "" },
    adPricePerDayKzt: 500,
    cardNumber: "4400 4303 3511 7997",
    cardHolderName: ""
  };
}

function defaultDb() {
  return {
    users: [], sessions: [], videos: [], comments: [],
    ads: [], settings: defaultSettings(), nextId: 1
  };
}

function migrate(db) {
  let changed = false;
  if (!db.ads) { db.ads = []; changed = true; }
  if (!db.settings) { db.settings = defaultSettings(); changed = true; }
  else {
    const def = defaultSettings();
    if (!db.settings.donateLinks) { db.settings.donateLinks = def.donateLinks; changed = true; }
    if (!db.settings.adSnippets) { db.settings.adSnippets = def.adSnippets; changed = true; }
    if (typeof db.settings.adPricePerDayKzt !== "number") { db.settings.adPricePerDayKzt = def.adPricePerDayKzt; changed = true; }
    if (typeof db.settings.cardNumber !== "string" || !db.settings.cardNumber) { db.settings.cardNumber = def.cardNumber; changed = true; }
    if (typeof db.settings.cardHolderName !== "string") { db.settings.cardHolderName = def.cardHolderName; changed = true; }
    if (!db.settings.siteName) { db.settings.siteName = "MyTube"; changed = true; }
    if (db.settings.mediaSecret) { delete db.settings.mediaSecret; changed = true; }
    if (typeof db.settings.premiumEnabled !== "undefined") { delete db.settings.premiumEnabled; changed = true; }
    if (typeof db.settings.kaspiNumber !== "undefined") { delete db.settings.kaspiNumber; changed = true; }
    if (typeof db.settings.kaspiHolderName !== "undefined") { delete db.settings.kaspiHolderName; changed = true; }
  }
  if (db.premiumCodes) { delete db.premiumCodes; changed = true; }
  (db.users || []).forEach((u) => {
    if (typeof u.totpEnabled === "undefined") { u.totpEnabled = false; changed = true; }
  });
  return changed;
}

let cache = null; // база в памяти — readDb()/writeDb() работают только с ней

async function loadFromFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const initial = defaultDb();
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  if (migrate(db)) fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  return db;
}

async function loadFromRedis() {
  const stored = await redisClient.get(REDIS_KEY);
  if (!stored) {
    const initial = defaultDb();
    await redisClient.set(REDIS_KEY, initial);
    return initial;
  }
  // @upstash/redis сам парсит JSON, но на случай если значение когда-то было
  // записано как строка (например, ручной импорт) — подстрахуемся.
  const db = typeof stored === "string" ? JSON.parse(stored) : stored;
  migrate(db);
  return db;
}

// Обязательно вызвать один раз при старте сервера (await) до app.listen().
async function loadDb() {
  cache = USE_REDIS ? await loadFromRedis() : await loadFromFile();
  console.log(
    USE_REDIS
      ? "MyTube: база данных подключена к Upstash Redis (постоянное хранилище)."
      : "MyTube: база данных хранится в локальном файле data/db.json (для хостингов с эфемерным диском задайте UPSTASH_REDIS_REST_URL/TOKEN)."
  );
  return cache;
}

function readDb() {
  if (!cache) {
    throw new Error("db.js: readDb() вызван до loadDb() — база ещё не загружена");
  }
  return cache;
}

let pendingPersist = null;
function persist(db) {
  const job = USE_REDIS
    ? redisClient.set(REDIS_KEY, db)
    : new Promise((resolve, reject) => {
        fs.writeFile(DB_FILE, JSON.stringify(db, null, 2), (err) => (err ? reject(err) : resolve()));
      });
  pendingPersist = job.catch((err) => {
    console.error("MyTube: не удалось сохранить базу данных:", err.message || err);
  });
  return pendingPersist;
}

// Синхронная сигнатура сохраняется для всего остального кода: writeDb()
// обновляет кэш сразу же, а во внешнее хранилище пишет в фоне.
function writeDb(db) {
  cache = db;
  persist(db);
}

// Дожидается, пока последняя фоновая запись точно завершится — полезно перед
// выключением сервера (например, обработчик SIGTERM), чтобы не потерять
// самые последние изменения.
async function flush() {
  if (pendingPersist) await pendingPersist;
}

function nextId(db) {
  const id = String(db.nextId);
  db.nextId += 1;
  return id;
}

module.exports = { loadDb, readDb, writeDb, flush, nextId, DATA_DIR, STORAGE_ROOT, USE_REDIS };
