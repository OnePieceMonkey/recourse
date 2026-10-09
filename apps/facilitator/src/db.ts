import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

// One tiny interface over PGlite (local, tests, judges running the repo) and
// Postgres (hosted demo). Same SQL for both.
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openPglite(dataDir?: string): Promise<Db> {
  const lite = dataDir ? new PGlite(dataDir) : new PGlite();
  await lite.waitReady;
  // PGlite runs one statement at a time; a simple queue keeps transactions from
  // interleaving with other requests.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const raw: Db = {
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await lite.query<T>(sql, params as any[]);
      return r.rows;
    },
    async exec(sql) {
      await lite.exec(sql);
    },
    tx: async () => {
      throw new Error("nested tx");
    },
    close: () => lite.close(),
  };
  return {
    query: (sql, params) => serial(() => raw.query(sql, params)),
    exec: (sql) => serial(() => raw.exec(sql)),
    tx: (fn) =>
      serial(async () => {
        await lite.exec("BEGIN");
        try {
          const out = await fn(raw);
          await lite.exec("COMMIT");
          return out;
        } catch (e) {
          await lite.exec("ROLLBACK");
          throw e;
        }
      }),
    close: () => lite.close(),
  };
}

export async function openPostgres(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const wrap = (c: pg.Pool | pg.PoolClient): Db => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await c.query(sql, params);
      return r.rows as T[];
    },
    async exec(sql) {
      await c.query(sql);
    },
    tx: async () => {
      throw new Error("nested tx");
    },
    close: async () => undefined,
  });
  return {
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(wrap(client));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  vault_id TEXT,
  payer_email TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_setups (
  setup_token_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS mandates (
  owner_id TEXT NOT NULL REFERENCES owners(id),
  version INTEGER NOT NULL,
  body JSONB NOT NULL,
  hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_id, version)
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  kid TEXT NOT NULL,
  public_jwk JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
-- Prepaid balance as an append-only ledger; balance = SUM(amount_minor).
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  kind TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS topups (
  order_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  capture_id TEXT,
  refunded_minor INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS publishers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payout_email TEXT NOT NULL,
  public_jwk JSONB NOT NULL,
  kid TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  publisher_id TEXT NOT NULL REFERENCES publishers(id),
  offer_id TEXT NOT NULL UNIQUE,
  offer JSONB NOT NULL,
  offer_hash TEXT NOT NULL,
  price_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  funding TEXT NOT NULL,
  paypal_order_id TEXT,
  paypal_capture_id TEXT,
  refunded_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  receipt_seq INTEGER,
  delivery JSONB,
  protection_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS earnings (
  purchase_id TEXT PRIMARY KEY REFERENCES purchases(id),
  publisher_id TEXT NOT NULL REFERENCES publishers(id),
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  payable_after TIMESTAMPTZ NOT NULL,
  payout_batch_id TEXT
);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchases(id),
  agent_id TEXT NOT NULL,
  reasons JSONB NOT NULL,
  requested_bps INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  refund_minor INTEGER NOT NULL,
  decided_reasons JSONB NOT NULL,
  agent_verdict JSONB,
  own_verdict JSONB,
  paypal_refund_id TEXT,
  log_seq INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  paypal_batch_id TEXT,
  status TEXT NOT NULL,
  total_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  log_seq INTEGER,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS log (
  seq INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  entry JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS anchors (
  head_seq INTEGER PRIMARY KEY,
  head_hash TEXT NOT NULL,
  proof JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS disputes (
  dispute_id TEXT PRIMARY KEY,
  purchase_id TEXT,
  reason TEXT NOT NULL,
  action TEXT NOT NULL,
  log_seq INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL
);
`;
