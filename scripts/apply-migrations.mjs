// Applies Prisma migration SQL to a libSQL/Turso database.
// Usage: node scripts/apply-migrations.mjs
// Requires DATABASE_URL (libsql://...) and DATABASE_AUTH_TOKEN in the environment
// (loaded from .env.local). Safe to run multiple times — uses IF NOT EXISTS where
// Prisma emits it; for a fresh Turso DB it creates all tables.
import "dotenv/config";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const url = process.env.DATABASE_URL;
const authToken = process.env.DATABASE_AUTH_TOKEN;

if (!url) {
  console.error("✗ DATABASE_URL is not set");
  process.exit(1);
}

const client = createClient({ url, authToken });

const migrationsDir = join(process.cwd(), "prisma", "migrations");
const dirs = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

console.log(`Applying ${dirs.length} migration(s) to ${url.split("?")[0]}`);

for (const dir of dirs) {
  const sql = readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8");
  try {
    await client.executeMultiple(sql);
    console.log(`  ✓ ${dir}`);
  } catch (err) {
    console.error(`  ✗ ${dir}: ${err.message}`);
    process.exit(1);
  }
}

console.log("Done.");
process.exit(0);
