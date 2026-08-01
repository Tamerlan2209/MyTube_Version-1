const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const cloudinary = require("cloudinary").v2;
let compression;
try { compression = require("compression"); } catch (e) { compression = null; }
const { loadDb, readDb, writeDb, nextId, STORAGE_ROOT, USE_REDIS } = require("./db");

const PORT = process.env.PORT || 3000;

// Файлы (видео, аватарки) хранятся в Cloudinary, а не на локальном диске —
// это тоже нужно, чтобы данные не терялись на хостингах с эфемерным диском
// (Render и т.п.). Настраивается через переменную окружения CLOUDINARY_URL
// (формат cloudinary://API_KEY:API_SECRET@CLOUD_NAME) — Cloudinary SDK
// подхватывает её автоматически, ничего больше указывать не нужно.
const USE_CLOUDINARY = !!process.env.CLOUDINARY_URL;
if (!USE_CLOUDINARY) {
  console.warn(
    "MyTube: CLOUDINARY_URL не задан — загруженные видео и аватарки будут " +
    "сохраняться на локальный диск сервера и могут теряться на хостингах " +
    "с эфемерным диском (например, Render). Подробности — в deploy/DEPLOY.md."
  );
}

// Бесплатный тариф Cloudinary принимает видеофайлы весом до 100 МБ через
// обычную загрузку API. Если задать CLOUDINARY_URL от платного тарифа —
// можно поднять лимит через переменную MAX_VIDEO_SIZE_MB.
const MAX_VIDEO_SIZE_MB = Number(process.env.MAX_VIDEO_SIZE_MB) || (USE_CLOUDINARY ? 100 : 500);
const MAX_AVATAR_SIZE_MB = 5;
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 60;
const BCRYPT_ROUNDS = 12;
const LOGIN_TICKET_LIFETIME_MS = 5 * 60 * 1000;
const OWNER_USERNAME = "MyTube";

const app = express();

if (compression) app.use(compression());
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.removeHeader("X-Powered-By");
  next();
});

// Лёгкий health-check эндпоинт — не трогает базу данных и не делает ничего
// тяжёлого, чтобы отвечать мгновенно. Его же используют:
//  1) Render (Health Check Path в настройках сервиса / render.yaml);
//  2) внешние "будильники" (UptimeRobot, cron-job.org и т.п.);
//  3) встроенный self-ping ниже (см. KEEP-ALIVE в конце файла).
app.get(["/healthz", "/health", "/ping"], (req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime(), ts: Date.now() });
});

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

function rateLimitAuth(req, res, next) {
  const key = req.ip + ":" + String((req.body || {}).username || "").toLowerCase();
  const now = Date.now();
  const rec = loginAttempts.get(key);
  if (rec && rec.blockedUntil && rec.blockedUntil > now) {
    const waitMin = Math.ceil((rec.blockedUntil - now) / 60000);
    return res.status(429).json({ error: `Слишком много попыток. Попробуйте снова через ${waitMin} мин.` });
  }
  next();
}
function registerFailedAttempt(req) {
  const key = req.ip + ":" + String((req.body || {}).username || "").toLowerCase();
  const now = Date.now();
  let rec = loginAttempts.get(key);
  if (!rec || now - rec.firstAt > LOGIN_WINDOW_MS) rec = { count: 0, firstAt: now, blockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_ATTEMPTS) {
    rec.blockedUntil = now + LOGIN_BLOCK_MS;
    rec.count = 0;
    rec.firstAt = now;
  }
  loginAttempts.set(key, rec);
}
function clearFailedAttempts(req) {
  const key = req.ip + ":" + String((req.body || {}).username || "").toLowerCase();
  loginAttempts.delete(key);
}
setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of loginAttempts.entries()) {
    if (rec.blockedUntil < now && now - rec.firstAt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  }
}, 30 * 60 * 1000).unref();

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const UPLOADS_DIR = path.join(STORAGE_ROOT, "uploads");
if (!USE_CLOUDINARY) {
  if (!fs.existsSync(path.join(UPLOADS_DIR, "videos"))) fs.mkdirSync(path.join(UPLOADS_DIR, "videos"), { recursive: true });
  if (!fs.existsSync(path.join(UPLOADS_DIR, "avatars"))) fs.mkdirSync(path.join(UPLOADS_DIR, "avatars"), { recursive: true });
}

const escapeHtmlAttr = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));

function sendVideoAwareIndex(req, res, videoId) {
  let html;
  try {
    html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf-8");
  } catch (e) {
    return res.status(500).send("Ошибка сервера");
  }

  const db = readDb();
  const video = videoId ? db.videos.find((v) => v.id === videoId) : null;
  const siteName = (db.settings && db.settings.siteName) || "MyTube";

  if (!video) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  }

  const title = `${escapeHtmlAttr(video.title)} — ${escapeHtmlAttr(siteName)}`;
  const desc = escapeHtmlAttr((video.description || "").slice(0, 180) || `Смотрите видео на ${siteName}`);
  const url = `${req.protocol}://${req.get("host")}/watch/${encodeURIComponent(video.id)}`;

  const metaBlock = `
  <title>${title}</title>
  <meta name="description" content="${desc}">
  <link rel="canonical" href="${url}">
  <meta property="og:type" content="video.other">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${desc}">
  <meta property="og:url" content="${url}">
  <meta property="og:site_name" content="${escapeHtmlAttr(siteName)}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${desc}">
  <script>window.__MTUBE_VIDEO_ID = ${JSON.stringify(video.id)};</script>
</head>`;

  html = html.replace(/<title>.*?<\/title>/i, "").replace("</head>", metaBlock);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
}

