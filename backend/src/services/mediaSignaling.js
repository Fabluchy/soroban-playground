import { randomUUID } from 'node:crypto';

// Opaque room names are invitation codes, not a replacement for WS_AUTH_TOKEN.
// Media never traverses this server; only room-scoped SDP and ICE do.
export function createMediaSignaling(send) {
  const members = new Map();
  const presence = (room) => {
    const peers = [...members.values()].filter((m) => m.room === room);
    for (const member of peers) {
      send(member.socket, {
        type: 'media-presence',
        selfId: member.id,
        peers: peers
          .filter((p) => p !== member)
          .map(({ id, name }) => ({ id, name })),
      });
    }
  };
  const leave = (socket) => {
    const member = members.get(socket);
    if (!member) return;
    members.delete(socket);
    presence(member.room);
  };
  const handle = (socket, payload) => {
    if (payload.type === 'media-join') {
      if (
        typeof payload.room !== 'string' ||
        !/^[a-zA-Z0-9_-]{12,128}$/.test(payload.room)
      ) {
        send(socket, {
          type: 'media-error',
          message:
            'Use a room code of 12–128 letters, numbers, dashes or underscores.',
        });
        return true;
      }
      const count = [...members.values()].filter(
        (m) => m.room === payload.room
      ).length;
      if (count >= 8 && members.get(socket)?.room !== payload.room) {
        send(socket, {
          type: 'media-error',
          message: 'This audio room is full (8 participants).',
        });
        return true;
      }
      leave(socket);
      members.set(socket, {
        socket,
        id: randomUUID(),
        room: payload.room,
        name: String(payload.name || 'Peer').slice(0, 40),
      });
      presence(payload.room);
      return true;
    }
    if (payload.type === 'media-leave') {
      leave(socket);
      return true;
    }
    if (payload.type !== 'media-signal') return false;
    const from = members.get(socket);
    const to = [...members.values()].find((m) => m.id === payload.to);
    if (!from || !to || from === to || from.room !== to.room) return true;
    const signal = payload.signal;
    if (
      !signal ||
      typeof signal !== 'object' ||
      JSON.stringify(signal).length > 65536
    )
      return true;
    if (
      signal.description &&
      !['offer', 'answer'].includes(signal.description.type)
    )
      return true;
    if (!signal.description && !signal.candidate) return true;
    send(to.socket, { type: 'media-signal', from: from.id, signal });
    return true;
  };
  return { handle, leave };
}
