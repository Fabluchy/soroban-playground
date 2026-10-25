"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MediaPeer, WebRtcMediaChannel } from "./WebRtcMediaChannel";

function MediaParticipant({ peer }: { peer: MediaPeer }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [speaking, setSpeaking] = useState(false);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const element = audio.current!;
    element.srcObject = peer.stream;
    void element.play().catch(() => setBlocked(true));
    let context: AudioContext | undefined;
    let frame = 0;
    try {
      context = new AudioContext();
      const source = context.createMediaStreamSource(peer.stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser); // Never route monitoring back to speakers.
      const samples = new Uint8Array(analyser.fftSize);
      const sample = () => {
        analyser.getByteTimeDomainData(samples);
        setSpeaking(samples.some((v) => Math.abs(v - 128) > 8));
        frame = requestAnimationFrame(sample);
      };
      frame = requestAnimationFrame(sample);
      void context.resume().catch(() => {});
    } catch {
      /* Audio still works when metering is unsupported. */
    }
    return () => {
      cancelAnimationFrame(frame);
      void context?.close().catch(() => {});
      element.pause();
      element.srcObject = null;
    };
  }, [peer.stream, peer.stream.getAudioTracks().length]);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <audio ref={audio} autoPlay />
      <span>
        {peer.name} · {peer.state}
        {speaking ? " · speaking" : ""}
      </span>
      <label>
        Volume for {peer.name}{" "}
        <input
          aria-label={`Volume for ${peer.name}`}
          type="range"
          min="0"
          max="1"
          step="0.05"
          defaultValue="1"
          onChange={(e) => {
            if (audio.current) audio.current.volume = Number(e.target.value);
          }}
        />
      </label>
      {blocked && (
        <button
          onClick={() =>
            void audio.current
              ?.play()
              .then(() => setBlocked(false))
              .catch(() => {})
          }
        >
          Enable audio for {peer.name}
        </button>
      )}
    </div>
  );
}

