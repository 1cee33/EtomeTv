import type WebSocket from "ws";
import { randomUUID } from "node:crypto";

export type Lobby = {
  id: string;
  creatorId: string;
  code: string;
  maxParticipants: number;
  memberIds: string[];
};

const randomQueue: { userId: string; ws: WebSocket }[] = [];

/** In-memory pairs created by random match (same lifetime as RAM on Render). */
export const lobbieById = new Map<string, Lobby>();

function send(ws: WebSocket, obj: Record<string, unknown>) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

export function enqueueRandom(userId: string, ws: WebSocket) {
  if (randomQueue.some((w) => w.userId === userId)) return;
  randomQueue.push({ userId, ws });
  while (randomQueue.length >= 2) {
    const A = randomQueue.shift()!;
    const B = randomQueue.shift()!;
    if (A.ws.readyState !== 1) {
      if (B.ws.readyState === 1) randomQueue.unshift(B);
      continue;
    }
    if (B.ws.readyState !== 1) {
      randomQueue.unshift(A);
      continue;
    }

    const id = randomUUID();
    const code = `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const lobby: Lobby = {
      id,
      creatorId: A.userId,
      code,
      maxParticipants: 8,
      memberIds: [A.userId, B.userId]
    };
    lobbieById.set(id, lobby);

    const signalingRoom = `lobby:${id}`;
    const payload = {
      type: "random_paired",
      lobbyId: lobby.id,
      code: lobby.code,
      signalingRoom
    };
    send(A.ws, payload);
    send(B.ws, payload);
  }
}

export function dequeueRandom(userId: string) {
  const i = randomQueue.findIndex((w) => w.userId === userId);
  if (i >= 0) randomQueue.splice(i, 1);
}

export function getLobby(id: string) {
  return lobbieById.get(id);
}

export function deleteLobbyIfCreatorEmpty(lobbyId: string): void {
  const L = lobbieById.get(lobbyId);
  if (!L || L.memberIds.length > 0) return;
  lobbieById.delete(lobbyId);
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
