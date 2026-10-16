import { normalizeApifyReel } from "./apify.js";

const ACTIVE = ["queued", "running", "importing"];
const MAX_SEARCH_TERMS = 3;

const TOPIC_EXPANSIONS = [
  { pattern: /ремонт|отделк|стройк|интерьер|дизайн помещ|дизайн квартир/i, terms: ["ремонт квартир", "отделка помещений", "ремонт до и после"] },
  { pattern: /сувенир|подар|мерч|hand.?made/i, terms: ["сувениры на заказ", "подарки ручной работы", "корпоративные подарки"] },
  { pattern: /обув|кроссов|кед|ботин|туфл/i, terms: ["магазин обуви", "кроссовки", "обувной магазин"] },
  { pattern: /нейросет|искусственн.{0,12}интеллект|(?:^|[^а-яё])ии(?:$|[^а-яё])|chat.?gpt/i, terms: ["нейросети", "обучение нейросетям", "ChatGPT"] },
  { pattern: /маркетинг|продвижен|реклам|смм|smm/i, terms: ["маркетинг для бизнеса", "продвижение бизнеса", "идеи для контента"] },
  { pattern: /красот|косметолог|макияж|маникюр|парикмах/i, terms: ["салон красоты", "советы косметолога", "мастер красоты"] },
  { pattern: /фитнес|трениров|спорт|похуден|питани/i, terms: ["фитнес тренировки", "тренировка дома", "здоровое питание"] }
];

const RUSSIAN_ENDINGS = [
  "иями", "ями", "ами", "ого", "ему", "ыми", "ими", "иях", "ах", "ях", "ов", "ев",
  "ей", "ам", "ям", "ом", "ем", "ой", "ый", "ий", "ая", "яя", "ое", "ее", "ые", "ие",
  "ую", "юю", "ы", "и", "а", "я", "е", "о", "у", "ю", "ь"
].sort((left, right) => right.length - left.length);

function normalizeQuery(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stem(value) {
  const word = value.toLocaleLowerCase("ru").replace(/ё/g, "е");
  const ending = RUSSIAN_ENDINGS.find((suffix) => word.length > suffix.length + 2 && word.endsWith(suffix));
  return ending ? word.slice(0, -ending.length) : word;
}

function tokens(value) {
  return String(value || "").toLocaleLowerCase("ru").replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2);
}

function keywords(value) {
  return tokens(value).map(stem);
}

export function buildNicheSearchTerms(value) {
  const raw = normalizeQuery(value);
  if (!raw) return [];

  // Explicitly separated topics are usually user-provided alternatives; keep them ahead of generated synonyms.
  const explicitTerms = raw.split(/[,;\n]+/).map(normalizeQuery).filter(Boolean);
  const startingTerms = explicitTerms.length > 1 ? explicitTerms : [raw];
  const candidates = [...startingTerms];
  for (const topic of TOPIC_EXPANSIONS) {
    if (!topic.pattern.test(raw)) continue;
    candidates.push(...topic.terms);
  }

  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const query = normalizeQuery(candidate);
    const key = query.toLocaleLowerCase("ru");
    if (!query || seen.has(key)) continue;
    seen.add(key);
    unique.push(query);
    if (unique.length === MAX_SEARCH_TERMS) break;
  }
  return unique;
}

function relevance(item, searchTerms) {
  const haystack = keywords(`${item.caption || ""} ${(item.hashtags || []).join(" ")}`);
  let best = { score: 0, matched: [] };
  for (const term of searchTerms) {
    const surfaceTerms = [...new Set(tokens(term))];
    const expected = surfaceTerms.map(stem);
    if (!expected.length) continue;
    const matched = surfaceTerms.filter((_, index) => haystack.some((candidate) => candidate === expected[index] || candidate.startsWith(expected[index]) || expected[index].startsWith(candidate)));
    const score = Math.round(matched.length / expected.length * 100);
    if (score > best.score) best = { score, matched };
  }
  return best;
}

async function apifyRequest(url, token, options) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options?.headers || {}) }
  });
  if (!response.ok) throw new Error(`Apify вернул ошибку ${response.status}`);
  return response.json();
}

