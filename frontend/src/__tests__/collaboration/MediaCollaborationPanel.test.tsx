import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MediaCollaborationPanel } from "@/collaboration/MediaCollaborationPanel";
import { WebRtcMediaChannel } from "@/collaboration/WebRtcMediaChannel";

jest.mock("@/collaboration/WebRtcMediaChannel", () => ({
  WebRtcMediaChannel: jest.fn(),
}));
let currentSocket: FakeSocket;
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = jest.fn();
  close = jest.fn();
}
const controls = {
  startAudio: jest.fn(),
  close: jest.fn(),
  setMuted: jest.fn(),
  setPeers: jest.fn(),
  receive: jest.fn(),
  stopScreen: jest.fn(),
  shareScreen: jest.fn(),
};
beforeEach(() => {
  jest.clearAllMocks();
  controls.startAudio.mockResolvedValue(true);
  (WebRtcMediaChannel as jest.Mock).mockImplementation(() => controls);
  Object.defineProperty(window, "isSecureContext", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: jest.fn(), getDisplayMedia: jest.fn() },
    configurable: true,
  });
  Object.assign(globalThis, {
    RTCPeerConnection: jest.fn(),
    WebSocket: Object.assign(
      jest.fn(() => {
        currentSocket = new FakeSocket();
        return currentSocket;
      }),
      { OPEN: 1 },
    ),
  });
});
async function join() {
  fireEvent.change(screen.getByLabelText("Private room code"), {
    target: { value: "private-room-123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Join audio" }));
  await waitFor(() => expect(controls.startAudio).toHaveBeenCalled());
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Leave collaboration" }),
    ).toBeInTheDocument(),
  );
  await waitFor(() => expect(currentSocket.onmessage).toBeTruthy());
  currentSocket.onopen!();
  await act(async () =>
    currentSocket.onmessage!({
      data: JSON.stringify({
        type: "media-presence",
        selfId: "self",
        peers: [],
      }),
    }),
  );
}
test("does not request media before opt-in and explains unsupported browsers", () => {
  Object.defineProperty(window, "isSecureContext", { value: false });
  render(<MediaCollaborationPanel wsUrl="ws://localhost/ws" />);
  expect(controls.startAudio).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Join audio" }));
  expect(screen.getByRole("status")).toHaveTextContent("HTTPS");
});
test("permission denial leaves no session and provides a retry explanation", async () => {
  controls.startAudio.mockRejectedValue(
    new DOMException("No", "NotAllowedError"),
  );
  render(<MediaCollaborationPanel wsUrl="ws://localhost/ws" />);
  fireEvent.change(screen.getByLabelText("Private room code"), {
    target: { value: "private-room-123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Join audio" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Microphone permission was denied",
    ),
  );
  expect(controls.close).toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Join audio" })).toBeEnabled();
});
test("shortcuts ignore text inputs, push to talk releases on blur, and Leave closes capture", async () => {
  render(<MediaCollaborationPanel wsUrl="ws://localhost/ws" />);
  await join();
  expect(currentSocket.send).toHaveBeenCalledWith(
    expect.stringContaining("media-join"),
  );
  fireEvent.keyDown(screen.getByLabelText("Your name"), { key: "m" });
  expect(controls.setMuted).not.toHaveBeenCalled();
  fireEvent.keyDown(document.body, { key: "m" });
  expect(controls.setMuted).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole("checkbox", { name: /Push to talk/ }));
  expect(controls.setMuted).toHaveBeenLastCalledWith(true);
  fireEvent.keyDown(document.body, { key: " ", code: "Space" });
  expect(controls.setMuted).toHaveBeenLastCalledWith(false);
  fireEvent.blur(window);
  expect(controls.setMuted).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Leave collaboration" }));
  expect(controls.close).toHaveBeenCalled();
  expect(currentSocket.close).toHaveBeenCalled();
});
test("unmount stops media and closes the signaling connection", async () => {
  const view = render(<MediaCollaborationPanel wsUrl="ws://localhost/ws" />);
  await join();
  view.unmount();
  expect(controls.close).toHaveBeenCalled();
  expect(currentSocket.close).toHaveBeenCalled();
});
