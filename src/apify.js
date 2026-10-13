import { createMediaStorage, downloadRemote } from "./storage.js";

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function text(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || "";
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : [];
}

function fallbackSegments(description) {
  const lines = description.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const hook = (lines[0] || description.split(/[.!?]/)[0] || "").slice(0, 500);
  return { hook, script: description, cta: "" };
}

export function normalizeApifyReel(item, competitorId) {
  const sourceUrl = text(item.url, item.inputUrl, item.postUrl);
  const platformId = text(item.id, item.shortCode, item.code) || sourceUrl;
  if (!platformId || !sourceUrl) return null;
  const description = text(item.caption, item.description, item.text);
  const segments = fallbackSegments(description);
  return {
    competitorId, platformId, sourceUrl,
    videoUrl: text(item.downloadedVideo, item.videoUrl, item.video_url, item.videoPlayUrl) || null,
    originalVideoUrl: text(item.videoUrl, item.video_url, item.videoPlayUrl) || null,
    thumbnailUrl: text(item.displayUrl, item.thumbnailUrl, item.thumbnail_url, item.imageUrl),
    title: text(item.title, description.split("\n")[0], "Instagram Reel").slice(0, 240),
    description, hookText: segments.hook, scriptText: segments.script, ctaText: segments.cta,
    transcript: text(item.transcript, item.videoTranscript),
    hashtags: stringList(item.hashtags), mentions: stringList(item.mentions),
    audio: item.musicInfo && typeof item.musicInfo === "object" ? item.musicInfo : {},
    ownerUsername: text(item.ownerUsername), ownerFullName: text(item.ownerFullName),
    ownerAvatarUrl: text(item.ownerProfilePicUrl, item.ownerProfilePicUrlHd),
    durationSeconds: number(item.videoDuration ?? item.duration),
    viewsCount: number(item.videoViewCount ?? item.viewCount ?? item.viewsCount) || number(item.videoPlayCount ?? item.playCount),
    playCount: number(item.videoPlayCount ?? item.playCount),
    likesCount: number(item.likesCount ?? item.likes),
    commentsCount: number(item.commentsCount ?? item.comments),
    sharesCount: number(item.sharesCount ?? item.shares),
    publishedAt: item.timestamp || item.publishedAt || null
  };
}

async function saveAsset(db, reelId, kind, asset) {
  await db.query(
    `INSERT INTO media_assets(reel_id, kind, storage_provider, storage_key, public_url, source_url, content_type, size_bytes, content)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (reel_id, kind) DO UPDATE SET
       storage_provider = EXCLUDED.storage_provider, storage_key = EXCLUDED.storage_key,
       public_url = EXCLUDED.public_url, source_url = EXCLUDED.source_url,
       content_type = EXCLUDED.content_type, size_bytes = EXCLUDED.size_bytes,
       content = EXCLUDED.content, updated_at = NOW()`,
    [reelId, kind, asset.provider, asset.key, asset.publicUrl, asset.sourceUrl, asset.contentType, asset.sizeBytes, asset.content || null]
  );
}

