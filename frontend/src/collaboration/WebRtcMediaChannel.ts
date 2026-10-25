export interface MediaSignal {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}
export interface MediaPeer {
  id: string;
  name: string;
  stream: MediaStream;
  state: RTCPeerConnectionState;
}
interface Connection {
  pc: RTCPeerConnection;
  peer: MediaPeer;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingAnswer: boolean;
  candidates: RTCIceCandidateInit[];
  audio: RTCRtpSender;
  video: RTCRtpSender;
  pending: Promise<void>;
}

/** Owns every capture track and peer connection for one opt-in room session. */
export class WebRtcMediaChannel {
  private connections = new Map<string, Connection>();
  private microphone: MediaStream | null = null;
  private screen: MediaStream | null = null;
  private generation = 0;
  private selfId = "";
  private muted = true;
  constructor(
    private config: RTCConfiguration,
    private send: (id: string, signal: MediaSignal) => void,
    private changed: (peers: MediaPeer[]) => void,
    private failed: (message: string) => void,
    private screenChanged: (stream: MediaStream | null) => void,
  ) {}

  async startAudio() {
    const generation = ++this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    if (generation !== this.generation) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    this.microphone = stream;
    this.setMuted(true);
    return true;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.microphone?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
  }

  async shareScreen() {
    if (this.screen) return;
    const generation = this.generation;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    if (generation !== this.generation) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.screen = stream;
    const track = stream.getVideoTracks()[0];
    track.onended = () => this.stopScreen();
    await Promise.all(
      [...this.connections.values()].map((c) => c.video.replaceTrack(track)),
    );
    this.screenChanged(stream);
  }

  stopScreen() {
    const stream = this.screen;
    this.screen = null;
    stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    for (const c of this.connections.values())
      void c.video.replaceTrack(null).catch(() => {});
    this.screenChanged(null);
  }

  setPeers(selfId: string, peers: { id: string; name: string }[]) {
    this.selfId = selfId;
    const ids = new Set(peers.map((p) => p.id));
    for (const [id, c] of this.connections) {
      if (!ids.has(id)) {
        c.pc.close();
        this.connections.delete(id);
      }
    }
    for (const peer of peers) {
      if (peer.id === selfId || this.connections.has(peer.id)) continue;
      const pc = new RTCPeerConnection(this.config);
      const c: Connection = {
        pc,
        peer: { ...peer, stream: new MediaStream(), state: "new" },
        makingOffer: false,
        ignoreOffer: false,
        settingAnswer: false,
        candidates: [],
        audio: pc.addTransceiver("audio", { direction: "sendrecv" }).sender,
        video: pc.addTransceiver("video", { direction: "sendrecv" }).sender,
        pending: Promise.resolve(),
      };
      this.connections.set(peer.id, c);
      const microphone = this.microphone?.getAudioTracks()[0];
      if (microphone)
        void c.audio
          .replaceTrack(microphone)
          .catch(() => this.failed("Microphone track could not be attached."));
      const screen = this.screen?.getVideoTracks()[0];
      if (screen)
        void c.video
          .replaceTrack(screen)
          .catch(() => this.failed("Screen track could not be attached."));
      pc.onicecandidate = ({ candidate }) => {
        if (candidate) this.send(peer.id, { candidate: candidate.toJSON() });
      };
      pc.ontrack = ({ track }) => {
        if (!c.peer.stream.getTracks().some((t) => t.id === track.id))
          c.peer.stream.addTrack(track);
        track.onended = () => {
          c.peer.stream.removeTrack(track);
          this.emit();
        };
        track.onmute = track.onunmute = () => this.emit();
        this.emit();
      };
      pc.onconnectionstatechange = () => {
        c.peer.state = pc.connectionState;
        if (pc.connectionState === "failed") {
          this.failed(
            "Peer connection failed. Check TURN configuration or leave and rejoin.",
          );
          pc.restartIce();
        }
        this.emit();
      };
      pc.onnegotiationneeded = async () => {
        try {
          c.makingOffer = true;
          await pc.setLocalDescription();
          if (pc.localDescription)
            this.send(peer.id, { description: pc.localDescription.toJSON() });
        } catch {
          if (pc.signalingState !== "closed")
            this.failed("Media negotiation failed. Leave and rejoin to retry.");
        } finally {
          c.makingOffer = false;
        }
      };
    }
    this.emit();
  }

  receive(id: string, signal: MediaSignal): Promise<void> {
    const c = this.connections.get(id);
    if (!c) return Promise.resolve();
    // Serialize each peer's signaling so ICE cannot race remote-description setup.
    c.pending = c.pending
      .then(async () => {
        const pc = c.pc;
        if (pc.signalingState === "closed") return;
        if (signal.description) {
          const ready =
            !c.makingOffer &&
            (pc.signalingState === "stable" || c.settingAnswer);
          c.ignoreOffer =
            signal.description.type === "offer" && !ready && this.selfId < id;
          if (c.ignoreOffer) return;
          c.settingAnswer = signal.description.type === "answer";
          try {
            await pc.setRemoteDescription(signal.description);
          } finally {
            c.settingAnswer = false;
          }
          for (const candidate of c.candidates.splice(0))
            await pc.addIceCandidate(candidate);
          if (signal.description.type === "offer") {
            await pc.setLocalDescription();
            if (pc.localDescription)
              this.send(id, { description: pc.localDescription.toJSON() });
          }
        } else if (signal.candidate && !c.ignoreOffer) {
          if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate);
          else c.candidates.push(signal.candidate);
        }
      })
      .catch(() =>
        this.failed("Media signaling failed. Leave and rejoin to retry."),
      );
    return c.pending;
  }

  close() {
    ++this.generation;
    this.stopScreen();
    this.microphone?.getTracks().forEach((t) => t.stop());
    this.microphone = null;
    for (const c of this.connections.values()) {
      c.pc.onnegotiationneeded =
        c.pc.onicecandidate =
        c.pc.ontrack =
        c.pc.onconnectionstatechange =
          null;
      c.pc.close();
    }
    this.connections.clear();
    this.emit();
  }
  private emit() {
    this.changed([...this.connections.values()].map((c) => ({ ...c.peer })));
  }
}