function preparePopularReel(item) {
  const owner = item.owner && typeof item.owner === "object" ? item.owner : {};
  const user = item.user && typeof item.user === "object" ? item.user : {};
  const videoUrl = item.videoUrl || item.video_url || item.videoPlayUrl || item.downloadedVideo;
  const type = String(item.type || item.mediaType || "").toLocaleLowerCase("en");
  if (!(type === "video" || item.productType === "clips" || videoUrl)) return null;

  const ownerUsername = item.ownerUsername || owner.username || user.username || item.username;
  if (!ownerUsername) return null;

  return {
    ...item,
    ownerUsername,
    ownerFullName: item.ownerFullName || owner.fullName || user.fullName || user.name,
    displayUrl: item.displayUrl || item.thumbnailUrl || item.thumbnail_url || item.imageUrl || item.coverUrl,
    videoUrl,
    url: item.url || item.postUrl || item.originalUrl
  };
}

function partialMessage({ items, noItemsTerms, queries }) {
  if (noItemsTerms.length) {
    const unavailable = [...new Set(noItemsTerms)].join(", ");
    return `Instagram не нашёл публичные популярные Reels по запросам «${unavailable}». Попробуйте указать более конкретные слова или синонимы.`;
  }
  if (!items.length) return `Instagram не вернул ролики по проверенным запросам: ${queries.join(", ")}. Попробуйте другие слова для этой ниши.`;
  return `Источник вернул ${items.length} записей, но не удалось распознать в них публичные Reels с автором и превью. Поиск проверял: ${queries.join(", ")}.`;
}

