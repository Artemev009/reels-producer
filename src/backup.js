import { withTransaction } from "./db.js";

const backupVersion = 1;

const columns = {
  competitors: ["instagram_handle", "profile_url", "display_name", "avatar_url", "bio", "follower_count", "following_count", "posts_count", "last_synced_at", "created_at", "updated_at"],
  reels: ["competitor_id", "platform_reel_id", "source_url", "video_url", "thumbnail_url", "title", "description", "hook_text", "script_text", "cta_text", "duration_seconds", "views_count", "likes_count", "comments_count", "shares_count", "is_favorite", "status", "published_at", "created_at", "updated_at", "owner_username", "owner_full_name", "transcript", "hashtags", "mentions", "audio", "play_count", "media_status", "last_synced_at"],
  scripts: ["reel_id", "title", "hook_text", "script_text", "cta_text", "status", "created_at", "updated_at"],
  tags: ["name"],
  sync_runs: ["competitor_id", "provider", "provider_run_id", "provider_dataset_id", "status", "imported_count", "skipped_count", "media_stored_count", "error_message", "started_at", "finished_at"],
  reel_metric_snapshots: ["reel_id", "views_count", "play_count", "likes_count", "comments_count", "shares_count", "captured_at"]
};

function requireArray(value, name) {
  if (!Array.isArray(value)) throw Object.assign(new Error(`В резервной копии отсутствует раздел ${name}`), { statusCode: 400 });
  return value;
}

async function insertRow(db, table, row, selectedColumns = columns[table]) {
  const values = selectedColumns.map((column) => row[column] ?? null);
  const placeholders = selectedColumns.map((_, index) => `$${index + 1}`).join(",");
  const result = await db.query(
    `INSERT INTO ${table}(${selectedColumns.join(",")}) VALUES (${placeholders}) RETURNING id`,
    values
  );
  return result.rows[0].id;
}

export async function createBackupSnapshot(db) {
  const [competitors, reels, scripts, tags, reelTags, syncRuns, snapshots, mediaAssets] = await Promise.all([
    db.query("SELECT * FROM competitors ORDER BY id"),
    db.query("SELECT * FROM reels ORDER BY id"),
    db.query("SELECT * FROM scripts ORDER BY id"),
    db.query("SELECT * FROM tags ORDER BY id"),
    db.query("SELECT * FROM reel_tags ORDER BY reel_id, tag_id"),
    db.query("SELECT * FROM sync_runs ORDER BY id"),
    db.query("SELECT * FROM reel_metric_snapshots ORDER BY id"),
    db.query(`SELECT id, reel_id, kind, storage_provider, storage_key, public_url, source_url,
      content_type, size_bytes, created_at, updated_at, (content IS NOT NULL) AS has_content
      FROM media_assets ORDER BY id`)
  ]);
  return {
    format: "reels-finder-backup",
    version: backupVersion,
    created_at: new Date().toISOString(),
    data: {
      competitors: competitors.rows,
      reels: reels.rows,
      scripts: scripts.rows,
      tags: tags.rows,
      reel_tags: reelTags.rows,
      sync_runs: syncRuns.rows,
      reel_metric_snapshots: snapshots.rows,
      media_assets: mediaAssets.rows
    }
  };
}

