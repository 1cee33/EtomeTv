import type WebSocket from "ws";

export type RoomMap = Map<string, Map<string, WebSocket>>;

export function createRoomMap(): RoomMap {
  return new Map();
}

export function joinRoom(
  rooms: RoomMap,
  roomKey: string,
  userId: string,
  ws: WebSocket,
  prevRoom: string | null
): void {
  if (prevRoom) {
    rooms.get(prevRoom)?.delete(userId);
  }
  let m = rooms.get(roomKey);
  if (!m) {
    m = new Map();
    rooms.set(roomKey, m);
  }
  m.set(userId, ws);
}

export function leaveAllRooms(rooms: RoomMap, ws: WebSocket): void {
  for (const [, members] of rooms) {
    for (const [mid, sock] of members) {
      if (sock === ws) members.delete(mid);
    }
  }
}

export function relayRoom(
  rooms: RoomMap,
  roomKey: string,
  fromUserId: string,
  envelope: Record<string, unknown>
): void {
  const room = rooms.get(roomKey);
  if (!room) return;
  const rawTarget = envelope.target as string | undefined;
  const msg = JSON.stringify({ ...envelope, from: fromUserId });
  if (rawTarget) {
    const sock = room.get(rawTarget);
    if (sock && sock.readyState === 1) sock.send(msg);
    return;
  }
  for (const [uid, sock] of room) {
    if (uid !== fromUserId && sock.readyState === 1) sock.send(msg);
  }
}
