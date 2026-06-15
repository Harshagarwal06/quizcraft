import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { createClient } from "@libsql/client";
import { SCHEMA_STATEMENTS } from "./schema";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient;
  schemaReady: Promise<void>;
};

function dbConfig() {
  // Works for both local SQLite (file:./dev.db) and remote Turso (libsql://...).
  return {
    url: process.env.DATABASE_URL ?? "file:./dev.db",
    authToken: process.env.DATABASE_AUTH_TOKEN,
  };
}

function createPrisma() {
  const adapter = new PrismaLibSql(dbConfig());
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrisma();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * Ensures the database schema exists. Runs the idempotent DDL once per process
 * so a fresh database (e.g. a new Turso instance) self-provisions on first use.
 */
export function ensureSchema(): Promise<void> {
  if (!globalForPrisma.schemaReady) {
    globalForPrisma.schemaReady = (async () => {
      const client = createClient(dbConfig());
      try {
        for (const stmt of SCHEMA_STATEMENTS) {
          await client.execute(stmt);
        }
      } finally {
        client.close();
      }
    })().catch((err) => {
      // Reset so a later request can retry if provisioning failed.
      globalForPrisma.schemaReady = undefined as unknown as Promise<void>;
      throw err;
    });
  }
  return globalForPrisma.schemaReady;
}
