const reels = [
  { title: "3 ошибки в утренней рутине, которые крадут твою энергию", handle: "@alyona.health", views: "1.2M", likes: "4.2K", duration: "0:32", image: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=700&q=85", favorite: true },
  { title: "Как я удвоил доход за 6 месяцев", handle: "@max.business", views: "920K", likes: "1.1K", duration: "0:45", image: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=700&q=85" },
  { title: "Простой и полезный завтрак за 5 минут", handle: "@healthy.kitchen", views: "640K", likes: "890", duration: "0:28", image: "https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=700&q=85", favorite: true },
  { title: "Мой подход к продуктивности", handle: "@julia.life", views: "1.4M", likes: "2.3K", duration: "0:28", image: "https://images.unsplash.com/photo-1524504388940-b1c1722653e1?auto=format&fit=crop&w=700&q=85" },
  { title: "Главный навык в 2024 году", handle: "@artem.mind", views: "780K", likes: "1.5K", duration: "0:51", image: "https://images.unsplash.com/photo-1568602471122-7832951cc4c5?auto=format&fit=crop&w=700&q=85" },
  { title: "Почему стоит посетить Бали хотя бы раз", handle: "@daria.travel", views: "2.1M", likes: "3.4K", duration: "0:34", image: "https://images.unsplash.com/photo-1537996194471-e657df975ab4?auto=format&fit=crop&w=700&q=85", favorite: true },
  { title: "5 привычек для чистой кожи", handle: "@beauty.maria", views: "690K", likes: "1.2K", duration: "0:29", image: "https://images.unsplash.com/photo-1531123897727-8f129e1688ce?auto=format&fit=crop&w=700&q=85" },
  { title: "Тренировка дома без оборудования", handle: "@nikita.fitness", views: "550K", likes: "980", duration: "0:40", image: "https://images.unsplash.com/photo-1560250097-0b93528c311a?auto=format&fit=crop&w=700&q=85" }
];

const scripts = [
  { title: "3 ошибки в утренней рутине", date: "Сегодня, 12:30", time: "32 сек" },
  { title: "Как найти время на себя", date: "Вчера, 18:42", time: "28 сек" },
  { title: "Мини-инструкция по продуктивности", date: "10 октября", time: "41 сек" }
];

const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
let activeView = "home";
let selectedReel = 0;
let activeTab = "all";

const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const escapeHtml = (value) => value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2300);
}

function setView(view) {
  activeView = view;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  if (view === "home" || view === "favorites") renderHome(view === "favorites");
  if (view === "competitors") renderCompetitors();
  if (view === "scripts") renderScripts();
  if (view === "remix") renderRemix();
  app.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function pageHead(title, subtitle, action = "") {
  return `<header class="page-head"><div><h1>${title}</h1><p class="subtitle">${subtitle}</p></div>${action}</header>`;
}

function reelCard(reel) {
  const reelIndex = reels.indexOf(reel);
  return `<article class="reel-card">
    <div class="reel-cover"><img src="${reel.image}" alt="Превью: ${reel.title}" loading="lazy"><span class="duration">${reel.duration}</span></div>
    <h2 class="reel-title">${reel.title}</h2><p class="handle">${reel.handle}</p>
    <p class="metrics"><span>▷ ${reel.views}</span><span>♡ ${reel.likes}</span></p>
    <div class="card-actions"><button class="remix-button" data-remix="${reelIndex}"><span>✦</span> Ремикс</button><button class="more" aria-label="Другие действия">${icon("more")}</button></div>
  </article>`;
}

function renderHome(onlyFavorites = false) {
  const visible = onlyFavorites ? reels.filter((reel) => reel.favorite) : reels;
  app.innerHTML = `<section class="page">
    ${pageHead(onlyFavorites ? "Избранное" : "Главная", onlyFavorites ? "Сохранённые идеи для будущих сценариев" : "Все собранные рилс из аккаунтов конкурентов", `<button class="button primary" data-view="competitors">${icon("plus")}<span>Добавить конкурента</span></button>`)}
    <div class="toolbar">
      <div class="tabs" role="tablist">
        <button class="tab ${activeTab === "all" ? "active" : ""}" data-tab="all">Все рилс <strong>128</strong></button>
        <button class="tab ${activeTab === "favorite" ? "active" : ""}" data-tab="favorite">Избранное <strong>12</strong></button>
        <button class="tab ${activeTab === "scripts" ? "active" : ""}" data-tab="scripts">Мои сценарии <strong>8</strong></button>
      </div>
      <label class="search-wrap">${icon("search")}<input id="reel-search" type="search" placeholder="Поиск по заголовку, аккаунту..." aria-label="Поиск рилс"></label>
      <button class="icon-button" aria-label="Фильтры" data-toast="Фильтры появятся на следующем этапе">${icon("sliders")}</button>
    </div>
    <div class="reel-grid" id="reel-grid">${visible.map(reelCard).join("")}</div>
  </section>`;
  bindPageEvents();
  const search = document.querySelector("#reel-search");
  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    const filtered = visible.filter((reel) => `${reel.title} ${reel.handle}`.toLowerCase().includes(query));
    document.querySelector("#reel-grid").innerHTML = filtered.length ? filtered.map(reelCard).join("") : `<div class="empty">Ничего не найдено. Попробуйте другой запрос.</div>`;
    bindRemixButtons();
  });
}

