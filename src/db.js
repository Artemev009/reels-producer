import pg from "pg";

const { Pool } = pg;

export function createDatabase(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required. Connect a PostgreSQL database before starting Reels Finder.");
  }

  return new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_SIZE || 5),
    ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
}

export async function withTransaction(db, callback) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