app.get("/watch/:id", (req, res) => sendVideoAwareIndex(req, res, req.params.id));
app.get("/", (req, res, next) => {
  const vid = (req.query || {}).v;
  if (!vid) return next();
  sendVideoAwareIndex(req, res, vid);
});

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send(
    "User-agent: *\nAllow: /\nDisallow: /api/\n" +
    `Sitemap: ${req.protocol}://${req.get("host")}/sitemap.xml\n`
  );
});

app.get("/sitemap.xml", (req, res) => {
  const db = readDb();
  const base = `${req.protocol}://${req.get("host")}`;
  const urls = [
    `<url><loc>${base}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>`
  ];
  db.videos.forEach((v) => {
    urls.push(
      `<url><loc>${base}/watch/${encodeURIComponent(v.id)}</loc>` +
      `<lastmod>${new Date(v.createdAt).toISOString()}</lastmod>` +
      `<changefreq>weekly</changefreq><priority>0.7</priority></url>`
    );
  });
  res.type("application/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`
  );
});

app.use(express.static(PUBLIC_DIR));

app.use("/uploads", express.static(UPLOADS_DIR, {
  acceptRanges: true,
  maxAge: "7d",
  setHeaders: (res) => res.setHeader("Cache-Control", "public, max-age=604800, immutable")
}));

app.get("/embed/:id", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "embed.html"));
});

// Когда настроен Cloudinary, файлы принимаются в память (буфер) и сразу
// перекладываются в облако — на локальный диск они не попадают вообще.
// Без Cloudinary — прежнее поведение: сохранение на локальный диск сервера.
const videoStorage = USE_CLOUDINARY ? multer.memoryStorage() : multer.diskStorage({
  destination: path.join(UPLOADS_DIR, "videos"),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  }
});
const avatarStorage = USE_CLOUDINARY ? multer.memoryStorage() : multer.diskStorage({
  destination: path.join(UPLOADS_DIR, "avatars"),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  }
});

// Загружает буфер файла в Cloudinary и возвращает { url, publicId }.
function uploadBufferToCloudinary(buffer, { resourceType, folder }) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: resourceType, folder },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}
const ALLOWED_VIDEO_EXT = [".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".ogv"];
const ALLOWED_AVATAR_EXT = [".jpg", ".jpeg", ".png", ".webp", ".gif"];

const uploadVideo = multer({
  storage: videoStorage,
  limits: { fileSize: MAX_VIDEO_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, file.mimetype.startsWith("video/") && ALLOWED_VIDEO_EXT.includes(ext));
  }
});
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: MAX_AVATAR_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, file.mimetype.startsWith("image/") && ALLOWED_AVATAR_EXT.includes(ext));
  }
});

const isValidUsername = (u) => /^[a-zA-Z0-9_]{3,20}$/.test(u || "");

function parseTags(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((t) => t.trim().toLowerCase().replace(/[^a-zа-я0-9_-]/gi, ""))
    .filter(Boolean)
    .slice(0, 6);
}

function isOwnerUser(user) {
  return !!user && user.username === OWNER_USERNAME;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    avatarUrl: u.avatarUrl || "",
    subscribedTo: u.subscribedTo || [],
    preferences: u.preferences || {},
    isOwner: isOwnerUser(u),
    totpEnabled: !!u.totpEnabled
  };
}

function publicVideo(v, viewerId, viewerExtras) {
  const extras = viewerExtras || {};
  const historyEntry = extras.historyMap ? extras.historyMap[v.id] : null;
  return {
    id: v.id,
    title: v.title,
    description: v.description,
    videoUrl: v.videoUrl,
    tags: v.tags || [],
    durationSec: v.durationSec || 0,
    authorId: v.authorId,
    authorUsername: v.authorUsername,
    authorAvatarUrl: v.authorAvatarUrl || "",
    createdAt: v.createdAt,
    views: v.views || 0,
    likesCount: (v.likes || []).length,
    likedByMe: viewerId ? (v.likes || []).includes(viewerId) : false,
    savedByMe: extras.watchLater ? extras.watchLater.includes(v.id) : false,
    progressPct: historyEntry && historyEntry.durationSec
      ? Math.min(100, Math.round((historyEntry.positionSec / historyEntry.durationSec) * 100))
      : 0,
    resumeAt: historyEntry ? historyEntry.positionSec || 0 : 0
  };
}

function historyMapFor(user) {
  const map = {};
  ((user && user.history) || []).forEach((h) => { map[h.videoId] = h; });
  return map;
}

function auth(required) {
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      if (required) return res.status(401).json({ error: "Нужно войти в аккаунт" });
      req.user = null;
      return next();
    }
    const db = readDb();
    const session = db.sessions.find((s) => s.token === token);
    if (!session || session.expiresAt < Date.now()) {
      if (required) return res.status(401).json({ error: "Сессия истекла, войдите заново" });
      req.user = null;
      return next();
    }
    const user = db.users.find((u) => u.id === session.userId);
    if (!user) {
      if (required) return res.status(401).json({ error: "Пользователь не найден" });
      req.user = null;
      return next();
    }
    req.user = user;
    next();
  };
}

