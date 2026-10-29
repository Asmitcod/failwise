import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "@neondatabase/serverless";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to run database migrations.");
  }

  const directory = fileURLToPath(new URL("../drizzle/", import.meta.url));
  const migrationFiles = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const pool = new Pool({ connectionString, max: 1 });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS failwise_migrations (
        filename text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    let applied = 0;
    for (const filename of migrationFiles) {
      const contents = await readFile(new URL(`../drizzle/${filename}`, import.meta.url), "utf8");
      const checksum = createHash("sha256").update(contents).digest("hex");
      const existing = await pool.query<{ checksum: string }>(
        "SELECT checksum FROM failwise_migrations WHERE filename = $1",
        [filename],
      );

      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Applied migration ${filename} has changed; create a new migration instead.`);
        }
        continue;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const statement of contents.split("--> statement-breakpoint")) {
          if (statement.trim()) await client.query(statement);
        }
        await client.query(
          "INSERT INTO failwise_migrations (filename, checksum) VALUES ($1, $2)",
          [filename, checksum],
        );
        await client.query("COMMIT");
        applied += 1;
        console.info(`Applied ${filename}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    if (applied === 0) console.info("Database schema is up to date.");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Database migration failed.");
  process.exitCode = 1;
});
