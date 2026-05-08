import bcrypt from "bcryptjs";
import { MongoClient, type Collection } from "mongodb";
import { Pool, type PoolConfig } from "pg";

export type UserRow = {
  id: string;
  email: string;
  passwordHash: string;
  handle: string;
  avatarUrl: string;
  bio: string;
};

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    handle: u.handle,
    avatarUrl: u.avatarUrl,
    bio: u.bio,
  };
}

export interface UserStore {
  findByEmailLc(emailLc: string): Promise<UserRow | null>;
  findById(id: string): Promise<UserRow | null>;
  /** True if email or normalized handle is already used. */
  isEmailOrHandleTaken(emailLc: string, handleNorm: string): Promise<boolean>;
  /** Another user (not excludeUserId) already uses this normalized handle. */
  isHandleTakenByOther(
    excludeUserId: string,
    handleNorm: string
  ): Promise<boolean>;
  createUser(row: UserRow): Promise<void>;
  applyProfilePatch(
    userId: string,
    patch: { handle?: string; bio?: string; avatarUrl?: string }
  ): Promise<UserRow | null>;
}

type MongoUserDoc = {
  _id: string;
  email: string;
  passwordHash: string;
  handle: string;
  handleNorm: string;
  avatarUrl: string;
  bio: string;
  createdAt: number;
};

function mongoDocToRow(doc: MongoUserDoc): UserRow {
  return {
    id: doc._id,
    email: doc.email,
    passwordHash: doc.passwordHash,
    handle: doc.handle,
    avatarUrl: doc.avatarUrl,
    bio: doc.bio,
  };
}

export class MongoUserStore implements UserStore {
  constructor(private readonly users: Collection<MongoUserDoc>) {}

  async ensureIndexes(): Promise<void> {
    await this.users.createIndex({ email: 1 }, { unique: true });
    await this.users.createIndex({ handleNorm: 1 }, { unique: true });
  }

  async findByEmailLc(emailLc: string): Promise<UserRow | null> {
    const doc = await this.users.findOne({ email: emailLc });
    return doc ? mongoDocToRow(doc) : null;
  }

  async findById(id: string): Promise<UserRow | null> {
    const doc = await this.users.findOne({ _id: id });
    return doc ? mongoDocToRow(doc) : null;
  }

  async isEmailOrHandleTaken(
    emailLc: string,
    handleNorm: string
  ): Promise<boolean> {
    const doc = await this.users.findOne({
      $or: [{ email: emailLc }, { handleNorm }],
    });
    return doc !== null;
  }

  async isHandleTakenByOther(
    excludeUserId: string,
    handleNorm: string
  ): Promise<boolean> {
    const doc = await this.users.findOne({
      handleNorm,
      _id: { $ne: excludeUserId },
    });
    return doc !== null;
  }

  async createUser(row: UserRow): Promise<void> {
    const d: MongoUserDoc = {
      _id: row.id,
      email: row.email,
      passwordHash: row.passwordHash,
      handle: row.handle,
      handleNorm: row.handle.trim().toLowerCase(),
      avatarUrl: row.avatarUrl,
      bio: row.bio,
      createdAt: Date.now(),
    };
    await this.users.insertOne(d);
  }

  async seedDemoIfMissing(): Promise<void> {
    const email = "test@example.com";
    const exists = await this.users.findOne({ email });
    if (exists) return;
    const passwordHash = bcrypt.hashSync("123456", 10);
    await this.createUser({
      id: "u1",
      email,
      passwordHash,
      handle: "testuser",
      avatarUrl: "",
      bio: "",
    });
  }

  async applyProfilePatch(
    userId: string,
    patch: { handle?: string; bio?: string; avatarUrl?: string }
  ): Promise<UserRow | null> {
    const $set: Record<string, string> = {};
    if (patch.handle !== undefined) {
      $set.handle = patch.handle;
      $set.handleNorm = patch.handle.trim().toLowerCase();
    }
    if (patch.bio !== undefined) $set.bio = patch.bio;
    if (patch.avatarUrl !== undefined) $set.avatarUrl = patch.avatarUrl;
    if (Object.keys($set).length === 0) return this.findById(userId);
    const r = await this.users.updateOne({ _id: userId }, { $set });
    if (r.matchedCount === 0) return null;
    return this.findById(userId);
  }
}