function requireOwner(req, res, next) {
  if (!isOwnerUser(req.user)) {
    return res.status(403).json({ error: "Доступно только владельцу сайта" });
  }
  next();
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let bits = "";
  for (const byte of buf) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += BASE32_ALPHABET[parseInt(bits.substring(i, i + 5), 2)];
  const rem = bits.length % 5;
  if (rem !== 0) out += BASE32_ALPHABET[parseInt(bits.substring(bits.length - rem).padEnd(5, "0"), 2)];
  return out;
}
function base32Decode(str) {
  const clean = String(str || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.substring(i, i + 8), 2));
  return Buffer.from(bytes);
}
function generateTotp(secretBase32, atMs) {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(atMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24 | (hmac[offset + 1] & 0xff) << 16 |
    (hmac[offset + 2] & 0xff) << 8 | (hmac[offset + 3] & 0xff)) % 1000000;
  return String(code).padStart(6, "0");
}
function verifyTotp(secretBase32, token) {
  if (!token || !/^\d{6}$/.test(String(token))) return false;
  const now = Date.now();
  for (let w = -1; w <= 1; w++) {
    if (safeEqual(generateTotp(secretBase32, now + w * 30000), String(token))) return true;
  }
  return false;
}

const loginTickets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [t, rec] of loginTickets.entries()) if (rec.expiresAt < now) loginTickets.delete(t);
}, 5 * 60 * 1000).unref();

