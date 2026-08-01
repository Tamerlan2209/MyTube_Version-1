/* =============================================================
   MyTube — логика страницы встраивания (/embed/:id)
   Отдельная лёгкая страница: получает id видео из адреса, тянет
   данные с того же сервера и показывает видео в собственном
   плеере (player.js), без остального интерфейса сайта.
   ============================================================= */

(function () {
  const DEFAULT_AVATAR = "./images/default-avatar.svg";
  const wrap = document.getElementById("embed-wrap");
  const loadingEl = document.getElementById("embed-loading");
  const badge = document.getElementById("embed-badge");

  function videoIdFromUrl() {
    const parts = location.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("embed");
    if (idx >= 0 && parts[idx + 1]) return decodeURIComponent(parts[idx + 1]);
    return new URLSearchParams(location.search).get("v");
  }

  async function init() {
    const id = videoIdFromUrl();
    if (!id) {
      loadingEl.textContent = "Не указано видео для встраивания.";
      return;
    }

    let video;
    try {
      const res = await fetch(`/api/videos/${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Видео не найдено");
      video = data.video;
    } catch (e) {
      loadingEl.textContent = "⚠️ " + (e.message || "Видео не найдено или сервер недоступен.");
      return;
    }

    loadingEl.remove();

    const videoEl = document.createElement("video");
    videoEl.id = "embed-video";
    videoEl.playsInline = true;
    videoEl.setAttribute("webkit-playsinline", "");
    wrap.insertBefore(videoEl, badge);

    const player = mountCustomPlayer(wrap, {
      videoId: "embed-video",
      features: { theater: false, minimize: false, share: false, pip: true }
    });
    player.setSrc(video.videoUrl);

    document.getElementById("embed-title").textContent = video.title;
    document.getElementById("embed-avatar").src = video.authorAvatarUrl || DEFAULT_AVATAR;
    badge.href = `./index.html?v=${encodeURIComponent(video.id)}`;
    badge.hidden = false;
    document.title = video.title + " — MyTube";

    fetch(`/api/videos/${encodeURIComponent(video.id)}/view`, { method: "POST" }).catch(() => {});

    document.addEventListener("keydown", (e) => {
      if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
      const key = e.key.toLowerCase();
      if (key === " " || key === "k") { e.preventDefault(); videoEl.paused ? videoEl.play() : videoEl.pause(); }
      else if (key === "arrowleft") videoEl.currentTime = Math.max(0, videoEl.currentTime - 5);
      else if (key === "arrowright") videoEl.currentTime = Math.min(videoEl.duration || 1e9, videoEl.currentTime + 5);
      else if (key === "arrowup") { e.preventDefault(); videoEl.volume = Math.min(1, videoEl.volume + 0.1); }
      else if (key === "arrowdown") { e.preventDefault(); videoEl.volume = Math.max(0, videoEl.volume - 0.1); }
      else if (key === "m") videoEl.muted = !videoEl.muted;
      else if (key === "f") { document.fullscreenElement ? document.exitFullscreen() : wrap.requestFullscreen?.(); }
    });
  }

  init();
})();
