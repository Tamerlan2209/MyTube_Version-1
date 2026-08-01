/* =============================================================
   MyTube — CTP (Custom Tube Player)
   Собственный видеоплеер поверх обычного <video>: своя шкала с
   буфером и превью времени, громкость, скорость, повтор, PiP,
   театральный режим, полноэкранный режим, двойной тап/клик для
   перемотки ±10 сек, автоскрытие панели. Используется и на самом
   сайте (в плеере видео), и на отдельной странице встраивания
   /embed/:id — то есть это один и тот же код для обоих мест.
   ============================================================= */

function mountCustomPlayer(rootEl, opts) {
  opts = Object.assign({
    features: { theater: true, minimize: true, share: true, pip: true },
    onMinimize: null,
    onShare: null,
    videoId: null
  }, opts || {});

  rootEl.classList.add("ctp-root");

  let video = opts.videoId ? document.getElementById(opts.videoId) : rootEl.querySelector("video");
  if (!video) {
    video = document.createElement("video");
    rootEl.appendChild(video);
  }
  video.classList.add("ctp-video");
  video.removeAttribute("controls");
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.preload = video.preload || "metadata";

  const overlay = document.createElement("div");
  overlay.className = "ctp-overlay";
  overlay.innerHTML = `
    <div class="ctp-skip-flash ctp-skip-left"><svg viewBox="0 0 24 24"><path d="M11.99 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg><span>10</span></div>
    <div class="ctp-skip-flash ctp-skip-right"><svg viewBox="0 0 24 24"><path d="M12.01 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z" transform="scale(-1,1) translate(-24,0)"/></svg><span>10</span></div>
    <div class="ctp-spinner"></div>
    <button class="ctp-big-play" aria-label="Пуск / пауза" type="button">
      <svg viewBox="0 0 24 24" class="ic-play"><path d="M8 5v14l11-7z"/></svg>
      <svg viewBox="0 0 24 24" class="ic-pause" hidden><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
    </button>
  `;
  rootEl.appendChild(overlay);

  const bar = document.createElement("div");
  bar.className = "ctp-controls";
  bar.innerHTML = `
    <div class="ctp-progress" tabindex="0">
      <div class="ctp-progress-track">
        <div class="ctp-progress-buffered"></div>
        <div class="ctp-progress-played"></div>
        <div class="ctp-progress-thumb"></div>
      </div>
      <div class="ctp-hover-time" hidden>0:00</div>
    </div>
    <div class="ctp-row">
      <button class="ctp-btn ctp-play" type="button" title="Пауза/Пуск (Space)">
        <svg viewBox="0 0 24 24" class="ic-play"><path d="M8 5v14l11-7z"/></svg>
        <svg viewBox="0 0 24 24" class="ic-pause" hidden><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
      </button>
      <div class="ctp-volume">
        <button class="ctp-btn ctp-mute" type="button" title="Звук (M)">
          <svg viewBox="0 0 24 24" class="ic-vol-hi"><path d="M3 10v4h4l5 5V5L7 10H3z"/><path d="M16.5 12a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4z"/><path d="M14 4.3v2.06c2.9.86 5 3.54 5 6.64s-2.1 5.78-5 6.64v2.06c4.01-.91 7-4.49 7-8.7s-2.99-7.79-7-8.7z"/></svg>
          <svg viewBox="0 0 24 24" class="ic-vol-mute" hidden><path d="M12 4L9.91 6.09 12 8.18V4zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73 4.27 3zm14.5 9c0-1.77-1-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.42.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71z"/></svg>
        </button>
        <input type="range" class="ctp-vol-slider" min="0" max="1" step="0.05" value="1">
      </div>
      <span class="ctp-time"><span class="ctp-time-cur">0:00</span><span class="ctp-time-sep">/</span><span class="ctp-time-dur">0:00</span></span>
      <div class="ctp-spacer"></div>
      <div class="ctp-menu-wrap ctp-settings-wrap">
        <button class="ctp-btn ctp-settings" type="button" title="Настройки">
          <svg viewBox="0 0 24 24"><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
        <div class="ctp-menu ctp-settings-menu" hidden>
          <div class="ctp-menu-title">Скорость воспроизведения</div>
          <div class="ctp-speed-grid">
            ${[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((s) => `<button type="button" class="ctp-speed-opt${s === 1 ? " active" : ""}" data-speed="${s}">${s}×</button>`).join("")}
          </div>
          <button type="button" class="ctp-menu-toggle ctp-loop-toggle">
            <span>Повтор видео</span><span class="ctp-toggle-dot"></span>
          </button>
        </div>
      </div>
      ${opts.features.pip !== false ? `<button class="ctp-btn ctp-pip" type="button" title="Картинка в картинке">
        <svg viewBox="0 0 24 24"><path d="M19 11h-8v6h8v-6zM21 3H3a2 2 0 00-2 2v14a2 2 0 002 2h18a2 2 0 002-2V5a2 2 0 00-2-2zm0 16H3V5h18v14z"/></svg>
      </button>` : ""}
      ${opts.features.share !== false ? `<button class="ctp-btn ctp-share" type="button" title="Поделиться">
        <svg viewBox="0 0 24 24"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81a3 3 0 10-3-3c0 .24.04.47.09.7L8.04 9.81A3 3 0 105 12c0 .24.04.47.09.7L5 9.81a3 3 0 103 3.7l7.13 4.16c-.05.21-.08.43-.08.65a3 3 0 103-3.24z"/></svg>
      </button>` : ""}
      ${opts.features.theater !== false ? `<button class="ctp-btn ctp-theater" type="button" title="Театральный режим">
        <svg viewBox="0 0 24 24"><path d="M19 7H5a2 2 0 00-2 2v6a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2zm0 8H5V9h14v6z"/></svg>
      </button>` : ""}
      ${opts.features.minimize !== false ? `<button class="ctp-btn ctp-minimize" type="button" title="Свернуть в мини-плеер">
        <svg viewBox="0 0 24 24"><path d="M19 13H5v-2h14v2z"/></svg>
      </button>` : ""}
      <button class="ctp-btn ctp-fullscreen" type="button" title="На весь экран (F)">
        <svg viewBox="0 0 24 24" class="ic-fs-open"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
        <svg viewBox="0 0 24 24" class="ic-fs-close" hidden><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>
      </button>
    </div>
  `;
  rootEl.appendChild(bar);

  const els = {
    bigPlay: overlay.querySelector(".ctp-big-play"),
    skipL: overlay.querySelector(".ctp-skip-left"),
    skipR: overlay.querySelector(".ctp-skip-right"),
    progress: bar.querySelector(".ctp-progress"),
    played: bar.querySelector(".ctp-progress-played"),
    buffered: bar.querySelector(".ctp-progress-buffered"),
    thumb: bar.querySelector(".ctp-progress-thumb"),
    hoverTime: bar.querySelector(".ctp-hover-time"),
    playBtn: bar.querySelector(".ctp-play"),
    muteBtn: bar.querySelector(".ctp-mute"),
    volSlider: bar.querySelector(".ctp-vol-slider"),
    timeCur: bar.querySelector(".ctp-time-cur"),
    timeDur: bar.querySelector(".ctp-time-dur"),
    settingsBtn: bar.querySelector(".ctp-settings"),
    settingsMenu: bar.querySelector(".ctp-settings-menu"),
    speedOpts: [...bar.querySelectorAll(".ctp-speed-opt")],
    loopToggle: bar.querySelector(".ctp-loop-toggle"),
    pipBtn: bar.querySelector(".ctp-pip"),
    shareBtn: bar.querySelector(".ctp-share"),
    theaterBtn: bar.querySelector(".ctp-theater"),
    minimizeBtn: bar.querySelector(".ctp-minimize"),
    fullscreenBtn: bar.querySelector(".ctp-fullscreen")
  };

  const fmt = (sec) => {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = h ? String(m).padStart(2, "0") : String(m);
    return (h ? h + ":" : "") + mm + ":" + String(s).padStart(2, "0");
  };

  function setPlayIcon(playing) {
    [els.bigPlay, els.playBtn].forEach((btn) => {
      btn.querySelector(".ic-play").hidden = playing;
      btn.querySelector(".ic-pause").hidden = !playing;
    });
  }

  function togglePlay() {
    if (video.paused || video.ended) video.play().catch(() => {});
    else video.pause();
  }

  video.addEventListener("play", () => { setPlayIcon(true); scheduleIdle(); });
  video.addEventListener("pause", () => { setPlayIcon(false); showControls(); });
  video.addEventListener("waiting", () => rootEl.classList.add("ctp-buffering"));
  video.addEventListener("playing", () => rootEl.classList.remove("ctp-buffering"));
  video.addEventListener("canplay", () => rootEl.classList.remove("ctp-buffering"));
  video.addEventListener("loadedmetadata", () => { els.timeDur.textContent = fmt(video.duration); });

  video.addEventListener("timeupdate", () => {
    if (!video.duration || scrubbing) return;
    els.timeCur.textContent = fmt(video.currentTime);
    const pct = (video.currentTime / video.duration) * 100;
    els.played.style.width = pct + "%";
    els.thumb.style.left = pct + "%";
  });

  video.addEventListener("progress", () => {
    if (!video.duration || !video.buffered.length) return;
    try {
      const end = video.buffered.end(video.buffered.length - 1);
      els.buffered.style.width = Math.min(100, (end / video.duration) * 100) + "%";
    } catch (e) { /* игнор */ }
  });

  video.addEventListener("volumechange", () => {
    els.volSlider.value = video.muted ? 0 : video.volume;
    const isMuted = video.muted || video.volume === 0;
    els.muteBtn.querySelector(".ic-vol-hi").hidden = isMuted;
    els.muteBtn.querySelector(".ic-vol-mute").hidden = !isMuted;
  });

  els.bigPlay.addEventListener("click", togglePlay);
  els.playBtn.addEventListener("click", togglePlay);
  els.muteBtn.addEventListener("click", () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = 0.5;
  });
  els.volSlider.addEventListener("input", () => {
    video.volume = parseFloat(els.volSlider.value);
    video.muted = video.volume === 0;
  });

  /* ---------- перемотка по шкале (клик/перетаскивание, мышь и палец) ---------- */
  let scrubbing = false;
  function pctFromEvent(e) {
    const rect = els.progress.getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
    return Math.min(1, Math.max(0, x / rect.width));
  }
  function updateHover(e) {
    if (!video.duration) return;
    const pct = pctFromEvent(e);
    els.hoverTime.style.left = (pct * 100) + "%";
    els.hoverTime.textContent = fmt(pct * video.duration);
    els.hoverTime.hidden = false;
  }
  els.progress.addEventListener("mousemove", updateHover);
  els.progress.addEventListener("mouseleave", () => { if (!scrubbing) els.hoverTime.hidden = true; });

  function startScrub(e) {
    scrubbing = true;
    moveScrub(e);
    document.addEventListener("mousemove", moveScrub);
    document.addEventListener("touchmove", moveScrub, { passive: false });
    document.addEventListener("mouseup", endScrub);
    document.addEventListener("touchend", endScrub);
  }
  function moveScrub(e) {
    if (!video.duration) return;
    if (e.cancelable) e.preventDefault();
    const pct = pctFromEvent(e);
    els.played.style.width = (pct * 100) + "%";
    els.thumb.style.left = (pct * 100) + "%";
    updateHover(e);
    video.currentTime = pct * video.duration;
  }
  function endScrub() {
    scrubbing = false;
    els.hoverTime.hidden = true;
    document.removeEventListener("mousemove", moveScrub);
    document.removeEventListener("touchmove", moveScrub);
    document.removeEventListener("mouseup", endScrub);
    document.removeEventListener("touchend", endScrub);
  }
  els.progress.addEventListener("mousedown", startScrub);
  els.progress.addEventListener("touchstart", startScrub, { passive: true });

  /* ---------- двойной клик/тап слева-справа = перемотка ±10 сек ---------- */
  let lastTap = 0;
  video.addEventListener("click", (e) => {
    const now = Date.now();
    if (now - lastTap < 320) {
      const rect = rootEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < rect.width * 0.4) skip(-10, "left");
      else if (x > rect.width * 0.6) skip(10, "right");
      else togglePlay();
    }
    lastTap = now;
  });
  function skip(delta, side) {
    video.currentTime = Math.min(video.duration || 1e9, Math.max(0, video.currentTime + delta));
    const flash = side === "left" ? els.skipL : els.skipR;
    flash.classList.remove("show");
    void flash.offsetWidth;
    flash.classList.add("show");
  }

  /* ---------- настройки: скорость + повтор ---------- */
  els.settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    els.settingsMenu.hidden = !els.settingsMenu.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!els.settingsMenu.hidden && !bar.contains(e.target)) els.settingsMenu.hidden = true;
  });
  els.speedOpts.forEach((btn) => btn.addEventListener("click", () => {
    video.playbackRate = parseFloat(btn.dataset.speed);
    els.speedOpts.forEach((b) => b.classList.toggle("active", b === btn));
  }));
  els.loopToggle.addEventListener("click", () => {
    video.loop = !video.loop;
    els.loopToggle.classList.toggle("active", video.loop);
  });

  /* ---------- картинка в картинке ---------- */
  if (els.pipBtn) {
    if (!("pictureInPictureEnabled" in document) || !document.pictureInPictureEnabled) {
      els.pipBtn.hidden = true;
    } else {
      els.pipBtn.addEventListener("click", async () => {
        try {
          if (document.pictureInPictureElement) await document.exitPictureInPicture();
          else await video.requestPictureInPicture();
        } catch (e) { /* браузер отказал — тихо игнорируем */ }
      });
    }
  }

  /* ---------- театральный режим ---------- */
  if (els.theaterBtn) {
    els.theaterBtn.addEventListener("click", () => {
      const on = rootEl.classList.toggle("ctp-theater-on");
      document.body.classList.toggle("ctp-theater-active", on);
    });
  }

  /* ---------- полноэкранный режим всего контейнера (панель остаётся видна) ---------- */
  function syncFsIcon() {
    const isFs = !!document.fullscreenElement;
    els.fullscreenBtn.querySelector(".ic-fs-open").hidden = isFs;
    els.fullscreenBtn.querySelector(".ic-fs-close").hidden = !isFs;
  }
  els.fullscreenBtn.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else rootEl.requestFullscreen?.().catch(() => {});
  });
  document.addEventListener("fullscreenchange", syncFsIcon);

  if (els.shareBtn) els.shareBtn.addEventListener("click", () => opts.onShare && opts.onShare());
  if (els.minimizeBtn) els.minimizeBtn.addEventListener("click", () => opts.onMinimize && opts.onMinimize());

  /* ---------- автоскрытие панели, пока идёт воспроизведение ---------- */
  let idleTimer = null;
  function showControls() { rootEl.classList.remove("ctp-idle"); }
  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (video.paused) return;
    idleTimer = setTimeout(() => {
      if (!video.paused && els.settingsMenu.hidden) rootEl.classList.add("ctp-idle");
    }, 2600);
  }
  rootEl.addEventListener("mousemove", () => { showControls(); scheduleIdle(); });
  rootEl.addEventListener("mouseleave", () => { if (!video.paused) rootEl.classList.add("ctp-idle"); });
  rootEl.addEventListener("touchstart", () => { showControls(); scheduleIdle(); }, { passive: true });

  els.volSlider.value = video.volume;

  return {
    video,
    setSrc(src, poster) {
      video.pause();
      video.src = src;
      if (poster) video.poster = poster;
      els.played.style.width = "0%";
      els.thumb.style.left = "0%";
      els.buffered.style.width = "0%";
      els.timeCur.textContent = "0:00";
      els.timeDur.textContent = "0:00";
    },
    reset() {
      video.playbackRate = 1;
      video.loop = false;
      els.speedOpts.forEach((b) => b.classList.toggle("active", b.dataset.speed === "1"));
      els.loopToggle.classList.remove("active");
      rootEl.classList.remove("ctp-theater-on");
      document.body.classList.remove("ctp-theater-active");
    },
    destroy() {
      overlay.remove();
      bar.remove();
    }
  };
}

window.mountCustomPlayer = mountCustomPlayer;
