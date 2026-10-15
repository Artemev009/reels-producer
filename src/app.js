import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cacheReelMedia, startApifySync } from "./apify.js";
import { createAdminAuth } from "./auth.js";
import { createBackupSnapshot, restoreBackupSnapshot, restoreMediaAsset } from "./backup.js";
import { startNicheSearch } from "./niche.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDirectory = path.join(root, "public");

const reelFields = `
  r.id, r.competitor_id, r.platform_reel_id, r.source_url, r.video_url, r.thumbnail_url,
  r.title, r.description, r.hook_text, r.script_text, r.cta_text, r.duration_seconds,
  r.views_count, r.likes_count, r.comments_count, r.shares_count, r.is_favorite,
  r.play_count, r.media_status, r.hashtags, r.mentions, r.transcript,
  r.owner_username, r.owner_full_name, r.status, r.published_at, r.last_synced_at,
  r.created_at, r.updated_at,
  c.instagram_handle, c.display_name AS competitor_name
`;

function parseId(value, name = "id") {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    const error = new Error(`Некорректный ${name}`);
    error.statusCode = 400;
    throw error;
  }
  return id;
}

function requiredText(value, name, maxLength = 500) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`Поле «${name}» обязательно`);
    error.statusCode = 400;
    throw error;
  }
  return value.trim().slice(0, maxLength);
}

