import { normalizeApifyReel } from "./apify.js";

const ACTIVE = ["queued", "running", "importing"];

function keywords(value) {
  return String(value || "").toLocaleLowerCase("ru")
    .split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2);
}

function relevance(item, terms) {
  const haystack = `${item.caption || ""} ${(item.hashtags || []).join(" ")}`.toLocaleLowerCase("ru");
  const matched = [...new Set(terms.filter((term) => haystack.includes(term)))];
  return { score: terms.length ? Math.round(matched.length / terms.length * 100) : 0, matched };
}

async function apifyRequest(url, token, options) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options?.headers || {}) }
  });
  if (!response.ok) throw new Error(`Apify вернул ошибку ${response.status}`);
  return response.json();
}

export async function runNicheSearch(db, searchId, { env = process.env } = {}) {
  const token = env.APIFY_API_TOKEN;
  if (!token) throw new Error("Apify не подключён: добавьте APIFY_API_TOKEN в Render.");
  const found = await db.query("SELECT * FROM niche_searches WHERE id = $1", [searchId]);
  if (!found.rowCount) return;
  const search = found.rows[0];
  try {
    await db.query("UPDATE niche_searches SET status = 'running' WHERE id = $1", [searchId]);
    const actor = encodeURIComponent((env.APIFY_NICHE_ACTOR_ID || "apify/instagram-search-scraper").replace("/", "~"));
    const limit = Math.min(20, Math.max(1, Number(env.NICHE_RESULTS_LIMIT) || 10));
    const started = await apifyRequest(`https://api.apify.com/v2/acts/${actor}/runs`, token, {
      method: "POST",
      body: JSON.stringify({ search: search.search_term, searchType: "popular", searchLimit: limit })
    });
    let run = started.data;
    await db.query("UPDATE niche_searches SET provider_run_id = $1 WHERE id = $2", [run.id, searchId]);
    for (let attempt = 0; !["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run.status) && attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      run = (await apifyRequest(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(run.id)}`, token)).data;
    }
    if (run.status !== "SUCCEEDED") throw new Error(`Поиск завершился со статусом ${run.status}`);
    await db.query("UPDATE niche_searches SET status = 'importing' WHERE id = $1", [searchId]);
    const items = await apifyRequest(`https://api.apify.com/v2/datasets/${encodeURIComponent(run.defaultDatasetId)}/items?clean=true&limit=${limit}`, token);
    const terms = keywords(search.niche);
    let imported = 0;
    for (const item of items) {
      if (!(item.type === "Video" || item.productType === "clips" || item.videoUrl) || !item.ownerUsername) continue;
      const username = String(item.ownerUsername).replace(/^@/, "").toLowerCase();
      if (!/^[a-z0-9._]{1,30}$/.test(username)) continue;
      const creator = await db.query(
        `INSERT INTO competitors(instagram_handle, profile_url, display_name)
         VALUES ($1,$2,$3)
         ON CONFLICT (instagram_handle) DO UPDATE SET
           display_name = EXCLUDED.display_name, updated_at = NOW()
         RETURNING id`,
        [`@${username}`, `https://www.instagram.com/${username}`, item.ownerFullName || `@${username}`]
      );
      const reel = normalizeApifyReel(item, creator.rows[0].id);
      if (!reel?.thumbnailUrl) continue;
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
      const matched = relevance(item, terms);
      await db.query(
        `INSERT INTO niche_search_reels(search_id, reel_id, relevance_score, matched_terms)
         VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (search_id, reel_id) DO UPDATE SET relevance_score = EXCLUDED.relevance_score, matched_terms = EXCLUDED.matched_terms`,
        [searchId, saved.rows[0].id, matched.score, JSON.stringify(matched.matched)]
      );
      imported += 1;
    }
    await db.query("UPDATE niche_searches SET status = $1, imported_count = $2, finished_at = NOW() WHERE id = $3", [imported ? "succeeded" : "partial", imported, searchId]);
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
