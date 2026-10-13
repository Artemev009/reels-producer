import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { newDb } from "pg-mem";
import { normalizeApifyReel } from "../src/apify.js";
import { createApp } from "../src/app.js";

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
});

test("REST API reads seeded reels and persists a script", async () => {
  const memory = newDb({ noAstCoverageCheck: true });
  const schema = await readFile(new URL("../db/migrations/001_schema.sql", import.meta.url), "utf8");
  memory.public.none(schema);
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
    "INSERT INTO scripts(reel_id, title) VALUES ($1, 'Existing script')",
    [reel.rows[0].id]
  );
  const server = createApp({ db: pool }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const reelsResponse = await fetch(`${base}/api/reels`);
    const reels = (await reelsResponse.json()).data;
    assert.equal(reelsResponse.status, 200);
    assert.equal(reels.length, 1);

    const scriptResponse = await fetch(`${base}/api/scripts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reel_id: reels[0].id })
    });
    assert.equal(scriptResponse.status, 201);
    const scripts = (await (await fetch(`${base}/api/scripts`)).json()).data;
    assert.equal(scripts.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
