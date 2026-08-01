const $ = (id) => document.getElementById(id);
const isValidUsername = (u) => /^[a-zA-Z0-9_]{3,20}$/.test(u);
const escapeHtml = (str = "") => str.replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));
const formatDate = (ts) => new Date(ts).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
const DEFAULT_AVATAR = "./images/default-avatar.svg";

const API = ""; // сервер раздаёт и сайт, и API с одного адреса

let token = localStorage.getItem("mtube_token") || null;
let currentUser = null;      // { id, username, avatarUrl, subscribedTo, preferences }
let activeVideoId = null;
let currentVideoObj = null;
let commentsPollTimer = null;
let videosPollTimer = null;
let progressTimer = null;
let isDragging = false;      // пока true — не перерисовываем дашборд поверх перетаскивания

let currentQuery = "";
let currentSort = "new";
let currentTag = "";

// Настройки сайта (имя, ссылки на донаты, рекламные вставки) — грузятся
// один раз при старте, доступны всем посетителям (см. /api/settings/public)
let siteSettings = { siteName: "MyTube", donateLinks: {}, adSnippets: {}, adPricePerDayKzt: 500 };
let activeAds = []; // самостоятельно купленная реклама (магазин рекламы), см. loadSettings()

/* ---------- Собственный плеер (player.js) ---------- */
let mainPlayer = null;
function doMinimizePlayer() {
  const mp = $("main-video-player");
  const mini = $("mini-video");
  if (!mp.src) return;
  mini.src = mp.src;
  mini.currentTime = mp.currentTime;
  mini.playbackRate = mp.playbackRate;
  mini.loop = mp.loop;
  $("mini-player-title").textContent = $("player-video-title").textContent;

  toggleModal("player-modal", false);
  if (commentsPollTimer) clearInterval(commentsPollTimer);
  stopProgressTracking();
  mp.pause();
  mp.src = "";

  miniActiveVideo = currentVideoObj;
  $("mini-player").hidden = false;
  positionMiniPlayer();
  mini.play().catch(() => {});
}