app.post("/api/2fa/setup", auth(true), (req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.user.id);
  const secret = base32Encode(crypto.randomBytes(20));
  user.totpPendingSecret = secret;
  writeDb(db);
  const label = encodeURIComponent(`${(db.settings || {}).siteName || "MyTube"}:${user.username}`);
  const issuer = encodeURIComponent((db.settings || {}).siteName || "MyTube");
  res.json({
    secret,
    otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&digits=6&period=30`
  });
});

app.post("/api/2fa/enable", auth(true), (req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.user.id);
  const { code } = req.body || {};
  if (!user.totpPendingSecret) return res.status(400).json({ error: "Сначала запросите настройку 2FA" });
  if (!verifyTotp(user.totpPendingSecret, code)) return res.status(400).json({ error: "Неверный код" });
  user.totpSecret = user.totpPendingSecret;
  user.totpEnabled = true;
  delete user.totpPendingSecret;
  writeDb(db);
  res.json({ ok: true, user: publicUser(user) });
});

app.post("/api/2fa/disable", auth(true), (req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.user.id);
  const { code } = req.body || {};
  if (!user.totpEnabled) return res.status(400).json({ error: "2FA и так выключена" });
  if (!verifyTotp(user.totpSecret, code)) return res.status(400).json({ error: "Неверный код" });
  user.totpEnabled = false;
  delete user.totpSecret;
  writeDb(db);
  res.json({ ok: true, user: publicUser(user) });
});

app.post("/api/register", rateLimitAuth, async (req, res) => {
  const { username, password } = req.body || {};
  if (!isValidUsername(username)) {
    return res.status(400).json({ error: "Имя пользователя: 3-20 символов, латиница/цифры/_" });
  }
  if (!password || password.length < 6 || password.length > 100) {
    return res.status(400).json({ error: "Пароль должен быть от 6 до 100 символов" });
  }

  const db = readDb();
  const usernameLower = username.toLowerCase();
  if (db.users.some((u) => u.username.toLowerCase() === usernameLower)) {
    registerFailedAttempt(req);
    return res.status(409).json({ error: "Это имя уже занято" });
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = {
    id: nextId(db),
    username,
    passwordHash,
    avatarUrl: "",
    subscribedTo: [],
    watchLater: [],
    history: [],
    preferences: {},
    totpEnabled: false,
    createdAt: Date.now()
  };
  db.users.push(user);

  const token = crypto.randomBytes(32).toString("hex");
  db.sessions.push({ token, userId: user.id, expiresAt: Date.now() + SESSION_LIFETIME_MS });

  writeDb(db);
  res.json({ token, user: publicUser(user) });
});

app.post("/api/login", rateLimitAuth, async (req, res) => {
  const { username, password } = req.body || {};
  const db = readDb();
  const user = db.users.find((u) => u.username.toLowerCase() === (username || "").toLowerCase());

  if (!user) {
    await bcrypt.compare(password || "", "$2a$12$CwTycUXWue0Thq9StjUM0uJ8z0KJ0F3fEqxUB6xY4uz0Xu5g8g8Xu");
    registerFailedAttempt(req);
    return res.status(401).json({ error: "Неверный логин или пароль" });
  }

  const ok = await bcrypt.compare(password || "", user.passwordHash);
  if (!ok) {
    registerFailedAttempt(req);
    return res.status(401).json({ error: "Неверный логин или пароль" });
  }
  clearFailedAttempts(req);

  if (user.totpEnabled) {
    const ticket = crypto.randomBytes(24).toString("hex");
    loginTickets.set(ticket, { userId: user.id, expiresAt: Date.now() + LOGIN_TICKET_LIFETIME_MS });
    return res.json({ requires2fa: true, loginTicket: ticket });
  }

  const token = crypto.randomBytes(32).toString("hex");
  db.sessions.push({ token, userId: user.id, expiresAt: Date.now() + SESSION_LIFETIME_MS });
  writeDb(db);

  res.json({ token, user: publicUser(user) });
});

app.post("/api/login/2fa", rateLimitAuth, (req, res) => {
  const { loginTicket, code } = req.body || {};
  const rec = loginTicket && loginTickets.get(loginTicket);
  if (!rec || rec.expiresAt < Date.now()) {
    return res.status(401).json({ error: "Сессия входа истекла, войдите заново" });
  }
  const db = readDb();
  const user = db.users.find((u) => u.id === rec.userId);
  if (!user || !user.totpEnabled) return res.status(400).json({ error: "Ошибка входа" });

  if (!verifyTotp(user.totpSecret, code)) {
    registerFailedAttempt(req);
    return res.status(401).json({ error: "Неверный код" });
  }
  loginTickets.delete(loginTicket);

  const token = crypto.randomBytes(32).toString("hex");
  db.sessions.push({ token, userId: user.id, expiresAt: Date.now() + SESSION_LIFETIME_MS });
  writeDb(db);
  res.json({ token, user: publicUser(user) });
});

app.post("/api/logout", auth(false), (req, res) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    const db = readDb();
    db.sessions = db.sessions.filter((s) => s.token !== token);
    writeDb(db);
  }
  res.json({ ok: true });
});

app.get("/api/me", auth(false), (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.put("/api/profile", auth(true), uploadAvatar.single("avatar"), async (req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "Пользователь не найден" });

  const { displayName } = req.body || {};
  if (displayName && isValidUsername(displayName)) {
    user.username = displayName;
  }
  if (req.file) {
    if (USE_CLOUDINARY) {
      try {
        const result = await uploadBufferToCloudinary(req.file.buffer, {
          resourceType: "image",
          folder: "mytube/avatars"
        });
        user.avatarUrl = result.secure_url;
        user.avatarPublicId = result.public_id;
      } catch (e) {
        console.error("Cloudinary avatar upload error:", e.message || e);
        return res.status(502).json({ error: "Не удалось загрузить аватар, попробуйте ещё раз" });
      }
    } else {
      user.avatarUrl = `/uploads/avatars/${req.file.filename}`;
    }
  }

  db.videos.forEach((v) => {
    if (v.authorId === user.id) {
      v.authorUsername = user.username;
      v.authorAvatarUrl = user.avatarUrl;
    }
  });
  db.comments.forEach((c) => {
    if (c.authorId === user.id) {
      c.authorUsername = user.username;
      c.authorAvatarUrl = user.avatarUrl;
    }
  });

  writeDb(db);
  res.json({ user: publicUser(user) });
});

app.put("/api/me/preferences", auth(true), (req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "Пользователь не найден" });

  const body = req.body || {};
  user.preferences = { ...(user.preferences || {}), ...body };
  writeDb(db);
  res.json({ preferences: user.preferences });
});

app.get("/api/videos", auth(false), (req, res) => {
  const db = readDb();
  const { q, tag, sort } = req.query || {};
  const extras = { watchLater: (req.user && req.user.watchLater) || [], historyMap: historyMapFor(req.user) };

  let list = [...db.videos];

  if (q && q.trim()) {
    const needle = q.trim().toLowerCase();
    list = list.filter((v) =>
      v.title.toLowerCase().includes(needle) ||
      (v.description || "").toLowerCase().includes(needle) ||
      (v.tags || []).some((t) => t.includes(needle))
    );
  }
  if (tag && tag.trim()) {
    const t = tag.trim().toLowerCase();
    list = list.filter((v) => (v.tags || []).includes(t));
  }

  if (sort === "popular") list.sort((a, b) => (b.views || 0) - (a.views || 0));
  else if (sort === "liked") list.sort((a, b) => (b.likes || []).length - (a.likes || []).length);
  else list.sort((a, b) => b.createdAt - a.createdAt);

  const videos = list.map((v) => ({
    ...publicVideo(v, req.user?.id, extras),
    isMine: req.user ? v.authorId === req.user.id : false
  }));
  res.json({ videos });
});

app.get("/api/videos/:id", auth(false), (req, res) => {
  const db = readDb();
  const video = db.videos.find((v) => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: "Видео не найдено" });

  const extras = req.user
    ? { watchLater: req.user.watchLater || [], historyMap: historyMapFor(req.user) }
    : {};
  res.json({
    video: {
      ...publicVideo(video, req.user?.id, extras),
      isMine: req.user ? video.authorId === req.user.id : false
    }
  });
});

app.get("/api/tags", (req, res) => {
  const db = readDb();
  const set = new Set();
  db.videos.forEach((v) => (v.tags || []).forEach((t) => set.add(t)));
  res.json({ tags: [...set].sort() });
});

app.get("/api/settings/public", (req, res) => {
  const db = readDb();
  const s = db.settings || {};
  res.json({
    settings: {
      siteName: s.siteName || "MyTube",
      donateLinks: s.donateLinks || {},
      adSnippets: s.adSnippets || {},
      adPricePerDayKzt: typeof s.adPricePerDayKzt === "number" ? s.adPricePerDayKzt : 500
    }
  });
});

app.put("/api/settings", auth(true), requireOwner, (req, res) => {
  const db = readDb();
  const body = req.body || {};
  db.settings = db.settings || {};
  if (typeof body.siteName === "string") db.settings.siteName = body.siteName.slice(0, 60).trim() || "MyTube";
  if (body.donateLinks && typeof body.donateLinks === "object") {
    db.settings.donateLinks = { ...(db.settings.donateLinks || {}), ...body.donateLinks };
  }
  if (body.adSnippets && typeof body.adSnippets === "object") {
    db.settings.adSnippets = { ...(db.settings.adSnippets || {}), ...body.adSnippets };
  }
  if (typeof body.adPricePerDayKzt === "number" && body.adPricePerDayKzt >= 0) {
    db.settings.adPricePerDayKzt = Math.round(body.adPricePerDayKzt);
  }
  if (typeof body.cardNumber === "string") db.settings.cardNumber = body.cardNumber.replace(/[^\d ]/g, "").slice(0, 25);
  if (typeof body.cardHolderName === "string") db.settings.cardHolderName = body.cardHolderName.slice(0, 60);
  writeDb(db);
  res.json({
    settings: {
      siteName: db.settings.siteName,
      donateLinks: db.settings.donateLinks,
      adSnippets: db.settings.adSnippets,
      adPricePerDayKzt: db.settings.adPricePerDayKzt,
      cardNumber: db.settings.cardNumber,
      cardHolderName: db.settings.cardHolderName
    }
  });
});

const AD_PLACEMENTS = ["header", "infeed", "sidebar"];

function publicAd(a) {
  return {
    id: a.id, title: a.title, description: a.description,
    linkUrl: a.linkUrl, imageUrl: a.imageUrl || "", placement: a.placement
  };
}
function adminAd(a) {
  return { ...publicAd(a), status: a.status, days: a.days, priceKzt: a.priceKzt,
    createdAt: a.createdAt, paidAt: a.paidAt || null, approvedAt: a.approvedAt || null,
    expiresAt: a.expiresAt || null, ownerUsername: a.ownerUsername };
}

app.get("/api/ads/active", (req, res) => {
  const db = readDb();
  const now = Date.now();
  const list = (db.ads || []).filter((a) => a.status === "active" && a.expiresAt > now);
  res.json({ ads: list.map(publicAd) });
});

app.get("/api/me/ads", auth(true), (req, res) => {
  const db = readDb();
  const list = (db.ads || []).filter((a) => a.ownerUserId === req.user.id).sort((a, b) => b.createdAt - a.createdAt);
  res.json({ ads: list.map(adminAd) });
});

app.post("/api/ads", auth(true), (req, res) => {
  const { title, description, linkUrl, imageUrl, placement, days } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: "Введите название рекламы" });
  if (!linkUrl || !/^https?:\/\//i.test(linkUrl)) return res.status(400).json({ error: "Ссылка должна начинаться с http(s)://" });
  if (!AD_PLACEMENTS.includes(placement)) return res.status(400).json({ error: "Некорректное место размещения" });
  const daysNum = Math.min(30, Math.max(1, parseInt(days, 10) || 1));

  const db = readDb();
  const pricePerDay = typeof (db.settings || {}).adPricePerDayKzt === "number" ? db.settings.adPricePerDayKzt : 500;
  const ad = {
    id: nextId(db),
    ownerUserId: req.user.id,
    ownerUsername: req.user.username,
    title: String(title).trim().slice(0, 80),
    description: String(description || "").trim().slice(0, 200),
    linkUrl: String(linkUrl).trim().slice(0, 300),
    imageUrl: String(imageUrl || "").trim().slice(0, 300),
    placement,
    days: daysNum,
    priceKzt: daysNum * pricePerDay,
    status: "pending_payment",
    createdAt: Date.now()
  };
  db.ads = db.ads || [];
  db.ads.push(ad);
  writeDb(db);
  res.json({ ad: adminAd(ad) });
});

app.get("/api/ads/:id/payment-card", auth(true), (req, res) => {
  const db = readDb();
  const ad = (db.ads || []).find((a) => a.id === req.params.id);
  if (!ad) return res.status(404).end();
  if (ad.ownerUserId !== req.user.id && !isOwnerUser(req.user)) return res.status(403).end();

  const s = db.settings || {};
  const number = s.cardNumber || "не задан владельцем сайта";
  const holder = s.cardHolderName || "";
  const esc = escapeHtmlAttr;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="240" viewBox="0 0 420 240">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#2b2b52"/>
        <stop offset="100%" stop-color="#0d0d11"/>
      </linearGradient>
    </defs>
    <rect width="420" height="240" rx="20" fill="url(#g)"/>
    <text x="24" y="42" font-family="Arial, sans-serif" font-size="16" fill="#aaa" font-weight="600">Оплата картой</text>
    <text x="24" y="118" font-family="Arial, sans-serif" font-size="28" fill="#fff" font-weight="800" letter-spacing="2">${esc(number)}</text>
    <text x="24" y="150" font-family="Arial, sans-serif" font-size="15" fill="#ddd">${esc(holder)}</text>
    <text x="24" y="200" font-family="Arial, sans-serif" font-size="15" fill="#ffd166">Сумма: ${ad.priceKzt} ₸ · Заявка №${esc(ad.id)}</text>
  </svg>`;
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");
  res.send(svg);
});

app.post("/api/ads/:id/mark-paid", auth(true), (req, res) => {
  const db = readDb();
  const ad = (db.ads || []).find((a) => a.id === req.params.id);
  if (!ad) return res.status(404).json({ error: "Заявка не найдена" });
  if (ad.ownerUserId !== req.user.id) return res.status(403).json({ error: "Это не ваша заявка" });
  if (ad.status !== "pending_payment") return res.status(409).json({ error: "Заявка уже обработана" });

  ad.status = "awaiting_confirmation";
  ad.paidAt = Date.now();
  writeDb(db);
  res.json({ ad: adminAd(ad) });
});

app.get("/api/admin/ads", auth(true), requireOwner, (req, res) => {
  const db = readDb();
  const list = [...(db.ads || [])].sort((a, b) => b.createdAt - a.createdAt);
  res.json({ ads: list.map(adminAd) });
});

app.post("/api/admin/ads/:id/approve", auth(true), requireOwner, (req, res) => {
  const db = readDb();
  const ad = (db.ads || []).find((a) => a.id === req.params.id);
  if (!ad) return res.status(404).json({ error: "Заявка не найдена" });
  ad.status = "active";
  ad.approvedAt = Date.now();
  ad.expiresAt = Date.now() + ad.days * 24 * 60 * 60 * 1000;
  writeDb(db);
  res.json({ ad: adminAd(ad) });
});

app.post("/api/admin/ads/:id/reject", auth(true), requireOwner, (req, res) => {
  const db = readDb();
  const ad = (db.ads || []).find((a) => a.id === req.params.id);
  if (!ad) return res.status(404).json({ error: "Заявка не найдена" });
  ad.status = "rejected";
  writeDb(db);
  res.json({ ad: adminAd(ad) });
});

app.delete("/api/admin/ads/:id", auth(true), requireOwner, (req, res) => {
  const db = readDb();
  db.ads = (db.ads || []).filter((a) => a.id !== req.params.id);
  writeDb(db);
  res.json({ ok: true });
});

app.get("/api/admin/users", auth(true), requireOwner, (req, res) => {
  const db = readDb();
  const list = db.users.map((u) => ({
    id: u.id,
    username: u.username,
    avatarUrl: u.avatarUrl || "",
    createdAt: u.createdAt,
    totpEnabled: !!u.totpEnabled,
    videosCount: db.videos.filter((v) => v.authorId === u.id).length,
    subscribersCount: db.users.filter((x) => (x.subscribedTo || []).includes(u.id)).length
  }));
  res.json({ users: list });
});

app.put("/api/admin/users/:id", auth(true), requireOwner, async (req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "Пользователь не найден" });

  const body = req.body || {};
  if (typeof body.username === "string" && body.username.trim()) {
    if (!isValidUsername(body.username)) return res.status(400).json({ error: "Некорректное имя" });
    const taken = db.users.some((u) => u.id !== user.id && u.username.toLowerCase() === body.username.toLowerCase());
    if (taken) return res.status(409).json({ error: "Это имя уже занято" });
    user.username = body.username;
    db.videos.forEach((v) => { if (v.authorId === user.id) v.authorUsername = user.username; });
    db.comments.forEach((c) => { if (c.authorId === user.id) c.authorUsername = user.username; });
  }
  if (typeof body.avatarUrl === "string") {
    user.avatarUrl = body.avatarUrl;
    db.videos.forEach((v) => { if (v.authorId === user.id) v.authorAvatarUrl = user.avatarUrl; });
    db.comments.forEach((c) => { if (c.authorId === user.id) c.authorAvatarUrl = user.avatarUrl; });
  }
  if (typeof body.newPassword === "string" && body.newPassword.length >= 6) {
    user.passwordHash = await bcrypt.hash(body.newPassword, BCRYPT_ROUNDS);
  }
  if (typeof body.totpEnabled === "boolean" && body.totpEnabled === false) {
    user.totpEnabled = false;
    delete user.totpSecret;
  }
  if (Array.isArray(body.subscribedTo)) user.subscribedTo = body.subscribedTo;
  if (body.preferences && typeof body.preferences === "object") {
    user.preferences = { ...(user.preferences || {}), ...body.preferences };
  }

  writeDb(db);
  res.json({ user: publicUser(user) });
});

