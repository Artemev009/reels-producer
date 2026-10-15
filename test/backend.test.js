import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { newDb } from "pg-mem";
import { backfillMissingSegments, cacheReelMedia, normalizeApifyReel, recoverInterruptedSyncRuns } from "../src/apify.js";
import { runNicheSearch } from "../src/niche.js";
import { createApp } from "../src/app.js";
import { createBackupSnapshot, restoreBackupSnapshot, restoreMediaAsset } from "../src/backup.js";

function addCurrentReelColumns(memory) {
  memory.public.none(`
    ALTER TABLE reels ADD COLUMN play_count BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE reels ADD COLUMN media_status TEXT NOT NULL DEFAULT 'missing';
    ALTER TABLE reels ADD COLUMN hashtags JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE reels ADD COLUMN mentions JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE reels ADD COLUMN audio JSONB NOT NULL DEFAULT '{}';
    ALTER TABLE reels ADD COLUMN transcript TEXT NOT NULL DEFAULT '';
    ALTER TABLE reels ADD COLUMN owner_username TEXT NOT NULL DEFAULT '';
    ALTER TABLE reels ADD COLUMN owner_full_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE reels ADD COLUMN last_synced_at TIMESTAMPTZ;
    ALTER TABLE sync_runs ADD COLUMN provider_dataset_id TEXT;
    ALTER TABLE sync_runs ADD COLUMN skipped_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sync_runs ADD COLUMN media_stored_count INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE media_assets (
      id BIGSERIAL PRIMARY KEY,
      reel_id BIGINT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      storage_provider TEXT NOT NULL,
      storage_key TEXT,
      public_url TEXT NOT NULL,
      source_url TEXT,
      content_type TEXT,
      size_bytes BIGINT,
      content BYTEA,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (reel_id, kind)
    );
    CREATE TABLE reel_metric_snapshots (
      id BIGSERIAL PRIMARY KEY,
      reel_id BIGINT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
      views_count BIGINT NOT NULL DEFAULT 0,
      play_count BIGINT NOT NULL DEFAULT 0,
      likes_count BIGINT NOT NULL DEFAULT 0,
      comments_count BIGINT NOT NULL DEFAULT 0,
      shares_count BIGINT NOT NULL DEFAULT 0,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

test("PostgreSQL migration creates the application tables", async () => {
  const memory = newDb({ noAstCoverageCheck: true });
  const schema = await readFile(new URL("../db/migrations/001_schema.sql", import.meta.url), "utf8");
  memory.public.none(schema);
  const tables = memory.public.many(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
  ).map((row) => row.table_name);
  for (const table of ["competitors", "reels", "scripts", "tags", "reel_tags", "sync_runs"]) {
    assert.ok(tables.includes(table), `${table} should exist`);
  }
});

test("Apify output is normalized into the SQL reel model", () => {
  const reel = normalizeApifyReel({
    id: "abc123",
    url: "https://instagram.com/reel/abc123",
    displayUrl: "https://cdn.example/preview.jpg",
    videoUrl: "https://cdn.example/video.mp4",
    caption: "Hook text\nMore text",
    videoDuration: 31.6,
    videoViewCount: 1200,
    likesCount: 87,
    commentsCount: 9
  }, 42);

  assert.equal(reel.competitorId, 42);
  assert.equal(reel.platformId, "abc123");
  assert.equal(reel.title, "Hook text");
  assert.equal(reel.durationSeconds, 32);
  assert.equal(reel.viewsCount, 1200);
  assert.equal(reel.videoUrl, "https://cdn.example/video.mp4");
  assert.equal(reel.hookText, "Hook text");
  assert.ok(reel.ctaText.includes("не найден"));

  const structured = normalizeApifyReel({
    id: "structured",
    url: "https://instagram.com/reel/structured",
    displayUrl: "https://cdn.example/preview.jpg",
    caption: "A strong hook.\nThe useful middle.\nSave this post for later."
  }, 42);
  assert.equal(structured.hookText, "A strong hook.");
  assert.equal(structured.scriptText, "The useful middle.");
  assert.equal(structured.ctaText, "Save this post for later.");

  const fallback = normalizeApifyReel({
    id: "with-plays",
    url: "https://instagram.com/reel/with-plays",
    displayUrl: "https://cdn.example/preview.jpg",
    videoViewCount: 0,
    videoPlayCount: 9876
  }, 42);
  assert.equal(fallback.viewsCount, 9876);

  const short = normalizeApifyReel({
    id: "short",
    url: "https://instagram.com/reel/short",
    displayUrl: "https://cdn.example/preview.jpg",
    caption: "Only one sentence."
  }, 42);
  assert.notEqual(short.scriptText, short.hookText);
  assert.match(short.scriptText, /не найден/i);
});

test("niche discovery imports matching reels and creators without a live Apify run", async () => {
  const memory = newDb({ noAstCoverageCheck: true });
  const schema = await readFile(new URL("../db/migrations/001_schema.sql", import.meta.url), "utf8");
  memory.public.none(schema);
  addCurrentReelColumns(memory);
  memory.public.none(await readFile(new URL("../db/migrations/005_niche_discovery.sql", import.meta.url), "utf8"));
  const pool = new (memory.adapters.createPg().Pool)();
  const search = await pool.query("INSERT INTO niche_searches(niche, search_term) VALUES ($1,$1) RETURNING id", ["обучение нейросетям"]);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (options?.method === "POST") return Response.json({ data: { id: "run-1", status: "SUCCEEDED", defaultDatasetId: "dataset-1" } });
    if (String(url).includes("actor-runs")) return Response.json({ data: { id: "run-1", status: "SUCCEEDED", defaultDatasetId: "dataset-1" } });
    return Response.json([{
      id: "niche-reel-1", shortCode: "niche-reel-1", type: "Video", productType: "clips",
      url: "https://www.instagram.com/reel/niche-reel-1/", ownerUsername: "ai.creator",
      ownerFullName: "AI Creator", displayUrl: "https://cdn.example/cover.jpg",
      videoUrl: "https://cdn.example/video.mp4", caption: "Обучение нейросетям: простой разбор",
      hashtags: ["нейросети"], videoViewCount: 5000, likesCount: 120, commentsCount: 8
    }]);
  };
  try {
    await runNicheSearch(pool, search.rows[0].id, { env: { APIFY_API_TOKEN: "fake-token" } });
  } finally {
    globalThis.fetch = previousFetch;
  }
  const status = await pool.query("SELECT status, imported_count FROM niche_searches WHERE id = $1", [search.rows[0].id]);
  const imported = await pool.query("SELECT r.title, c.instagram_handle, nsr.relevance_score, nsr.matched_terms FROM niche_search_reels nsr JOIN reels r ON r.id = nsr.reel_id JOIN competitors c ON c.id = r.competitor_id");
  assert.equal(status.rows[0].status, "succeeded");
  assert.equal(Number(status.rows[0].imported_count), 1);
  assert.equal(imported.rows[0].instagram_handle, "@ai.creator");
  assert.equal(imported.rows[0].relevance_score, 100);
  assert.deepEqual(imported.rows[0].matched_terms, ["обучение", "нейросетям"]);
});

test("REST API reads seeded reels and persists a script", async () => {
  const memory = newDb({ noAstCoverageCheck: true });
  const schema = await readFile(new URL("../db/migrations/001_schema.sql", import.meta.url), "utf8");
  memory.public.none(schema);
  addCurrentReelColumns(memory);
  const nicheSchema = await readFile(new URL("../db/migrations/005_niche_discovery.sql", import.meta.url), "utf8");
  memory.public.none(nicheSchema);
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  const competitor = await pool.query(
    "INSERT INTO competitors(instagram_handle, profile_url) VALUES ('@test', 'https://instagram.com/test') RETURNING id"
  );
  const reel = await pool.query(
    `INSERT INTO reels(competitor_id, platform_reel_id, source_url, thumbnail_url, title)
     VALUES ($1, 'test-reel', 'https://instagram.com/reel/test', 'https://example.com/test.jpg', 'Test reel') RETURNING id`,
    [competitor.rows[0].id]
  );
  await pool.query(
    "UPDATE reels SET description = 'Start here. Useful middle. Save this post.' WHERE id = $1",
    [reel.rows[0].id]
  );
  assert.equal(await backfillMissingSegments(pool), 1);
  const segments = await pool.query("SELECT hook_text, script_text, cta_text FROM reels WHERE id = $1", [reel.rows[0].id]);
  assert.equal(segments.rows[0].hook_text, "Start here.");
  assert.equal(segments.rows[0].script_text, "Useful middle.");
  assert.equal(segments.rows[0].cta_text, "Save this post.");
  await pool.query("UPDATE reels SET script_text = description WHERE id = $1", [reel.rows[0].id]);
  assert.equal(await backfillMissingSegments(pool), 1);
  const refined = await pool.query("SELECT script_text FROM reels WHERE id = $1", [reel.rows[0].id]);
  assert.equal(refined.rows[0].script_text, "Useful middle.");
  await pool.query(
    "INSERT INTO scripts(reel_id, title) VALUES ($1, 'Existing script')",
    [reel.rows[0].id]
  );
  const server = createApp({
    db: pool,
    env: { APIFY_API_TOKEN: "test-token", SCRIPT_LIMIT: "2", SYNC_COOLDOWN_MINUTES: "10", SYNC_HOURLY_LIMIT: "3", SYNC_DAILY_LIMIT: "10" },
    mediaCacher: async (_db, reelId) => ({ reelId, stored: true, evictedReelId: null, assetsStored: 2 }),
    nicheSearcher: async (db, niche) => (await db.query(
      "INSERT INTO niche_searches(niche, search_term) VALUES ($1,$1) RETURNING *", [niche]
    )).rows[0],
    apifyImporter: async (_db, selectedCompetitor) => ({
      id: 77,
      competitor_id: selectedCompetitor.id,
      status: "queued"
    })
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const reelsResponse = await fetch(`${base}/api/reels`);
    const reels = (await reelsResponse.json()).data;
    assert.equal(reelsResponse.status, 200);
    assert.equal(reels.length, 1);
    assert.equal(reelsResponse.headers.get("x-content-type-options"), "nosniff");
    assert.match(reelsResponse.headers.get("content-security-policy"), /frame-ancestors 'none'/);

    const backupResponse = await fetch(`${base}/api/admin/backup`);
    assert.equal(backupResponse.status, 200);
    assert.equal((await backupResponse.json()).data.reels.length, 1);

    const csvResponse = await fetch(`${base}/api/export/reels.csv`);
    assert.equal(csvResponse.status, 200);
    assert.match(csvResponse.headers.get("content-type"), /text\/csv/);
    assert.match(await csvResponse.text(), /Test reel/);

    const cacheResponse = await fetch(`${base}/api/reels/${reels[0].id}/cache-media`, { method: "POST" });
    assert.equal(cacheResponse.status, 200);
    assert.equal((await cacheResponse.json()).data.assetsStored, 2);

    const competitorsResponse = await fetch(`${base}/api/competitors`);
    const competitors = (await competitorsResponse.json()).data;
    assert.equal(competitorsResponse.status, 200);
    assert.equal(competitors[0].reels_count, 1);
    assert.equal(Number(competitors[0].total_views), 0);
    assert.equal(competitors[0].stored_media_count, 0);
    assert.equal(competitors[0].external_media_count, 0);
    assert.equal(competitors[0].missing_media_count, 1);
    assert.equal(competitors[0].sync_can_start, true);
    assert.equal(competitors[0].sync_hourly_remaining, 3);

    const nicheResponse = await fetch(`${base}/api/niche-searches`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ niche: "магазин обуви" })
    });
    assert.equal(nicheResponse.status, 202);
    const nicheSearch = (await nicheResponse.json()).data;
    assert.equal(nicheSearch.niche, "магазин обуви");
    const nicheStatus = await fetch(`${base}/api/niche-searches/${nicheSearch.id}`);
    assert.equal((await nicheStatus.json()).data.status, "queued");
    const nicheResults = await fetch(`${base}/api/niche-searches/${nicheSearch.id}/results`);
    assert.equal((await nicheResults.json()).data.reels.length, 0);

    const syncResponse = await fetch(`${base}/api/competitors/${competitors[0].id}/sync`, { method: "POST" });
    const syncRun = (await syncResponse.json()).data;
    assert.equal(syncResponse.status, 202);
    assert.equal(syncRun.status, "queued");

    const scriptResponse = await fetch(`${base}/api/scripts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reel_id: reels[0].id })
    });
    assert.equal(scriptResponse.status, 201);
    const createdScript = (await scriptResponse.json()).data;
    const detailResponse = await fetch(`${base}/api/scripts/${createdScript.id}`);
    assert.equal(detailResponse.status, 200);
    assert.equal((await detailResponse.json()).data.title, "Test reel");

    const updateResponse = await fetch(`${base}/api/scripts/${createdScript.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Edited script", status: "ready" })
    });
    assert.equal(updateResponse.status, 200);
    assert.equal((await updateResponse.json()).data.status, "ready");
    const scripts = (await (await fetch(`${base}/api/scripts`)).json()).data;
    assert.equal(scripts.length, 2);

    const limitedScriptResponse = await fetch(`${base}/api/scripts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Over the demo limit" })
    });
    assert.equal(limitedScriptResponse.status, 429);

    await pool.query(
      `INSERT INTO sync_runs(competitor_id, status) VALUES
       ($1, 'succeeded'), ($1, 'succeeded'), ($1, 'succeeded')`,
      [competitor.rows[0].id]
    );
    const limitedSyncResponse = await fetch(`${base}/api/competitors/${competitor.rows[0].id}/sync`, {
      method: "POST"
    });
    assert.equal(limitedSyncResponse.status, 429);

    const protectedCompetitor = await pool.query(
      "INSERT INTO competitors(instagram_handle, profile_url) VALUES ('@active', 'https://instagram.com/active') RETURNING id"
    );
    await pool.query("INSERT INTO sync_runs(competitor_id, status) VALUES ($1, 'queued')", [protectedCompetitor.rows[0].id]);
    const protectedDelete = await fetch(`${base}/api/competitors/${protectedCompetitor.rows[0].id}`, { method: "DELETE" });
    assert.equal(protectedDelete.status, 409);
    await pool.query("UPDATE sync_runs SET status = 'succeeded' WHERE competitor_id = $1", [protectedCompetitor.rows[0].id]);
    const allowedDelete = await fetch(`${base}/api/competitors/${protectedCompetitor.rows[0].id}`, { method: "DELETE" });
    assert.equal(allowedDelete.status, 204);

    const video = Buffer.from("0123456789");
    await pool.query(
      `INSERT INTO media_assets(reel_id, kind, storage_provider, public_url, content_type, size_bytes, content)
       VALUES ($1, 'video', 'postgres', $2, 'video/mp4', $3, $4)`,
      [reel.rows[0].id, `/api/media/${reel.rows[0].id}/video`, video.length, video]
    );
    const mediaResponse = await fetch(`${base}/api/media/${reel.rows[0].id}/video`, {
      headers: { Range: "bytes=2-5" }
    });
    assert.equal(mediaResponse.status, 206);
    assert.equal(mediaResponse.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(Buffer.from(await mediaResponse.arrayBuffer()).toString(), "2345");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});

