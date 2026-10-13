const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
let activeView = "home";
let selectedReelId = null;
let activeTab = "all";
let sortMode = "latest";
let editMode = false;
let originalMode = false;
let currentReel = null;
let selectedScriptId = null;
let selectedCompetitorId = null;

const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const nl2br = (value = "") => escapeHtml(value).replace(/\n/g, "<br>");
const duration = (seconds = 0) => `${Math.floor(Number(seconds) / 60)}:${String(Number(seconds) % 60).padStart(2, "0")}`;
const compact = (value = 0) => new Intl.NumberFormat("ru", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value));
const dateTime = (value) => value ? new Date(value).toLocaleString("ru", { dateStyle: "short", timeStyle: "short" }) : "—";

function relativeTime(value) {
  if (!value) return "ещё не обновлялся";
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const attempts = method === "GET" ? 3 : 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(path, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers || {}) }
      });
      if (response.status === 204) return null;
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload.error || `Ошибка API: ${response.status}`);
        error.retryable = response.status >= 500;
        throw error;
      }
      return payload.data;
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || error.retryable === false) break;
      await new Promise((resolve) => setTimeout(resolve, 650 * (attempt + 1)));
    }
  }
  throw new Error(lastError?.message === "Failed to fetch" ? "Сервер просыпается или соединение прервалось" : lastError?.message || "Не удалось связаться с сервером");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function loading() {
  app.innerHTML = `<div class="loading">Загружаем данные — бесплатный сервер может просыпаться до минуты</div>`;
}

function pageHead(title, subtitle, action = "") {
  return `<header class="page-head"><div><h1>${title}</h1><p class="subtitle">${subtitle}</p></div>${action}</header>`;
}

