import { readFile } from "node:fs/promises";
import { newDb } from "pg-mem";
import { createApp } from "../src/app.js";

const memory = newDb({ noAstCoverageCheck: true });
const schema = await readFile(new URL("../db/migrations/001_schema.sql", import.meta.url), "utf8");
memory.public.none(schema);
const adapter = memory.adapters.createPg();
const db = new adapter.Pool();

const competitor = await db.query(`
  INSERT INTO competitors(instagram_handle, profile_url, display_name, avatar_url, follower_count, following_count, posts_count, last_synced_at)
  VALUES ('@alyona.health', 'https://instagram.com/alyona.health', 'Алёна | Здоровье и баланс',
    'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=300&q=85', 320000, 412, 248, NOW())
  RETURNING id
`);

const demoReels = [
  ["preview-1", "3 ошибки в утренней рутине, которые крадут твою энергию", "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=700&q=85", 32, 1200000, 4200, true],
  ["preview-2", "Простой и полезный завтрак за 5 минут", "https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=700&q=85", 28, 640000, 890, false]
];

for (const [id, title, thumbnail, seconds, views, likes, favorite] of demoReels) {
  await db.query(
    `INSERT INTO reels(competitor_id, platform_reel_id, source_url, video_url, thumbnail_url, title, description,
      hook_text, script_text, cta_text, duration_seconds, views_count, likes_count, is_favorite, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())`,
    [competitor.rows[0].id, id, `https://instagram.com/reel/${id}`,
      "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4", thumbnail, title,
      "Оригинальное описание рилса", "Ты тоже просыпаешься уставшим?",
      "1. Не бери телефон сразу.\n2. Выпей воды.\n3. Подготовь полезный завтрак.",
      "Сохрани видео и попробуй завтра ❤️", seconds, views, likes, favorite]
  );
}

createApp({ db }).listen(3000, "127.0.0.1", () => console.log("Preview: http://127.0.0.1:3000"));
