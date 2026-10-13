const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
let activeView = "home";
let selectedReelId = null;
let activeTab = "all";
let sortMode = "latest";
let editMode = false;
let originalMode = false;
let currentReel = null;

const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const nl2br = (value = "") => escapeHtml(value).replace(/\n/g, "<br>");
const duration = (seconds = 0) => `${Math.floor(Number(seconds) / 60)}:${String(Number(seconds) % 60).padStart(2, "0")}`;
const compact = (value = 0) => new Intl.NumberFormat("ru", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value));

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Ошибка API: ${response.status}`);
  return payload.data;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function loading() {
  app.innerHTML = `<div class="loading">Загружаем данные</div>`;
}

function pageHead(title, subtitle, action = "") {
  return `<header class="page-head"><div><h1>${title}</h1><p class="subtitle">${subtitle}</p></div>${action}</header>`;
}

async function setView(view) {
  activeView = view;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  loading();
  try {
    if (view === "home" || view === "favorites") await renderHome(view === "favorites");
    if (view === "competitors") await renderCompetitors();
    if (view === "scripts") await renderScripts();
    if (view === "remix") await renderRemix();
  } catch (error) {
    app.innerHTML = `<section class="page"><div class="empty"><strong>Не удалось загрузить данные</strong><br><br>${escapeHtml(error.message)}</div></section>`;
  }
  app.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function reelCard(reel) {
  const mediaLabel = reel.media_status === "stored" ? "Сохранено" : reel.video_url ? "Видео" : "Оригинал";
  return `<article class="reel-card" data-card-id="${reel.id}">
    <div class="reel-cover interactive" data-remix="${reel.id}" role="button" tabindex="0" aria-label="Открыть ${escapeHtml(reel.title)}">
      <img src="${escapeHtml(reel.thumbnail_url)}" alt="Превью: ${escapeHtml(reel.title)}" loading="lazy"><span class="media-pill ${escapeHtml(reel.media_status || "missing")}">${mediaLabel}</span><span class="duration">${duration(reel.duration_seconds)}</span>
    </div>
    <h2 class="reel-title">${escapeHtml(reel.title)}</h2><p class="handle">${escapeHtml(reel.instagram_handle || "")}</p>
    <p class="metrics"><span>▷ ${compact(reel.views_count)}</span><span>♡ ${compact(reel.likes_count)}</span></p>
    <div class="card-actions"><button class="remix-button" data-remix="${reel.id}"><span>✦</span> Ремикс</button><button class="more" data-menu="${reel.id}" aria-label="Другие действия">${icon("more")}</button></div>
  </article>`;
}

async function renderHome(onlyFavorites = false) {
  const query = new URLSearchParams({ sort: sortMode });
  if (onlyFavorites) query.set("favorite", "true");
  const reels = await api(`/api/reels?${query}`);
  app.innerHTML = `<section class="page">
    ${pageHead(onlyFavorites ? "Избранное" : "Главная", onlyFavorites ? "Сохранённые идеи для будущих сценариев" : "Все собранные рилс из аккаунтов конкурентов", `<button class="button primary" data-view="competitors">${icon("plus")}<span>Добавить конкурента</span></button>`)}
    <div class="toolbar">
      <div class="tabs" role="tablist">
        <button class="tab ${activeTab === "all" ? "active" : ""}" data-tab="all">Все рилс <strong>${reels.length}</strong></button>
        <button class="tab ${activeTab === "favorite" ? "active" : ""}" data-tab="favorite">Избранное</button>
        <button class="tab ${activeTab === "scripts" ? "active" : ""}" data-tab="scripts">Мои сценарии</button>
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
  menu.innerHTML = `<button data-favorite="${reelId}">☆ Добавить / убрать избранное</button><button data-open="${reelId}">${icon("external")} Открыть оригинал</button>`;
  card.querySelector(".card-actions").append(menu);
  menu.querySelector("[data-favorite]").addEventListener("click", async () => {
    const reel = await api(`/api/reels/${reelId}`);
    await api(`/api/reels/${reelId}`, { method: "PATCH", body: JSON.stringify({ is_favorite: !reel.is_favorite }) });
    showToast(reel.is_favorite ? "Удалено из избранного" : "Добавлено в избранное");
    renderHome(activeView === "favorites");
  });
  menu.querySelector("[data-open]").addEventListener("click", async () => {
    const reel = await api(`/api/reels/${reelId}`);
    window.open(reel.source_url, "_blank", "noopener,noreferrer");
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
  const statusLabel = (status) => ({ queued: "В очереди", running: "Apify работает", importing: "Импортируем", succeeded: "Готово", partial: "Частично", failed: "Ошибка" })[status] || "Не запускалась";
  const active = new Set(["queued", "running", "importing"]);
  app.innerHTML = `<section class="page">
    ${pageHead("Конкуренты", "Добавляйте Instagram аккаунты и собирайте их последние рилс")}
    <form class="fetch-panel" id="competitor-form"><div class="url-field"><input class="url-input" name="instagram" placeholder="https://www.instagram.com/username" value="" aria-label="Ссылка на Instagram" required></div><button class="button primary" type="submit">Добавить и загрузить 20 рилс →</button></form>
    <div class="competitor-list">${competitors.length ? competitors.map((competitor) => `<article class="profile-panel">
      <img class="profile-photo" src="${escapeHtml(competitor.avatar_url || reels.find((reel) => String(reel.competitor_id) === String(competitor.id))?.thumbnail_url || "")}" alt=""><div class="profile-copy"><strong>${escapeHtml(competitor.instagram_handle)}</strong><span>${escapeHtml(competitor.display_name)}</span><small>${competitor.last_synced_at ? `Обновлено ${new Date(competitor.last_synced_at).toLocaleString("ru")}` : "Ещё не синхронизирован"}</small></div>
      <div class="profile-stats"><div class="stat"><strong>${compact(competitor.reels_count)}</strong><span>рилс</span></div><div class="stat"><strong>${compact(competitor.total_views)}</strong><span>просмотров</span></div><div class="stat"><strong>${statusLabel(competitor.sync_status)}</strong><span>${competitor.sync_error ? escapeHtml(competitor.sync_error) : `${competitor.sync_imported_count || 0} импортировано`}</span></div></div>
      <div class="profile-actions"><a class="button" href="${escapeHtml(competitor.profile_url)}" target="_blank" rel="noopener">${icon("external")} Instagram</a><button class="button sync-competitor" data-sync-competitor="${competitor.id}" ${active.has(competitor.sync_status) ? "disabled" : ""}>${icon("refresh")} ${active.has(competitor.sync_status) ? "Синхронизация…" : "Обновить"}</button></div>
    </article>`).join("") : `<div class="empty">Добавьте первого конкурента.</div>`}</div>
    <div class="section-head"><h2>Последние рилс</h2><span class="success-pill">${reels.length} записей в PostgreSQL</span></div>
    <div class="table-panel"><table class="reels-table"><thead><tr><th>#</th><th>Превью</th><th>Заголовок</th><th>Длительность</th><th>Просмотры</th><th>Статус</th><th></th></tr></thead><tbody>
      ${reels.map((reel, index) => `<tr><td>${index + 1}</td><td><img class="table-preview" src="${escapeHtml(reel.thumbnail_url)}" alt=""></td><td class="table-title">${escapeHtml(reel.title)}</td><td>${duration(reel.duration_seconds)}</td><td>${compact(reel.views_count)}</td><td><span class="status">${escapeHtml(reel.status)}</span></td><td><button class="more" data-remix="${reel.id}" aria-label="Открыть рилс">${icon("more")}</button></td></tr>`).join("")}
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
      <div class="video-frame">${reel.video_url ? `<video controls playsinline poster="${escapeHtml(reel.thumbnail_url)}" src="${escapeHtml(reel.video_url)}">Ваш браузер не поддерживает видео.</video>` : `<img src="${escapeHtml(reel.thumbnail_url)}" alt="${escapeHtml(reel.title)}"><a class="play" href="${escapeHtml(reel.source_url)}" target="_blank" rel="noopener" aria-label="Открыть оригинал">${icon("play")}</a>`}</div>
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
    await navigator.clipboard.writeText(`${reel.hook_text}\n\n${reel.script_text}\n\n${reel.cta_text}`);
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
}

async function renderScripts() {
  const scripts = await api("/api/scripts");
  app.innerHTML = `<section class="page">${pageHead("Мои сценарии", "Сохранённые в PostgreSQL сценарии", `<button class="button primary" data-view="home">${icon("plus")}<span>Новый сценарий</span></button>`)}
    <div class="scripts-grid">${scripts.length ? scripts.map((script) => `<article class="script-card" data-script="${script.id}" ${script.reel_id ? `data-remix="${script.reel_id}"` : ""}>${script.thumbnail_url ? `<img class="script-thumb" src="${escapeHtml(script.thumbnail_url)}" alt="">` : ""}<small>${escapeHtml(script.status)} · ${new Date(script.updated_at).toLocaleDateString("ru")}</small><h3>${escapeHtml(script.title)}</h3><footer><span>${duration(script.duration_seconds)}</span><button class="delete-script" data-delete-script="${script.id}">Удалить</button></footer></article>`).join("") : `<div class="empty">Сохранённых сценариев пока нет.</div>`}</div>
  </section>`;
  bindPageEvents();
  app.querySelectorAll("[data-delete-script]").forEach((button) => button.addEventListener("click", async (event) => {
    event.stopPropagation(); await api(`/api/scripts/${button.dataset.deleteScript}`, { method: "DELETE" }); showToast("Сценарий удалён"); await renderScripts();
  }));
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
setView("home");
