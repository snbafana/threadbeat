import { drizzle } from "drizzle-orm/postgres-js";
import "dotenv/config";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error("DATABASE_URL is required");
export const client = postgres(databaseUrl, { prepare: false });
export const db = drizzle(client);

export async function close() {
  await client.end();
}
