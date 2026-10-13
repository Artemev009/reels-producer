import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withTransaction } from "./db.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = path.join(root, "db", "migrations");

export async function runMigrations(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = (await fs.readdir(migrationsDirectory)).filter((file) => file.endsWith(".sql")).sort();
  const applied = await db.query("SELECT version FROM schema_migrations");
  const appliedVersions = new Set(applied.rows.map((row) => row.version));

  for (const file of files) {
    if (appliedVersions.has(file)) continue;
    const sql = await fs.readFile(path.join(migrationsDirectory, file), "utf8");
    await withTransaction(db, async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
    });
    console.log(`Applied migration ${file}`);
  }
}