async function setView(view) {
  activeView = view;
  if (view === "home") activeTab = "all";
  if (view === "favorites") activeTab = "favorite";
  if (view === "scripts") activeTab = "scripts";
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  loading();
  try {
    if (view === "home" || view === "favorites") await renderHome(view === "favorites");
    if (view === "competitors") await renderCompetitors();
    if (view === "scripts") await renderScripts();
    if (view === "remix") await renderRemix();
    if (view === "script-editor") await renderScriptEditor();
  } catch (error) {
    app.innerHTML = `<section class="page"><div class="empty error-state"><strong>Не удалось загрузить данные</strong><p>${escapeHtml(error.message)}</p><button class="button primary" id="retry-view">Повторить</button></div></section>`;
    document.querySelector("#retry-view")?.addEventListener("click", () => setView(view));
  }
  app.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function reelCard(reel) {
  const mediaLabel = reel.media_status === "stored" ? "Сохранено" : reel.video_url ? "Видео" : "Оригинал";
  return `<article class="reel-card" data-card-id="${reel.id}" data-source-url="${escapeHtml(reel.source_url)}">
    <div class="reel-cover interactive" data-remix="${reel.id}" role="button" tabindex="0" aria-label="Открыть ${escapeHtml(reel.title)}">
      <img src="${escapeHtml(reel.thumbnail_url)}" alt="Превью: ${escapeHtml(reel.title)}" loading="lazy" data-fallback><span class="media-pill ${escapeHtml(reel.media_status || "missing")}">${mediaLabel}</span><span class="duration">${duration(reel.duration_seconds)}</span>
    </div>
    <h2 class="reel-title">${escapeHtml(reel.title)}</h2><p class="handle">${escapeHtml(reel.instagram_handle || "")}</p>
    <p class="metrics"><span>▷ ${compact(reel.views_count)}</span><span>♡ ${compact(reel.likes_count)}</span></p>
    <div class="card-actions"><button class="remix-button" data-remix="${reel.id}"><span>✦</span> Ремикс</button><button class="more" data-menu="${reel.id}" aria-label="Другие действия">${icon("more")}</button></div>
  </article>`;
}

async function renderHome(onlyFavorites = false) {
  const query = new URLSearchParams({ sort: sortMode });
  const favoriteQuery = new URLSearchParams({ sort: sortMode, favorite: "true" });
  const [allReels, favoriteReels, scripts] = await Promise.all([
    api(`/api/reels?${query}`), api(`/api/reels?${favoriteQuery}`), api("/api/scripts")
  ]);
  const reels = onlyFavorites ? favoriteReels : allReels;
  app.innerHTML = `<section class="page">
    ${pageHead(onlyFavorites ? "Избранное" : "Главная", onlyFavorites ? "Сохранённые идеи для будущих сценариев" : "Все собранные рилс из аккаунтов конкурентов", `<button class="button primary" data-view="competitors">${icon("plus")}<span>Добавить конкурента</span></button>`)}
    <div class="toolbar">
      <div class="tabs" role="tablist">
        <button class="tab ${activeTab === "all" ? "active" : ""}" data-tab="all">Все рилс <strong>${allReels.length}</strong></button>
        <button class="tab ${activeTab === "favorite" ? "active" : ""}" data-tab="favorite">Избранное <strong>${favoriteReels.length}</strong></button>
        <button class="tab ${activeTab === "scripts" ? "active" : ""}" data-tab="scripts">Мои сценарии <strong>${scripts.length}</strong></button>
      </div>
      <label class="search-wrap">${icon("search")}<input id="reel-search" type="search" placeholder="Поиск по заголовку, аккаунту..." aria-label="Поиск рилс"></label>
      <button class="icon-button" id="sort-reels" aria-label="Сортировка" title="${sortMode === "latest" ? "Сначала новые" : "Сначала популярные"}">${icon("sliders")}</button>
    </div>
    <div class="reel-grid" id="reel-grid">${reels.length ? reels.map(reelCard).join("") : `<div class="empty">Здесь пока нет рилсов.</div>`}</div>
  </section>`;
  bindPageEvents();
  const search = document.querySelector("#reel-search");
  search.addEventListener("input", () => {
    const queryText = search.value.trim().toLowerCase();
    const filtered = reels.filter((reel) => `${reel.title} ${reel.instagram_handle}`.toLowerCase().includes(queryText));
    document.querySelector("#reel-grid").innerHTML = filtered.length ? filtered.map(reelCard).join("") : `<div class="empty">Ничего не найдено.</div>`;
    bindReelActions();
  });
  document.querySelector("#sort-reels").addEventListener("click", () => {
    sortMode = sortMode === "latest" ? "views" : "latest";
    showToast(sortMode === "views" ? "Сортировка по просмотрам" : "Сортировка по дате");
    renderHome(onlyFavorites);
  });
}

function openCardMenu(button, reelId) {
  document.querySelectorAll(".action-menu").forEach((menu) => menu.remove());
  const card = button.closest(".reel-card");
  const menu = document.createElement("div");
  menu.className = "action-menu";
  menu.innerHTML = `<button data-favorite="${reelId}">☆ Добавить / убрать избранное</button><a href="${escapeHtml(card.dataset.sourceUrl)}" target="_blank" rel="noopener noreferrer">${icon("external")} Открыть оригинал</a>`;
  card.querySelector(".card-actions").append(menu);
  menu.querySelector("[data-favorite]").addEventListener("click", async () => {
    const reel = await api(`/api/reels/${reelId}`);
    await api(`/api/reels/${reelId}`, { method: "PATCH", body: JSON.stringify({ is_favorite: !reel.is_favorite }) });
    showToast(reel.is_favorite ? "Удалено из избранного" : "Добавлено в избранное");
    renderHome(activeView === "favorites");
  });
}

function bindReelActions() {
  app.querySelectorAll("[data-remix]").forEach((element) => {
    const open = () => { selectedReelId = Number(element.dataset.remix); editMode = false; originalMode = false; setView("remix"); };
    element.addEventListener("click", open);
    element.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") open(); });
  });
  app.querySelectorAll("[data-menu]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    openCardMenu(button, Number(button.dataset.menu));
  }));
}