function renderCompetitors() {
  app.innerHTML = `<section class="page">
    ${pageHead("Конкуренты", "Добавляйте Instagram аккаунты и собирайте их последние рилс")}
    <div class="fetch-panel"><div class="url-field"><input class="url-input" value="https://www.instagram.com/alyona.health" aria-label="Ссылка на Instagram"></div><button class="button primary" id="fetch-reels">Fetch последние 20 рилс →</button></div>
    <div class="profile-panel">
      <img class="profile-photo" src="${reels[0].image}" alt="Аватар Alyona Health"><div class="profile-copy"><strong>@alyona.health</strong><span>Алена | Здоровье и баланс</span></div>
      <div class="profile-stats"><div class="stat"><strong>248</strong><span>публикаций</span></div><div class="stat"><strong>320K</strong><span>подписчиков</span></div><div class="stat"><strong>412</strong><span>подписок</span></div></div>
      <button class="button" data-toast="Открываем профиль в Instagram">${icon("external")} Открыть в Instagram</button>
    </div>
    <div class="section-head"><h2>Последние 20 рилс</h2><span class="success-pill">✓ Успешно собрано 20 рилс</span><div class="update"><span>Сегодня, 12:30</span><button class="button" id="refresh-reels">${icon("refresh")} Обновить</button></div></div>
    <div class="table-panel"><table class="reels-table"><thead><tr><th>#</th><th>Превью</th><th>Заголовок / Описание</th><th>Длительность</th><th>Просмотры</th><th>Статус</th><th></th></tr></thead><tbody>
      ${reels.slice(0, 6).map((reel, i) => `<tr><td>${i + 1}</td><td><img class="table-preview" src="${reel.image}" alt=""></td><td class="table-title">${reel.title}</td><td>${reel.duration}</td><td>${reel.views}</td><td><span class="status">Добавлено</span></td><td><button class="more" data-remix="${i}" aria-label="Открыть">${icon("more")}</button></td></tr>`).join("")}
    </tbody></table></div>
  </section>`;
  bindPageEvents();
  document.querySelector("#fetch-reels").addEventListener("click", () => showToast("20 рилс успешно собраны"));
  document.querySelector("#refresh-reels").addEventListener("click", (event) => { event.currentTarget.innerHTML = `${icon("refresh")} Обновлено`; showToast("Данные конкурента обновлены"); });
}

