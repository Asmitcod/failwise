import { Pool } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import * as schema from "./schema.ts";

type Database = NeonDatabase<typeof schema>;

declare global {
  var failwisePool: Pool | undefined;
  var failwiseDb: Database | undefined;
}

export function getDatabase(): Database {
  if (globalThis.failwiseDb) return globalThis.failwiseDb;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for webhook persistence.");
  }

  const pool = new Pool({ connectionString, max: 1 });
  globalThis.failwisePool = pool;
  globalThis.failwiseDb = drizzle(pool, { schema });
  return globalThis.failwiseDb;
}
