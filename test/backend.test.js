import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { newDb } from "pg-mem";
import { backfillMissingSegments, normalizeApifyReel } from "../src/apify.js";
import { createApp } from "../src/app.js";

function addCurrentReelColumns(memory) {
  memory.public.none(`
    ALTER TABLE reels ADD COLUMN play_count BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE reels ADD COLUMN media_status TEXT NOT NULL DEFAULT 'missing';
    ALTER TABLE reels ADD COLUMN hashtags JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE reels ADD COLUMN mentions JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE reels ADD COLUMN transcript TEXT NOT NULL DEFAULT '';
    ALTER TABLE reels ADD COLUMN owner_username TEXT NOT NULL DEFAULT '';
    ALTER TABLE reels ADD COLUMN owner_full_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE reels ADD COLUMN last_synced_at TIMESTAMPTZ;
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
});

test("REST API reads seeded reels and persists a script", async () => {
  const memory = newDb({ noAstCoverageCheck: true });
  const schema = await readFile(new URL("../db/migrations/001_schema.sql", import.meta.url), "utf8");
  memory.public.none(schema);
  addCurrentReelColumns(memory);
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
    env: { SCRIPT_LIMIT: "2", SYNC_COOLDOWN_MINUTES: "10", SYNC_HOURLY_LIMIT: "3", SYNC_DAILY_LIMIT: "10" },
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

    const competitorsResponse = await fetch(`${base}/api/competitors`);
    const competitors = (await competitorsResponse.json()).data;
    assert.equal(competitorsResponse.status, 200);
    assert.equal(competitors[0].reels_count, 1);
    assert.equal(Number(competitors[0].total_views), 0);

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