function renderRemix() {
  const reel = reels[selectedReel];
  app.innerHTML = `<section class="page">
    <div class="breadcrumb">Главная　›　Рилс　›　Remix</div>
    ${pageHead("Remix Reel", "Используйте структуру этого рилса и создайте свой уникальный сценарий")}
    <div class="remix-layout">
      <div class="video-frame"><img src="${reel.image}" alt="${reel.title}"><button class="play" aria-label="Воспроизвести">${icon("play")}</button><div class="timeline"><i></i></div></div>
      <div>
        <div class="remix-top"><div><h2>${reel.title}</h2><p>${reel.handle}　•　${reel.views} просмотров　•　${reel.likes} лайков</p></div><button class="more">${icon("more")}</button></div>
        <div class="remix-toggle"><button class="button">Оригинал</button><button class="button accent">✦ Мой ремикс</button><button class="button primary" data-toast="Редактор сценария скоро будет доступен">Редактировать</button></div>
        <div class="segments">
          <article class="segment"><span class="segment-number">1</span><div class="segment-head"><strong>Hook (Первые 3 секунды)</strong><span>${icon("clock")} ~ 0:03</span></div><div class="segment-body">Ты тоже просыпаешься уставшим?
Вот 3 ошибки в утренней рутине, которые крадут твою энергию.</div></article>
          <article class="segment"><span class="segment-number">2</span><div class="segment-head"><strong>Основной сценарий</strong><span>${icon("clock")} ~ 0:25</span></div><div class="segment-body">1. Первая ошибка — сразу брать телефон.
2. Вторая ошибка — пропускать воду.
3. Третья ошибка — хаотичный завтрак.

И как это исправить 👇</div></article>
          <article class="segment"><span class="segment-number">3</span><div class="segment-head"><strong>Call to Action</strong><span>${icon("clock")} ~ 0:04</span></div><div class="segment-body">Сохрани это видео, чтобы не забыть, и подпишись за больше полезных советов! ❤️</div></article>
        </div>
        <div class="remix-actions"><button class="button" id="copy-script">${icon("copy")} Скопировать сценарий</button><button class="button primary" data-toast="Шаблон добавлен в ваши сценарии">✦ Использовать этот шаблон</button></div>
      </div>
    </div>
  </section>`;
  bindPageEvents();
  document.querySelector("#copy-script").addEventListener("click", async () => {
    await navigator.clipboard?.writeText("Hook: Ты тоже просыпаешься уставшим?\n\nОсновной сценарий: 3 ошибки в утренней рутине.\n\nCTA: Сохрани это видео!");
    showToast("Сценарий скопирован");
  });
}

function renderScripts() {
  app.innerHTML = `<section class="page">${pageHead("Мои сценарии", "Ваши готовые идеи и ремиксы", `<button class="button primary" data-view="home">${icon("plus")}<span>Новый сценарий</span></button>`)}
    <div class="scripts-grid">${scripts.map((script, i) => `<article class="script-card" data-remix="${i}"><small>Сценарий ${String(i + 1).padStart(2, "0")}</small><h3>${script.title}</h3><footer><span>${script.date}</span><span>${script.time}</span></footer></article>`).join("")}</div>
  </section>`;
  bindPageEvents();
}

function bindRemixButtons() {
  app.querySelectorAll("[data-remix]").forEach((button) => button.addEventListener("click", () => { selectedReel = Number(button.dataset.remix) || 0; setView("remix"); }));
}

function bindPageEvents() {
  app.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  app.querySelectorAll("[data-toast]").forEach((button) => button.addEventListener("click", () => showToast(button.dataset.toast)));
  app.querySelectorAll("[data-tab]").forEach((tab) => tab.addEventListener("click", () => {
    activeTab = tab.dataset.tab;
    if (activeTab === "favorite") setView("favorites"); else if (activeTab === "scripts") setView("scripts"); else setView("home");
  }));
  bindRemixButtons();
}

document.querySelectorAll(".sidebar [data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
setView("home");