app.delete("/api/admin/users/:id", auth(true), requireOwner, (req, res) => {
  const db = readDb();
  const target = db.users.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: "Пользователь не найден" });

  const videoIds = db.videos.filter((v) => v.authorId === target.id).map((v) => v.id);
  videoIds.forEach((vid) => {
    const v = db.videos.find((x) => x.id === vid);
    if (!v) return;
    if (v.publicId) cloudinary.uploader.destroy(v.publicId, { resource_type: "video" }, () => {});
    else if (v.filePath) fs.unlink(v.filePath, () => {});
  });

  db.videos = db.videos.filter((v) => v.authorId !== target.id);
  db.comments = db.comments.filter((c) => c.authorId !== target.id && !videoIds.includes(c.videoId));
  db.sessions = db.sessions.filter((s) => s.userId !== target.id);
  db.users.forEach((u) => {
    u.watchLater = (u.watchLater || []).filter((id) => !videoIds.includes(id));
    u.history = (u.history || []).filter((h) => !videoIds.includes(h.videoId));
    u.subscribedTo = (u.subscribedTo || []).filter((id) => id !== target.id);
  });
  db.users = db.users.filter((u) => u.id !== target.id);

  writeDb(db);
  res.json({ ok: true });
});

app.put("/api/admin/videos/:id", auth(true), requireOwner, (req, res) => {
  const db = readDb();
  const video = db.videos.find((v) => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: "Видео не найдено" });

  const body = req.body || {};
  if (typeof body.title === "string" && body.title.trim()) video.title = body.title.trim();
  if (typeof body.description === "string") video.description = body.description.trim();
  if (typeof body.tags === "string") video.tags = parseTags(body.tags);

  writeDb(db);
  res.json({ video: publicVideo(video, req.user.id, {}) });
});

