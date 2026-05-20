import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { config } from "./config.js";

if (!config.databaseUrl) throw new Error("DATABASE_URL is required");

export const client = postgres(config.databaseUrl, { prepare: false });
export const db = drizzle(client);

export async function close() {
  await client.end();
}
