import { createDatabase } from "./db.js";
import { runMigrations } from "./migrate.js";
import { createApp } from "./app.js";
import { backfillMissingSegments, warmDatabaseMediaCache } from "./apify.js";

const port = Number(process.env.PORT || 3000);
const db = createDatabase();

await runMigrations(db);
await backfillMissingSegments(db);
const app = createApp({ db });
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Reels Finder is listening on port ${port}`);
  setImmediate(() => warmDatabaseMediaCache(db).catch((error) => {
    console.error("PostgreSQL media cache warm-up failed:", error.message);
  }));
});

async function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  server.close(async () => {
    await db.end();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