async function renderCompetitors() {
  const [competitors, reels] = await Promise.all([api("/api/competitors"), api("/api/reels?sort=latest")]);
  const active = new Set(["queued", "running", "importing"]);
  const statusInfo = (competitor) => {
    const map = {
      queued: ["В очереди", "active", "Задача ожидает запуска"],
      running: ["Собираем рилсы", "active", "Apify получает данные из Instagram"],
      importing: ["Сохраняем", "active", "Записываем результат в PostgreSQL"],
      succeeded: ["Готово", "success", `${competitor.sync_imported_count || 0} рилсов импортировано`],
      partial: ["Частично", "warning", `${competitor.sync_imported_count || 0} импортировано, ${competitor.sync_skipped_count || 0} пропущено`],
      failed: ["Ошибка", "error", competitor.sync_error || "Загрузка не завершилась"]
    };
    return map[competitor.sync_status] || ["Не запускалась", "muted", "Нажмите «Обновить», чтобы получить рилсы"];
  };
  const filteredReels = selectedCompetitorId
    ? reels.filter((reel) => String(reel.competitor_id) === String(selectedCompetitorId))
    : reels;
  const selectedCompetitor = competitors.find((competitor) => String(competitor.id) === String(selectedCompetitorId));
  const storedTotal = reels.filter((reel) => reel.media_status === "stored").length;
  const temporaryTotal = reels.filter((reel) => reel.media_status === "external").length;
  const hourlyRemaining = competitors[0]?.sync_hourly_remaining ?? 3;
  const mediaStatus = (status) => ({ stored: ["Сохранено", "success"], external: ["Временная ссылка", "info"], storing: ["Сохраняется", "active"], failed: ["Ошибка видео", "error"], missing: ["Только оригинал", "warning"] })[status] || ["Неизвестно", "muted"];
  app.innerHTML = `<section class="page">
    ${pageHead("Конкуренты", "Добавляйте Instagram аккаунты и собирайте их последние рилс")}
    <div class="overview-grid">
      <article><span>Конкуренты</span><strong>${competitors.length}</strong><small>из 10 на тестовом стенде</small></article>
      <article><span>Рилсы в базе</span><strong>${reels.length}</strong><small>${storedTotal} сохранено · ${temporaryTotal} временных</small></article>
      <article><span>Бесплатные импорты</span><strong>${hourlyRemaining}</strong><small>осталось в текущем часу</small></article>
    </div>
    <form class="fetch-panel" id="competitor-form"><div class="url-field"><input class="url-input" name="instagram" placeholder="https://www.instagram.com/username" value="" aria-label="Ссылка на Instagram" required></div><button class="button primary" type="submit">Добавить и загрузить 20 рилс →</button></form>
    <div class="competitor-list">${competitors.length ? competitors.map((competitor) => {
      const [label, tone, detail] = statusInfo(competitor);
      const savedPercent = competitor.reels_count ? Math.round(Number(competitor.stored_media_count) / Number(competitor.reels_count) * 100) : 0;
      const running = active.has(competitor.sync_status);
      const blocked = !running && !competitor.sync_can_start;
      const limitReached = Number(competitor.sync_hourly_remaining) === 0 || Number(competitor.sync_daily_remaining) === 0;
      const syncHint = limitReached ? "Исчерпан бесплатный лимит импортов" : blocked ? `Повтор будет доступен ${relativeTime(competitor.sync_next_available_at)}` : "Загрузить свежие рилсы";
      const syncLabel = running ? "Синхронизация…" : limitReached ? "Лимит исчерпан" : blocked ? "Подождите" : "Обновить";
      return `<article class="profile-panel competitor-panel ${String(selectedCompetitorId) === String(competitor.id) ? "selected" : ""}">
        <div class="competitor-main"><img class="profile-photo" src="${escapeHtml(competitor.avatar_url || reels.find((reel) => String(reel.competitor_id) === String(competitor.id))?.thumbnail_url || "/placeholder.svg")}" alt="" data-fallback><div class="profile-copy"><strong>${escapeHtml(competitor.instagram_handle)}</strong><span>${escapeHtml(competitor.display_name)}</span><small>Обновлено ${relativeTime(competitor.last_synced_at)} · ${dateTime(competitor.last_synced_at)}</small></div><span class="sync-pill ${tone}">${running ? `<i></i>` : ""}${label}</span></div>
        <p class="sync-detail ${tone}">${escapeHtml(detail)}</p>
        <div class="profile-stats"><div class="stat"><strong>${compact(competitor.reels_count)}</strong><span>рилс</span></div><div class="stat"><strong>${compact(competitor.total_views)}</strong><span>просмотров</span></div><div class="stat"><strong>${competitor.stored_media_count || 0}</strong><span>видео сохранено</span></div><div class="stat"><strong>${competitor.external_media_count || 0}</strong><span>временных ссылок</span></div></div>
        <div class="storage-line"><div><span>Надёжность видео</span><b>${savedPercent}%</b></div><div class="storage-progress"><i style="width:${savedPercent}%"></i></div></div>
        <div class="profile-actions"><button class="button ${String(selectedCompetitorId) === String(competitor.id) ? "accent" : ""}" data-filter-competitor="${competitor.id}">Показать рилсы</button><a class="button" href="${escapeHtml(competitor.profile_url)}" target="_blank" rel="noopener">${icon("external")} Instagram</a><button class="button sync-competitor" data-sync-competitor="${competitor.id}" title="${escapeHtml(syncHint)}" ${running || blocked ? "disabled" : ""}>${icon("refresh")} ${syncLabel}</button><button class="button danger" data-delete-competitor="${competitor.id}" data-competitor-name="${escapeHtml(competitor.instagram_handle)}" data-reels-count="${competitor.reels_count || 0}" ${running ? "disabled" : ""}>Удалить</button></div>
      </article>`;
    }).join("") : `<div class="empty">Добавьте первого конкурента.</div>`}</div>
    <div class="section-head"><h2>${selectedCompetitor ? `Рилсы ${escapeHtml(selectedCompetitor.instagram_handle)}` : "Последние рилс"}</h2><span class="success-pill">${filteredReels.length} записей в PostgreSQL</span>${selectedCompetitor ? `<button class="button clear-filter" data-clear-competitor>Показать все</button>` : ""}</div>
    <div class="table-panel"><table class="reels-table"><thead><tr><th>#</th><th>Превью</th><th>Заголовок</th><th>Длительность</th><th>Просмотры</th><th>Статус</th><th></th></tr></thead><tbody>
      ${filteredReels.length ? filteredReels.map((reel, index) => { const [label, tone] = mediaStatus(reel.media_status); return `<tr><td>${index + 1}</td><td><img class="table-preview" src="${escapeHtml(reel.thumbnail_url)}" alt="" data-fallback></td><td class="table-title">${escapeHtml(reel.title)}</td><td>${duration(reel.duration_seconds)}</td><td>${compact(reel.views_count)}</td><td><span class="status ${tone}">${label}</span></td><td><button class="more" data-remix="${reel.id}" aria-label="Открыть рилс">${icon("more")}</button></td></tr>`; }).join("") : `<tr><td colspan="7"><div class="empty compact-empty">У этого конкурента пока нет рилсов.</div></td></tr>`}
    </tbody></table></div>
  </section>`;
  bindPageEvents();
  document.querySelector("#competitor-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector("button");
    submit.disabled = true; submit.textContent = "Сохраняем...";
    try {
      const competitor = await api("/api/competitors", { method: "POST", body: JSON.stringify({ instagram: new FormData(event.currentTarget).get("instagram") }) });
      try {
        const run = await api(`/api/competitors/${competitor.id}/sync`, { method: "POST", body: "{}" });
        showToast(`Синхронизация #${run.id} запущена в фоне`);
      } catch (syncError) {
        showToast(`Конкурент сохранён. ${syncError.message}`);
      }
      await renderCompetitors();
    } catch (error) { showToast(error.message); submit.disabled = false; submit.textContent = "Добавить и загрузить 20 рилс →"; }
  });
  document.querySelectorAll("[data-sync-competitor]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const run = await api(`/api/competitors/${button.dataset.syncCompetitor}/sync`, { method: "POST", body: "{}" });
      showToast(`Синхронизация #${run.id} запущена`);
      await renderCompetitors();
    } catch (error) { showToast(error.message); button.disabled = false; }
  }));
  document.querySelectorAll("[data-filter-competitor]").forEach((button) => button.addEventListener("click", () => {
    selectedCompetitorId = Number(button.dataset.filterCompetitor);
    renderCompetitors();
  }));
  document.querySelector("[data-clear-competitor]")?.addEventListener("click", () => {
    selectedCompetitorId = null;
    renderCompetitors();
  });
  document.querySelectorAll("[data-delete-competitor]").forEach((button) => button.addEventListener("click", async () => {
    const message = `Удалить ${button.dataset.competitorName} и связанные рилсы (${button.dataset.reelsCount})? Сценарии останутся, но потеряют связь с источником.`;
    if (!window.confirm(message)) return;
    button.disabled = true;
    try {
      await api(`/api/competitors/${button.dataset.deleteCompetitor}`, { method: "DELETE" });
      if (String(selectedCompetitorId) === button.dataset.deleteCompetitor) selectedCompetitorId = null;
      showToast("Конкурент и его рилсы удалены");
      await renderCompetitors();
    } catch (error) { showToast(error.message); button.disabled = false; }
  }));
  if (competitors.some((competitor) => active.has(competitor.sync_status))) {
    clearTimeout(renderCompetitors.pollTimer);
    renderCompetitors.pollTimer = setTimeout(() => { if (activeView === "competitors") renderCompetitors(); }, 4000);
  }
}