app.post("/api/videos", auth(true), uploadVideo.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Видеофайл не получен (проверь формат и размер)" });

  const { title, description, tags, durationSec } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: "Введи название видео" });

  let videoUrl, filePath, publicId;
  if (USE_CLOUDINARY) {
    try {
      const result = await uploadBufferToCloudinary(req.file.buffer, {
        resourceType: "video",
        folder: "mytube/videos"
      });
      videoUrl = result.secure_url;
      publicId = result.public_id;
    } catch (e) {
      console.error("Cloudinary video upload error:", e.message || e);
      return res.status(502).json({ error: "Не удалось загрузить видео, попробуйте ещё раз" });
    }
  } else {
    videoUrl = `/uploads/videos/${req.file.filename}`;
    filePath = req.file.path;
  }

  const db = readDb();
  const video = {
    id: nextId(db),
    title: title.trim(),
    description: (description || "").trim(),
    tags: parseTags(tags),
    durationSec: Math.max(0, Math.round(Number(durationSec) || 0)),
    videoUrl,
    filePath,
    publicId,
    authorId: req.user.id,
    authorUsername: req.user.username,
    authorAvatarUrl: req.user.avatarUrl || "",
    createdAt: Date.now(),
    views: 0,
    likes: []
  };
  db.videos.push(video);
  writeDb(db);

  res.json({ video: publicVideo(video, req.user.id, {}) });
});

