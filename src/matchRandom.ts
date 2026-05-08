import type WebSocket from "ws";
import { randomUUID } from "node:crypto";

export type Lobby = {
  id: string;
  creatorId: string;
  code: string;
  maxParticipants: number;
  memberIds: string[];
};

type Waiter = { userId: string; ws: WebSocket; interests: string[] };

/** Pairing queues: `__global__` or `lobby:<id>` for lobby-only matching. */
const queues = new Map<string, Waiter[]>();

/** In-memory lobbies (hosted + random-pair). */
export const lobbieById = new Map<string, Lobby>();

function getQueue(key: string): Waiter[] {
  let q = queues.get(key);
  if (!q) {
    q = [];
    queues.set(key, q);
  }
  return q;
}

function send(ws: WebSocket, obj: Record<string, unknown>) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

/** Users in the same lobby can scope random match to only pair within that lobby. */
export function resolveRandomQueueKey(
  userId: string,
  lobbyIdRaw: unknown
): string {
  if (typeof lobbyIdRaw !== "string" || !lobbyIdRaw.trim()) return "__global__";
  const id = lobbyIdRaw.trim();
  const L = lobbieById.get(id);
  if (L?.memberIds.includes(userId)) return `lobby:${id}`;
  return "__global__";
}

export function enqueueRandom(
  userId: string,
  ws: WebSocket,
  queueKey: string,
  interestsRaw?: unknown,
  onPaired?: (pair: { lobbyId: string; users: [string, string] }) => void
) {
  const q = getQueue(queueKey);
  const interests = Array.isArray(interestsRaw)
    ? interestsRaw
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 10)
    : [];
  if (q.some((w) => w.userId === userId)) return;
  q.push({ userId, ws, interests });
  while (q.length >= 2) {
    const A = q.shift()!;
    let bi = -1;
    for (let i = 0; i < q.length; i++) {
      const cand = q[i]!;
      const hasSharedInterest =
        A.interests.length > 0 &&
        cand.interests.length > 0 &&
        A.interests.some((t) => cand.interests.includes(t));
      const fallbackNoPrefs = A.interests.length === 0 || cand.interests.length === 0;
      if (hasSharedInterest || fallbackNoPrefs) {
        bi = i;
        break;
      }
    }
    if (bi < 0) {
      q.push(A);
      break;
    }
    const [B] = q.splice(bi, 1);
    if (!B) break;
    if (A.ws.readyState !== 1) {
      if (B.ws.readyState === 1) q.unshift(B);
      continue;
    }
    if (B.ws.readyState !== 1) {
      q.unshift(A);
      continue;
    }

    const id = randomUUID();
    const code = `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const lobby: Lobby = {
      id,
      creatorId: A.userId,
      code,
      maxParticipants: 8,
      memberIds: [A.userId, B.userId],
    };
    lobbieById.set(id, lobby);

    const signalingRoom = `lobby:${id}`;
    const payload = {
      type: "random_paired",
      lobbyId: lobby.id,
      code: lobby.code,
      signalingRoom,
    };
    send(A.ws, payload);
    send(B.ws, payload);
    onPaired?.({ lobbyId: lobby.id, users: [A.userId, B.userId] });
  }
}

export function joinHostedLobby(
  userId: string,
  codeRaw: string
):
  | { ok: true; lobby: Lobby }
  | { ok: false; error: "not_found" | "full" } {
  const code = codeRaw.trim().toUpperCase();
  const lobby = [...lobbieById.values()].find((l) => l.code === code);
  if (!lobby) return { ok: false, error: "not_found" };
  if (
    !lobby.memberIds.includes(userId) &&
    lobby.memberIds.length >= lobby.maxParticipants
  ) {
    return { ok: false, error: "full" };
  }
  if (!lobby.memberIds.includes(userId)) lobby.memberIds.push(userId);
  return { ok: true, lobby };
}

export function createHostedLobby(
  creatorId: string,
  maxParticipants: number
): Lobby {
  const id = randomUUID();
  const code = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const lobby: Lobby = {
    id,
    creatorId,
    code,
    maxParticipants: Math.max(2, Math.min(12, maxParticipants)),
    memberIds: [creatorId],
  };
  lobbieById.set(id, lobby);
  return lobby;
}

export function dequeueRandom(userId: string) {
  for (const q of queues.values()) {
    const i = q.findIndex((w) => w.userId === userId);
    if (i >= 0) q.splice(i, 1);
  }
}

export function getLobby(id: string) {
  return lobbieById.get(id);
}

export function leaveLobbyMember(lobbyId: string, userId: string): void {
  const L = lobbieById.get(lobbyId);
  if (!L) return;
  L.memberIds = L.memberIds.filter((id) => id !== userId);
  if (L.creatorId === userId && L.memberIds.length > 0) {
    L.creatorId = L.memberIds[0]!;
  }
  if (L.memberIds.length === 0) {
    lobbieById.delete(lobbyId);
  }
}