function segmentsMarkup(reel) {
  if (originalMode) return `<div class="segment"><span class="segment-number">↗</span><div class="segment-head"><strong>Описание оригинала</strong></div><div class="segment-body">${nl2br(reel.description || "У оригинала нет описания")}</div></div>`;
  const segments = [
    ["Hook (Первые 3 секунды)", "hook_text", reel.hook_text, "~ 0:03"],
    ["Основной сценарий", "script_text", reel.script_text, `~ 0:${String(Math.max(0, reel.duration_seconds - 7)).padStart(2, "0")}`],
    ["Call to Action", "cta_text", reel.cta_text, "~ 0:04"]
  ];
  return segments.map(([title, field, value, time], index) => `<article class="segment"><span class="segment-number">${index + 1}</span><div class="segment-head"><strong>${title}</strong><span>${icon("clock")} ${time}</span></div>${editMode ? `<textarea class="segment-editor" name="${field}">${escapeHtml(value)}</textarea>` : `<div class="segment-body">${nl2br(value)}</div>`}</article>`).join("");
}

async function renderRemix() {
  if (!selectedReelId) return setView("home");
  currentReel = await api(`/api/reels/${selectedReelId}`);
  const reel = currentReel;
  app.innerHTML = `<section class="page">
    <div class="breadcrumb">Главная　›　Рилс　›　Remix</div>
    ${pageHead("Remix Reel", "Используйте структуру этого рилса и создайте свой уникальный сценарий")}
    <div class="remix-layout">
      <div class="video-frame">${reel.video_url ? `<video controls playsinline poster="${escapeHtml(reel.thumbnail_url)}" src="${escapeHtml(reel.video_url)}">Ваш браузер не поддерживает видео.</video><div class="video-error" hidden><strong>Ссылка на видео устарела</strong><a class="button" href="${escapeHtml(reel.source_url)}" target="_blank" rel="noopener">Открыть оригинал</a></div>` : `<img src="${escapeHtml(reel.thumbnail_url)}" alt="${escapeHtml(reel.title)}" data-fallback><a class="play" href="${escapeHtml(reel.source_url)}" target="_blank" rel="noopener" aria-label="Открыть оригинал">${icon("play")}</a>`}</div>
      <div>
        ${reel.media_status === "stored" ? "" : `<div class="notice">${reel.video_url ? "Видео загружено по временной ссылке источника. Подключение R2 сделает его постоянным." : "Видео ещё не импортировано. Можно открыть оригинал в Instagram или повторить синхронизацию."}</div>`}
        <div class="remix-top"><div><h2>${escapeHtml(reel.title)}</h2><p>${escapeHtml(reel.instagram_handle || "")}　•　${compact(reel.views_count)} просмотров　•　${compact(reel.likes_count)} лайков</p></div><button class="more" id="favorite-reel" title="Избранное">${reel.is_favorite ? "★" : icon("star")}</button></div>
        <div class="remix-toggle"><button class="button ${originalMode ? "accent" : ""}" id="show-original">Оригинал</button><button class="button ${!originalMode ? "accent" : ""}" id="show-remix">✦ Мой ремикс</button>${!originalMode ? `<button class="button primary" id="toggle-edit">${editMode ? "Отменить" : "Редактировать"}</button>` : ""}</div>
        <div class="segments">${segmentsMarkup(reel)}</div>
        <div class="remix-actions">${editMode ? `<button class="button primary" id="save-remix">Сохранить изменения</button>` : `<button class="button" id="copy-script">${icon("copy")} Скопировать сценарий</button><button class="button primary" id="use-template">✦ Использовать этот шаблон</button>`}</div>
      </div>
    </div>
  </section>`;
  bindPageEvents();
  document.querySelector("#show-original").addEventListener("click", () => { originalMode = true; editMode = false; renderRemix(); });
  document.querySelector("#show-remix").addEventListener("click", () => { originalMode = false; renderRemix(); });
  document.querySelector("#toggle-edit")?.addEventListener("click", () => { editMode = !editMode; renderRemix(); });
  document.querySelector("#save-remix")?.addEventListener("click", async () => {
    const body = {};
    app.querySelectorAll(".segment-editor").forEach((field) => { body[field.name] = field.value; });
    currentReel = await api(`/api/reels/${reel.id}`, { method: "PATCH", body: JSON.stringify(body) });
    editMode = false; showToast("Сценарий сохранён в PostgreSQL"); await renderRemix();
  });
  document.querySelector("#copy-script")?.addEventListener("click", async () => {
    const value = `${reel.hook_text}\n\n${reel.script_text}\n\n${reel.cta_text}`;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement("textarea");
      area.value = value; area.style.position = "fixed"; area.style.opacity = "0";
      document.body.append(area); area.select(); document.execCommand("copy"); area.remove();
    }
    showToast("Сценарий скопирован");
  });
  document.querySelector("#use-template")?.addEventListener("click", async () => {
    await api("/api/scripts", { method: "POST", body: JSON.stringify({ reel_id: reel.id }) });
    showToast("Шаблон сохранён в «Моих сценариях»");
    await setView("scripts");
  });
  document.querySelector("#favorite-reel").addEventListener("click", async () => {
    await api(`/api/reels/${reel.id}`, { method: "PATCH", body: JSON.stringify({ is_favorite: !reel.is_favorite }) });
    showToast(reel.is_favorite ? "Удалено из избранного" : "Добавлено в избранное"); await renderRemix();
  });
  document.querySelector(".video-frame video")?.addEventListener("error", (event) => {
    event.currentTarget.hidden = true;
    document.querySelector(".video-error").hidden = false;
  });
}