export async function restoreBackupSnapshot(db, backup) {
  if (backup?.format !== "reels-finder-backup" || Number(backup?.version) !== backupVersion) {
    throw Object.assign(new Error("Неподдерживаемый формат резервной копии"), { statusCode: 400 });
  }
  const data = backup.data || {};
  const competitors = requireArray(data.competitors, "competitors");
  const reels = requireArray(data.reels, "reels");
  const scripts = requireArray(data.scripts, "scripts");
  const tags = requireArray(data.tags, "tags");
  const reelTags = requireArray(data.reel_tags, "reel_tags");
  const syncRuns = requireArray(data.sync_runs, "sync_runs");
  const snapshots = requireArray(data.reel_metric_snapshots, "reel_metric_snapshots");
  const mediaAssets = requireArray(data.media_assets, "media_assets");

  return withTransaction(db, async (client) => {
    await client.query("DELETE FROM reel_metric_snapshots");
    await client.query("DELETE FROM media_assets");
    await client.query("DELETE FROM reel_tags");
    await client.query("DELETE FROM scripts");
    await client.query("DELETE FROM sync_runs");
    await client.query("DELETE FROM reels");
    await client.query("DELETE FROM tags");
    await client.query("DELETE FROM competitors");

    const competitorIds = new Map();
    for (const row of competitors) competitorIds.set(String(row.id), await insertRow(client, "competitors", row));

    const tagIds = new Map();
    for (const row of tags) tagIds.set(String(row.id), await insertRow(client, "tags", row));

    const assetByReel = new Map();
    for (const asset of mediaAssets) {
      const key = String(asset.reel_id);
      if (!assetByReel.has(key)) assetByReel.set(key, {});
      assetByReel.get(key)[asset.kind] = asset;
    }
    const reelIds = new Map();
    for (const source of reels) {
      const row = { ...source, competitor_id: source.competitor_id ? competitorIds.get(String(source.competitor_id)) : null };
      const assets = assetByReel.get(String(source.id)) || {};
      if (String(row.video_url || "").startsWith("/api/media/")) row.video_url = assets.video?.source_url || null;
      if (String(row.thumbnail_url || "").startsWith("/api/media/")) row.thumbnail_url = assets.thumbnail?.source_url || row.source_url;
      row.media_status = row.video_url ? "external" : "missing";
      reelIds.set(String(source.id), await insertRow(client, "reels", row));
    }

    const scriptIds = new Map();
    for (const source of scripts) {
      const row = { ...source, reel_id: source.reel_id ? reelIds.get(String(source.reel_id)) || null : null };
      scriptIds.set(String(source.id), await insertRow(client, "scripts", row));
    }
    for (const row of reelTags) {
      const reelId = reelIds.get(String(row.reel_id));
      const tagId = tagIds.get(String(row.tag_id));
      if (reelId && tagId) await client.query("INSERT INTO reel_tags(reel_id, tag_id) VALUES ($1,$2)", [reelId, tagId]);
    }
    for (const source of syncRuns) {
      const status = ["queued", "running", "importing"].includes(source.status) ? "failed" : source.status;
      const row = {
        ...source,
        competitor_id: competitorIds.get(String(source.competitor_id)),
        status,
        error_message: status !== source.status ? "Импорт был прерван до создания резервной копии" : source.error_message,
        finished_at: status !== source.status ? new Date() : source.finished_at
      };
      if (row.competitor_id) await insertRow(client, "sync_runs", row);
    }
    for (const source of snapshots) {
      const row = { ...source, reel_id: reelIds.get(String(source.reel_id)) };
      if (row.reel_id) await insertRow(client, "reel_metric_snapshots", row);
    }
    return {
      competitors: competitorIds.size,
      reels: reelIds.size,
      scripts: scriptIds.size,
      reelIds: Object.fromEntries(reelIds)
    };
  });
}

export async function restoreMediaAsset(db, reelId, kind, content, { contentType, sourceUrl } = {}) {
  if (!Buffer.isBuffer(content) || !content.length) throw Object.assign(new Error("Медиафайл пуст"), { statusCode: 400 });
  if (!["video", "thumbnail"].includes(kind)) throw Object.assign(new Error("Некорректный тип медиа"), { statusCode: 400 });
  const reel = await db.query("SELECT id FROM reels WHERE id = $1", [reelId]);
  if (!reel.rowCount) throw Object.assign(new Error("Рилс не найден"), { statusCode: 404 });
  const publicUrl = `/api/media/${reelId}/${kind}`;
  const bytea = `\\x${content.toString("hex")}`;
  await db.query(
    `INSERT INTO media_assets(reel_id, kind, storage_provider, public_url, source_url, content_type, size_bytes, content)
     VALUES ($1,$2,'postgres',$3,$4,$5,$6,$7)
     ON CONFLICT (reel_id, kind) DO UPDATE SET storage_provider = 'postgres', storage_key = NULL,
       public_url = EXCLUDED.public_url, source_url = EXCLUDED.source_url,
       content_type = EXCLUDED.content_type, size_bytes = EXCLUDED.size_bytes,
       content = EXCLUDED.content, updated_at = NOW()`,
    [reelId, kind, publicUrl, sourceUrl || null, contentType || (kind === "video" ? "video/mp4" : "image/jpeg"), content.length, bytea]
  );
  const column = kind === "video" ? "video_url" : "thumbnail_url";
  await db.query(
    `UPDATE reels SET ${column} = $1, media_status = CASE WHEN $2 = 'video' THEN 'stored' ELSE media_status END,
     updated_at = NOW() WHERE id = $3`,
    [publicUrl, kind, reelId]
  );
  return { reelId, kind, sizeBytes: content.length, publicUrl };
}
