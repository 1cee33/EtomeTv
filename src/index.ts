import http from "node:http";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  createRoomMap,
  joinRoom,
  leaveAllRooms,
  relayRoom,
} from "./signalRooms.js";
import {
  dequeueRandom,
  enqueueRandom,
  getLobby,
  leaveLobbyMember,
} from "./matchRandom.js";
import {
  closeUserStore,
  createUserStore,
  publicUser,
  type PersistenceMode,
  type UserStore,
} from "./userStore.js";

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

function normalizeHandle(handle: string) {
  return handle.trim().toLowerCase();
}

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

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateHandle(handle: string) {
  const t = handle.trim();
  return t.length >= 2 && t.length <= 32 && /^[a-zA-Z0-9_-]+$/.test(t);
}

function authUser(req: express.Request): string | null {
  const hdr = req.headers.authorization;
  const tok = hdr?.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!tok) return null;
  return verifyUserId(tok);
}

function isDuplicateKey(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: string | number }).code;
  return code === "23505" || code === 23505 || code === 11000;
}

function mountRoutes(store: UserStore, persistence: PersistenceMode) {
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("Not allowed by CORS"));
      },
      credentials: true,
    })
  );
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      service: "express-backend",
      wsPath: "/ws",
      persistence,
    });
  });

  app.post("/api/auth/register", async (req, res) => {
    const { email, password, handle } = req.body ?? {};
    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      typeof handle !== "string"
    ) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const emailTrimmed = email.trim();
    if (
      !isValidEmail(emailTrimmed) ||
      password.length < 6 ||
      !validateHandle(handle)
    ) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const emailLc = emailTrimmed.toLowerCase();
    const nHandle = normalizeHandle(handle);

    try {
      if (await store.isEmailOrHandleTaken(emailLc, nHandle)) {
        res.status(409).json({ error: "email_or_handle_taken" });
        return;
      }

      const id = randomUUID();
      const passwordHash = bcrypt.hashSync(password, 10);
      await store.createUser({
        id,
        email: emailLc,
        passwordHash,
        handle: handle.trim(),
        avatarUrl: "",
        bio: "",
      });

      const fresh = await store.findById(id);
      if (!fresh) {
        res.status(500).json({ error: "server_error" });
        return;
      }

      const token = signToken(id);
      res.json({ token, user: publicUser(fresh) });
    } catch (e) {
      if (isDuplicateKey(e)) {
        res.status(409).json({ error: "email_or_handle_taken" });
        return;
      }
      console.error(e);
      res.status(500).json({ error: "server_error" });
    }
  });

  const loginHandler: express.RequestHandler = async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "missing_email_or_password" });
      return;
    }
    const u = await store.findByEmailLc(email.trim().toLowerCase());
    if (!u || !bcrypt.compareSync(password, u.passwordHash)) {
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }
    const token = signToken(u.id);
    res.json({ ok: true, token, user: publicUser(u) });
  };

  app.post("/api/login", loginHandler);
  app.post("/api/auth/login", loginHandler);

  app.get("/api/me", async (req, res) => {
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
    const u = await store.findById(uid);
    if (!u) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(publicUser(u));
  });

  app.patch("/api/profile", async (req, res) => {
    const uid = authUser(req);
    if (!uid) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const { handle, bio, avatarUrl } = body;

    if (
      handle !== undefined &&
      (typeof handle !== "string" || !validateHandle(handle))
    ) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    if (
      bio !== undefined &&
      (typeof bio !== "string" || bio.length > 500)
    ) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    if (avatarUrl !== undefined && typeof avatarUrl !== "string") {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    let avatarTrim = "";
    if (typeof avatarUrl === "string") {
      avatarTrim = avatarUrl.trim();
      if (avatarTrim !== "" && !/^https?:\/\/.+/i.test(avatarTrim)) {
        res.status(400).json({ error: "invalid_body" });
        return;
      }
    }

    try {
      if (typeof handle === "string") {
        const hn = normalizeHandle(handle);
        if (await store.isHandleTakenByOther(uid, hn)) {
          res.status(409).json({ error: "handle_taken" });
          return;
        }
      }

      const patch: {
        handle?: string;
        bio?: string;
        avatarUrl?: string;
      } = {};
      if (typeof handle === "string") patch.handle = handle.trim();
      if (typeof bio === "string") patch.bio = bio;
      if (avatarUrl !== undefined) patch.avatarUrl = avatarTrim;

      const u = await store.applyProfilePatch(uid, patch);
      if (!u) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(publicUser(u));
    } catch (e) {
      if (isDuplicateKey(e)) {
        res.status(409).json({ error: "handle_taken" });
        return;
      }
      console.error(e);
      res.status(500).json({ error: "server_error" });
    }
  });

  app.post("/api/lobbies/:id/leave", (req, res) => {
    const uid = authUser(req);
    if (!uid) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const lobbyId = req.params.id;
    leaveLobbyMember(lobbyId, uid);
    res.json({ ok: true });
  });

  app.get("/api/lobbies/:id/roster", async (req, res) => {
    const uid = authUser(req);
    if (!uid) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const lobby = getLobby(req.params.id);
    if (!lobby || !lobby.memberIds.includes(uid)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const members = [];
    for (const idm of lobby.memberIds) {
      const pu = await store.findById(idm);
      if (pu)
        members.push({
          id: pu.id,
          email: pu.email,
          handle: pu.handle,
          avatarUrl: pu.avatarUrl,
          bio: pu.bio,
          isSelf: idm === uid,
          isFriend: false,
        });
    }

    res.json({
      lobbyId: lobby.id,
      code: lobby.code,
      creatorId: lobby.creatorId,
      members,
    });
  });
}

const rtcRooms = createRoomMap();
const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws: WebSocket) => {
  let uid: string | null = null;
  let currentRoom: string | null = null;

  ws.on("message", (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const t = msg.type as string | undefined;

    if (t === "auth") {
      const token = typeof msg.token === "string" ? msg.token : "";
      const p = verifyUserId(token);
      if (!p) {
        ws.send(JSON.stringify({ type: "auth_error" }));
        return;
      }
      uid = p;
      ws.send(JSON.stringify({ type: "auth_ok" }));
      return;
    }

    if (!uid) return;

    if (t === "rtc_join") {
      const roomKey = typeof msg.room === "string" ? msg.room : "";
      if (!roomKey.startsWith("lobby:")) return;
      const lobbyId = roomKey.slice("lobby:".length);
      const lobby = getLobby(lobbyId);
      if (!lobby?.memberIds.includes(uid)) {
        ws.send(JSON.stringify({ type: "rtc_error", error: "forbidden_room" }));
        return;
      }
      joinRoom(rtcRooms, roomKey, uid, ws, currentRoom);
      currentRoom = roomKey;
      const peers = [...(rtcRooms.get(roomKey)?.keys() ?? [])].filter(
        (id) => id !== uid
      );
      ws.send(JSON.stringify({ type: "rtc_joined", room: roomKey, peers }));
      return;
    }

    if (t === "rtc" && currentRoom) {
      relayRoom(rtcRooms, currentRoom, uid, msg);
      return;
    }

    if (t === "rtc_leave" && currentRoom) {
      relayRoom(rtcRooms, currentRoom, uid, { type: "rtc_peer_left" });
      rtcRooms.get(currentRoom)?.delete(uid);
      currentRoom = null;
      return;
    }

    if (t === "chat" && currentRoom) {
      relayRoom(rtcRooms, currentRoom, uid, msg);
      return;
    }

    if (t === "random_join") {
      enqueueRandom(uid, ws);
      ws.send(JSON.stringify({ type: "random_queued" }));
      return;
    }

    if (t === "random_leave") {
      dequeueRandom(uid);
    }
  });

  ws.on("close", () => {
    if (uid && currentRoom) {
      relayRoom(rtcRooms, currentRoom, uid, { type: "rtc_peer_left" });
    }
    leaveAllRooms(rtcRooms, ws);
    if (uid) {
      dequeueRandom(uid);
    }
  });
});

async function main() {
  const { store, mode } = await createUserStore();
  mountRoutes(store, mode);
  server.listen(PORT, () => {
    console.log(`API + WS on http://localhost:${PORT} persistence=${mode}`);
  });
}

main().catch((e) => {
  console.error(e);
  void closeUserStore();
  process.exit(1);
});

process.on("SIGTERM", () => {
  void closeUserStore();
});