async function renderScripts() {
  const scripts = await api("/api/scripts");
  app.innerHTML = `<section class="page">${pageHead("Мои сценарии", "Сохранённые в PostgreSQL сценарии", `<button class="button primary" id="new-script">${icon("plus")}<span>Новый сценарий</span></button>`)}
    <div class="scripts-grid">${scripts.length ? scripts.map((script) => `<article class="script-card" data-edit-script="${script.id}" role="button" tabindex="0">${script.thumbnail_url ? `<img class="script-thumb" src="${escapeHtml(script.thumbnail_url)}" alt="" data-fallback>` : `<div class="script-placeholder">${icon("file")}</div>`}<small>${escapeHtml(script.status)} · ${new Date(script.updated_at).toLocaleDateString("ru")}</small><h3>${escapeHtml(script.title)}</h3><p>${escapeHtml(script.hook_text || "Без хука")}</p><footer><span>${duration(script.duration_seconds)}</span><button class="delete-script" data-delete-script="${script.id}">Удалить</button></footer></article>`).join("") : `<div class="empty">Сохранённых сценариев пока нет.<br><br>Создайте пустой сценарий или выберите шаблон у любого Reel.</div>`}</div>
  </section>`;
  bindPageEvents();
  document.querySelector("#new-script").addEventListener("click", async () => {
    const script = await api("/api/scripts", { method: "POST", body: JSON.stringify({ title: "Новый сценарий" }) });
    selectedScriptId = Number(script.id);
    await setView("script-editor");
  });
  app.querySelectorAll("[data-edit-script]").forEach((card) => {
    const open = () => { selectedScriptId = Number(card.dataset.editScript); setView("script-editor"); };
    card.addEventListener("click", (event) => { if (!event.target.closest("[data-delete-script]")) open(); });
    card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") open(); });
  });
  app.querySelectorAll("[data-delete-script]").forEach((button) => button.addEventListener("click", async (event) => {
    event.stopPropagation(); await api(`/api/scripts/${button.dataset.deleteScript}`, { method: "DELETE" }); showToast("Сценарий удалён"); await renderScripts();
  }));
}

