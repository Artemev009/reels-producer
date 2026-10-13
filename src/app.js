import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importFromApify } from "./apify.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDirectory = path.join(root, "public");

const reelFields = `
  r.id, r.competitor_id, r.platform_reel_id, r.source_url, r.video_url, r.thumbnail_url,
  r.title, r.description, r.hook_text, r.script_text, r.cta_text, r.duration_seconds,
  r.views_count, r.likes_count, r.comments_count, r.shares_count, r.is_favorite,
  r.status, r.published_at, r.created_at, r.updated_at,
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

export function createApp({ db, apifyImporter = importFromApify }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", async (_request, response) => {
    try {
      await db.query("SELECT 1");
      response.json({ status: "ok", database: "connected" });
    } catch {
      response.status(503).json({ status: "error", database: "unavailable" });
    }
  });

  app.get("/api/competitors", async (_request, response) => {
    const result = await db.query(`
      SELECT c.*,
        COUNT(r.id)::INTEGER AS reels_count,
        COALESCE(SUM(r.views_count), 0)::BIGINT AS total_views
      FROM competitors c
      LEFT JOIN reels r ON r.competitor_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);
    response.json({ data: result.rows });
  });

  app.post("/api/competitors", async (request, response) => {
    const { handle, profileUrl } = normalizeInstagram(request.body.instagram || request.body.profile_url || "");
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
    const result = await db.query("DELETE FROM competitors WHERE id = $1 RETURNING id", [parseId(request.params.id)]);
    if (!result.rowCount) return response.status(404).json({ error: "Конкурент не найден" });
    response.status(204).end();
  });

  app.post("/api/competitors/:id/sync", async (request, response) => {
    const id = parseId(request.params.id);
    const result = await db.query("SELECT * FROM competitors WHERE id = $1", [id]);
    if (!result.rowCount) return response.status(404).json({ error: "Конкурент не найден" });
    const imported = await apifyImporter(db, result.rows[0]);
    response.json({ data: imported });
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
    const result = await db.query(
      `SELECT ${reelFields} FROM reels r LEFT JOIN competitors c ON c.id = r.competitor_id ${where} ORDER BY ${order} LIMIT 200`,
      values
    );
    response.json({ data: result.rows });
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

  app.post("/api/scripts", async (request, response) => {
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
    console.error(error);
    const result = publicError(error);
    response.status(result.status).json({ error: result.message });
  });

  return app;
}
