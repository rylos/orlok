import postgres from "postgres";
import { createDatabase, runMigrations } from "../db/client";
import { MIGRATIONS_FOLDER, TEST_DATABASE_URL } from "./db";

// Creates the test database if missing and applies migrations, once per run.
export default async function setup() {
  const target = new URL(TEST_DATABASE_URL);
  const databaseName = decodeURIComponent(target.pathname.slice(1));

  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { onnotice: () => {} });
  try {
    const existing = await admin`select 1 from pg_database where datname = ${databaseName}`;
    if (existing.length === 0) {
      await admin.unsafe(`create database "${databaseName.replaceAll('"', '""')}"`);
    }
  } finally {
    await admin.end();
  }

  const { db, close } = createDatabase(TEST_DATABASE_URL);
  try {
    await runMigrations(db, MIGRATIONS_FOLDER);
  } finally {
    await close();
  }
}