app.delete("/api/videos/:id", auth(true), (req, res) => {
  const db = readDb();
  const video = db.videos.find((v) => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: "Видео не найдено" });
  if (video.authorId !== req.user.id && !isOwnerUser(req.user)) {
    return res.status(403).json({ error: "Можно удалять только свои видео" });
  }

  db.videos = db.videos.filter((v) => v.id !== req.params.id);
  db.comments = db.comments.filter((c) => c.videoId !== req.params.id);
  db.users.forEach((u) => {
    u.watchLater = (u.watchLater || []).filter((id) => id !== req.params.id);
    u.history = (u.history || []).filter((h) => h.videoId !== req.params.id);
  });
  writeDb(db);

  if (video.publicId) {
    cloudinary.uploader.destroy(video.publicId, { resource_type: "video" }, () => {});
  } else if (video.filePath) {
    fs.unlink(video.filePath, () => {});
  }

  res.json({ ok: true });
});

app.post("/api/videos/:id/view", auth(false), (req, res) => {
  const db = readDb();
  const video = db.videos.find((v) => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: "Видео не найдено" });
  video.views = (video.views || 0) + 1;

  if (req.user) {
    const user = db.users.find((u) => u.id === req.user.id);
    user.history = (user.history || []).filter((h) => h.videoId !== video.id);
    user.history.unshift({ videoId: video.id, watchedAt: Date.now(), positionSec: 0, durationSec: 0 });
    user.history = user.history.slice(0, HISTORY_LIMIT);
  }

  writeDb(db);
  res.json({ views: video.views });
});

app.post("/api/videos/:id/progress", auth(true), (req, res) => {
  const db = readDb();
  const video = db.videos.find((v) => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: "Видео не найдено" });

  const { positionSec, durationSec } = req.body || {};
  const user = db.users.find((u) => u.id === req.user.id);
  user.history = user.history || [];
  let entry = user.history.find((h) => h.videoId === video.id);
  if (!entry) {
    entry = { videoId: video.id, watchedAt: Date.now(), positionSec: 0, durationSec: 0 };
    user.history.unshift(entry);
  }
  entry.watchedAt = Date.now();
  if (typeof positionSec === "number") entry.positionSec = positionSec;
  if (typeof durationSec === "number") entry.durationSec = durationSec;
  user.history = user.history.slice(0, HISTORY_LIMIT);

  writeDb(db);
  res.json({ ok: true });
});

app.post("/api/videos/:id/like", auth(true), (req, res) => {
  const db = readDb();
  const video = db.videos.find((v) => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: "Видео не найдено" });

  video.likes = video.likes || [];
  const idx = video.likes.indexOf(req.user.id);
  if (idx >= 0) video.likes.splice(idx, 1);
  else video.likes.push(req.user.id);

  writeDb(db);
  res.json({ likesCount: video.likes.length, likedByMe: idx < 0 });
});

app.post("/api/videos/:id/watch-later", auth(true), (req, res) => {
  const db = readDb();
  const video = db.videos.find((v) => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: "Видео не найдено" });

  const user = db.users.find((u) => u.id === req.user.id);
  user.watchLater = user.watchLater || [];
  const idx = user.watchLater.indexOf(video.id);
  if (idx >= 0) user.watchLater.splice(idx, 1);
  else user.watchLater.unshift(video.id);

  writeDb(db);
  res.json({ saved: idx < 0 });
});

app.post("/api/videos/:id/subscribe", auth(true), (req, res) => {
  const db = readDb();
  const video = db.videos.find((v) => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: "Видео не найдено" });

  const me = db.users.find((u) => u.id === req.user.id);
  me.subscribedTo = me.subscribedTo || [];
  const idx = me.subscribedTo.indexOf(video.authorId);
  if (idx >= 0) me.subscribedTo.splice(idx, 1);
  else me.subscribedTo.push(video.authorId);

  writeDb(db);
  res.json({ subscribed: idx < 0 });
});

app.put("/api/me/watch-later/order", auth(true), (req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.user.id);
  const current = new Set(user.watchLater || []);
  const requested = Array.isArray((req.body || {}).order) ? req.body.order : [];

  const seen = new Set();
  const newOrder = requested.filter((id) => current.has(id) && !seen.has(id) && seen.add(id));
  (user.watchLater || []).forEach((id) => { if (!seen.has(id)) { newOrder.push(id); seen.add(id); } });

  user.watchLater = newOrder;
  writeDb(db);
  res.json({ ok: true, order: user.watchLater });
});

app.get("/api/me/watch-later", auth(true), (req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.user.id);
  const extras = { watchLater: user.watchLater || [], historyMap: historyMapFor(user) };
  const ids = user.watchLater || [];
  const videos = ids
    .map((id) => db.videos.find((v) => v.id === id))
    .filter(Boolean)
    .map((v) => publicVideo(v, req.user.id, extras));
  res.json({ videos });
});

app.get("/api/me/history", auth(true), (req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.user.id);
  const extras = { watchLater: user.watchLater || [], historyMap: historyMapFor(user) };
  const videos = (user.history || [])
    .map((h) => {
      const v = db.videos.find((vid) => vid.id === h.videoId);
      return v ? publicVideo(v, req.user.id, extras) : null;
    })
    .filter(Boolean);
  res.json({ videos });
});