async function renderScriptEditor() {
  if (!selectedScriptId) return setView("scripts");
  const script = await api(`/api/scripts/${selectedScriptId}`);
  app.innerHTML = `<section class="page script-editor-page">
    <div class="breadcrumb">Мои сценарии　›　Редактор</div>
    ${pageHead("Редактор сценария", "Изменения сохраняются в PostgreSQL")}
    <form class="script-form" id="script-form">
      <label>Название<input name="title" value="${escapeHtml(script.title)}" maxlength="300" required></label>
      <label>Хук<textarea name="hook_text" rows="3" placeholder="Первые секунды, которые удержат внимание">${escapeHtml(script.hook_text)}</textarea></label>
      <label>Основной сценарий<textarea name="script_text" rows="10" placeholder="Основная часть ролика">${escapeHtml(script.script_text)}</textarea></label>
      <label>Call to Action<textarea name="cta_text" rows="3" placeholder="Что зритель должен сделать дальше">${escapeHtml(script.cta_text)}</textarea></label>
      <label class="status-field">Статус<select name="status"><option value="draft" ${script.status === "draft" ? "selected" : ""}>Черновик</option><option value="ready" ${script.status === "ready" ? "selected" : ""}>Готов</option><option value="published" ${script.status === "published" ? "selected" : ""}>Опубликован</option></select></label>
      <div class="form-actions"><button class="button" type="button" id="back-to-scripts">Назад</button>${script.reel_id ? `<button class="button" type="button" id="open-source">Открыть исходный Reel</button>` : ""}<button class="button primary" type="submit">Сохранить сценарий</button></div>
    </form>
  </section>`;
  document.querySelector("#back-to-scripts").addEventListener("click", () => setView("scripts"));
  document.querySelector("#open-source")?.addEventListener("click", () => { selectedReelId = Number(script.reel_id); setView("remix"); });
  document.querySelector("#script-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    await api(`/api/scripts/${script.id}`, { method: "PATCH", body: JSON.stringify(values) });
    showToast("Сценарий сохранён");
    await setView("scripts");
  });
}

function bindPageEvents() {
  app.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  app.querySelectorAll("[data-tab]").forEach((tab) => tab.addEventListener("click", () => {
    activeTab = tab.dataset.tab;
    if (activeTab === "favorite") setView("favorites"); else if (activeTab === "scripts") setView("scripts"); else setView("home");
  }));
  bindReelActions();
}

document.querySelectorAll(".sidebar [data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
document.addEventListener("click", (event) => { if (!event.target.closest("[data-menu], .action-menu")) document.querySelectorAll(".action-menu").forEach((menu) => menu.remove()); });
document.addEventListener("error", (event) => {
  if (!(event.target instanceof HTMLImageElement) || !event.target.matches("[data-fallback]")) return;
  event.target.removeAttribute("data-fallback");
  event.target.src = "/placeholder.svg";
  event.target.classList.add("image-fallback");
}, true);
setView("home");
