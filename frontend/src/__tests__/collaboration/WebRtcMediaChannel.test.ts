import { WebRtcMediaChannel } from "@/collaboration/WebRtcMediaChannel";

function track(kind = "audio") {
  return {
    id: kind,
    kind,
    enabled: true,
    stop: jest.fn(),
    onended: null,
    onmute: null,
    onunmute: null,
  };
}
class Stream {
  tracks: ReturnType<typeof track>[];
  constructor(tracks: ReturnType<typeof track>[] = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  addTrack(t: ReturnType<typeof track>) {
    this.tracks.push(t);
  }
  removeTrack(t: ReturnType<typeof track>) {
    this.tracks = this.tracks.filter((v) => v !== t);
  }
}
const pcs: FakePC[] = [];
class FakePC {
  signalingState = "stable";
  connectionState = "new";
  remoteDescription: unknown = null;
  localDescription = { toJSON: () => ({ type: "answer", sdp: "answer" }) };
  onnegotiationneeded: (() => Promise<void>) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onicecandidate: unknown;
  ontrack: unknown;
  senders: { replaceTrack: jest.Mock }[] = [];
  constructor() {
    pcs.push(this);
  }
  addTransceiver() {
    const sender = { replaceTrack: jest.fn().mockResolvedValue(undefined) };
    this.senders.push(sender);
    return { sender };
  }
  setRemoteDescription = jest.fn(async (description) => {
    this.remoteDescription = description;
    this.signalingState = "stable";
  });
  setLocalDescription = jest.fn().mockResolvedValue(undefined);
  addIceCandidate = jest.fn().mockResolvedValue(undefined);
  restartIce = jest.fn();
  close = jest.fn(() => {
    this.signalingState = "closed";
  });
}
let microphone: Stream;
let display: Stream;
let send: jest.Mock;
let failed: jest.Mock;
let screenChanged: jest.Mock;
let media: WebRtcMediaChannel;
beforeEach(() => {
  pcs.length = 0;
  microphone = new Stream([track()]);
  display = new Stream([track("video")]);
  Object.assign(globalThis, { MediaStream: Stream, RTCPeerConnection: FakePC });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: jest.fn().mockResolvedValue(microphone),
      getDisplayMedia: jest.fn().mockResolvedValue(display),
    },
  });
  send = jest.fn();
  failed = jest.fn();
  screenChanged = jest.fn();
  media = new WebRtcMediaChannel(
    {
      iceServers: [
        {
          urls: "turn:relay.example",
          username: "temporary",
          credential: "temporary",
        },
      ],
    },
    send,
    jest.fn(),
    failed,
    screenChanged,
  );
});
afterEach(() => media.close());

test("requests echo-cancelled microphone only, starts muted and toggles capture", async () => {
  await media.startAudio();
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  expect(microphone.tracks[0].enabled).toBe(false);
  media.setMuted(false);
  expect(microphone.tracks[0].enabled).toBe(true);
  media.setMuted(true);
  expect(microphone.tracks[0].enabled).toBe(false);
});
test("late permission response after leave immediately stops all returned tracks", async () => {
  let resolve!: (stream: Stream) => void;
  (navigator.mediaDevices.getUserMedia as jest.Mock).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const pending = media.startAudio();
  media.close();
  resolve(microphone);
  expect(await pending).toBe(false);
  expect(microphone.tracks[0].stop).toHaveBeenCalled();
});
test("permission failures propagate so the UI can explain the browser denial", async () => {
  (navigator.mediaDevices.getUserMedia as jest.Mock).mockRejectedValue(
    new DOMException("Denied", "NotAllowedError"),
  );
  await expect(media.startAudio()).rejects.toHaveProperty(
    "name",
    "NotAllowedError",
  );
});
test("creates one peer per member, removes departed peers and preserves other connections", async () => {
  await media.startAudio();
  media.setPeers("a", [
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ]);
  media.setPeers("a", [{ id: "b", name: "B" }]);
  expect(pcs).toHaveLength(2);
  expect(pcs[1].close).toHaveBeenCalled();
  expect(pcs[0].close).not.toHaveBeenCalled();
});
test("buffers ICE until remote description and responds to offers", async () => {
  media.setPeers("z", [{ id: "b", name: "B" }]);
  const candidate = { candidate: "candidate:1" };
  await media.receive("b", { candidate });
  expect(pcs[0].addIceCandidate).not.toHaveBeenCalled();
  await media.receive("b", { description: { type: "offer", sdp: "offer" } });
  expect(pcs[0].addIceCandidate).toHaveBeenCalledWith(candidate);
  expect(send).toHaveBeenCalledWith("b", {
    description: { type: "answer", sdp: "answer" },
  });
});
test("impolite peer ignores colliding offers and their ICE", async () => {
  media.setPeers("a", [{ id: "z", name: "Z" }]);
  pcs[0].signalingState = "have-local-offer";
  await media.receive("z", {
    description: { type: "offer", sdp: "collision" },
  });
  await media.receive("z", { candidate: { candidate: "ignored" } });
  expect(pcs[0].setRemoteDescription).not.toHaveBeenCalled();
  expect(pcs[0].addIceCandidate).not.toHaveBeenCalled();
});
test("polite peer accepts colliding offer for implicit rollback", async () => {
  media.setPeers("z", [{ id: "a", name: "A" }]);
  pcs[0].signalingState = "have-local-offer";
  await media.receive("a", {
    description: { type: "offer", sdp: "collision" },
  });
  expect(pcs[0].setRemoteDescription).toHaveBeenCalledWith({
    type: "offer",
    sdp: "collision",
  });
});
test("shares a screen on existing video sender and browser stop releases capture", async () => {
  await media.startAudio();
  media.setPeers("a", [{ id: "b", name: "B" }]);
  await media.shareScreen();
  expect(pcs[0].senders[1].replaceTrack).toHaveBeenCalledWith(
    display.tracks[0],
  );
  (display.tracks[0].onended as unknown as () => void)();
  expect(display.tracks[0].stop).toHaveBeenCalled();
  expect(screenChanged).toHaveBeenLastCalledWith(null);
});
test("late screen selection after leave is stopped and never published", async () => {
  let resolve!: (stream: Stream) => void;
  (navigator.mediaDevices.getDisplayMedia as jest.Mock).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const pending = media.shareScreen();
  media.close();
  resolve(display);
  await pending;
  expect(display.tracks[0].stop).toHaveBeenCalled();
  expect(screenChanged).not.toHaveBeenCalledWith(display);
});
test("failed connections attempt ICE restart and cleanup closes every connection and capture", async () => {
  await media.startAudio();
  media.setPeers("a", [{ id: "b", name: "B" }]);
  await media.shareScreen();
  pcs[0].connectionState = "failed";
  pcs[0].onconnectionstatechange!();
  expect(pcs[0].restartIce).toHaveBeenCalled();
  expect(failed).toHaveBeenCalled();
  media.close();
  expect(pcs[0].close).toHaveBeenCalled();
  expect(microphone.tracks[0].stop).toHaveBeenCalled();
  expect(display.tracks[0].stop).toHaveBeenCalled();
});
