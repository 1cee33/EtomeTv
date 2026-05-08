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
  createHostedLobby,
  getLobby,
  joinHostedLobby,
  leaveLobbyMember,
  resolveRandomQueueKey,
} from "./matchRandom.js";
import {
  closeUserStore,
  createUserStore,
  publicUser,
  type PersistenceMode,
  type UserStore,
} from "./userStore.js";

dotenv.config();

type Friendship = {
  id: string;
  requesterId: string;
  targetId: string;
  status: "pending" | "accepted";
  createdAt: number;
};
type MatchEntry = {
  id: string;
  users: [string, string];
  lobbyId: string;
  createdAt: number;
  optedIn: Set<string>;
};
const friendships = new Map<string, Friendship>();
const blocks = new Set<string>();
const randomByLobbyId = new Map<string, MatchEntry>();

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

function normalizeInterests(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const val of raw) {
    if (typeof val !== "string") continue;
    const clean = val
      .trim()
      .toLowerCase()
      .replace(/^#+/, "");
    if (!clean) continue;
    const tag = `#${clean}`;
    if (tag.length > 32 || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= 10) break;
  }
  return out;
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
  function blockKey(a: string, b: string) {
    return `${a}:${b}`;
  }
  function areFriends(a: string, b: string) {
    for (const f of friendships.values()) {
      if (f.status !== "accepted") continue;
      if (
        (f.requesterId === a && f.targetId === b) ||
        (f.requesterId === b && f.targetId === a)
      ) {
        return true;
      }
    }
    return false;
  }
  function pendingFriendshipBetween(a: string, b: string): Friendship | null {
    for (const f of friendships.values()) {
      if (f.status !== "pending") continue;
      if (
        (f.requesterId === a && f.targetId === b) ||
        (f.requesterId === b && f.targetId === a)
      ) {
        return f;
      }
    }
    return null;
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
        status: "online",
        gender: "",
        country: "",
        interests: [],
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
    const { handle, bio, avatarUrl, status, gender, country, interests } = body;

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
    if (
      status !== undefined &&
      status !== "online" &&
      status !== "away" &&
      status !== "in_call"
    ) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    if (gender !== undefined && typeof gender !== "string") {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    if (country !== undefined && typeof country !== "string") {
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
      const patch: {
        handle?: string;
        bio?: string;
        avatarUrl?: string;
        status?: "online" | "away" | "in_call";
        gender?: string;
        country?: string;
        interests?: string[];
      } = {};
      if (typeof handle === "string") patch.handle = handle.trim();
      if (typeof bio === "string") patch.bio = bio;
      if (avatarUrl !== undefined) patch.avatarUrl = avatarTrim;
      if (status === "online" || status === "away" || status === "in_call") patch.status = status;
      if (typeof gender === "string") patch.gender = gender.trim().slice(0, 40);
      if (typeof country === "string") patch.country = country.trim().slice(0, 40);
      if (interests !== undefined) patch.interests = normalizeInterests(interests);

      if (typeof handle === "string") {
        const hn = normalizeHandle(handle);
        const current = await store.findById(uid);
        const sameHandle =
          current && normalizeHandle(current.handle) === hn;
        if (!sameHandle && (await store.isHandleTakenByOther(uid, hn))) {
          res.status(409).json({ error: "handle_taken" });
          return;
        }
      }

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

  app.post("/api/lobbies", async (req, res) => {
    const uid = authUser(req);
    if (!uid) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const raw = (req.body as { maxParticipants?: unknown })?.maxParticipants;
    const maxParticipants =
      typeof raw === "number" && Number.isFinite(raw) ? raw : 8;
    const lobby = createHostedLobby(uid, maxParticipants);
    res.json({
      lobbyId: lobby.id,
      code: lobby.code,
      signalingRoom: `lobby:${lobby.id}`,
    });
  });

  app.post("/api/lobbies/join", async (req, res) => {
    const uid = authUser(req);
    if (!uid) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const code = (req.body as { code?: unknown })?.code;
    if (typeof code !== "string" || code.trim().length < 4) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const r = joinHostedLobby(uid, code);
    if (!r.ok) {
      if (r.error === "not_found") res.status(404).json({ error: "not_found" });
      else res.status(403).json({ error: "lobby_full" });
      return;
    }
    const lobby = r.lobby;
    res.json({
      lobbyId: lobby.id,
      code: lobby.code,
      signalingRoom: `lobby:${lobby.id}`,
    });
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

  app.get("/api/users/:id/public", async (req, res) => {
    const uid = authUser(req);
    if (!uid) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const target = await store.findById(req.params.id);
    if (!target) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({
      ...publicUser(target),
      isFriend: areFriends(uid, target.id),
    });
  });

  app.get("/api/users/search", async (req, res) => {
    const uid = authUser(req);
    if (!uid) return void res.status(401).json({ error: "unauthorized" });
    const qRaw = typeof req.query.q === "string" ? req.query.q : "";
    const q = normalizeHandle(qRaw);
    if (!q) return void res.json({ users: [] });
    const rows = await store.searchByHandle(q, 8);
    const users = rows
      .map((u) => ({
        id: u.id,
        handle: u.handle,
        avatarUrl: u.avatarUrl,
        isSelf: u.id === uid,
      }));
    res.json({ users });
  });

  app.get("/api/friends", async (req, res) => {
    const uid = authUser(req);
    if (!uid) return void res.status(401).json({ error: "unauthorized" });
    const friends: Array<Record<string, unknown>> = [];
    const inbound: Array<Record<string, unknown>> = [];
    const outbound: Array<Record<string, unknown>> = [];
    for (const f of friendships.values()) {
      const otherId = f.requesterId === uid ? f.targetId : f.targetId === uid ? f.requesterId : null;
      if (!otherId) continue;
      const other = await store.findById(otherId);
      if (!other) continue;
      const row = { friendshipId: f.id, ...publicUser(other) };
      if (f.status === "accepted") friends.push(row);
      else if (f.targetId === uid) inbound.push(row);
      else outbound.push(row);
    }
    res.json({ friends, inbound, outbound });
  });

  app.post("/api/friends/request", async (req, res) => {
    const uid = authUser(req);
    if (!uid) return void res.status(401).json({ error: "unauthorized" });
    const body = req.body as { targetHandle?: unknown; targetUserId?: unknown };
    let target = null as Awaited<ReturnType<UserStore["findById"]>>;
    if (typeof body.targetUserId === "string" && body.targetUserId.trim()) {
      target = await store.findById(body.targetUserId.trim());
    } else if (typeof body.targetHandle === "string" && body.targetHandle.trim()) {
      target = await store.findByHandleNorm(normalizeHandle(body.targetHandle));
    }
    if (!target) return void res.status(404).json({ error: "target_not_found" });
    if (target.id === uid) return void res.status(400).json({ error: "cannot_friend_self" });
    if (blocks.has(blockKey(uid, target.id)) || blocks.has(blockKey(target.id, uid))) {
      return void res.status(403).json({ error: "blocked" });
    }
    if (areFriends(uid, target.id)) return void res.json({ ok: true, already: "friends" });
    const pending = pendingFriendshipBetween(uid, target.id);
    if (pending) return void res.json({ ok: true, already: "pending" });
    const fr: Friendship = {
      id: randomUUID(),
      requesterId: uid,
      targetId: target.id,
      status: "pending",
      createdAt: Date.now(),
    };
    friendships.set(fr.id, fr);
    res.json({ ok: true, friendshipId: fr.id });
  });

  app.post("/api/friends/accept", async (req, res) => {
    const uid = authUser(req);
    if (!uid) return void res.status(401).json({ error: "unauthorized" });
    const fid = (req.body as { friendshipId?: unknown })?.friendshipId;
    if (typeof fid !== "string" || !fid.trim()) {
      return void res.status(400).json({ error: "invalid_body" });
    }
    const f = friendships.get(fid);
    if (!f || f.targetId !== uid || f.status !== "pending") {
      return void res.status(404).json({ error: "not_found" });
    }
    f.status = "accepted";
    friendships.set(f.id, f);
    res.json({ ok: true });
  });

  app.delete("/api/friends/:id", async (req, res) => {
    const uid = authUser(req);
    if (!uid) return void res.status(401).json({ error: "unauthorized" });
    const otherId = req.params.id;
    for (const [id, f] of friendships) {
      if (
        (f.requesterId === uid && f.targetId === otherId) ||
        (f.targetId === uid && f.requesterId === otherId)
      ) {
        friendships.delete(id);
      }
    }
    res.json({ ok: true });
  });

  app.post("/api/friends/block", async (req, res) => {
    const uid = authUser(req);
    if (!uid) return void res.status(401).json({ error: "unauthorized" });
    const other = (req.body as { userId?: unknown })?.userId;
    if (typeof other !== "string" || !other.trim()) {
      return void res.status(400).json({ error: "invalid_body" });
    }
    blocks.add(blockKey(uid, other));
    for (const [id, f] of friendships) {
      if (
        (f.requesterId === uid && f.targetId === other) ||
        (f.targetId === uid && f.requesterId === other)
      ) {
        friendships.delete(id);
      }
    }
    res.json({ ok: true });
  });

  app.post("/api/random/:lobbyId/opt-in", (req, res) => {
    const uid = authUser(req);
    if (!uid) return void res.status(401).json({ error: "unauthorized" });
    const m = randomByLobbyId.get(req.params.lobbyId);
    if (!m || !m.users.includes(uid)) return void res.status(404).json({ error: "not_found" });
    const optIn = Boolean((req.body as { optIn?: unknown })?.optIn);
    if (optIn) m.optedIn.add(uid);
    else m.optedIn.delete(uid);
    res.json({ ok: true, mutual: m.optedIn.size === 2 });
  });

  app.get("/api/random/history", async (req, res) => {
    const uid = authUser(req);
    if (!uid) return void res.status(401).json({ error: "unauthorized" });
    const entries = [];
    for (const m of randomByLobbyId.values()) {
      if (!m.users.includes(uid)) continue;
      if (m.optedIn.size < 2) continue;
      const otherId = m.users[0] === uid ? m.users[1] : m.users[0];
      const other = await store.findById(otherId);
      if (!other) continue;
      entries.push({
        matchId: m.id,
        lobbyId: m.lobbyId,
        matchedAt: m.createdAt,
        user: publicUser(other),
      });
    }
    entries.sort((a, b) => b.matchedAt - a.matchedAt);
    res.json({ history: entries.slice(0, 30) });
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
      const room = rtcRooms.get(roomKey);
      const peers = [...(room?.keys() ?? [])].filter(
        (id) => id !== uid
      );
      ws.send(JSON.stringify({ type: "rtc_joined", room: roomKey, peers }));
      // Notify existing peers immediately so at least one side dials without waiting for roster polling.
      const joinedNotice = JSON.stringify({ type: "rtc_peer_joined", from: uid });
      for (const [pid, sock] of room ?? []) {
        if (pid === uid) continue;
        if (sock.readyState === 1) sock.send(joinedNotice);
      }
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
      const queueKey = resolveRandomQueueKey(uid, msg.lobbyId);
      enqueueRandom(uid, ws, queueKey, msg.interests, (pair) => {
        randomByLobbyId.set(pair.lobbyId, {
          id: randomUUID(),
          users: pair.users,
          lobbyId: pair.lobbyId,
          createdAt: Date.now(),
          optedIn: new Set<string>(),
        });
      });
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
