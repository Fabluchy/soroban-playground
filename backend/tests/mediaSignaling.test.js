import { createMediaSignaling } from '../src/services/mediaSignaling.js';

describe('room-scoped WebRTC signaling', () => {
  let relay;
  let send;
  const a = {};
  const b = {};
  const c = {};
  const join = (socket, room = 'private-room-123') =>
    relay.handle(socket, { type: 'media-join', room, name: 'Developer' });
  beforeEach(() => {
    send = jest.fn();
    relay = createMediaSignaling(send);
  });
  test('stable server-issued identity is shared in presence and departure is broadcast', () => {
    join(a);
    const id = send.mock.calls[0][1].selfId;
    join(b);
    expect(
      send.mock.calls.find(
        ([socket, payload]) => socket === b && payload.peers.length
      )[1].peers[0].id
    ).toBe(id);
    relay.leave(a);
    expect(send).toHaveBeenLastCalledWith(
      b,
      expect.objectContaining({ peers: [] })
    );
  });
  test('routes only to same-room members and replaces forged sender identity', () => {
    join(a);
    join(b);
    join(c, 'different-room-123');
    const idFor = (socket) =>
      send.mock.calls.find(([s]) => s === socket)[1].selfId;
    const target = idFor(b);
    const other = idFor(c);
    const signal = { description: { type: 'offer', sdp: 'hello' } };
    send.mockClear();
    relay.handle(a, {
      type: 'media-signal',
      to: target,
      from: 'forged',
      signal,
    });
    expect(send).toHaveBeenCalledWith(
      b,
      expect.objectContaining({
        type: 'media-signal',
        signal,
        from: expect.not.stringMatching(/^forged$/),
      })
    );
    send.mockClear();
    relay.handle(a, { type: 'media-signal', to: other, signal });
    expect(send).not.toHaveBeenCalled();
    relay.handle({}, { type: 'media-signal', to: target, signal });
    expect(send).not.toHaveBeenCalled();
  });
  test('rejects invalid room codes and oversized signal payloads', () => {
    join(a, 'public');
    expect(send).toHaveBeenCalledWith(
      a,
      expect.objectContaining({ type: 'media-error' })
    );
    join(a);
    join(b);
    const target = send.mock.calls.find(([s]) => s === b)[1].selfId;
    send.mockClear();
    relay.handle(a, {
      type: 'media-signal',
      to: target,
      signal: { description: { type: 'offer', sdp: 'x'.repeat(70000) } },
    });
    expect(send).not.toHaveBeenCalled();
  });
  test('limits mesh rooms to eight participants', () => {
    for (let i = 0; i < 8; i++) join({});
    const extra = {};
    join(extra);
    expect(send).toHaveBeenLastCalledWith(
      extra,
      expect.objectContaining({ type: 'media-error' })
    );
  });
  test('leaving prevents further signaling and unrelated protocols are untouched', () => {
    join(a);
    relay.leave(a);
    expect(relay.handle(a, { type: 'subscribe' })).toBe(false);
  });
});
