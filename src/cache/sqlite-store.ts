import type BetterSqlite3 from "better-sqlite3";
import { dot, type CacheEntry, type CacheStore, type SemanticMatch } from "./store.js";

/**
 * SQLite-backed store for a cache that survives restarts. Exact lookups are a
 * primary-key read; semantic search loads the vectors of a single scope and
 * scans them in process (no vector index; see README for the tradeoff).
 */
export class SqliteCacheStore implements CacheStore {
  private readonly db: BetterSqlite3.Database;
  private readonly stmts;
  private writes = 0;

  private constructor(db: BetterSqlite3.Database) {
    this.db = db;
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS exact_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS semantic_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        vector BLOB NOT NULL,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS semantic_cache_scope ON semantic_cache (scope, expires_at);
    `);
    this.stmts = {
      get: db.prepare<[string, number], { value: string; created_at: number; expires_at: number }>(
        "SELECT value, created_at, expires_at FROM exact_cache WHERE key = ? AND expires_at > ?",
      ),
      set: db.prepare("INSERT OR REPLACE INTO exact_cache (key, value, created_at, expires_at) VALUES (?, ?, ?, ?)"),
      scan: db.prepare<[string, number], { vector: Buffer; value: string; created_at: number; expires_at: number }>(
        "SELECT vector, value, created_at, expires_at FROM semantic_cache WHERE scope = ? AND expires_at > ?",
      ),
      add: db.prepare("INSERT INTO semantic_cache (scope, vector, value, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"),
      pruneExact: db.prepare("DELETE FROM exact_cache WHERE expires_at <= ?"),
      pruneSemantic: db.prepare("DELETE FROM semantic_cache WHERE expires_at <= ?"),
    };
  }

  static async open(path: string): Promise<SqliteCacheStore> {
    // Loaded lazily so the native module is only required when this store is configured.
    const { default: Database } = await import("better-sqlite3");
    return new SqliteCacheStore(new Database(path));
  }

  async get(key: string, now = Date.now()) {
    const row = this.stmts.get.get(key, now);
    return row ? { value: row.value, createdAt: row.created_at, expiresAt: row.expires_at } : undefined;
  }

  async set(key: string, entry: CacheEntry) {
    this.stmts.set.run(key, entry.value, entry.createdAt, entry.expiresAt);
    this.maybePrune(entry.createdAt);
  }

  async semanticSearch(scope: string, vector: Float32Array, threshold: number, now = Date.now()): Promise<SemanticMatch | undefined> {
    let best: SemanticMatch | undefined;
    for (const row of this.stmts.scan.iterate(scope, now)) {
      // copy: driver buffers may come from a shared pool with an unaligned offset
      const stored = new Float32Array(new Uint8Array(row.vector).buffer);
      const score = dot(vector, stored);
      if (score >= threshold && (!best || score > best.score)) {
        best = { score, entry: { value: row.value, createdAt: row.created_at, expiresAt: row.expires_at } };
      }
    }
    return best;
  }

  async semanticAdd(scope: string, vector: Float32Array, entry: CacheEntry) {
    const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    this.stmts.add.run(scope, blob, entry.value, entry.createdAt, entry.expiresAt);
    this.maybePrune(entry.createdAt);
  }

  async close() {
    this.db.close();
  }

  private maybePrune(now: number) {
    if (++this.writes % 500 !== 0) return;
    this.stmts.pruneExact.run(now);
    this.stmts.pruneSemantic.run(now);
  }
}
