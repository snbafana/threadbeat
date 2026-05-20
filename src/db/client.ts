import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { databaseUrl } from "../config.js";

if (!databaseUrl) throw new Error("DATABASE_URL is required");

export const client = postgres(databaseUrl, { prepare: false });
export const db = drizzle(client);

export async function close() {
  await client.end();
}