function ScreenFrame({ stream, name }: { stream: MediaStream; name: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [position, setPosition] = useState({ x: 16, y: 16 });
  const drag = useRef<{
    x: number;
    y: number;
    startX: number;
    startY: number;
  } | null>(null);
  const move = useCallback(
    (x: number, y: number) =>
      setPosition({
        x: Math.max(
          0,
          Math.min(
            x,
            Math.max(0, window.innerWidth - Math.min(384, window.innerWidth)),
          ),
        ),
        y: Math.max(0, Math.min(y, Math.max(0, window.innerHeight - 280))),
      }),
    [],
  );
  useEffect(() => {
    video.current!.srcObject = stream;
    const element = video.current!;
    return () => {
      element.srcObject = null;
    };
  }, [stream]);
  useEffect(() => {
    const resize = () => move(position.x, position.y);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [move, position]);
  return (
    <section
      aria-label={`Shared screen from ${name}`}
      style={{
        left: position.x,
        top: position.y,
        width: "min(24rem, 100vw)",
        maxHeight: "90vh",
      }}
      className="fixed z-50 overflow-auto rounded-lg border border-cyan-300 bg-slate-950 p-2 shadow-xl"
    >
      <button
        className="w-full touch-none cursor-move text-left"
        aria-label={`Move shared screen from ${name}; use arrow keys`}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = {
            x: position.x,
            y: position.y,
            startX: e.clientX,
            startY: e.clientY,
          };
        }}
        onPointerMove={(e) => {
          if (drag.current)
            move(
              drag.current.x + e.clientX - drag.current.startX,
              drag.current.y + e.clientY - drag.current.startY,
            );
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={(e) => {
          const offsets: Record<string, [number, number]> = {
            ArrowLeft: [-10, 0],
            ArrowRight: [10, 0],
            ArrowUp: [0, -10],
            ArrowDown: [0, 10],
          };
          if (offsets[e.key]) {
            e.preventDefault();
            move(
              position.x + offsets[e.key][0],
              position.y + offsets[e.key][1],
            );
          }
        }}
      >
        {name} · shared screen (drag or use arrow keys)
      </button>
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        aria-label={`Screen shared by ${name}`}
        style={{ width: "100%", maxHeight: "70vh", objectFit: "contain" }}
      />
    </section>
  );
}

export function MediaCollaborationPanel({ wsUrl }: { wsUrl: string }) {
  const [room, setRoom] = useState("");
  const [name, setName] = useState("Developer");
  const [state, setState] = useState<"idle" | "joining" | "joined">("idle");
  const [message, setMessage] = useState(
    "Use a private room code shared with your collaborator. Join requests microphone permission; no camera is used.",
  );
  const [muted, setMuted] = useState(true);
  const [pushToTalk, setPushToTalk] = useState(false);
  const [peers, setPeers] = useState<MediaPeer[]>([]);
  const [screen, setScreen] = useState<MediaStream | null>(null);
  const channel = useRef<WebRtcMediaChannel | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const joining = useRef(false);
  const leave = useCallback(() => {
    joining.current = false;
    channel.current?.close();
    channel.current = null;
    const ws = socket.current;
    socket.current = null;
    if (ws) {
      ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null;
      ws.close();
    }
    setPeers([]);
    setScreen(null);
    setState("idle");
    setMuted(true);
  }, []);
  useEffect(() => leave, [leave]);
  const mute = useCallback((value: boolean) => {
    channel.current?.setMuted(value);
    setMuted(value);
  }, []);
  useEffect(() => {
    if (state !== "joined") return;
    const keydown = (e: KeyboardEvent) => {
      if (
        e.repeat ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        (e.target instanceof Element &&
          e.target.closest(
            'input,textarea,select,button,a,[contenteditable="true"],[role="textbox"]',
          ))
      )
        return;
      if (e.code === "Space" && pushToTalk) {
        e.preventDefault();
        mute(false);
      }
      if (e.key.toLowerCase() === "m" && !pushToTalk) mute(!muted);
    };
    const keyup = (e: KeyboardEvent) => {
      if (e.code === "Space" && pushToTalk) mute(true);
    };
    const release = () => {
      if (pushToTalk) mute(true);
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
    };
  }, [state, pushToTalk, muted, mute]);

  const join = async () => {
    if (joining.current || channel.current) return;
    if (
      !window.isSecureContext ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof RTCPeerConnection === "undefined"
    ) {
      setMessage("Voice needs a browser with WebRTC and HTTPS (or localhost).");
      return;
    }
    if (!/^[a-zA-Z0-9_-]{12,128}$/.test(room)) {
      setMessage(
        "Enter a shared room code of 12–128 letters, numbers, dashes or underscores.",
      );
      return;
    }
    joining.current = true;
    setState("joining");
    try {
      const configured = process.env.NEXT_PUBLIC_WEBRTC_ICE_SERVERS;
      const iceServers: RTCIceServer[] = configured
        ? JSON.parse(configured)
        : [{ urls: "stun:stun.l.google.com:19302" }];
      const media = new WebRtcMediaChannel(
        { iceServers },
        (to, signal) => {
          if (socket.current?.readyState === WebSocket.OPEN)
            socket.current.send(
              JSON.stringify({ type: "media-signal", to, signal }),
            );
        },
        setPeers,
        setMessage,
        setScreen,
      );
      channel.current = media;
      if (!(await media.startAudio()) || channel.current !== media) return;
      const ws = new WebSocket(wsUrl);
      socket.current = ws;
      ws.onopen = () =>
        ws.send(JSON.stringify({ type: "media-join", room, name }));
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === "media-presence") {
            media.setPeers(data.selfId, data.peers);
            setState("joined");
            joining.current = false;
            setMessage(
              "Connected. Microphone starts muted. Use headphones to reduce echo.",
            );
          }
          if (data.type === "media-signal")
            void media.receive(data.from, data.signal);
          if (data.type === "media-error") {
            leave();
            setMessage(data.message);
          }
        } catch {
          setMessage("The collaboration server sent an invalid message.");
        }
      };
      ws.onclose = ws.onerror = () => {
        leave();
        setMessage(
          "Collaboration disconnected. All microphone and screen tracks have stopped. Rejoin to retry.",
        );
      };
    } catch (error) {
      leave();
      setMessage(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "Microphone permission was denied. Allow microphone access in your browser and try joining again."
          : "Could not start voice. Check your microphone, room server and ICE configuration, then retry.",
      );
    }
  };

  return (
    <section
      aria-label="Pair programming audio and screen sharing"
      className="border-b border-white/10 p-4 text-sm"
    >
      <div className="flex flex-wrap items-center gap-3">
        <label>
          Private room code{" "}
          <input
            value={room}
            maxLength={128}
            disabled={state !== "idle"}
            onChange={(e) => setRoom(e.target.value)}
            className="rounded border bg-slate-900 p-1"
          />
        </label>
        <button
          disabled={state !== "idle"}
          onClick={() => setRoom(crypto.randomUUID())}
        >
          Generate room code
        </button>
        <label>
          Your name{" "}
          <input
            value={name}
            maxLength={40}
            disabled={state !== "idle"}
            onChange={(e) => setName(e.target.value)}
            className="rounded border bg-slate-900 p-1"
          />
        </label>
        {state === "idle" ? (
          <button onClick={() => void join()}>Join audio</button>
        ) : (
          <button onClick={leave}>Leave collaboration</button>
        )}
        {state === "joined" && (
          <>
            <button
              aria-pressed={muted}
              disabled={pushToTalk}
              onClick={() => mute(!muted)}
            >
              {muted ? "Unmute microphone (M)" : "Mute microphone (M)"}
            </button>
            <label>
              <input
                type="checkbox"
                checked={pushToTalk}
                onChange={(e) => {
                  setPushToTalk(e.target.checked);
                  mute(true);
                }}
              />
              Push to talk (hold Space outside the editor)
            </label>
            <button
              disabled={!navigator.mediaDevices?.getDisplayMedia}
              onClick={() => {
                if (screen) channel.current?.stopScreen();
                else
                  void channel.current
                    ?.shareScreen()
                    .catch(() =>
                      setMessage(
                        "Screen sharing was cancelled or unavailable. Choose a screen or window to retry.",
                      ),
                    );
              }}
            >
              {screen ? "Stop screen sharing" : "Share screen"}
            </button>
            {pushToTalk && (
              <button
                onPointerDown={() => mute(false)}
                onPointerUp={() => mute(true)}
                onPointerCancel={() => mute(true)}
                onPointerLeave={() => mute(true)}
                onKeyDown={(e) => {
                  if (e.code === "Space" || e.key === "Enter") {
                    e.preventDefault();
                    mute(false);
                  }
                }}
                onKeyUp={() => mute(true)}
                onBlur={() => mute(true)}
              >
                Hold to talk
              </button>
            )}
          </>
        )}
      </div>
      <p role="status" className="mt-2 text-slate-300">
        {message}
      </p>
      {state === "joined" && (
        <aside
          aria-label="Audio participants"
          className="fixed bottom-4 left-4 z-40 max-h-48 max-w-[calc(100vw-2rem)] overflow-auto rounded-lg border bg-slate-950 p-3"
        >
          <p>
            You · {muted ? "muted" : "microphone on"} · {peers.length + 1}{" "}
            participants
          </p>
          {peers.map((peer) => (
            <MediaParticipant key={peer.id} peer={peer} />
          ))}
        </aside>
      )}
      {screen && <ScreenFrame stream={screen} name="You" />}
      {peers
        .filter((p) =>
          p.stream
            .getVideoTracks()
            .some((t) => !t.muted && t.readyState === "live"),
        )
        .map((p) => (
          <ScreenFrame key={p.id} stream={p.stream} name={p.name} />
        ))}
    </section>
  );
}