test("owner password protects mutations while reads stay public", async () => {
  const memory = newDb({ noAstCoverageCheck: true });
  const schema = await readFile(new URL("../db/migrations/001_schema.sql", import.meta.url), "utf8");
  memory.public.none(schema);
  addCurrentReelColumns(memory);
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  const server = createApp({
    db: pool,
    env: {
      ADMIN_PASSWORD: "local-test-password",
      ADMIN_SESSION_SECRET: "local-test-session-secret",
      AUTH_COOKIE_SECURE: "false"
    }
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const publicRead = await fetch(`${base}/api/reels`);
    assert.equal(publicRead.status, 200);

    const statusBefore = await fetch(`${base}/api/auth/status`);
    assert.deepEqual((await statusBefore.json()).data, { enabled: true, authenticated: false });

    const unauthorized = await fetch(`${base}/api/competitors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instagram: "test" })
    });
    assert.equal(unauthorized.status, 401);

    const wrongLogin = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" })
    });
    assert.equal(wrongLogin.status, 401);

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "local-test-password" })
    });
    assert.equal(login.status, 204);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.match(cookie, /^reels_admin=/);

    const statusAfter = await fetch(`${base}/api/auth/status`, { headers: { Cookie: cookie } });
    assert.deepEqual((await statusAfter.json()).data, { enabled: true, authenticated: true });

    const authorized = await fetch(`${base}/api/competitors`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ instagram: "test" })
    });
    assert.equal(authorized.status, 201);

    const malformedCookie = await fetch(`${base}/api/auth/status`, { headers: { Cookie: "reels_admin=%E0%A4%A" } });
    assert.equal(malformedCookie.status, 200);
    assert.equal((await malformedCookie.json()).data.authenticated, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});

test("rotating database cache keeps the old video when a new source has expired", async () => {
  const memory = newDb({ noAstCoverageCheck: true });
  const schema = await readFile(new URL("../db/migrations/001_schema.sql", import.meta.url), "utf8");
  memory.public.none(schema);
  addCurrentReelColumns(memory);
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  const competitor = await pool.query(
    "INSERT INTO competitors(instagram_handle, profile_url) VALUES ('@cache', 'https://instagram.com/cache') RETURNING id"
  );
  const oldReel = await pool.query(
    `INSERT INTO reels(competitor_id, platform_reel_id, source_url, video_url, thumbnail_url, title, media_status)
     VALUES ($1, 'old', 'https://instagram.com/reel/old', '/api/media/1/video', '/api/media/1/thumbnail', 'Old', 'stored') RETURNING id`,
    [competitor.rows[0].id]
  );
  const targetReel = await pool.query(
    `INSERT INTO reels(competitor_id, platform_reel_id, source_url, video_url, thumbnail_url, title, media_status)
     VALUES ($1, 'target', 'https://instagram.com/reel/target', 'https://cdn.example/expired.mp4', 'https://cdn.example/expired.jpg', 'Target', 'external') RETURNING id`,
    [competitor.rows[0].id]
  );
  await pool.query(
    `INSERT INTO media_assets(reel_id, kind, storage_provider, public_url, source_url, content_type, size_bytes, content)
     VALUES ($1, 'video', 'postgres', $2, 'https://cdn.example/old.mp4', 'video/mp4', 3, $3)`,
    [oldReel.rows[0].id, `/api/media/${oldReel.rows[0].id}/video`, Buffer.from("old")]
  );
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("expired", { status: 403 });
  try {
    await assert.rejects(
      cacheReelMedia(pool, targetReel.rows[0].id, {
        storage: { configured: false },
        env: { DATABASE_MEDIA_CACHE: "true", DATABASE_MEDIA_REELS_LIMIT: "1" }
      }),
      (error) => error.statusCode === 502
    );
    const cached = await pool.query("SELECT reel_id FROM media_assets WHERE storage_provider = 'postgres'");
    assert.deepEqual(cached.rows.map((row) => Number(row.reel_id)), [Number(oldReel.rows[0].id)]);
    const oldStatus = await pool.query("SELECT media_status FROM reels WHERE id = $1", [oldReel.rows[0].id]);
    assert.equal(oldStatus.rows[0].media_status, "stored");
  } finally {
    globalThis.fetch = previousFetch;
    await pool.end();
  }
});

test("backup restores relational data and media into a fresh database state", async () => {
  const memory = newDb({ noAstCoverageCheck: true });
  const schema = await readFile(new URL("../db/migrations/001_schema.sql", import.meta.url), "utf8");
  memory.public.none(schema);
  addCurrentReelColumns(memory);
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  const competitor = await pool.query(
    "INSERT INTO competitors(instagram_handle, profile_url) VALUES ('@backup', 'https://instagram.com/backup') RETURNING id"
  );
  const reel = await pool.query(
    `INSERT INTO reels(competitor_id, platform_reel_id, source_url, video_url, thumbnail_url, title, media_status)
     VALUES ($1, 'backup-reel', 'https://instagram.com/reel/backup', 'https://cdn.example/video.mp4',
       'https://cdn.example/thumb.jpg', 'Backup reel', 'external') RETURNING id`,
    [competitor.rows[0].id]
  );
  await pool.query("INSERT INTO scripts(reel_id, title) VALUES ($1, 'Backup script')", [reel.rows[0].id]);
  await pool.query("INSERT INTO sync_runs(competitor_id, status) VALUES ($1, 'running')", [competitor.rows[0].id]);
  const snapshot = await createBackupSnapshot(pool);
  assert.equal(snapshot.data.reels.length, 1);
  const restored = await restoreBackupSnapshot(pool, snapshot);
  assert.equal(restored.reels, 1);
  assert.equal(restored.scripts, 1);
  const newReelId = restored.reelIds[String(reel.rows[0].id)];
  const interrupted = await pool.query("SELECT status FROM sync_runs");
  assert.equal(interrupted.rows[0].status, "failed");
  await restoreMediaAsset(pool, newReelId, "video", Buffer.from("video-bytes"), {
    contentType: "video/mp4",
    sourceUrl: "https://cdn.example/video.mp4"
  });
  const restoredReel = await pool.query("SELECT media_status, video_url FROM reels WHERE id = $1", [newReelId]);
  assert.equal(restoredReel.rows[0].media_status, "stored");
  assert.equal(restoredReel.rows[0].video_url, `/api/media/${newReelId}/video`);
  await pool.end();
});

test("interrupted sync runs are released on startup", async () => {
  const memory = newDb({ noAstCoverageCheck: true });
  const schema = await readFile(new URL("../db/migrations/001_schema.sql", import.meta.url), "utf8");
  memory.public.none(schema);
  addCurrentReelColumns(memory);
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  const competitor = await pool.query(
    "INSERT INTO competitors(instagram_handle, profile_url) VALUES ('@recover', 'https://instagram.com/recover') RETURNING id"
  );
  await pool.query("INSERT INTO sync_runs(competitor_id, status) VALUES ($1, 'queued')", [competitor.rows[0].id]);
  assert.equal(await recoverInterruptedSyncRuns(pool), 1);
  const run = await pool.query("SELECT status, finished_at FROM sync_runs");
  assert.equal(run.rows[0].status, "failed");
  assert.ok(run.rows[0].finished_at);
  await pool.end();
});