function poolFromEnv(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL required for PostgreSQL store");
  }

  const config: PoolConfig = { connectionString };

  // Render / most cloud Postgres URLs need TLS; local Docker often does not.
  const useSsl =
    process.env.PGSSLMODE === "require" ||
    /\.render\.com|neon\.tech|supabase\.co|azure\.com/i.test(
      connectionString
    );
  if (useSsl) {
    config.ssl = { rejectUnauthorized: false };
  }

  return new Pool(config);
}

async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      handle TEXT NOT NULL,
      avatar_url TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_handle_lower_idx ON users (LOWER(handle));
  `);
}

function rowFromPg(r: {
  id: string;
  email: string;
  password_hash: string;
  handle: string;
  avatar_url: string;
  bio: string;
}): UserRow {
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    handle: r.handle,
    avatarUrl: r.avatar_url,
    bio: r.bio,
  };
}

export class PgUserStore implements UserStore {
  constructor(private readonly pool: Pool) {}

  async findByEmailLc(emailLc: string): Promise<UserRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id, email, password_hash, handle, avatar_url, bio FROM users WHERE email = $1 LIMIT 1`,
      [emailLc]
    );
    return rows[0] ? rowFromPg(rows[0] as never) : null;
  }

  async findById(id: string): Promise<UserRow | null> {
    const { rows } = await this.pool.query(
      `SELECT id, email, password_hash, handle, avatar_url, bio FROM users WHERE id = $1 LIMIT 1`,
      [id]
    );
    return rows[0] ? rowFromPg(rows[0] as never) : null;
  }

  async isEmailOrHandleTaken(
    emailLc: string,
    handleNorm: string
  ): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM users WHERE email = $1 OR LOWER(handle) = $2 LIMIT 1`,
      [emailLc, handleNorm]
    );
    return rows.length > 0;
  }

  async createUser(row: UserRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO users (id, email, password_hash, handle, avatar_url, bio, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.email,
        row.passwordHash,
        row.handle,
        row.avatarUrl,
        row.bio,
        Date.now(),
      ]
    );
  }

  async seedDemoIfMissing(): Promise<void> {
    const email = "test@example.com";
    const { rows } = await this.pool.query(
      `SELECT id FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );
    if (rows.length > 0) return;
    const passwordHash = bcrypt.hashSync("123456", 10);
    await this.createUser({
      id: "u1",
      email,
      passwordHash,
      handle: "testuser",
      avatarUrl: "",
      bio: "",
    });
  }

  async isHandleTakenByOther(
    excludeUserId: string,
    handleNorm: string
  ): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT id FROM users WHERE LOWER(handle) = $1 AND id != $2 LIMIT 1`,
      [handleNorm, excludeUserId]
    );
    return rows.length > 0;
  }

  async applyProfilePatch(
    userId: string,
    patch: { handle?: string; bio?: string; avatarUrl?: string }
  ): Promise<UserRow | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (patch.handle !== undefined) {
      sets.push(`handle = $${i++}`);
      vals.push(patch.handle);
    }
    if (patch.bio !== undefined) {
      sets.push(`bio = $${i++}`);
      vals.push(patch.bio);
    }
    if (patch.avatarUrl !== undefined) {
      sets.push(`avatar_url = $${i++}`);
      vals.push(patch.avatarUrl);
    }
    if (sets.length === 0) return this.findById(userId);
    vals.push(userId);
    const q = `UPDATE users SET ${sets.join(", ")} WHERE id = $${i}`;
    const { rowCount } = await this.pool.query(q, vals);
    if (!rowCount) return null;
    return this.findById(userId);
  }
}

export class MemoryUserStore implements UserStore {
  private readonly byId = new Map<string, UserRow>();
  private readonly byEmail = new Map<string, UserRow>();

  async findByEmailLc(emailLc: string): Promise<UserRow | null> {
    return this.byEmail.get(emailLc) ?? null;
  }

  async findById(id: string): Promise<UserRow | null> {
    return this.byId.get(id) ?? null;
  }

  async isEmailOrHandleTaken(
    emailLc: string,
    handleNorm: string
  ): Promise<boolean> {
    for (const u of this.byId.values()) {
      if (u.email === emailLc || u.handle.trim().toLowerCase() === handleNorm)
        return true;
    }
    return false;
  }

  async isHandleTakenByOther(
    excludeUserId: string,
    handleNorm: string
  ): Promise<boolean> {
    for (const u of this.byId.values()) {
      if (u.id !== excludeUserId && u.handle.trim().toLowerCase() === handleNorm)
        return true;
    }
    return false;
  }

  async createUser(row: UserRow): Promise<void> {
    this.byId.set(row.id, row);
    this.byEmail.set(row.email, row);
  }

  async seedDemoIfMissing(): Promise<void> {
    if (this.byId.has("u1")) return;
    const passwordHash = bcrypt.hashSync("123456", 10);
    const row: UserRow = {
      id: "u1",
      email: "test@example.com",
      passwordHash,
      handle: "testuser",
      avatarUrl: "",
      bio: "",
    };
    await this.createUser(row);
  }

  async applyProfilePatch(
    userId: string,
    patch: { handle?: string; bio?: string; avatarUrl?: string }
  ): Promise<UserRow | null> {
    const u = await this.findById(userId);
    if (!u) return null;
    if (patch.handle !== undefined) u.handle = patch.handle;
    if (patch.bio !== undefined) u.bio = patch.bio;
    if (patch.avatarUrl !== undefined) u.avatarUrl = patch.avatarUrl;
    this.byId.set(u.id, u);
    this.byEmail.set(u.email, u);
    return u;
  }
}

let pgPool: Pool | null = null;
let mongoClient: MongoClient | null = null;

export type PersistenceMode = "mongodb" | "postgres" | "memory";

export async function createUserStore(): Promise<{
  store: UserStore;
  mode: PersistenceMode;
}> {
  if (process.env.MONGODB_URI) {
    const uri = process.env.MONGODB_URI.trim();
    try {
      mongoClient = new MongoClient(uri, {
        connectTimeoutMS: 60_000,
        serverSelectionTimeoutMS: 60_000,
        maxPoolSize: 10,
      });
      await mongoClient.connect();
      const dbName = process.env.MONGODB_DB ?? "etometv";
      const db = mongoClient.db(dbName);
      await db.command({ ping: 1 });
      const store = new MongoUserStore(db.collection<MongoUserDoc>("users"));
      await store.ensureIndexes();
      await store.seedDemoIfMissing();
      return { store, mode: "mongodb" };
    } catch (e) {
      console.error(
        "[EtomeTv] MongoDB connection failed; falling back to in-memory users (not persistent).",
        "Fix Atlas: resume cluster, Network Access 0.0.0.0/0, URL-encode password in MONGODB_URI.",
        e
      );
      await mongoClient?.close().catch(() => {});
      mongoClient = null;
      const store = new MemoryUserStore();
      await store.seedDemoIfMissing();
      return { store, mode: "memory" };
    }
  }

  if (process.env.DATABASE_URL) {
    pgPool = poolFromEnv();
    await ensureSchema(pgPool);
    const store = new PgUserStore(pgPool);
    await store.seedDemoIfMissing();
    return { store, mode: "postgres" };
  }

  const store = new MemoryUserStore();
  await store.seedDemoIfMissing();
  return { store, mode: "memory" };
}

/** Call on shutdown (optional). */
export async function closeUserStore(): Promise<void> {
  await pgPool?.end();
  pgPool = null;
  await mongoClient?.close();
  mongoClient = null;
}
