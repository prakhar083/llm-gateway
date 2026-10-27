import type BetterSqlite3 from "better-sqlite3";

/** Monthly spend per virtual key. Periods are calendar months in UTC ("2026-10"). */
export interface SpendLedger {
  get(key: string, period: string): Promise<number>;
  add(key: string, period: string, usd: number): Promise<number>;
  close(): Promise<void>;
}

export function currentPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export class MemoryLedger implements SpendLedger {
  private spend = new Map<string, number>();
  async get(key: string, period: string) {
    return this.spend.get(`${period}:${key}`) ?? 0;
  }
  async add(key: string, period: string, usd: number) {
    const total = (this.spend.get(`${period}:${key}`) ?? 0) + usd;
    this.spend.set(`${period}:${key}`, total);
    return total;
  }
  async close() {}
}

/** Durable ledger so a restart does not reset everyone's monthly budget. */
export class SqliteLedger implements SpendLedger {
  private constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly stmts: { get: BetterSqlite3.Statement<[string, string], { usd: number }>; add: BetterSqlite3.Statement },
  ) {}

  static async open(path: string): Promise<SqliteLedger> {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS spend (key TEXT NOT NULL, period TEXT NOT NULL, usd REAL NOT NULL, PRIMARY KEY (key, period))");
    return new SqliteLedger(db, {
      get: db.prepare("SELECT usd FROM spend WHERE key = ? AND period = ?"),
      add: db.prepare("INSERT INTO spend (key, period, usd) VALUES (?, ?, ?) ON CONFLICT (key, period) DO UPDATE SET usd = usd + excluded.usd"),
    });
  }

  async get(key: string, period: string) {
    return this.stmts.get.get(key, period)?.usd ?? 0;
  }
  async add(key: string, period: string, usd: number) {
    this.stmts.add.run(key, period, usd);
    return this.get(key, period);
  }
  async close() {
    this.db.close();
  }
}