function optionalText(value, maxLength = 10_000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeInstagram(value) {
  const raw = requiredText(value, "Instagram аккаунт", 500);
  const match = raw.match(/instagram\.com\/([^/?#]+)/i);
  const username = (match?.[1] || raw).replace(/^@/, "").trim();
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(username)) {
    const error = new Error("Введите корректный Instagram username или ссылку на профиль");
    error.statusCode = 400;
    throw error;
  }
  return { handle: `@${username}`, profileUrl: `https://www.instagram.com/${username}` };
}

function publicError(error) {
  if (error.code === "23505") return { status: 409, message: "Такая запись уже существует" };
  if (error.code === "23503") return { status: 400, message: "Связанная запись не найдена" };
  return { status: error.statusCode || 500, message: error.statusCode ? error.message : "Внутренняя ошибка сервера" };
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function limitError(message) {
  return Object.assign(new Error(message), { statusCode: 429 });
}

async function enforceSyncBudget(db, competitorId, env) {
  const active = await db.query(
    "SELECT 1 FROM sync_runs WHERE competitor_id = $1 AND status IN ('queued','running','importing') LIMIT 1",
    [competitorId]
  );
  if (active.rowCount) return;
  const now = Date.now();
  const cooldownMinutes = positiveInteger(env.SYNC_COOLDOWN_MINUTES, 10);
  const hourlyLimit = positiveInteger(env.SYNC_HOURLY_LIMIT, 3);
  const dailyLimit = positiveInteger(env.SYNC_DAILY_LIMIT, 10);
  const [latest, hourly, daily] = await Promise.all([
    db.query("SELECT started_at FROM sync_runs WHERE competitor_id = $1 ORDER BY started_at DESC LIMIT 1", [competitorId]),
    db.query("SELECT COUNT(*)::INTEGER AS count FROM sync_runs WHERE started_at >= $1", [new Date(now - 60 * 60 * 1000)]),
    db.query("SELECT COUNT(*)::INTEGER AS count FROM sync_runs WHERE started_at >= $1", [new Date(now - 24 * 60 * 60 * 1000)])
  ]);
  if (latest.rowCount && now - new Date(latest.rows[0].started_at).getTime() < cooldownMinutes * 60 * 1000) {
    throw limitError(`Повторная загрузка этого аккаунта будет доступна через ${cooldownMinutes} минут`);
  }
  if (Number(hourly.rows[0].count) >= hourlyLimit) {
    throw limitError(`Бесплатный лимит: не более ${hourlyLimit} загрузок в час`);
  }
  if (Number(daily.rows[0].count) >= dailyLimit) {
    throw limitError(`Бесплатный лимит: не более ${dailyLimit} загрузок в сутки`);
  }
}

function byteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return false;
  return { start, end: Math.min(end, size - 1) };
}

export function createApp({ db, apifyImporter = startApifySync, mediaCacher = cacheReelMedia, nicheSearcher = startNicheSearch, env = process.env }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((_request, response, next) => {
    response.set({
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https: data:; media-src 'self' https: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    });
    next();
  });
  app.use(express.json({ limit: "256kb" }));
  const auth = createAdminAuth(env);

  app.get("/api/auth/status", auth.status);
  app.post("/api/auth/login", auth.login);
  app.post("/api/auth/logout", auth.logout);
  app.use("/api", (request, response, next) => {
    if (!["POST", "PATCH", "DELETE"].includes(request.method)) return next();
    return auth.requireMutation(request, response, next);
  });

  app.get("/health", async (_request, response) => {
    try {
      await db.query("SELECT 1");
      response.json({
        status: "ok",
        database: "connected",
        apify: env.APIFY_API_TOKEN ? "configured" : "missing",
        media_storage: env.R2_ACCOUNT_ID ? "object-storage" : "postgres-demo-cache"
      });
    } catch {
      response.status(503).json({ status: "error", database: "unavailable" });
    }
  });

  app.get("/api/admin/backup", auth.requireMutation, async (_request, response) => {
    const backup = await createBackupSnapshot(db);
    const date = new Date().toISOString().slice(0, 10);
    response.set({
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="reels-finder-backup-${date}.json"`
    });
    response.json(backup);
  });

  app.post("/api/admin/restore", express.json({ type: "application/vnd.reels-finder.backup+json", limit: "20mb" }), async (request, response) => {
    const result = await restoreBackupSnapshot(db, request.body);
    response.json({ data: result });
  });

  app.post("/api/admin/media/:reelId/:kind", express.raw({ type: () => true, limit: "150mb" }), async (request, response) => {
    const maxBytes = positiveInteger(env.RESTORE_MEDIA_MAX_BYTES, 120 * 1024 * 1024);
    if (!Buffer.isBuffer(request.body) || request.body.length > maxBytes) {
      return response.status(413).json({ error: "Медиафайл превышает лимит восстановления" });
    }
    const result = await restoreMediaAsset(db, parseId(request.params.reelId, "reelId"), request.params.kind, request.body, {
      contentType: request.headers["content-type"],
      sourceUrl: optionalText(request.headers["x-source-url"], 4000)
    });
    response.status(201).json({ data: result });
  });

  app.get("/api/media/:reelId/:kind", async (request, response) => {
    const kind = request.params.kind;
    if (!["video", "thumbnail"].includes(kind)) return response.status(404).json({ error: "Медиафайл не найден" });
    const result = await db.query(
      `SELECT content, content_type, size_bytes
       FROM media_assets
       WHERE reel_id = $1 AND kind = $2 AND storage_provider = 'postgres' AND content IS NOT NULL`,
      [parseId(request.params.reelId, "reelId"), kind]
    );
    if (!result.rowCount) return response.status(404).json({ error: "Медиафайл не найден" });
    const content = Buffer.from(result.rows[0].content);
    const range = byteRange(request.headers.range, content.length);
    response.set({
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=86400",
      "Content-Type": result.rows[0].content_type || (kind === "video" ? "video/mp4" : "image/jpeg")
    });
    if (range === false) {
      response.set("Content-Range", `bytes */${content.length}`);
      return response.status(416).end();
    }
    if (range) {
      const chunk = content.subarray(range.start, range.end + 1);
      response.set({
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${range.start}-${range.end}/${content.length}`
      });
      return response.status(206).end(chunk);
    }
    response.set("Content-Length", String(content.length));
    return response.end(content);
  });

  app.get("/api/competitors", async (_request, response) => {
    const [competitors, aggregates, syncs] = await Promise.all([
      db.query("SELECT * FROM competitors ORDER BY created_at DESC"),
      db.query(`
        SELECT competitor_id, COUNT(*)::INTEGER AS reels_count,
          COALESCE(SUM(views_count), 0)::BIGINT AS total_views,
          COALESCE(SUM(CASE WHEN media_status = 'stored' THEN 1 ELSE 0 END), 0)::INTEGER AS stored_media_count,
          COALESCE(SUM(CASE WHEN media_status = 'external' THEN 1 ELSE 0 END), 0)::INTEGER AS external_media_count,
          COALESCE(SUM(CASE WHEN media_status IN ('missing', 'failed') THEN 1 ELSE 0 END), 0)::INTEGER AS missing_media_count,
          MAX(published_at) AS latest_reel_at
        FROM reels
        GROUP BY competitor_id
      `),
      db.query("SELECT * FROM sync_runs ORDER BY id DESC")
    ]);
    const aggregateByCompetitor = new Map(
      aggregates.rows.map((row) => [String(row.competitor_id), row])
    );
    const latestByCompetitor = new Map();
    for (const sync of syncs.rows) {
      if (!latestByCompetitor.has(String(sync.competitor_id))) latestByCompetitor.set(String(sync.competitor_id), sync);
    }
    const now = Date.now();
    const cooldownMinutes = positiveInteger(env.SYNC_COOLDOWN_MINUTES, 10);
    const hourlyLimit = positiveInteger(env.SYNC_HOURLY_LIMIT, 3);
    const dailyLimit = positiveInteger(env.SYNC_DAILY_LIMIT, 10);
    const hourlyUsed = syncs.rows.filter((sync) => now - new Date(sync.started_at).getTime() < 60 * 60 * 1000).length;
    const dailyUsed = syncs.rows.filter((sync) => now - new Date(sync.started_at).getTime() < 24 * 60 * 60 * 1000).length;
    const data = competitors.rows.map((competitor) => {
      const sync = latestByCompetitor.get(String(competitor.id));
      const aggregate = aggregateByCompetitor.get(String(competitor.id));
      const nextSyncAt = sync?.started_at ? new Date(new Date(sync.started_at).getTime() + cooldownMinutes * 60 * 1000) : null;
      const syncActive = ["queued", "running", "importing"].includes(sync?.status);
      return {
        ...competitor,
        reels_count: aggregate?.reels_count || 0,
        total_views: aggregate?.total_views || 0,
        stored_media_count: aggregate?.stored_media_count || 0,
        external_media_count: aggregate?.external_media_count || 0,
        missing_media_count: aggregate?.missing_media_count || 0,
        latest_reel_at: aggregate?.latest_reel_at || null,
        sync_run_id: sync?.id || null,
        sync_status: sync?.status || null,
        sync_imported_count: sync?.imported_count || 0,
        sync_skipped_count: sync?.skipped_count || 0,
        sync_error: sync?.error_message || null,
        sync_started_at: sync?.started_at || null,
        sync_finished_at: sync?.finished_at || null,
        sync_next_available_at: nextSyncAt,
        sync_can_start: !syncActive && (!nextSyncAt || nextSyncAt.getTime() <= now) && hourlyUsed < hourlyLimit && dailyUsed < dailyLimit,
        sync_hourly_remaining: Math.max(0, hourlyLimit - hourlyUsed),
        sync_daily_remaining: Math.max(0, dailyLimit - dailyUsed)
      };
    });
    response.json({ data });
  });

  app.post("/api/competitors", async (request, response) => {
    const { handle, profileUrl } = normalizeInstagram(request.body.instagram || request.body.profile_url || "");
    const existing = await db.query("SELECT id FROM competitors WHERE instagram_handle = $1", [handle]);
    if (!existing.rowCount) {
      const count = await db.query("SELECT COUNT(*)::INTEGER AS count FROM competitors");
      const limit = positiveInteger(env.COMPETITOR_LIMIT, 10);
      if (Number(count.rows[0].count) >= limit) throw limitError(`Бесплатный стенд поддерживает до ${limit} конкурентов`);
    }
    const result = await db.query(
      `INSERT INTO competitors(instagram_handle, profile_url, display_name)
       VALUES ($1, $2, $1)
       ON CONFLICT (instagram_handle) DO UPDATE SET profile_url = EXCLUDED.profile_url, updated_at = NOW()
       RETURNING *`,
      [handle, profileUrl]
    );
    response.status(201).json({ data: result.rows[0] });
  });

  app.delete("/api/competitors/:id", async (request, response) => {
    const id = parseId(request.params.id);
    const active = await db.query(
      "SELECT 1 FROM sync_runs WHERE competitor_id = $1 AND status IN ('queued','running','importing') LIMIT 1",
      [id]
    );
    if (active.rowCount) return response.status(409).json({ error: "Дождитесь завершения синхронизации перед удалением" });
    const result = await db.query("DELETE FROM competitors WHERE id = $1 RETURNING id", [id]);
    if (!result.rowCount) return response.status(404).json({ error: "Конкурент не найден" });
    response.status(204).end();
  });

  app.post("/api/competitors/:id/sync", async (request, response) => {
    const id = parseId(request.params.id);
    const result = await db.query("SELECT * FROM competitors WHERE id = $1", [id]);
    if (!result.rowCount) return response.status(404).json({ error: "Конкурент не найден" });
    await enforceSyncBudget(db, id, env);
    const syncRun = await apifyImporter(db, result.rows[0]);
    response.status(202).json({ data: syncRun });
  });

  app.post("/api/niche-searches", async (request, response) => {
    if (!env.APIFY_API_TOKEN) return response.status(503).json({ error: "Apify не подключён" });
    const niche = requiredText(request.body.niche, "Ниша", 100);
    const budget = positiveInteger(env.NICHE_DAILY_LIMIT, 3);
    const used = await db.query("SELECT COUNT(*)::INTEGER AS count FROM niche_searches WHERE started_at >= $1", [new Date(Date.now() - 24 * 60 * 60 * 1000)]);
    if (Number(used.rows[0].count) >= budget) throw limitError(`Бесплатный лимит: не более ${budget} поисков по нише в сутки`);
    const search = await nicheSearcher(db, niche, { env });
    response.status(202).json({ data: search });
  });

  app.get("/api/niche-searches/:id", async (request, response) => {
    const result = await db.query("SELECT * FROM niche_searches WHERE id = $1", [parseId(request.params.id)]);
    if (!result.rowCount) return response.status(404).json({ error: "Поиск не найден" });
    response.json({ data: result.rows[0] });
  });

  app.get("/api/niche-searches/:id/results", async (request, response) => {
    const id = parseId(request.params.id);
    const [search, results] = await Promise.all([
      db.query("SELECT * FROM niche_searches WHERE id = $1", [id]),
      db.query(`SELECT ${reelFields}, nsr.relevance_score, nsr.matched_terms
        FROM niche_search_reels nsr JOIN reels r ON r.id = nsr.reel_id
        LEFT JOIN competitors c ON c.id = r.competitor_id
        WHERE nsr.search_id = $1 ORDER BY nsr.relevance_score DESC, r.views_count DESC LIMIT 50`, [id])
    ]);
    if (!search.rowCount) return response.status(404).json({ error: "Поиск не найден" });
    response.json({ data: { search: search.rows[0], reels: results.rows } });
  });

  app.get("/api/sync-runs/:id", async (request, response) => {
    const result = await db.query("SELECT * FROM sync_runs WHERE id = $1", [parseId(request.params.id)]);
    if (!result.rowCount) return response.status(404).json({ error: "Синхронизация не найдена" });
    response.json({ data: result.rows[0] });
  });

  app.get("/api/reels", async (request, response) => {
    const values = [];
    const conditions = [];
    if (request.query.favorite === "true") conditions.push("r.is_favorite = TRUE");
    if (request.query.competitor_id) {
      values.push(parseId(request.query.competitor_id, "competitor_id"));
      conditions.push(`r.competitor_id = $${values.length}`);
    }
    if (request.query.search) {
      values.push(`%${String(request.query.search).slice(0, 100)}%`);
      conditions.push(`(r.title ILIKE $${values.length} OR r.description ILIKE $${values.length} OR c.instagram_handle ILIKE $${values.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = request.query.sort === "views" ? "r.views_count DESC" : "r.published_at DESC NULLS LAST, r.id DESC";
    const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 100));
    const offset = Math.max(0, Number(request.query.offset) || 0);
    values.push(limit, offset);
    const result = await db.query(
      `SELECT ${reelFields} FROM reels r LEFT JOIN competitors c ON c.id = r.competitor_id ${where}
       ORDER BY ${order} LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    response.json({ data: result.rows });
  });

  app.get("/api/export/reels.csv", async (request, response) => {
    const values = [];
    let where = "";
    if (request.query.competitor_id) {
      values.push(parseId(request.query.competitor_id, "competitor_id"));
      where = "WHERE r.competitor_id = $1";
    }
    const result = await db.query(
      `SELECT r.id, c.instagram_handle, r.title, r.source_url, r.duration_seconds,
         r.views_count, r.likes_count, r.comments_count, r.shares_count, r.media_status,
         r.hook_text, r.script_text, r.cta_text, r.published_at
       FROM reels r LEFT JOIN competitors c ON c.id = r.competitor_id
       ${where} ORDER BY r.published_at DESC NULLS LAST, r.id DESC`,
      values
    );
    const quote = (value) => {
      const text = String(value ?? "");
      const safe = /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const header = ["id", "account", "title", "source_url", "duration_seconds", "views", "likes", "comments", "shares", "media_status", "hook", "script", "cta", "published_at"];
    const csv = [header, ...result.rows.map((row) => [row.id, row.instagram_handle, row.title, row.source_url,
      row.duration_seconds, row.views_count, row.likes_count, row.comments_count, row.shares_count,
      row.media_status, row.hook_text, row.script_text, row.cta_text, row.published_at])]
      .map((row) => row.map(quote).join(",")).join("\r\n");
    response.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="reels-finder-export.csv"',
      "Cache-Control": "no-store"
    });
    response.send(`\uFEFF${csv}`);
  });

  app.post("/api/reels/:id/cache-media", async (request, response) => {
    const id = parseId(request.params.id);
    const result = await mediaCacher(db, id, { env });
    const reel = await db.query("SELECT * FROM reels WHERE id = $1", [id]);
    response.json({ data: { ...result, reel: reel.rows[0] } });
  });

  app.get("/api/reels/:id", async (request, response) => {
    const result = await db.query(
      `SELECT ${reelFields} FROM reels r LEFT JOIN competitors c ON c.id = r.competitor_id WHERE r.id = $1`,
      [parseId(request.params.id)]
    );
    if (!result.rowCount) return response.status(404).json({ error: "Рилс не найден" });
    response.json({ data: result.rows[0] });
  });

  app.patch("/api/reels/:id", async (request, response) => {
    const allowed = {
      title: (value) => requiredText(value, "Название", 300),
      description: (value) => optionalText(value),
      hook_text: (value) => optionalText(value),
      script_text: (value) => optionalText(value),
      cta_text: (value) => optionalText(value),
      is_favorite: (value) => Boolean(value)
    };
    const updates = [];
    const values = [];
    for (const [field, convert] of Object.entries(allowed)) {
      if (!(field in request.body)) continue;
      values.push(convert(request.body[field]));
      updates.push(`${field} = $${values.length}`);
    }
    if (!updates.length) return response.status(400).json({ error: "Нет полей для обновления" });
    values.push(parseId(request.params.id));
    const result = await db.query(
      `UPDATE reels SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (!result.rowCount) return response.status(404).json({ error: "Рилс не найден" });
    response.json({ data: result.rows[0] });
  });

  app.delete("/api/reels/:id", async (request, response) => {
    const result = await db.query("DELETE FROM reels WHERE id = $1 RETURNING id", [parseId(request.params.id)]);
    if (!result.rowCount) return response.status(404).json({ error: "Рилс не найден" });
    response.status(204).end();
  });

  app.get("/api/scripts", async (_request, response) => {
    const result = await db.query(`
      SELECT s.*, r.thumbnail_url, r.duration_seconds
      FROM scripts s LEFT JOIN reels r ON r.id = s.reel_id
      ORDER BY s.updated_at DESC, s.id DESC
    `);
    response.json({ data: result.rows });
  });

  app.get("/api/scripts/:id", async (request, response) => {
    const result = await db.query(
      `SELECT s.*, r.thumbnail_url, r.duration_seconds, r.source_url
       FROM scripts s LEFT JOIN reels r ON r.id = s.reel_id
       WHERE s.id = $1`,
      [parseId(request.params.id)]
    );
    if (!result.rowCount) return response.status(404).json({ error: "Сценарий не найден" });
    response.json({ data: result.rows[0] });
  });

  app.post("/api/scripts", async (request, response) => {
    const scriptCount = await db.query("SELECT COUNT(*)::INTEGER AS count FROM scripts");
    const scriptLimit = positiveInteger(env.SCRIPT_LIMIT, 200);
    if (Number(scriptCount.rows[0].count) >= scriptLimit) throw limitError(`Бесплатный стенд поддерживает до ${scriptLimit} сценариев`);
    const reelId = request.body.reel_id ? parseId(request.body.reel_id, "reel_id") : null;
    let source = null;
    if (reelId) {
      const reel = await db.query("SELECT * FROM reels WHERE id = $1", [reelId]);
      if (!reel.rowCount) return response.status(404).json({ error: "Рилс не найден" });
      source = reel.rows[0];
    }
    const result = await db.query(
      `INSERT INTO scripts(reel_id, title, hook_text, script_text, cta_text)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [reelId, requiredText(request.body.title || source?.title || "Новый сценарий", "Название", 300),
        optionalText(request.body.hook_text ?? source?.hook_text), optionalText(request.body.script_text ?? source?.script_text),
        optionalText(request.body.cta_text ?? source?.cta_text)]
    );
    response.status(201).json({ data: result.rows[0] });
  });

  app.patch("/api/scripts/:id", async (request, response) => {
    const fields = ["title", "hook_text", "script_text", "cta_text", "status"];
    const updates = [];
    const values = [];
    for (const field of fields) {
      if (!(field in request.body)) continue;
      const value = field === "title" ? requiredText(request.body[field], "Название", 300) : optionalText(request.body[field]);
      if (field === "status" && !["draft", "ready", "published"].includes(value)) {
        return response.status(400).json({ error: "Некорректный статус" });
      }
      values.push(value);
      updates.push(`${field} = $${values.length}`);
    }
    if (!updates.length) return response.status(400).json({ error: "Нет полей для обновления" });
    values.push(parseId(request.params.id));
    const result = await db.query(
      `UPDATE scripts SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`, values
    );
    if (!result.rowCount) return response.status(404).json({ error: "Сценарий не найден" });
    response.json({ data: result.rows[0] });
  });

  app.delete("/api/scripts/:id", async (request, response) => {
    const result = await db.query("DELETE FROM scripts WHERE id = $1 RETURNING id", [parseId(request.params.id)]);
    if (!result.rowCount) return response.status(404).json({ error: "Сценарий не найден" });
    response.status(204).end();
  });

  app.use(express.static(publicDirectory, { extensions: ["html"] }));
  app.get("/{*path}", (_request, response) => response.sendFile(path.join(publicDirectory, "index.html")));

  app.use((error, _request, response, _next) => {
    const result = publicError(error);
    if (result.status >= 500) console.error(error);
    response.status(result.status).json({ error: result.message });
  });

  return app;
}
