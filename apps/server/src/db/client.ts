import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, { onnotice: () => {} });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end() };
}

export type Db = ReturnType<typeof createDatabase>["db"];

export async function runMigrations(db: Db, migrationsFolder: string) {
  await migrate(db, { migrationsFolder });
}