app.delete("/api/me/history", auth(true), (req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.user.id);
  user.history = [];
  writeDb(db);
  res.json({ ok: true });
});

app.get("/api/me/subscriptions-feed", auth(true), (req, res) => {
  const db = readDb();
  const user = db.users.find((u) => u.id === req.user.id);
  const extras = { watchLater: user.watchLater || [], historyMap: historyMapFor(user) };
  const subs = user.subscribedTo || [];
  const videos = db.videos
    .filter((v) => subs.includes(v.authorId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((v) => publicVideo(v, req.user.id, extras));
  res.json({ videos });
});

app.get("/api/videos/:id/comments", (req, res) => {
  const db = readDb();
  const list = db.comments
    .filter((c) => c.videoId === req.params.id)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((c) => ({
      id: c.id, text: c.text, authorId: c.authorId, authorUsername: c.authorUsername,
      authorAvatarUrl: c.authorAvatarUrl || "", createdAt: c.createdAt, parentId: c.parentId || null
    }));
  res.json({ comments: list });
});

app.post("/api/videos/:id/comments", auth(true), (req, res) => {
  const { text, parentId } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Комментарий пустой" });

  const db = readDb();
  const video = db.videos.find((v) => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: "Видео не найдено" });

  if (parentId && !db.comments.some((c) => c.id === parentId && c.videoId === req.params.id)) {
    return res.status(400).json({ error: "Комментарий, на который вы отвечаете, не найден" });
  }

  const comment = {
    id: nextId(db),
    videoId: req.params.id,
    text: text.trim(),
    parentId: parentId || null,
    authorId: req.user.id,
    authorUsername: req.user.username,
    authorAvatarUrl: req.user.avatarUrl || "",
    createdAt: Date.now()
  };
  db.comments.push(comment);
  writeDb(db);

  res.json({ comment });
});

app.delete("/api/videos/:id/comments/:commentId", auth(true), (req, res) => {
  const db = readDb();
  const comment = db.comments.find((c) => c.id === req.params.commentId && c.videoId === req.params.id);
  if (!comment) return res.status(404).json({ error: "Комментарий не найден" });

  const video = db.videos.find((v) => v.id === req.params.id);
  const canDelete = comment.authorId === req.user.id || (video && video.authorId === req.user.id) || isOwnerUser(req.user);
  if (!canDelete) return res.status(403).json({ error: "Можно удалять только свои комментарии" });

  db.comments = db.comments.filter((c) => c.id !== req.params.commentId && c.parentId !== req.params.commentId);
  writeDb(db);
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Файл слишком большой" });
  }
  if (err) {
    console.error(err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
  next();
});

setInterval(() => {
  try {
    const db = readDb();
    const before = db.sessions.length;
    db.sessions = db.sessions.filter((s) => s.expiresAt > Date.now());
    let changed = db.sessions.length !== before;
    (db.ads || []).forEach((a) => {
      if (a.status === "active" && a.expiresAt && a.expiresAt < Date.now()) { a.status = "expired"; changed = true; }
    });
    if (changed) writeDb(db);
  } catch (e) { /* skip */ }
}, 60 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// KEEP-ALIVE (чтобы бесплатный Render не "усыплял" сервис)
// ---------------------------------------------------------------------------
// На бесплатном тарифе Render веб-сервис останавливается после ~15 минут
// без входящих HTTP-запросов, и следующий запрос будит его 30-60 секунд.
// Ниже — самопинг: сервис каждые несколько минут сам стучится на свой же
// /healthz, что считается "активностью" и не даёт Render его усыпить.
//
// RENDER_EXTERNAL_URL Render подставляет автоматически (например,
// https://mytube-xxxx.onrender.com) — вручную задавать не нужно.
//
// ВАЖНО: это не 100% гарантия — Render может остановить бесплатный сервис
// по другим причинам (деплой, техобслуживание, лимит часов). Для
// максимальной надёжности дополнительно настрой внешний "будильник"
// (UptimeRobot / cron-job.org) на URL /healthz каждые 5-10 минут —
// подробная инструкция в deploy/DEPLOY.md. Один только внешний пинг тоже
// решает задачу без изменений в коде, но связка "внешний + внутренний"
// надёжнее всего.
const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_PING_URL;
if (SELF_PING_URL) {
  const https = require("https");
  const http = require("http");
  const pingTarget = SELF_PING_URL.replace(/\/+$/, "") + "/healthz";
  const client = pingTarget.startsWith("https") ? https : http;
  const SELF_PING_INTERVAL_MS = 10 * 60 * 1000; // 10 минут < 15-минутного таймаута Render
  setInterval(() => {
    const req = client.get(pingTarget, { timeout: 10000 }, (res) => {
      res.resume(); // слить ответ, чтобы не держать сокет
    });
    req.on("timeout", () => req.destroy());
    req.on("error", (e) => console.warn("MyTube keep-alive: ошибка self-ping:", e.message));
  }, SELF_PING_INTERVAL_MS).unref();
  console.log(`MyTube: keep-alive self-ping включён -> ${pingTarget} каждые ${SELF_PING_INTERVAL_MS / 60000} мин.`);
} else {
  console.log(
    "MyTube: keep-alive self-ping выключен (нет RENDER_EXTERNAL_URL/SELF_PING_URL) — " +
    "это нормально при локальном запуске."
  );
}

loadDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`MyTube запущен: http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error("MyTube: не удалось загрузить базу данных при старте:", e);
    process.exit(1);
  });