function openShareModal() {
  if (!currentVideoObj) return;
  const origin = location.origin;
  const link = `${origin}/?v=${encodeURIComponent(currentVideoObj.id)}`;
  const embedCode = `<iframe src="${origin}/embed/${encodeURIComponent(currentVideoObj.id)}" width="640" height="360" style="border:0;max-width:100%;" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  $("share-link-input").value = link;
  $("share-embed-input").value = embedCode;
  toggleModal("share-modal", true);
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // запасной способ для браузеров без Clipboard API/без https
    const tmp = document.createElement("textarea");
    tmp.value = text;
    tmp.style.position = "fixed";
    tmp.style.opacity = "0";
    document.body.appendChild(tmp);
    tmp.select();
    try { document.execCommand("copy"); } catch (e2) { /* ничего не поделать */ }
    document.body.removeChild(tmp);
  }
  if (btn) {
    const original = btn.textContent;
    btn.textContent = "Скопировано ✓";
    setTimeout(() => { btn.textContent = original; }, 1600);
  }
}

$("copy-share-link")?.addEventListener("click", () => copyToClipboard($("share-link-input").value, $("copy-share-link")));
$("copy-share-embed")?.addEventListener("click", () => copyToClipboard($("share-embed-input").value, $("copy-share-embed")));

document.addEventListener("DOMContentLoaded", () => {
  const root = $("ctp-main-root");
  if (root && window.mountCustomPlayer) {
    mainPlayer = window.mountCustomPlayer(root, {
      videoId: "main-video-player",
      features: { theater: true, minimize: true, share: true, pip: true },
      onMinimize: doMinimizePlayer,
      onShare: openShareModal
    });
  }
});

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const formatDuration = (sec) => {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
};

// Читаем длительность выбранного видеофайла прямо в браузере — без
// ffmpeg на сервере: временно грузим файл в скрытый <video>, ждём
// метаданные, освобождаем ссылку.
function readVideoDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.src = url;
    const done = (val) => { URL.revokeObjectURL(url); resolve(val); };
    probe.onloadedmetadata = () => done(probe.duration || 0);
    probe.onerror = () => done(0);
    setTimeout(() => done(0), 4000); // на всякий случай не ждём вечно
  });
}

function toggleModal(id, show) {
  const el = $(id);
  if (el) el.style.display = show ? "flex" : "none";
  // блокируем прокрутку страницы под модалкой на телефонах/планшетах, пока открыто окно
  const anyOpen = show || document.querySelectorAll('.modal[style*="flex"]').length > 0;
  document.body.style.overflow = anyOpen ? "hidden" : "";
}

function showAuthRequired() {
  alert("Нужно войти в аккаунт, чтобы это сделать.");
  toggleModal("register-modal", true);
}

async function api(path, { method = "GET", body, isForm = false } = {}) {
  const headers = {};
  if (token) headers["Authorization"] = "Bearer " + token;
  if (!isForm && body) headers["Content-Type"] = "application/json";

  const res = await fetch(API + path, {
    method,
    headers,
    body: isForm ? body : (body ? JSON.stringify(body) : undefined)
  });

  let data = {};
  try { data = await res.json(); } catch (e) { /* пустой ответ */ }

  if (!res.ok) {
    throw new Error(data.error || `Ошибка сервера (${res.status})`);
  }
  return data;
}

/* ---------- ОБНОВЛЕНИЕ ШАПКИ ПОСЛЕ ВХОДА/ВЫХОДА ---------- */
function renderAuthUI() {
  const authBtn = $("google-auth-btn");
  const profileBtn = $("profile-nav-btn");

  if (currentUser) {
    if (authBtn) authBtn.style.display = "none";
    if (profileBtn) {
      profileBtn.style.display = "inline-flex";
      profileBtn.querySelector("span").textContent = "@" + currentUser.username;
      profileBtn.querySelector("img").src = currentUser.avatarUrl || DEFAULT_AVATAR;
    }
  } else {
    if (authBtn) authBtn.style.display = "inline-block";
    if (profileBtn) profileBtn.style.display = "none";
  }
}

async function loadMe() {
  if (!token) { renderAuthUI(); return; }
  try {
    const data = await api("/api/me");
    currentUser = data.user;
  } catch (e) {
    currentUser = null;
    token = null;
    localStorage.removeItem("mtube_token");
  }
  renderAuthUI();
}

/* ---------- ПРОВЕРКА, ЧТО СЕРВЕР ЗАПУЩЕН ---------- */
async function checkServer() {
  try {
    await fetch(API + "/api/videos");
  } catch (e) {
    const dash = $("dashboard");
    if (dash) {
      dash.innerHTML = `<p class="widget-empty">⚠️ Не удаётся подключиться к серверу.
        Проверь, что он запущен: в папке <b>server</b> выполни <code>npm install</code>,
        затем <code>npm start</code>. Подробности — в README.md.</p>`;
    }
  }
}

/* ---------- НАСТРОЙКИ САЙТА: имя сайта, реклама, ссылки на донаты ---------- */

function injectHtmlWithScripts(el, html) {
  el.innerHTML = html;
  // <script> вставленные через innerHTML браузер не выполняет — это
  // защита самого браузера, а не баг. Пересоздаём такие теги вручную,
  // чтобы код рекламной сети (например, AdSense) реально подключался.
  el.querySelectorAll("script").forEach((oldScript) => {
    const newScript = document.createElement("script");
    [...oldScript.attributes].forEach((attr) => newScript.setAttribute(attr.name, attr.value));
    newScript.textContent = oldScript.textContent;
    oldScript.replaceWith(newScript);
  });
}

function fillAdSlot(elId, html) {
  const el = $(elId);
  if (!el) return;
  if (!html || !html.trim()) { el.hidden = true; el.innerHTML = ""; return; }
  injectHtmlWithScripts(el, html);
  el.hidden = false;
}

const DONATE_LABELS = {
  boosty: "Boosty", donationalerts: "DonationAlerts", yoomoney: "ЮMoney",
  paypal: "PayPal", crypto: "Крипто-адрес"
};

function renderDonateModal() {
  const wrap = $("donate-links-list");
  if (!wrap) return;
  const links = siteSettings.donateLinks || {};
  const rows = [];
  ["boosty", "donationalerts", "yoomoney", "paypal"].forEach((key) => {
    if (links[key]) rows.push(`<a class="donate-link-btn" target="_blank" rel="noopener" href="${escapeHtml(links[key])}">${DONATE_LABELS[key]}</a>`);
  });
  if (links.crypto) {
    rows.push(`<div class="donate-crypto-row"><span>${DONATE_LABELS.crypto}:</span><code>${escapeHtml(links.crypto)}</code>
      <button type="button" class="copy-btn" data-copy-crypto="${escapeHtml(links.crypto)}">Копировать</button></div>`);
  }
  if (links.custom && links.custom.includes("|")) {
    const [label, url] = links.custom.split("|");
    if (url) rows.push(`<a class="donate-link-btn" target="_blank" rel="noopener" href="${escapeHtml(url.trim())}">${escapeHtml(label.trim())}</a>`);
  }
  wrap.querySelectorAll(".donate-link-btn, .donate-crypto-row").forEach((n) => n.remove());
  if (rows.length) {
    $("donate-empty-msg").hidden = true;
    wrap.insertAdjacentHTML("beforeend", rows.join(""));
  } else if ($("donate-empty-msg")) {
    $("donate-empty-msg").hidden = false;
  }
  wrap.querySelectorAll("[data-copy-crypto]").forEach((btn) => {
    btn.addEventListener("click", () => copyToClipboard(btn.dataset.copyCrypto, btn));
  });
}

async function loadSettings() {
  try {
    const data = await api("/api/settings/public");
    siteSettings = data.settings;
  } catch (e) { /* сайт продолжит работать с настройками по умолчанию */ }

  if (siteSettings.siteName) document.title = siteSettings.siteName;
  const snippets = siteSettings.adSnippets || {};
  fillAdSlot("ad-slot-header", snippets.header);
  fillAdSlot("ad-slot-sidebar", snippets.sidebar);
  renderDonateModal();

  try {
    const adsData = await api("/api/ads/active");
    activeAds = adsData.ads || [];
  } catch (e) { activeAds = []; }
  renderSelfServeAdSlots();
}

function selfServeAdCardHtml(a) {
  return `<a class="selfserve-ad-card" href="${escapeHtml(a.linkUrl)}" target="_blank" rel="noopener nofollow sponsored">
    <span class="ad-tag">Реклама</span>
    ${a.imageUrl ? `<img src="${escapeHtml(a.imageUrl)}" alt="">` : ""}
    <h5>${escapeHtml(a.title)}</h5>
    ${a.description ? `<p>${escapeHtml(a.description)}</p>` : ""}
  </a>`;
}

// Рендерит купленную рекламу (магазин рекламы) в шапке и сайдбаре, поверх/рядом
// с вставками владельца сайта (AdSense-код). В ленте видео реклама вставляется
// отдельно, прямо в buildWidgetEl().
function renderSelfServeAdSlots() {
  const headerAd = activeAds.find((a) => a.placement === "header");
  const sidebarAd = activeAds.find((a) => a.placement === "sidebar");

  const headerEl = $("ad-slot-header");
  if (headerEl && headerAd) {
    headerEl.insertAdjacentHTML("beforeend", selfServeAdCardHtml(headerAd));
    headerEl.hidden = false;
  }
  const sidebarEl = $("ad-slot-sidebar");
  if (sidebarEl && sidebarAd) {
    sidebarEl.insertAdjacentHTML("beforeend", selfServeAdCardHtml(sidebarAd));
    sidebarEl.hidden = false;
  }
}

$("open-donate-modal")?.addEventListener("click", (e) => {
  e.preventDefault();
  renderDonateModal();
  toggleModal("donate-modal", true);
});
$("player-donate-btn")?.addEventListener("click", () => {
  renderDonateModal();
  toggleModal("donate-modal", true);
});

/* ---------- Магазин рекламы: открыть модалку заявки ---------- */
$("open-ads-modal")?.addEventListener("click", (e) => {
  e.preventDefault();
  if (!currentUser) { showAuthRequired(); return; }
  setDrawerOpen(false);
  resetAdsModal();
  loadMyAdsList();
  updateAdPricePreview();
  toggleModal("ads-modal", true);
});

/* ---------- ПАНЕЛЬ ВЛАДЕЛЬЦА САЙТА ---------- */

function fillOwnerSettingsForm() {
  const dl = siteSettings.donateLinks || {};
  const ad = siteSettings.adSnippets || {};
  if ($("owner-site-name")) $("owner-site-name").value = siteSettings.siteName || "MyTube";
  if ($("owner-donate-boosty")) $("owner-donate-boosty").value = dl.boosty || "";
  if ($("owner-donate-donationalerts")) $("owner-donate-donationalerts").value = dl.donationalerts || "";
  if ($("owner-donate-yoomoney")) $("owner-donate-yoomoney").value = dl.yoomoney || "";
  if ($("owner-donate-paypal")) $("owner-donate-paypal").value = dl.paypal || "";
  if ($("owner-donate-crypto")) $("owner-donate-crypto").value = dl.crypto || "";
  if ($("owner-donate-custom")) $("owner-donate-custom").value = dl.custom || "";
  if ($("owner-ad-header")) $("owner-ad-header").value = ad.header || "";
  if ($("owner-ad-infeed")) $("owner-ad-infeed").value = ad.inFeed || "";
  if ($("owner-ad-sidebar")) $("owner-ad-sidebar").value = ad.sidebar || "";
  if ($("owner-ad-price")) $("owner-ad-price").value = siteSettings.adPricePerDayKzt || 500;
}

$("save-owner-settings-btn")?.addEventListener("click", async () => {
  const status = $("owner-settings-status");
  if (status) status.textContent = "";
  const body = {
    siteName: $("owner-site-name")?.value.trim() || "MyTube",
    donateLinks: {
      boosty: $("owner-donate-boosty")?.value.trim() || "",
      donationalerts: $("owner-donate-donationalerts")?.value.trim() || "",
      yoomoney: $("owner-donate-yoomoney")?.value.trim() || "",
      paypal: $("owner-donate-paypal")?.value.trim() || "",
      crypto: $("owner-donate-crypto")?.value.trim() || "",
      custom: $("owner-donate-custom")?.value.trim() || ""
    },
    adSnippets: {
      header: $("owner-ad-header")?.value || "",
      inFeed: $("owner-ad-infeed")?.value || "",
      sidebar: $("owner-ad-sidebar")?.value || ""
    },
    adPricePerDayKzt: parseInt($("owner-ad-price")?.value, 10) || 0,
    cardNumber: $("owner-card-number")?.value.trim() || "",
    cardHolderName: $("owner-card-holder")?.value.trim() || ""
  };
  try {
    const data = await api("/api/settings", { method: "PUT", body });
    siteSettings = { ...siteSettings, ...data.settings };
    document.title = siteSettings.siteName || "MyTube";
    fillAdSlot("ad-slot-header", (siteSettings.adSnippets || {}).header);
    fillAdSlot("ad-slot-sidebar", (siteSettings.adSnippets || {}).sidebar);
    renderSelfServeAdSlots();
    renderDonateModal();
    if (status) { status.style.color = "var(--accent-2, #31d0aa)"; status.textContent = "Сохранено ✓"; }
    renderDashboard(); // обновит рекламную карточку в ленте
  } catch (err) {
    if (status) status.textContent = "Ошибка: " + err.message;
  }
});

/* ---------- Модерация заявок на рекламу (только владелец сайта) ---------- */
function adStatusLabel(s) {
  return { pending_payment: "Ждём оплату", awaiting_confirmation: "Проверить оплату",
    active: "Активна", rejected: "Отклонена", expired: "Истекла" }[s] || s;
}

async function loadOwnerAdsList() {
  const wrap = $("owner-ads-list");
  if (!wrap) return;
  try {
    const data = await api("/api/admin/ads");
    if (!data.ads.length) { wrap.innerHTML = `<p class="widget-empty">Заявок пока нет</p>`; return; }
    wrap.innerHTML = data.ads.map((a) => `
      <div class="premium-code-row" data-ad-id="${a.id}" style="flex-direction:column;align-items:stretch;gap:6px;">
        <div style="display:flex;justify-content:space-between;gap:8px;">
          <b>${escapeHtml(a.title)}</b>
          <span class="ad-status-pill status-${a.status}">${adStatusLabel(a.status)}</span>
        </div>
        <span>@${escapeHtml(a.ownerUsername)} · ${a.days} дн. · ${a.priceKzt} ₸ · ${a.placement}</span>
        ${a.status === "awaiting_confirmation" ? `
          <div style="display:flex;gap:6px;">
            <button type="button" class="copy-btn" data-action="approve-ad" data-id="${a.id}">✓ Подтвердить оплату</button>
            <button type="button" class="copy-btn" data-action="reject-ad" data-id="${a.id}">✕ Отклонить</button>
          </div>` : ""}
      </div>`).join("");
  } catch (e) { wrap.innerHTML = `<p class="widget-empty">Не удалось загрузить заявки</p>`; }
}

$("owner-ads-list")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  try {
    if (btn.dataset.action === "approve-ad") await api(`/api/admin/ads/${id}/approve`, { method: "POST" });
    else if (btn.dataset.action === "reject-ad") await api(`/api/admin/ads/${id}/reject`, { method: "POST" });
    loadOwnerAdsList();
    loadSettings();
  } catch (err) { alert(err.message); }
});

async function loadOwnerUsersList() {
  const wrap = $("owner-users-list");
  if (!wrap) return;
  try {
    const data = await api("/api/admin/users");
    if (!data.users.length) { wrap.innerHTML = `<p class="widget-empty">Пользователей нет</p>`; return; }
    wrap.innerHTML = data.users.map((u) => `
      <div class="premium-code-row" style="flex-direction:column;align-items:stretch;gap:6px;">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
          <div style="display:flex;align-items:center;gap:8px;">
            <img src="${u.avatarUrl || DEFAULT_AVATAR}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;">
            <b>@${escapeHtml(u.username)}</b>
          </div>
          <span>${u.videosCount} видео · ${u.subscribersCount} подп.${u.totpEnabled ? " · 2FA" : ""}</span>
        </div>
        <div style="display:flex;gap:6px;">
          <button type="button" class="copy-btn" data-action="edit-user" data-id="${u.id}">Изменить</button>
        </div>
      </div>`).join("");
  } catch (e) { wrap.innerHTML = `<p class="widget-empty">Не удалось загрузить пользователей</p>`; }
}

let allOwnerUsersCache = [];
$("owner-users-list")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action='edit-user']");
  if (!btn) return;
  try {
    if (!allOwnerUsersCache.length) allOwnerUsersCache = (await api("/api/admin/users")).users;
    const u = allOwnerUsersCache.find((x) => x.id === btn.dataset.id) || (await api("/api/admin/users")).users.find((x) => x.id === btn.dataset.id);
    $("admin-edit-user-id").value = u.id;
    $("admin-edit-username").value = u.username;
    $("admin-edit-avatar").value = u.avatarUrl || "";
    $("admin-edit-password").value = "";
    $("admin-edit-disable-2fa").checked = false;
    $("admin-edit-user-error").textContent = "";
    toggleModal("admin-edit-user-modal", true);
  } catch (err) { alert(err.message); }
});

$("admin-edit-user-save-btn")?.addEventListener("click", async () => {
  const id = $("admin-edit-user-id").value;
  const body = {
    username: $("admin-edit-username").value.trim(),
    avatarUrl: $("admin-edit-avatar").value.trim()
  };
  const newPassword = $("admin-edit-password").value;
  if (newPassword) body.newPassword = newPassword;
  if ($("admin-edit-disable-2fa").checked) body.totpEnabled = false;
  try {
    await api(`/api/admin/users/${id}`, { method: "PUT", body });
    toggleModal("admin-edit-user-modal", false);
    loadOwnerUsersList();
  } catch (err) {
    $("admin-edit-user-error").textContent = err.message;
  }
});

$("admin-edit-user-delete-btn")?.addEventListener("click", async () => {
  const id = $("admin-edit-user-id").value;
  if (!confirm("Удалить этого пользователя и всё его видео без возможности восстановления?")) return;
  try {
    await api(`/api/admin/users/${id}`, { method: "DELETE" });
    toggleModal("admin-edit-user-modal", false);
    loadOwnerUsersList();
    renderDashboard();
  } catch (err) {
    $("admin-edit-user-error").textContent = err.message;
  }
});

async function loadOwnerVideosList() {
  const wrap = $("owner-videos-list");
  if (!wrap) return;
  try {
    const data = await api("/api/videos");
    if (!data.videos.length) { wrap.innerHTML = `<p class="widget-empty">Видео нет</p>`; return; }
    wrap.innerHTML = data.videos.map((v) => `
      <div class="premium-code-row" style="flex-direction:column;align-items:stretch;gap:4px;">
        <div style="display:flex;justify-content:space-between;gap:8px;">
          <b>${escapeHtml(v.title)}</b>
          <span>@${escapeHtml(v.authorUsername)}</span>
        </div>
        <div style="display:flex;gap:6px;">
          <button type="button" class="copy-btn" data-action="edit-video" data-id="${v.id}">Изменить</button>
        </div>
      </div>`).join("");
  } catch (e) { wrap.innerHTML = `<p class="widget-empty">Не удалось загрузить видео</p>`; }
}

let allOwnerVideosCache = [];
$("owner-videos-list")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action='edit-video']");
  if (!btn) return;
  try {
    allOwnerVideosCache = (await api("/api/videos")).videos;
    const v = allOwnerVideosCache.find((x) => x.id === btn.dataset.id);
    $("admin-edit-video-id").value = v.id;
    $("admin-edit-video-title").value = v.title;
    $("admin-edit-video-desc").value = v.description || "";
    $("admin-edit-video-tags").value = (v.tags || []).join(", ");
    $("admin-edit-video-error").textContent = "";
    toggleModal("admin-edit-video-modal", true);
  } catch (err) { alert(err.message); }
});

$("admin-edit-video-save-btn")?.addEventListener("click", async () => {
  const id = $("admin-edit-video-id").value;
  const body = {
    title: $("admin-edit-video-title").value.trim(),
    description: $("admin-edit-video-desc").value,
    tags: $("admin-edit-video-tags").value
  };
  try {
    await api(`/api/admin/videos/${id}`, { method: "PUT", body });
    toggleModal("admin-edit-video-modal", false);
    loadOwnerVideosList();
    renderDashboard();
  } catch (err) {
    $("admin-edit-video-error").textContent = err.message;
  }
});

$("admin-edit-video-delete-btn")?.addEventListener("click", async () => {
  const id = $("admin-edit-video-id").value;
  if (!confirm("Удалить это видео без возможности восстановления?")) return;
  try {
    await api(`/api/videos/${id}`, { method: "DELETE" });
    toggleModal("admin-edit-video-modal", false);
    loadOwnerVideosList();
    renderDashboard();
  } catch (err) {
    $("admin-edit-video-error").textContent = err.message;
  }
});

/* ============================================================= */

let currentAdId = null;

function resetAdsModal() {
  currentAdId = null;
  $("ads-form-step").hidden = false;
  $("ads-payment-step").hidden = true;
  $("ad-form-error").textContent = "";
  $("ad-payment-status").textContent = "";
}

function updateAdPricePreview() {
  const days = Math.min(30, Math.max(1, parseInt($("ad-days")?.value, 10) || 1));
  const price = days * (siteSettings.adPricePerDayKzt || 500);
  if ($("ad-price-preview")) $("ad-price-preview").textContent = `Стоимость: ${price} ₸ (${days} дн. × ${siteSettings.adPricePerDayKzt || 500} ₸/день)`;
}
$("ad-days")?.addEventListener("input", updateAdPricePreview);

$("ad-submit-btn")?.addEventListener("click", async () => {
  const title = $("ad-title").value.trim();
  const linkUrl = $("ad-link").value.trim();
  $("ad-form-error").textContent = "";
  if (!title) { $("ad-form-error").textContent = "Введите название"; return; }
  if (!/^https?:\/\//i.test(linkUrl)) { $("ad-form-error").textContent = "Ссылка должна начинаться с http:// или https://"; return; }

  const body = {
    title,
    description: $("ad-description").value.trim(),
    linkUrl,
    imageUrl: $("ad-image").value.trim(),
    placement: $("ad-placement").value,
    days: parseInt($("ad-days").value, 10) || 1
  };
  try {
    const data = await api("/api/ads", { method: "POST", body });
    currentAdId = data.ad.id;
    await showAdPaymentStep(currentAdId);
  } catch (err) {
    $("ad-form-error").textContent = err.message;
  }
});

async function showAdPaymentStep(adId) {
  $("ads-form-step").hidden = true;
  $("ads-payment-step").hidden = false;
  // Реквизиты приходят картинкой (SVG), а не текстом/JSON — запрашиваем её
  // через авторизованный fetch и показываем как обычное изображение.
  try {
    const res = await fetch(`${API}/api/ads/${encodeURIComponent(adId)}/payment-card`, {
      headers: token ? { Authorization: "Bearer " + token } : {}
    });
    if (!res.ok) throw new Error("Не удалось загрузить реквизиты оплаты");
    const blob = await res.blob();
    $("ad-payment-card-img").src = URL.createObjectURL(blob);
  } catch (e) {
    $("ad-payment-status").textContent = "Ошибка: " + e.message;
  }
}

$("ad-mark-paid-btn")?.addEventListener("click", async () => {
  if (!currentAdId) return;
  try {
    await api(`/api/ads/${currentAdId}/mark-paid`, { method: "POST" });
    $("ad-payment-status").textContent = "Спасибо! Заявка отправлена владельцу сайта на проверку.";
    $("ad-mark-paid-btn").disabled = true;
    loadMyAdsList();
  } catch (err) {
    $("ad-payment-status").textContent = "Ошибка: " + err.message;
  }
});

async function loadMyAdsList() {
  const wrap = $("ads-my-list");
  if (!wrap || !currentUser) return;
  try {
    const data = await api("/api/me/ads");
    if (!data.ads.length) { wrap.innerHTML = `<p class="widget-empty">Заявок пока нет</p>`; return; }
    wrap.innerHTML = data.ads.map((a) => `
      <div class="premium-code-row" style="flex-direction:column;align-items:stretch;gap:4px;">
        <div style="display:flex;justify-content:space-between;gap:8px;">
          <b>${escapeHtml(a.title)}</b>
          <span class="ad-status-pill status-${a.status}">${adStatusLabel(a.status)}</span>
        </div>
        <span>${a.days} дн. · ${a.priceKzt} ₸ · ${a.placement}</span>
      </div>`).join("");
  } catch (e) { wrap.innerHTML = `<p class="widget-empty">Не удалось загрузить заявки</p>`; }
}

/* ---------- ЦВЕТ ТЕМЫ (личная настройка, видна только владельцу) ---------- */

function applyAccent(a, b) {
  const root = document.documentElement.style;
  const toRgba = (hex, alpha) => {
    const c = hex.replace("#", "");
    const r = parseInt(c.substring(0, 2), 16), g = parseInt(c.substring(2, 4), 16), bl = parseInt(c.substring(4, 6), 16);
    return `rgba(${r},${g},${bl},${alpha})`;
  };
  root.setProperty("--accent", a);
  root.setProperty("--accent-2", b);
  root.setProperty("--accent-grad", `linear-gradient(135deg, ${a}, ${b})`);
  root.setProperty("--accent-soft", toRgba(a, 0.14));
  root.setProperty("--accent-ring", toRgba(a, 0.35));
}

function currentAccentPref() {
  return (currentUser && currentUser.preferences && currentUser.preferences.accent)
    || JSON.parse(localStorage.getItem("mtube_accent") || "null");
}

function applyAccentPreference() {
  const acc = currentAccentPref();
  if (acc && acc.a && acc.b) applyAccent(acc.a, acc.b);
}

document.querySelectorAll("#accent-swatches .swatch").forEach((btn) => {
  btn.addEventListener("click", () => {
    const a = btn.dataset.a, b = btn.dataset.b;
    applyAccent(a, b);
    localStorage.setItem("mtube_accent", JSON.stringify({ a, b }));
    if (currentUser) {
      currentUser.preferences = { ...(currentUser.preferences || {}), accent: { a, b } };
      api("/api/me/preferences", { method: "PUT", body: { accent: { a, b } } }).catch(() => {});
    }
    document.querySelectorAll("#accent-swatches .swatch").forEach((s) => s.classList.remove("active"));
    btn.classList.add("active");
  });
});

function markActiveSwatch() {
  const acc = currentAccentPref();
  document.querySelectorAll("#accent-swatches .swatch").forEach((s) => {
    s.classList.toggle("active", !!acc && s.dataset.a === acc.a);
  });
}

/* ---------- АВТОРИЗАЦИЯ ---------- */

$("google-auth-btn")?.addEventListener("click", (e) => {
  e.preventDefault();
  toggleModal("register-modal", true);
});

$("profile-nav-btn")?.addEventListener("click", (e) => {
  e.preventDefault();
  $("profile-preview-avatar").src = currentUser?.avatarUrl || DEFAULT_AVATAR;
  $("profile-display-name-input").value = currentUser?.username || "";
  markActiveSwatch();
  renderTwoFaStatus();
  const ownerBlock = $("owner-settings-block");
  if (ownerBlock) {
    ownerBlock.hidden = !currentUser?.isOwner;
    if (currentUser?.isOwner) {
      fillOwnerSettingsForm();
      loadOwnerAdsList();
      loadOwnerUsersList();
      loadOwnerVideosList();
    }
  }
  toggleModal("profile-settings-modal", true);
});

let authMode = "register";
$("switch-auth-btn")?.addEventListener("click", (e) => {
  e.preventDefault();
  authMode = authMode === "register" ? "login" : "register";
  $("auth-title").textContent = authMode === "register" ? "Регистрация на MTube" : "Вход в MTube";
  $("submit-register-btn").textContent = authMode === "register" ? "Зарегистрироваться" : "Войти";
  $("confirm-password-group").style.display = authMode === "register" ? "block" : "none";
  $("switch-auth-btn").textContent = authMode === "register"
    ? "Уже есть аккаунт? Войти"
    : "Ещё нет аккаунта? Зарегистрироваться";
  $("username-error").textContent = "";
  $("password-error").textContent = "";
  resetLogin2faStep();
});

$("submit-register-btn")?.addEventListener("click", async () => {
  const username = $("reg-username").value.trim();
  const password = $("reg-password").value;
  const confirmPassword = $("reg-confirm-password").value;
  $("username-error").textContent = "";
  $("password-error").textContent = "";

  if (!isValidUsername(username)) {
    $("username-error").textContent = "3-20 символов: латиница, цифры, _";
    return;
  }
  if (!password || password.length < 6) {
    $("password-error").textContent = "Пароль должен быть от 6 символов";
    return;
  }
  if (authMode === "register" && password !== confirmPassword) {
    $("password-error").textContent = "Пароли не совпадают";
    return;
  }

  try {
    const endpoint = authMode === "register" ? "/api/register" : "/api/login";
    const data = await api(endpoint, { method: "POST", body: { username, password } });

    if (data.requires2fa) {
      pendingLoginTicket = data.loginTicket;
      $("login-2fa-step").hidden = false;
      $("login-2fa-code").value = "";
      $("login-2fa-error").textContent = "";
      $("login-2fa-code").focus();
      return;
    }

    token = data.token;
    currentUser = data.user;
    localStorage.setItem("mtube_token", token);
    renderAuthUI();

    toggleModal("register-modal", false);
    $("reg-username").value = "";
    $("reg-password").value = "";
    $("reg-confirm-password").value = "";

    loadDashboardState();
    applyAccentPreference();
    renderDashboard();
  } catch (err) {
    $("password-error").textContent = err.message;
  }
});

let pendingLoginTicket = null;
function resetLogin2faStep() {
  pendingLoginTicket = null;
  if ($("login-2fa-step")) $("login-2fa-step").hidden = true;
}

$("login-2fa-submit-btn")?.addEventListener("click", async () => {
  const code = $("login-2fa-code").value.trim();
  $("login-2fa-error").textContent = "";
  if (!pendingLoginTicket) { resetLogin2faStep(); return; }
  try {
    const data = await api("/api/login/2fa", { method: "POST", body: { loginTicket: pendingLoginTicket, code } });
    token = data.token;
    currentUser = data.user;
    localStorage.setItem("mtube_token", token);
    renderAuthUI();
    resetLogin2faStep();

    toggleModal("register-modal", false);
    $("reg-username").value = "";
    $("reg-password").value = "";
    $("reg-confirm-password").value = "";

    loadDashboardState();
    applyAccentPreference();
    renderDashboard();
  } catch (err) {
    $("login-2fa-error").textContent = err.message;
  }
});

$("logout-btn")?.addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch (e) { /* игнор */ }
  token = null;
  currentUser = null;
  localStorage.removeItem("mtube_token");
  renderAuthUI();
  toggleModal("profile-settings-modal", false);

  loadDashboardState();
  applyAccentPreference();
  renderDashboard();
});

/* ---------- ДВУХЭТАПНАЯ ЗАЩИТА АККАУНТА (2FA) ---------- */

function renderTwoFaStatus() {
  const text = $("twofa-status-text");
  const enableBtn = $("twofa-enable-start-btn");
  const disableBtn = $("twofa-disable-start-btn");
  $("twofa-setup-panel").hidden = true;
  $("twofa-disable-panel").hidden = true;
  if (!text) return;
  if (currentUser?.totpEnabled) {
    text.textContent = "Включена ✓ — при входе потребуется код из приложения.";
    if (enableBtn) enableBtn.hidden = true;
    if (disableBtn) disableBtn.hidden = false;
  } else {
    text.textContent = "Выключена — вход только по паролю.";
    if (enableBtn) enableBtn.hidden = false;
    if (disableBtn) disableBtn.hidden = true;
  }
}

$("twofa-enable-start-btn")?.addEventListener("click", async () => {
  $("twofa-setup-error").textContent = "";
  try {
    const data = await api("/api/2fa/setup", { method: "POST" });
    $("twofa-secret-output").value = data.secret;
    $("twofa-setup-code").value = "";
    $("twofa-setup-panel").hidden = false;
  } catch (err) {
    alert("Не удалось начать настройку 2FA: " + err.message);
  }
});

$("twofa-copy-secret")?.addEventListener("click", () => {
  copyToClipboard($("twofa-secret-output").value, $("twofa-copy-secret"));
});

$("twofa-confirm-enable-btn")?.addEventListener("click", async () => {
  const code = $("twofa-setup-code").value.trim();
  $("twofa-setup-error").textContent = "";
  try {
    const data = await api("/api/2fa/enable", { method: "POST", body: { code } });
    currentUser = data.user;
    renderTwoFaStatus();
  } catch (err) {
    $("twofa-setup-error").textContent = err.message;
  }
});

$("twofa-disable-start-btn")?.addEventListener("click", () => {
  $("twofa-disable-code").value = "";
  $("twofa-disable-error").textContent = "";
  $("twofa-disable-panel").hidden = false;
});

$("twofa-confirm-disable-btn")?.addEventListener("click", async () => {
  const code = $("twofa-disable-code").value.trim();
  $("twofa-disable-error").textContent = "";
  try {
    const data = await api("/api/2fa/disable", { method: "POST", body: { code } });
    currentUser = data.user;
    renderTwoFaStatus();
  } catch (err) {
    $("twofa-disable-error").textContent = err.message;
  }
});

/* ---------- ПРОФИЛЬ ---------- */

$("save-profile-btn")?.addEventListener("click", async () => {
  if (!currentUser) return;
  const newName = $("profile-display-name-input").value.trim();
  const file = $("profile-avatar-input").files[0];

  const form = new FormData();
  if (newName) form.append("displayName", newName);
  if (file) form.append("avatar", file);

  try {
    const data = await api("/api/profile", { method: "PUT", body: form, isForm: true });
    currentUser = data.user;
    renderAuthUI();
    toggleModal("profile-settings-modal", false);
    renderDashboard();
  } catch (err) {
    alert("Ошибка при сохранении: " + err.message);
  }
});

/* ---------- ЗАГРУЗКА ВИДЕО ---------- */

$("open-upload-modal")?.addEventListener("click", (e) => {
  e.preventDefault();
  if (!currentUser) { showAuthRequired(); return; }
  setDrawerOpen(false);
  toggleModal("upload-modal", true);
});

$("submit-video-btn")?.addEventListener("click", async () => {
  if (!currentUser) { showAuthRequired(); return; }

  const file = $("video-file").files[0];
  const title = $("video-title").value.trim();
  const desc = $("video-desc").value.trim();
  const tags = $("video-tags").value.trim();

  if (!file) { alert("Выбери видеофайл!"); return; }
  if (!file.type.startsWith("video/")) { alert("Нужно выбрать видеофайл!"); return; }
  if (!title) { alert("Введи название видео!"); return; }

  const submitBtn = $("submit-video-btn");
  const progressWrap = $("upload-progress-wrap");
  const progressBar = $("upload-progress-bar");

  submitBtn.disabled = true;
  submitBtn.textContent = "Подготовка...";
  const durationSec = await readVideoDuration(file);

  const form = new FormData();
  form.append("video", file);
  form.append("title", title);
  form.append("description", desc);
  form.append("tags", tags);
  form.append("durationSec", String(durationSec));

  submitBtn.textContent = "Загрузка...";
  if (progressWrap) progressWrap.style.display = "block";

  // Используем XMLHttpRequest вместо fetch, чтобы показать реальный прогресс загрузки
  const xhr = new XMLHttpRequest();
  xhr.open("POST", API + "/api/videos");
  if (token) xhr.setRequestHeader("Authorization", "Bearer " + token);

  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    if (progressBar) { progressBar.style.width = pct + "%"; progressBar.textContent = pct + "%"; }
  };

  xhr.onload = () => {
    submitBtn.disabled = false;
    submitBtn.textContent = "Опубликовать видео";
    if (progressWrap) progressWrap.style.display = "none";
    if (progressBar) { progressBar.style.width = "0%"; progressBar.textContent = ""; }

    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch (e) { /* пусто */ }

    if (xhr.status >= 200 && xhr.status < 300) {
      $("video-file").value = "";
      $("video-title").value = "";
      $("video-desc").value = "";
      $("video-tags").value = "";
      toggleModal("upload-modal", false);
      loadTags();
      renderDashboard();
    } else {
      alert("Ошибка загрузки: " + (data.error || xhr.status));
    }
  };

  xhr.onerror = () => {
    alert("Не удалось связаться с сервером. Проверь, что он запущен (см. README.md).");
    submitBtn.disabled = false;
    submitBtn.textContent = "Опубликовать видео";
    if (progressWrap) progressWrap.style.display = "none";
  };

  xhr.send(form);
});

/* ---------- ПОИСК / СОРТИРОВКА / ТЕГИ ---------- */

$("search-input")?.addEventListener("input", debounce(() => {
  currentQuery = $("search-input").value.trim();
  renderDashboard();
}, 350));

$("sort-select")?.addEventListener("change", () => {
  currentSort = $("sort-select").value;
  renderDashboard();
});

async function loadTags() {
  const wrap = $("tag-chips");
  if (!wrap) return;
  try {
    const data = await api("/api/tags");
    wrap.innerHTML = "";
    data.tags.forEach((t) => {
      const chip = document.createElement("button");
      chip.className = "tag-chip";
      chip.textContent = "#" + t;
      chip.dataset.tag = t;
      chip.classList.toggle("active", currentTag === t);
      chip.addEventListener("click", () => {
        currentTag = currentTag === t ? "" : t;
        wrap.querySelectorAll(".tag-chip").forEach((c) => c.classList.toggle("active", c.dataset.tag === currentTag));
        renderDashboard();
      });
      wrap.appendChild(chip);
    });
  } catch (e) { /* тихо игнорируем */ }
}

/* ---------- ЛИЧНЫЙ ДАШБОРД: перетаскиваемые и изменяемые по размеру блоки ---------- */

const WIDGET_DEFS = {
  all: { title: "Все видео", empty: "Видео пока нет. Откройте меню (☰) → «Создать видео»!" },
  subs: { title: "Лента подписок", empty: "Вы пока ни на кого не подписаны — подпишитесь на автора в плеере." },
  watchlater: { title: "Смотреть позже", empty: "Список пуст — добавляйте видео значком 🔖 в плеере." },
  history: { title: "История просмотров", empty: "Вы ещё ничего не смотрели." }
};
const DEFAULT_ORDER = ["all", "subs", "watchlater", "history"];

let dashboardState = { order: [...DEFAULT_ORDER], spans: {}, sizes: {} };

function normalizeDashboardState(raw) {
  const order = Array.isArray(raw?.order) ? raw.order.filter((id) => DEFAULT_ORDER.includes(id)) : [];
  DEFAULT_ORDER.forEach((id) => { if (!order.includes(id)) order.push(id); });
  return {
    order,
    spans: (raw && raw.spans) || {},
    sizes: (raw && raw.sizes) || {}
  };
}

function loadDashboardState() {
  const fromServer = currentUser?.preferences?.dashboardLayout;
  const fromLocal = JSON.parse(localStorage.getItem("mtube_dashboard") || "null");
  dashboardState = normalizeDashboardState(fromServer || fromLocal || null);
}

function saveDashboardState() {
  localStorage.setItem("mtube_dashboard", JSON.stringify(dashboardState));
  if (currentUser) {
    api("/api/me/preferences", { method: "PUT", body: { dashboardLayout: dashboardState } }).catch(() => {});
  }
}

$("reset-layout-btn")?.addEventListener("click", (e) => {
  e.preventDefault();
  dashboardState = normalizeDashboardState(null);
  localStorage.removeItem("mtube_dashboard");
  if (currentUser) api("/api/me/preferences", { method: "PUT", body: { dashboardLayout: dashboardState } }).catch(() => {});
  renderDashboard();
  setFaqOpen(false);
});

async function fetchAllVideos() {
  const params = new URLSearchParams();
  if (currentQuery) params.set("q", currentQuery);
  if (currentTag) params.set("tag", currentTag);
  if (currentSort) params.set("sort", currentSort);
  const data = await api(`/api/videos?${params.toString()}`);
  return data.videos;
}

async function fetchWidgetVideos(id) {
  try {
    if (id === "all") return await fetchAllVideos();
    if (!currentUser) return [];
    if (id === "subs") return (await api("/api/me/subscriptions-feed")).videos;
    if (id === "watchlater") return (await api("/api/me/watch-later")).videos;
    if (id === "history") return (await api("/api/me/history")).videos;
  } catch (e) { /* тихо, checkServer() уже покажет предупреждение */ }
  return [];
}

// Ленивая загрузка превью карточек: не грузим метаданные видео, пока
// карточка не окажется рядом с видимой областью экрана — так лента с
// десятками видео открывается моментально, а не тормозит на старте.
const cardPreviewObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    const vidEl = entry.target;
    if (vidEl.dataset.src && !vidEl.getAttribute("src")) {
      vidEl.src = vidEl.dataset.src;
    }
    cardPreviewObserver.unobserve(vidEl);
  });
}, { rootMargin: "400px 0px" });

function buildVideoCardEl(v) {
  const card = document.createElement("div");
  card.className = "video-card is-loading";
  card.innerHTML = `
    <video data-src="${v.videoUrl}" muted preload="none" loop playsinline webkit-playsinline></video>
    <div class="card-thumb-shimmer"></div>
    ${v.durationSec ? `<span class="duration-badge">${formatDuration(v.durationSec)}</span>` : ""}
    ${v.progressPct > 0 ? `<div class="watch-progress"><span style="width:${v.progressPct}%"></span></div>` : ""}
    <div class="video-card-info">
      <h4>${escapeHtml(v.title)}</h4>
      <div class="video-card-author-row">
        <img class="video-card-avatar" src="${v.authorAvatarUrl || DEFAULT_AVATAR}" alt="">
        <p>@${escapeHtml(v.authorUsername)}</p>
      </div>
      <span class="video-date">${formatDate(v.createdAt)} · ${v.views || 0} просмотров${v.savedByMe ? " · 🔖" : ""}</span>
      ${v.isMine ? `<button class="delete-card-btn" title="Удалить видео">🗑</button>` : ""}
    </div>`;

  const previewVideo = card.querySelector("video");
  cardPreviewObserver.observe(previewVideo);
  previewVideo.addEventListener("loadeddata", () => card.classList.remove("is-loading"), { once: true });
  previewVideo.addEventListener("error", () => card.classList.remove("is-loading"), { once: true });

  // Наведение мышью — короткое превью видео (как автопроигрывание на
  // главной у YouTube), только если превью уже подгружено
  let hoverTimer = null;
  card.addEventListener("mouseenter", () => {
    if (!previewVideo.src) return;
    hoverTimer = setTimeout(() => {
      previewVideo.currentTime = 0;
      previewVideo.play().then(() => card.classList.add("is-previewing")).catch(() => {});
    }, 220);
  });
  card.addEventListener("mouseleave", () => {
    clearTimeout(hoverTimer);
    previewVideo.pause();
    previewVideo.currentTime = 0;
    card.classList.remove("is-previewing");
  });

  card.addEventListener("click", (e) => {
    if (e.target.closest(".delete-card-btn")) return;
    openPlayer(v);
  });

  const delBtn = card.querySelector(".delete-card-btn");
  delBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("Удалить это видео насовсем?")) return;
    try {
      await api(`/api/videos/${v.id}`, { method: "DELETE" });
      renderDashboard();
    } catch (err) {
      alert("Не удалось удалить: " + err.message);
    }
  });

  return card;
}

function buildWidgetEl(id, videos, orderIdx) {
  const def = WIDGET_DEFS[id];
  const span = dashboardState.spans[id] || 3;
  const size = dashboardState.sizes[id] || "m";

  const el = document.createElement("section");
  el.className = "widget";
  el.dataset.widget = id;
  el.style.order = orderIdx;
  el.style.setProperty("--span", span);

  const extraBtn = (id === "history" && videos.length)
    ? `<button data-action="clear-history" title="Очистить историю">🗑 История</button>` : "";

  const head = document.createElement("header");
  head.className = "widget-head";
  head.innerHTML = `
    <button class="widget-drag" title="Перетащить, чтобы изменить порядок" aria-label="Перетащить">⠿</button>
    <h3>${def.title}</h3>
    <div class="widget-controls">
      <button data-action="move-up" title="Переместить выше">↑</button>
      <button data-action="move-down" title="Переместить ниже">↓</button>
      <button data-action="cycle-span" title="Ширина блока: нажмите, чтобы изменить">⇔ ${span}/3</button>
      <button data-action="cycle-size" title="Размер карточек: нажмите, чтобы изменить">${size.toUpperCase()}</button>
      ${extraBtn}
    </div>`;

  const body = document.createElement("div");
  body.className = "widget-body";
  const grid = document.createElement("div");
  grid.className = `video-grid density-${size}`;

  if (!videos.length) {
    grid.innerHTML = `<p class="widget-empty">${currentUser || id === "all" ? def.empty : "Войдите в аккаунт, чтобы пользоваться этим блоком."}</p>`;
  } else {
    videos.forEach((v, idx) => {
      grid.appendChild(buildVideoCardEl(v));
      // Рекламная карточка в ленте — только в блоке "Все видео", один раз,
      // после нескольких первых видео: сначала свой HTML-код владельца
      // (например, AdSense), затем купленная через магазин рекламы карточка.
      if (id === "all" && idx === 5) {
        const inFeedAd = (siteSettings.adSnippets || {}).inFeed;
        if (inFeedAd && inFeedAd.trim()) {
          const adCard = document.createElement("div");
          adCard.className = "video-card ad-card";
          injectHtmlWithScripts(adCard, inFeedAd);
          grid.appendChild(adCard);
        }
        const selfServeInfeed = activeAds.find((a) => a.placement === "infeed");
        if (selfServeInfeed) {
          const adCard = document.createElement("div");
          adCard.innerHTML = selfServeAdCardHtml(selfServeInfeed);
          grid.appendChild(adCard.firstElementChild);
        }
      }
    });
  }

  body.appendChild(grid);
  el.appendChild(head);
  el.appendChild(body);
  return el;
}

function applyOrderStyles() {
  const container = $("dashboard");
  if (!container) return;
  dashboardState.order.forEach((id, idx) => {
    const el = container.querySelector(`.widget[data-widget="${id}"]`);
    if (el) el.style.order = idx;
  });
}

async function renderDashboard() {
  if (isDragging) return;
  const container = $("dashboard");
  if (!container) return;

  const visible = dashboardState.order.filter((id) => id === "all" || currentUser);
  const dataMap = {};
  await Promise.all(visible.map(async (id) => { dataMap[id] = await fetchWidgetVideos(id); }));

  if (isDragging) return; // на случай, если перетаскивание началось, пока грузились данные
  container.innerHTML = "";
  visible.forEach((id, idx) => container.appendChild(buildWidgetEl(id, dataMap[id], idx)));
}

function startVideosPolling() {
  if (videosPollTimer) clearInterval(videosPollTimer);
  videosPollTimer = setInterval(() => { if (!isDragging) renderDashboard(); }, 6000);
}

/* ---------- клики по кнопкам управления виджетом ---------- */
$("dashboard")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const widgetEl = btn.closest(".widget");
  if (!widgetEl) return;
  const id = widgetEl.dataset.widget;
  const action = btn.dataset.action;

  if (action === "move-up" || action === "move-down") {
    const order = dashboardState.order;
    const i = order.indexOf(id);
    const j = action === "move-up" ? i - 1 : i + 1;
    if (j >= 0 && j < order.length) {
      [order[i], order[j]] = [order[j], order[i]];
      applyOrderStyles();
      saveDashboardState();
    }
  } else if (action === "cycle-span") {
    const cur = dashboardState.spans[id] || 3;
    const next = cur >= 3 ? 1 : cur + 1;
    dashboardState.spans[id] = next;
    widgetEl.style.setProperty("--span", next);
    btn.textContent = `⇔ ${next}/3`;
    saveDashboardState();
  } else if (action === "cycle-size") {
    const sizes = ["s", "m", "l"];
    const cur = dashboardState.sizes[id] || "m";
    const next = sizes[(sizes.indexOf(cur) + 1) % sizes.length];
    dashboardState.sizes[id] = next;
    const grid = widgetEl.querySelector(".video-grid");
    if (grid) grid.className = `video-grid density-${next}`;
    btn.textContent = next.toUpperCase();
    saveDashboardState();
  } else if (action === "clear-history") {
    if (!confirm("Очистить всю историю просмотров?")) return;
    api("/api/me/history", { method: "DELETE" }).then(() => renderDashboard()).catch(() => {});
  }
});

/* ---------- перетаскивание виджетов мышью/пальцем (Pointer Events) ---------- */
let dragCtx = null;

$("dashboard")?.addEventListener("pointerdown", (e) => {
  const handle = e.target.closest(".widget-drag");
  if (!handle) return;
  const widgetEl = handle.closest(".widget");
  if (!widgetEl) return;
  dragCtx = { id: widgetEl.dataset.widget };
  isDragging = true;
  document.body.classList.add("no-select");
  try { handle.setPointerCapture(e.pointerId); } catch (err) { /* игнор */ }
});

function onDashboardDragMove(e) {
  if (!dragCtx) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const overWidget = el && el.closest && el.closest(".widget");
  if (!overWidget) return;
  const overId = overWidget.dataset.widget;
  if (overId === dragCtx.id) return;
  const order = dashboardState.order;
  const from = order.indexOf(dragCtx.id);
  const to = order.indexOf(overId);
  if (from === -1 || to === -1) return;
  order.splice(from, 1);
  order.splice(to, 0, dragCtx.id);
  applyOrderStyles();
}

function onDashboardDragEnd() {
  if (!dragCtx) return;
  dragCtx = null;
  isDragging = false;
  document.body.classList.remove("no-select");
  saveDashboardState();
}

/* ---------- ПЛЕЕР: скорость, повтор, PiP, "смотреть позже", главы, прогресс ---------- */

function updateWatchLaterBtn(saved) {
  const btn = $("watch-later-btn");
  if (!btn) return;
  btn.classList.toggle("active", saved);
  btn.textContent = saved ? "✅ В списке" : "🔖 Позже";
}

function parseChapters(desc) {
  const lines = (desc || "").split(/\n/);
  const re = /^(\d{1,2}:)?(\d{1,2}):(\d{2})\s+(.+)$/;
  const chapters = [];
  lines.forEach((line) => {
    const trimmed = line.trim();
    const m = trimmed.match(re);
    if (m) {
      const h = m[1] ? parseInt(m[1]) : 0;
      const mm = parseInt(m[2]);
      const ss = parseInt(m[3]);
      chapters.push({ seconds: h * 3600 + mm * 60 + ss, label: m[4].trim(), time: trimmed.split(/\s+/)[0] });
    }
  });
  return chapters;
}

function renderChapters(chapters, vp) {
  const wrap = $("player-chapters");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!chapters.length) { wrap.style.display = "none"; return; }
  wrap.style.display = "flex";
  chapters.forEach((c) => {
    const btn = document.createElement("button");
    btn.className = "chapter-chip";
    btn.textContent = `${c.time} ${c.label}`;
    btn.addEventListener("click", () => { vp.currentTime = c.seconds; vp.play().catch(() => {}); });
    wrap.appendChild(btn);
  });
}

function startProgressTracking(videoId) {
  if (progressTimer) clearInterval(progressTimer);
  if (!currentUser) return;
  progressTimer = setInterval(() => {
    const vp = $("main-video-player");
    if (!vp || !vp.duration) return;
    api(`/api/videos/${videoId}/progress`, { method: "POST", body: { positionSec: vp.currentTime, durationSec: vp.duration } }).catch(() => {});
  }, 5000);
}

function stopProgressTracking() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
}

async function openPlayer(v, startAtOverride) {
  activeVideoId = v.id;
  currentVideoObj = v;
  setReplyTarget(null, "");
  if (new URLSearchParams(location.search).get("v") !== v.id) {
    history.pushState({ v: v.id }, "", `?v=${encodeURIComponent(v.id)}`);
  }
  const vp = $("main-video-player");

  let src = v.videoUrl;
  if (mainPlayer) {
    mainPlayer.setSrc(src);
    mainPlayer.reset();
  } else {
    vp.src = src;
    vp.loop = false;
    vp.playbackRate = 1;
  }

  $("player-video-title").textContent = v.title;
  const rawDesc = v.description || "";
  $("player-video-desc").textContent = rawDesc;
  $("player-video-author").textContent = "@" + v.authorUsername;
  if ($("player-video-avatar")) $("player-video-avatar").src = v.authorAvatarUrl || DEFAULT_AVATAR;

  renderChapters(parseChapters(rawDesc), vp);

  api(`/api/videos/${v.id}/view`, { method: "POST" }).catch(() => {});

  const likeBtn = $("like-btn");
  $("like-count").textContent = v.likesCount || 0;
  likeBtn.classList.toggle("liked", !!v.likedByMe);
  updateWatchLaterBtn(!!v.savedByMe);

  const subBtn = $("subscribe-btn");
  const subscribed = currentUser?.subscribedTo?.includes(v.authorId);
  subBtn.textContent = subscribed ? "Вы подписаны" : "Подписаться";
  subBtn.classList.toggle("subscribed", !!subscribed);
  subBtn.style.display = (currentUser && currentUser.id === v.authorId) ? "none" : "inline-block";

  likeBtn.onclick = async () => {
    if (!currentUser) { showAuthRequired(); return; }
    try {
      const data = await api(`/api/videos/${v.id}/like`, { method: "POST" });
      likeBtn.classList.toggle("liked", data.likedByMe);
      $("like-count").textContent = data.likesCount;
      likeBtn.classList.remove("like-pop");
      void likeBtn.offsetWidth;
      likeBtn.classList.add("like-pop");
    } catch (err) { alert(err.message); }
  };

  subBtn.onclick = async () => {
    if (!currentUser) { showAuthRequired(); return; }
    try {
      const data = await api(`/api/videos/${v.id}/subscribe`, { method: "POST" });
      subBtn.textContent = data.subscribed ? "Вы подписаны" : "Подписаться";
      subBtn.classList.toggle("subscribed", data.subscribed);
      currentUser.subscribedTo = currentUser.subscribedTo || [];
      if (data.subscribed) currentUser.subscribedTo.push(v.authorId);
      else currentUser.subscribedTo = currentUser.subscribedTo.filter((id) => id !== v.authorId);
    } catch (err) { alert(err.message); }
  };

  $("watch-later-btn").onclick = async () => {
    if (!currentUser) { showAuthRequired(); return; }
    try {
      const data = await api(`/api/videos/${v.id}/watch-later`, { method: "POST" });
      updateWatchLaterBtn(data.saved);
    } catch (err) { alert(err.message); }
  };

  const onLoadedMeta = () => {
    const resumeAt = startAtOverride != null ? startAtOverride : (v.resumeAt || 0);
    if (resumeAt > 5 && vp.duration && resumeAt < vp.duration - 5) vp.currentTime = resumeAt;
    vp.removeEventListener("loadedmetadata", onLoadedMeta);
  };
  vp.addEventListener("loadedmetadata", onLoadedMeta);

  startProgressTracking(v.id);

  await loadComments(v.id);
  if (commentsPollTimer) clearInterval(commentsPollTimer);
  commentsPollTimer = setInterval(() => loadComments(v.id), 4000);

  toggleModal("player-modal", true);
}

let replyToId = null;

function setReplyTarget(id, username) {
  replyToId = id;
  const wrap = $("reply-indicator");
  if (!wrap) return;
  if (id) {
    $("reply-indicator-name").textContent = "@" + username;
    wrap.hidden = false;
    $("new-comment-text").focus();
  } else {
    wrap.hidden = true;
  }
}

$("cancel-reply-btn")?.addEventListener("click", () => setReplyTarget(null, ""));

function commentItemHtml(c, isReply) {
  const mine = currentUser && c.authorId === currentUser.id;
  return `
    <div class="comment-item${isReply ? " comment-reply" : ""}" data-comment-id="${c.id}">
      <img class="comment-avatar" src="${c.authorAvatarUrl || DEFAULT_AVATAR}" alt="">
      <div class="comment-text-block">
        <div><b>@${escapeHtml(c.authorUsername)}</b> ${escapeHtml(c.text)}</div>
        <div class="comment-actions">
          ${!isReply ? `<button data-action="reply" data-id="${c.id}" data-user="${escapeHtml(c.authorUsername)}">Ответить</button>` : ""}
          ${mine ? `<button data-action="delete-comment" data-id="${c.id}">Удалить</button>` : ""}
        </div>
      </div>
    </div>`;
}

async function loadComments(videoId) {
  try {
    const data = await api(`/api/videos/${videoId}/comments`);
    const list = $("comments-list");
    list.innerHTML = "";
    const top = data.comments.filter((c) => !c.parentId);
    const byParent = {};
    data.comments.forEach((c) => {
      if (c.parentId) { (byParent[c.parentId] = byParent[c.parentId] || []).push(c); }
    });
    if (!top.length) {
      list.innerHTML = `<p class="widget-empty">Комментариев пока нет — станьте первым!</p>`;
      return;
    }
    top.forEach((c) => {
      list.insertAdjacentHTML("beforeend", commentItemHtml(c, false));
      (byParent[c.id] || []).forEach((r) => list.insertAdjacentHTML("beforeend", commentItemHtml(r, true)));
    });
  } catch (e) { /* тихо игнорируем сбой одного опроса */ }
}

$("comments-list")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  if (!currentUser) { showAuthRequired(); return; }

  if (btn.dataset.action === "reply") {
    setReplyTarget(btn.dataset.id, btn.dataset.user);
  } else if (btn.dataset.action === "delete-comment") {
    if (!confirm("Удалить этот комментарий?")) return;
    try {
      await api(`/api/videos/${activeVideoId}/comments/${btn.dataset.id}`, { method: "DELETE" });
      loadComments(activeVideoId);
    } catch (err) { alert(err.message); }
  }
});

$("send-comment-btn")?.addEventListener("click", async () => {
  if (!currentUser) { showAuthRequired(); return; }
  const input = $("new-comment-text");
  const text = input.value.trim();
  if (!text || !activeVideoId) return;

  try {
    await api(`/api/videos/${activeVideoId}/comments`, { method: "POST", body: { text, parentId: replyToId } });
    input.value = "";
    setReplyTarget(null, "");
    loadComments(activeVideoId);
  } catch (err) {
    alert(err.message);
  }
});

function closePlayerModal() {
  toggleModal("player-modal", false);
  if (commentsPollTimer) clearInterval(commentsPollTimer);
  stopProgressTracking();
  $("main-video-player").pause();
  $("main-video-player").src = "";
  if (new URLSearchParams(location.search).get("v")) {
    history.replaceState({}, "", location.pathname);
  }
}

document.querySelector(".close-player")?.addEventListener("click", closePlayerModal);

/* ---------- ПЛАВАЮЩИЙ МИНИ-ПЛЕЕР — можно перетащить в любое место экрана ---------- */

let miniActiveVideo = null;
let miniState = JSON.parse(localStorage.getItem("mtube_mini") || "null") || { x: null, y: null, w: 320 };

function positionMiniPlayer() {
  const el = $("mini-player");
  if (!el) return;
  if (miniState.x == null) miniState.x = window.innerWidth - miniState.w - 24;
  if (miniState.y == null) miniState.y = window.innerHeight - (miniState.w * 9 / 16) - 90;
  miniState.x = clamp(miniState.x, 4, Math.max(4, window.innerWidth - 80));
  miniState.y = clamp(miniState.y, 4, Math.max(4, window.innerHeight - 60));
  el.style.left = miniState.x + "px";
  el.style.top = miniState.y + "px";
  el.style.width = miniState.w + "px";
}

function saveMiniState() {
  localStorage.setItem("mtube_mini", JSON.stringify(miniState));
}

$("mini-player-expand")?.addEventListener("click", () => {
  if (!miniActiveVideo) return;
  const mini = $("mini-video");
  const t = mini.currentTime;
  mini.pause();
  mini.src = "";
  $("mini-player").hidden = true;
  openPlayer(miniActiveVideo, t);
});

$("mini-player-close")?.addEventListener("click", () => {
  const mini = $("mini-video");
  mini.pause();
  mini.src = "";
  $("mini-player").hidden = true;
  miniActiveVideo = null;
});

let miniDrag = null;
let miniResize = null;

$("mini-player-drag")?.addEventListener("pointerdown", (e) => {
  if (e.target.closest("button")) return;
  miniDrag = { startX: e.clientX, startY: e.clientY, origX: miniState.x, origY: miniState.y };
  try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* игнор */ }
});

$("mini-resize-handle")?.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  miniResize = { startX: e.clientX, origW: miniState.w };
  try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* игнор */ }
});

/* ---------- ОБЩИЙ ОБРАБОТЧИК УКАЗАТЕЛЯ: тащим либо виджет дашборда, либо ---------- */

document.addEventListener("pointermove", (e) => {
  if (dragCtx) onDashboardDragMove(e);

  if (miniDrag) {
    const dx = e.clientX - miniDrag.startX;
    const dy = e.clientY - miniDrag.startY;
    miniState.x = clamp(miniDrag.origX + dx, 4, window.innerWidth - 80);
    miniState.y = clamp(miniDrag.origY + dy, 4, window.innerHeight - 60);
    positionMiniPlayer();
  }

  if (miniResize) {
    const dx = e.clientX - miniResize.startX;
    miniState.w = clamp(miniResize.origW + dx, 220, Math.min(720, window.innerWidth - 32));
    positionMiniPlayer();
  }
});

document.addEventListener("pointerup", () => {
  if (dragCtx) onDashboardDragEnd();
  if (miniDrag) { miniDrag = null; saveMiniState(); }
  if (miniResize) { miniResize = null; saveMiniState(); }
});

window.addEventListener("resize", () => { if ($("mini-player") && !$("mini-player").hidden) positionMiniPlayer(); });

/* ---------- ЗАКРЫТИЕ МОДАЛОК ПО КЛИКУ НА ФОН ---------- */
window.onclick = (e) => {
  if (e.target.classList.contains("modal")) {
    if (e.target.id === "player-modal") closePlayerModal();
    else toggleModal(e.target.id, false);
  }
};

/* ---------- Боковое меню + свайп от левого края ---------- */
const drawerEl = $("faq-settings");
const drawerBackdrop = $("side-drawer-backdrop");
const faqToggleBtn = $("faq-toggle-btn");

function setDrawerOpen(open) {
  if (!drawerEl) return;
  drawerEl.classList.toggle("is-open", open);
  drawerBackdrop?.classList.toggle("is-open", open);
  faqToggleBtn?.setAttribute("aria-expanded", open ? "true" : "false");
}
// Оставляем прежнее имя функции — используется в других обработчиках ниже
const setFaqOpen = setDrawerOpen;

faqToggleBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  setDrawerOpen(!drawerEl.classList.contains("is-open"));
});
$("side-drawer-close")?.addEventListener("click", () => setDrawerOpen(false));
drawerBackdrop?.addEventListener("click", () => setDrawerOpen(false));

drawerEl?.querySelectorAll(".side-drawer-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    // reset-layout-btn и open-* обработчики сами закрывают меню там, где
    // нужно; здесь просто закрываем его для ссылок вроде FAQ
    if (tab.id !== "reset-layout-btn" && tab.id !== "open-upload-modal" &&
        tab.id !== "open-donate-modal" && tab.id !== "open-ads-modal") {
      setDrawerOpen(false);
    }
  });
});

$("open-donate-modal")?.addEventListener("click", () => setDrawerOpen(false));

// Свайп от левого края экрана вправо — открывает меню; свайп влево на
// открытом меню — закрывает его. Работает через Pointer Events, поэтому
// одинаково реагирует и на палец, и на мышь.
(function setupEdgeSwipe() {
  const EDGE_ZONE_PX = 24;
  const OPEN_THRESHOLD_PX = 60;
  let swipe = null; // { startX, startY, dragging, fromEdge }

  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return; // жест только для тача
    const isOpen = drawerEl?.classList.contains("is-open");
    const fromEdge = e.clientX <= EDGE_ZONE_PX;
    if (!fromEdge && !isOpen) return;
    if (isOpen && !drawerEl.contains(e.target) && e.clientX > drawerEl.getBoundingClientRect().width) return;
    swipe = { startX: e.clientX, startY: e.clientY, dragging: false, fromEdge, wasOpen: isOpen };
  });

  document.addEventListener("pointermove", (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.startX;
    const dy = e.clientY - swipe.startY;
    if (!swipe.dragging) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dy) > Math.abs(dx)) { swipe = null; return; } // это вертикальный скролл, не наш жест
      swipe.dragging = true;
      drawerEl?.classList.add("is-dragging");
    }
    if (!drawerEl) return;
    const width = drawerEl.getBoundingClientRect().width || 300;
    if (swipe.wasOpen) {
      // Меню уже открыто — тащим влево, чтобы закрыть
      drawerEl.style.transform = `translateX(${clamp(dx, -width, 0)}px)`;
    } else {
      // Меню закрыто, свайп начался у левого края — тащим вправо, чтобы открыть
      drawerEl.style.transform = `translateX(${clamp(dx - width, -width, 0)}px)`;
    }
    drawerBackdrop?.classList.add("is-open");
  });

  document.addEventListener("pointerup", (e) => {
    if (!swipe) return;
    if (swipe.dragging && drawerEl) {
      const dx = e.clientX - swipe.startX;
      drawerEl.classList.remove("is-dragging");
      drawerEl.style.transform = "";
      const width = drawerEl.getBoundingClientRect().width || 300;
      if (swipe.wasOpen) setDrawerOpen(dx > -OPEN_THRESHOLD_PX);
      else setDrawerOpen(dx > OPEN_THRESHOLD_PX);
    }
    swipe = null;
  });
})();

document.addEventListener("click", (e) => {
  if (drawerEl && drawerEl.classList.contains("is-open") &&
      !drawerEl.contains(e.target) && e.target !== faqToggleBtn && !faqToggleBtn?.contains(e.target)) {
    setDrawerOpen(false);
  }
});

/* ---------- Горячие клавиши плеера (как в YouTube) + Escape для модалок ---------- */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    setFaqOpen(false);
    ["register-modal", "upload-modal", "profile-settings-modal", "share-modal", "donate-modal", "ads-modal", "admin-edit-user-modal", "admin-edit-video-modal"].forEach((id) => {
      const el = $(id);
      if (el && el.style.display === "flex") toggleModal(id, false);
    });
    if ($("player-modal")?.style.display === "flex") closePlayerModal();
    return;
  }

  const playerOpen = $("player-modal")?.style.display === "flex";
  if (!playerOpen) return;
  if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return; // не мешаем печатать комментарий

  const vp = $("main-video-player");
  if (!vp) return;
  const key = e.key.toLowerCase();

  if (key === " " || key === "k") { e.preventDefault(); vp.paused ? vp.play() : vp.pause(); }
  else if (key === "arrowleft") vp.currentTime = Math.max(0, vp.currentTime - 5);
  else if (key === "arrowright") vp.currentTime = Math.min(vp.duration || 1e9, vp.currentTime + 5);
  else if (key === "j") vp.currentTime = Math.max(0, vp.currentTime - 10);
  else if (key === "l") vp.currentTime = Math.min(vp.duration || 1e9, vp.currentTime + 10);
  else if (key === "arrowup") { e.preventDefault(); vp.volume = Math.min(1, vp.volume + 0.1); }
  else if (key === "arrowdown") { e.preventDefault(); vp.volume = Math.max(0, vp.volume - 0.1); }
  else if (key === "m") vp.muted = !vp.muted;
  else if (key === "f") { if (vp.requestFullscreen) vp.requestFullscreen(); }
  else if (key === ",") vp.playbackRate = Math.max(0.25, vp.playbackRate - 0.25);
  else if (key === ".") vp.playbackRate = Math.min(2, vp.playbackRate + 0.25);
});

window.addEventListener("popstate", () => {
  const id = new URLSearchParams(location.search).get("v");
  if (!id && $("player-modal")?.style.display === "flex") closePlayerModal();
});

/* ---------- Прямые ссылки на видео: сайт.ru/?v=ID или /watch/ID открывает плеер сразу ---------- */
function sharedVideoIdFromLocation() {
  if (window.__MTUBE_VIDEO_ID) return window.__MTUBE_VIDEO_ID;
  const fromQuery = new URLSearchParams(location.search).get("v");
  if (fromQuery) return fromQuery;
  const pathMatch = location.pathname.match(/^\/watch\/([^/]+)/);
  return pathMatch ? decodeURIComponent(pathMatch[1]) : null;
}

async function openSharedVideoFromUrl() {
  const id = sharedVideoIdFromLocation();
  if (!id) return;
  try {
    const data = await api(`/api/videos/${encodeURIComponent(id)}`);
    openPlayer(data.video);
  } catch (e) { /* видео не найдено/удалено — просто показываем ленту */ }
}

/* ---------- СТАРТ ---------- */
(async function init() {
  await checkServer();
  await loadMe();
  await loadSettings();
  loadDashboardState();
  applyAccentPreference();
  await loadTags();
  await renderDashboard();
  startVideosPolling();
  openSharedVideoFromUrl();
})();
