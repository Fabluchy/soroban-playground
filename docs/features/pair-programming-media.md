# Pair-programming voice and screen sharing

The playground's **Join audio** control starts an opt-in WebRTC room. Generate a
private room code and share it with your collaborator out of band. Both users
join the same code on the same backend instance. Rooms support up to eight users.
Codes are invitation secrets; the existing WebSocket authentication/origin policy
still applies. No microphone permission is requested before joining, and no
camera capture is requested. Microphones start muted.

Use **M** to mute/unmute outside text inputs, Monaco, links and buttons. With
push-to-talk enabled, hold Space outside the editor or use **Hold to talk**.
Releasing Space, losing focus, or hiding the tab silences push-to-talk. Use
headphones; capture requests browser echo cancellation, noise suppression and
automatic gain control. Local audio is never played back. Remote volume sliders
and speaking indicators are in the floating participant bar. If autoplay is
blocked, use **Enable audio**. Browser metering support may vary.

**Share screen** opens the browser's screen/window picker. Audio for the screen
is not captured, avoiding duplicated microphone audio. Shared screens preserve
their aspect ratio in a floating frame; drag its header or use the arrow keys
while its move button is focused. The frame clamps to the viewport on resize.
Browser Stop sharing, Leave, disconnect and component unmount release capture
tracks and peer connections. Late permission responses after Leave are stopped.

HTTPS or localhost and a WebRTC-capable browser are required. Permission denial,
cancelled screen selection, unsupported APIs and connection failures have visible
explanations. The backend relays only room-scoped SDP/ICE, never audio/video.

## ICE configuration

By default the browser uses `stun:stun.l.google.com:19302`. For restrictive NATs,
configure `NEXT_PUBLIC_WEBRTC_ICE_SERVERS` at frontend build time as a JSON array
of standard `RTCIceServer` objects, for example:

```json
[{"urls":"stun:stun.example.net:3478"},{"urls":"turns:relay.example.net:5349","username":"short-lived-user","credential":"short-lived-credential"}]
```

These values are public browser configuration. Use short-lived TURN credentials;
never embed a TURN administration secret. Negotiation uses the browser's ICE
agent and the polite/impolite perfect-negotiation pattern. Room membership is
currently process-local; deployments with multiple backend replicas need sticky
routing for collaborators or a distributed membership/signaling service.

## Validation

Automated tests cover mute/capture lifecycle, pending permission cancellation,
ICE queuing, offer collision handling, screen-stop cleanup, failed-connection
restart, room membership, sender identity, cross-room isolation and room limits.
Live two-device audio quality, real TURN traversal, end-to-end latency below
100ms, and an absence of audible echo require real devices/networks. They are
pending manual verification and are not guaranteed by mocked unit tests.