function databaseCacheEnabled(env) {
  return String(env.DATABASE_MEDIA_CACHE || "true").toLowerCase() !== "false";
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function hasDatabaseCacheSlot(db, reelId, env) {
  const existing = await db.query(
    "SELECT 1 FROM media_assets WHERE reel_id = $1 AND kind = 'video' AND storage_provider = 'postgres' AND content IS NOT NULL",
    [reelId]
  );
  if (existing.rowCount) return true;
  const usage = await db.query(
    `SELECT COUNT(DISTINCT reel_id) FILTER (WHERE kind = 'video')::INTEGER AS reel_count,
       COALESCE(SUM(size_bytes), 0)::BIGINT AS total_bytes
     FROM media_assets WHERE storage_provider = 'postgres' AND content IS NOT NULL`
  );
  const limit = positiveInteger(env.DATABASE_MEDIA_REELS_LIMIT, 5);
  const maxBytes = positiveInteger(env.DATABASE_MEDIA_TOTAL_BYTES, 280 * 1024 * 1024);
  return Number(usage.rows[0].reel_count) < limit && Number(usage.rows[0].total_bytes) < maxBytes;
}

async function storeInDatabase({ reelId, kind, sourceUrl, env }) {
  const maxBytes = kind === "video"
    ? positiveInteger(env.DATABASE_MEDIA_VIDEO_MAX_BYTES, 50 * 1024 * 1024)
    : positiveInteger(env.DATABASE_MEDIA_THUMBNAIL_MAX_BYTES, 5 * 1024 * 1024);
  const { bytes, contentType } = await downloadRemote(sourceUrl, { maxBytes, kind });
  return {
    provider: "postgres",
    key: null,
    publicUrl: `/api/media/${reelId}/${kind}`,
    contentType,
    sizeBytes: bytes.byteLength,
    sourceUrl,
    content: Buffer.from(bytes)
  };
}

async function persistMedia(db, storage, reelId, reel, env = process.env) {
  const useDatabase = !storage.configured && databaseCacheEnabled(env) && await hasDatabaseCacheSlot(db, reelId, env);
  if ((!storage.configured && !useDatabase) || (!reel.videoUrl && !reel.thumbnailUrl)) return { stored: 0, failed: 0 };
  await db.query("UPDATE reels SET media_status = 'storing' WHERE id = $1", [reelId]);
  let stored = 0;
  let failed = 0;
  let videoStored = false;
  for (const [kind, sourceUrl] of [["video", reel.videoUrl], ["thumbnail", reel.thumbnailUrl]]) {
    if (!sourceUrl) continue;
    try {
      const asset = storage.configured
        ? await storage.storeRemote({ reelId, kind, sourceUrl })
        : await storeInDatabase({ reelId, kind, sourceUrl, env });
      if (!asset) continue;
      await saveAsset(db, reelId, kind, asset);
      const column = kind === "video" ? "video_url" : "thumbnail_url";
      await db.query(`UPDATE reels SET ${column} = $1, updated_at = NOW() WHERE id = $2`, [asset.publicUrl, reelId]);
      stored += 1;
      if (kind === "video") videoStored = true;
    } catch (error) {
      failed += 1;
      console.error(`Media ${kind} failed for reel ${reelId}:`, error.message);
    }
  }
  const mediaStatus = videoStored ? "stored" : reel.videoUrl ? "external" : "missing";
  await db.query("UPDATE reels SET media_status = $1, updated_at = NOW() WHERE id = $2", [mediaStatus, reelId]);
  return { stored, failed, videoStored };
}

export async function runApifySync(db, competitor, syncRunId, { storage = createMediaStorage(), env = process.env } = {}) {
  const token = env.APIFY_API_TOKEN;
  const actorId = env.APIFY_ACTOR_ID || "apify/instagram-reel-scraper";
  if (!token) throw Object.assign(new Error("Apify ещё не подключён: добавьте APIFY_API_TOKEN в Render."), { statusCode: 503 });
  try {
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const safeActorId = encodeURIComponent(actorId.replace("/", "~"));
    const startedResponse = await fetch(`https://api.apify.com/v2/acts/${safeActorId}/runs`, {
      method: "POST", headers,
      body: JSON.stringify({
        username: [competitor.instagram_handle.replace(/^@/, "")], resultsLimit: Number(env.APIFY_RESULTS_LIMIT || 20),
        includeDownloadedVideo: env.APIFY_DOWNLOAD_VIDEOS === "true",
        includeTranscript: env.APIFY_INCLUDE_TRANSCRIPT === "true",
        includeSharesCount: env.APIFY_INCLUDE_SHARES === "true", skipPinnedPosts: true
      })
    });
    if (!startedResponse.ok) throw new Error(`Apify отклонил запуск: ${startedResponse.status}`);
    let run = (await startedResponse.json()).data;
    await db.query("UPDATE sync_runs SET provider_run_id = $1, status = 'running' WHERE id = $2", [run.id, syncRunId]);
    for (let attempt = 0; !["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run.status) && attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const response = await fetch(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(run.id)}`, { headers });
      if (!response.ok) throw new Error(`Не удалось получить статус Apify: ${response.status}`);
      run = (await response.json()).data;
    }
    if (run.status !== "SUCCEEDED") throw new Error(`Запуск Apify завершён со статусом ${run.status}`);
    await db.query("UPDATE sync_runs SET status = 'importing', provider_dataset_id = $1 WHERE id = $2", [run.defaultDatasetId, syncRunId]);
    const datasetResponse = await fetch(`https://api.apify.com/v2/datasets/${encodeURIComponent(run.defaultDatasetId)}/items?clean=true&limit=${Number(env.APIFY_RESULTS_LIMIT || 20)}`, { headers });
    if (!datasetResponse.ok) throw new Error(`Не удалось получить Dataset Apify: ${datasetResponse.status}`);
    const items = await datasetResponse.json();
    let importedCount = 0, skippedCount = 0, mediaStoredCount = 0, mediaFailures = 0;
    let firstReel = null;
    for (const item of items) {
      const reel = normalizeApifyReel(item, competitor.id);
      if (!reel || !reel.thumbnailUrl) { skippedCount += 1; continue; }
      firstReel ||= reel;
      const result = await db.query(
        `INSERT INTO reels (
          competitor_id, platform_reel_id, source_url, video_url, thumbnail_url, title,
          description, hook_text, script_text, cta_text, transcript, hashtags, mentions, audio,
          owner_username, owner_full_name, duration_seconds, views_count, play_count, likes_count,
          comments_count, shares_count, media_status, published_at, last_synced_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,NOW())
        ON CONFLICT (platform_reel_id) DO UPDATE SET
          competitor_id = EXCLUDED.competitor_id, source_url = EXCLUDED.source_url,
          video_url = CASE WHEN reels.media_status = 'stored' THEN reels.video_url ELSE COALESCE(EXCLUDED.video_url, reels.video_url) END,
          thumbnail_url = CASE WHEN reels.media_status = 'stored' THEN reels.thumbnail_url ELSE EXCLUDED.thumbnail_url END,
          title = EXCLUDED.title, description = EXCLUDED.description, transcript = EXCLUDED.transcript,
          hashtags = EXCLUDED.hashtags, mentions = EXCLUDED.mentions, audio = EXCLUDED.audio,
          owner_username = EXCLUDED.owner_username, owner_full_name = EXCLUDED.owner_full_name,
          duration_seconds = EXCLUDED.duration_seconds, views_count = EXCLUDED.views_count,
          play_count = EXCLUDED.play_count, likes_count = EXCLUDED.likes_count,
          comments_count = EXCLUDED.comments_count, shares_count = EXCLUDED.shares_count,
          media_status = CASE WHEN reels.media_status = 'stored' THEN 'stored' ELSE EXCLUDED.media_status END,
          published_at = EXCLUDED.published_at, last_synced_at = NOW(), updated_at = NOW()
        RETURNING id`,
        [reel.competitorId, reel.platformId, reel.sourceUrl, reel.videoUrl, reel.thumbnailUrl, reel.title,
          reel.description, reel.hookText, reel.scriptText, reel.ctaText, reel.transcript,
          JSON.stringify(reel.hashtags), JSON.stringify(reel.mentions), JSON.stringify(reel.audio),
          reel.ownerUsername, reel.ownerFullName, reel.durationSeconds, reel.viewsCount, reel.playCount,
          reel.likesCount, reel.commentsCount, reel.sharesCount, reel.videoUrl ? "external" : "missing", reel.publishedAt]
      );
      const reelId = result.rows[0].id;
      await db.query(
        `INSERT INTO reel_metric_snapshots(reel_id, views_count, play_count, likes_count, comments_count, shares_count)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [reelId, reel.viewsCount, reel.playCount, reel.likesCount, reel.commentsCount, reel.sharesCount]
      );
      const media = await persistMedia(db, storage, reelId, reel, env);
      mediaStoredCount += media.stored; mediaFailures += media.failed; importedCount += 1;
    }
    if (firstReel) {
      await db.query(
        `UPDATE competitors SET display_name = COALESCE(NULLIF($1, ''), display_name),
         avatar_url = COALESCE(NULLIF($2, ''), avatar_url), last_synced_at = NOW(), updated_at = NOW() WHERE id = $3`,
        [firstReel.ownerFullName, firstReel.ownerAvatarUrl, competitor.id]
      );
    }
    const finalStatus = skippedCount || mediaFailures ? "partial" : "succeeded";
    await db.query(
      `UPDATE sync_runs SET status = $1, imported_count = $2, skipped_count = $3,
       media_stored_count = $4, finished_at = NOW() WHERE id = $5`,
      [finalStatus, importedCount, skippedCount, mediaStoredCount, syncRunId]
    );
    return { syncRunId, importedCount, skippedCount, mediaStoredCount, status: finalStatus };
  } catch (error) {
    await db.query("UPDATE sync_runs SET status = 'failed', error_message = $1, finished_at = NOW() WHERE id = $2", [String(error.message).slice(0, 1000), syncRunId]);
    throw error;
  }
}

export async function warmDatabaseMediaCache(db, { storage = createMediaStorage(), env = process.env } = {}) {
  if (storage.configured || !databaseCacheEnabled(env)) return { storedReels: 0, skipped: true };
  const limit = positiveInteger(env.DATABASE_MEDIA_REELS_LIMIT, 5);
  const candidates = await db.query(
    `SELECT id, video_url, thumbnail_url
     FROM reels
     WHERE video_url IS NOT NULL
       AND video_url NOT LIKE '/api/media/%'
       AND platform_reel_id NOT LIKE 'demo-%'
     ORDER BY published_at DESC NULLS LAST, id DESC
     LIMIT $1`,
    [limit * 4]
  );
  let storedReels = 0;
  for (const row of candidates.rows) {
    if (!await hasDatabaseCacheSlot(db, row.id, env)) break;
    const result = await persistMedia(db, storage, row.id, {
      videoUrl: row.video_url,
      thumbnailUrl: row.thumbnail_url
    }, env);
    if (result.videoStored) storedReels += 1;
  }
  console.log(`PostgreSQL media cache warmed: ${storedReels} reel(s)`);
  return { storedReels, skipped: false };
}

export async function startApifySync(db, competitor, options = {}) {
  const active = await db.query(
    "SELECT * FROM sync_runs WHERE competitor_id = $1 AND status IN ('queued','running','importing') ORDER BY id DESC LIMIT 1",
    [competitor.id]
  );
  if (active.rowCount) return { ...active.rows[0], reused: true };
  const created = await db.query("INSERT INTO sync_runs(competitor_id, status) VALUES ($1, 'queued') RETURNING *", [competitor.id]);
  const syncRun = created.rows[0];
  setImmediate(() => runApifySync(db, competitor, syncRun.id, options).catch((error) => console.error(`Apify sync ${syncRun.id} failed:`, error.message)));
  return syncRun;
}