export async function runNicheSearch(db, searchId, { env = process.env } = {}) {
  const token = env.APIFY_API_TOKEN;
  if (!token) throw new Error("Apify не подключён: добавьте APIFY_API_TOKEN в Render.");
  const found = await db.query("SELECT * FROM niche_searches WHERE id = $1", [searchId]);
  if (!found.rowCount) return;
  const search = found.rows[0];
  try {
    await db.query("UPDATE niche_searches SET status = 'running' WHERE id = $1", [searchId]);
    const queries = buildNicheSearchTerms(search.search_term || search.niche);
    if (!queries.length) throw new Error("Не удалось подготовить поисковые фразы для этой ниши.");

    const actor = encodeURIComponent((env.APIFY_NICHE_ACTOR_ID || "apify/instagram-search-scraper").replace("/", "~"));
    // Three results for up to three phrases keeps this discovery call small and predictable on the free allowance.
    const limit = Math.min(3, Math.max(1, Number(env.NICHE_RESULTS_LIMIT) || 3));
    const started = await apifyRequest(`https://api.apify.com/v2/acts/${actor}/runs`, token, {
      method: "POST",
      body: JSON.stringify({ search: queries.join(", "), searchType: "popular", searchLimit: limit })
    });
    let run = started.data;
    await db.query("UPDATE niche_searches SET provider_run_id = $1 WHERE id = $2", [run.id, searchId]);
    for (let attempt = 0; !["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run.status) && attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      run = (await apifyRequest(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(run.id)}`, token)).data;
    }
    if (run.status !== "SUCCEEDED") throw new Error(`Поиск завершился со статусом ${run.status}`);
    await db.query("UPDATE niche_searches SET status = 'importing' WHERE id = $1", [searchId]);
    const response = await apifyRequest(`https://api.apify.com/v2/datasets/${encodeURIComponent(run.defaultDatasetId)}/items?clean=true&limit=${queries.length * limit}`, token);
    const items = Array.isArray(response) ? response : [];
    const noItemsTerms = items.filter((item) => item.error === "no_items").map((item) => item.searchTerm || item.inputUrl || "запрос без результатов");
    let imported = 0;
    let eligible = 0;
    const seenReels = new Set();
    for (const item of items) {
      if (item.error) continue;
      const prepared = preparePopularReel(item);
      if (!prepared) continue;
      eligible += 1;
      const username = String(prepared.ownerUsername).replace(/^@/, "").toLowerCase();
      if (!/^[a-z0-9._]{1,30}$/.test(username)) continue;
      const reel = normalizeApifyReel(prepared, 0);
      if (!reel?.thumbnailUrl || seenReels.has(reel.platformId)) continue;
      seenReels.add(reel.platformId);

      const creator = await db.query(
        `INSERT INTO competitors(instagram_handle, profile_url, display_name)
         VALUES ($1,$2,$3)
         ON CONFLICT (instagram_handle) DO UPDATE SET
           display_name = EXCLUDED.display_name, updated_at = NOW()
         RETURNING id`,
        [`@${username}`, `https://www.instagram.com/${username}`, reel.ownerFullName || `@${username}`]
      );
      reel.competitorId = creator.rows[0].id;
      const saved = await db.query(
        `INSERT INTO reels (
          competitor_id, platform_reel_id, source_url, video_url, thumbnail_url, title,
          description, hook_text, script_text, cta_text, transcript, hashtags, mentions, audio,
          owner_username, owner_full_name, duration_seconds, views_count, play_count, likes_count,
          comments_count, shares_count, media_status, published_at, last_synced_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,NOW())
        ON CONFLICT (platform_reel_id) DO UPDATE SET
          competitor_id = EXCLUDED.competitor_id, source_url = EXCLUDED.source_url,
          video_url = CASE WHEN reels.media_status = 'stored' THEN reels.video_url ELSE EXCLUDED.video_url END,
          thumbnail_url = CASE WHEN reels.media_status = 'stored' THEN reels.thumbnail_url ELSE EXCLUDED.thumbnail_url END,
          title = EXCLUDED.title, description = EXCLUDED.description, hashtags = EXCLUDED.hashtags,
          views_count = EXCLUDED.views_count, play_count = EXCLUDED.play_count,
          likes_count = EXCLUDED.likes_count, comments_count = EXCLUDED.comments_count,
          media_status = CASE WHEN reels.media_status = 'stored' THEN 'stored' ELSE EXCLUDED.media_status END,
          last_synced_at = NOW(), updated_at = NOW()
        RETURNING id`,
        [reel.competitorId, reel.platformId, reel.sourceUrl, reel.videoUrl, reel.thumbnailUrl, reel.title,
          reel.description, reel.hookText, reel.scriptText, reel.ctaText, reel.transcript,
          JSON.stringify(reel.hashtags), JSON.stringify(reel.mentions), JSON.stringify(reel.audio),
          username, reel.ownerFullName, reel.durationSeconds, reel.viewsCount, reel.playCount,
          reel.likesCount, reel.commentsCount, reel.sharesCount, reel.videoUrl ? "external" : "missing", reel.publishedAt]
      );
      const matched = relevance(item, queries);
      await db.query(
        `INSERT INTO niche_search_reels(search_id, reel_id, relevance_score, matched_terms)
         VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (search_id, reel_id) DO UPDATE SET relevance_score = EXCLUDED.relevance_score, matched_terms = EXCLUDED.matched_terms`,
        [searchId, saved.rows[0].id, matched.score, JSON.stringify(matched.matched)]
      );
      imported += 1;
    }
    const status = imported ? "succeeded" : "partial";
    const message = imported ? null : eligible ? `Instagram нашёл ролики, но не удалось сохранить их карточки. Проверенные запросы: ${queries.join(", ")}.` : partialMessage({ items, noItemsTerms, queries });
    await db.query("UPDATE niche_searches SET status = $1, imported_count = $2, error_message = $3, finished_at = NOW() WHERE id = $4", [status, imported, message, searchId]);
  } catch (error) {
    await db.query("UPDATE niche_searches SET status = 'failed', error_message = $1, finished_at = NOW() WHERE id = $2", [String(error.message).slice(0, 500), searchId]);
    console.error(`Niche search ${searchId} failed:`, error.message);
  }
}

export async function startNicheSearch(db, niche, options = {}) {
  const active = await db.query(`SELECT * FROM niche_searches WHERE status = ANY($1::text[]) ORDER BY id DESC LIMIT 1`, [ACTIVE]);
  if (active.rowCount) return { ...active.rows[0], reused: true };
  const created = await db.query("INSERT INTO niche_searches(niche, search_term) VALUES ($1,$2) RETURNING *", [niche, niche]);
  const search = created.rows[0];
  setImmediate(() => runNicheSearch(db, search.id, options));
  return search;
}
