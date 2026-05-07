import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT ?? 8787);
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-insecure-change-me";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173";

const listed =
  process.env.FRONTEND_ORIGINS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [];
const allowedOrigins = listed.length > 0 ? listed : [FRONTEND_ORIGIN];

type UserRow = {
  id: string;
  email: string;
  passwordHash: string;
  handle: string;
  avatarUrl: string;
  bio: string;
};

const usersById = new Map<string, UserRow>();
const usersByEmail = new Map<string, UserRow>(); // lowercase email

function normalizeHandle(handle: string) {
  return handle.trim().toLowerCase();
}

function seedDemoUser() {
  const id = "u1";
  if (usersById.has(id)) return;
  const email = "test@example.com";
  const passwordHash = bcrypt.hashSync("123456", 10);
  const row: UserRow = {
    id,
    email,
    passwordHash,
    handle: "testuser",
    avatarUrl: "",
    bio: ""
  };
  usersById.set(id, row);
  usersByEmail.set(email.toLowerCase(), row);
}

seedDemoUser();

function signToken(userId: string) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "7d" });
}

function verifyUserId(tok: string): string | null {
  try {
    const p = jwt.verify(tok, JWT_SECRET) as { sub?: string };
    return typeof p?.sub === "string" ? p.sub : null;
  } catch {
    return null;
  }
}

function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    handle: u.handle,
    avatarUrl: u.avatarUrl,
    bio: u.bio
  };
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateHandle(handle: string) {
  const t = handle.trim();
  return t.length >= 2 && t.length <= 32 && /^[a-zA-Z0-9_-]+$/.test(t);
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true
  })
);
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "express-backend" });
});

app.post("/api/auth/register", (req, res) => {
  const { email, password, handle } = req.body ?? {};
  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    typeof handle !== "string"
  ) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  if (!isValidEmail(email) || password.length < 6 || !validateHandle(handle)) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const emailLc = email.toLowerCase();
  const nHandle = normalizeHandle(handle);
  for (const u of usersById.values()) {
    if (u.email === emailLc || normalizeHandle(u.handle) === nHandle) {
      res.status(409).json({ error: "email_or_handle_taken" });
      return;
    }
  }

  const id = randomUUID();
  const passwordHash = bcrypt.hashSync(password, 10);
  const row: UserRow = {
    id,
    email: emailLc,
    passwordHash,
    handle: handle.trim(),
    avatarUrl: "",
    bio: ""
  };
  usersById.set(id, row);
  usersByEmail.set(emailLc, row);

  const token = signToken(id);
  res.json({ token, user: publicUser(row) });
});

const loginHandler: express.RequestHandler = (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "missing_email_or_password" });
    return;
  }
  const u = usersByEmail.get(email.toLowerCase());
  if (!u || !bcrypt.compareSync(password, u.passwordHash)) {
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }
  const token = signToken(u.id);
  res.json({ ok: true, token, user: publicUser(u) });
};

app.post("/api/login", loginHandler);
app.post("/api/auth/login", loginHandler);

app.get("/api/me", (req, res) => {
  const hdr = req.headers.authorization;
  const tok = hdr?.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!tok) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const uid = verifyUserId(tok);
  if (!uid) {
    res.status(401).json({ error: "invalid_token" });
    return;
  }
  const u = usersById.get(uid);
  if (!u) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(publicUser(u));
});

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
