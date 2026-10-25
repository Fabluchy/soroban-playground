import { act, fireEvent, render, screen } from "@testing-library/react";
import DeploymentShaderCanvas, {
  DEPLOYMENT_CELEBRATION_DURATION_MS,
  FRAGMENT_SHADER_SOURCE,
  VERTEX_SHADER_SOURCE,
  createWebGLResources,
  disposeWebGLResources,
} from "../../components/Celebration/DeploymentShaderCanvas";

const originalMatchMedia = window.matchMedia;

function createFakeGL(overrides: Record<string, unknown> = {}) {
  const loseContext = jest.fn();
  const gl: Record<string, unknown> = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    POINTS: 0,
    DEPTH_TEST: 0x0b71,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE: 1,
    COLOR_BUFFER_BIT: 0x4000,
    FLOAT: 0x1406,
    createShader: jest.fn(() => ({})),
    shaderSource: jest.fn(),
    compileShader: jest.fn(),
    getShaderParameter: jest.fn(() => true),
    getShaderInfoLog: jest.fn(() => ""),
    deleteShader: jest.fn(),
    createProgram: jest.fn(() => ({})),
    attachShader: jest.fn(),
    linkProgram: jest.fn(),
    getProgramParameter: jest.fn(() => true),
    getProgramInfoLog: jest.fn(() => ""),
    deleteProgram: jest.fn(),
    useProgram: jest.fn(),
    createBuffer: jest.fn(() => ({})),
    bindBuffer: jest.fn(),
    bufferData: jest.fn(),
    deleteBuffer: jest.fn(),
    getAttribLocation: jest.fn(() => 0),
    enableVertexAttribArray: jest.fn(),
    vertexAttribPointer: jest.fn(),
    getUniformLocation: jest.fn(() => ({})),
    uniform1f: jest.fn(),
    uniform3f: jest.fn(),
    viewport: jest.fn(),
    clearColor: jest.fn(),
    clear: jest.fn(),
    enable: jest.fn(),
    disable: jest.fn(),
    blendFunc: jest.fn(),
    drawArrays: jest.fn(),
    getExtension: jest.fn(() => ({ loseContext })),
    ...overrides,
  };

  return Object.assign(gl, { __loseContext: loseContext });
}

function mockReducedMotion(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: jest.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
}

function setupAnimationFrame() {
  let callbacks: FrameRequestCallback[] = [];
  let nextId = 1;

  jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callbacks.push(callback);
    return nextId++;
  });
  jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

  return {
    flush(timestamp: number) {
      const current = callbacks;
      callbacks = [];
      act(() => {
        current.forEach((callback) => callback(timestamp));
      });
    },
  };
}

describe("DeploymentShaderCanvas", () => {
  beforeEach(() => {
    mockReducedMotion(false);
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it("compiles the custom GLSL shaders and renders a particle frame", () => {
    const gl = createFakeGL();
    jest
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(gl as unknown as RenderingContext);
    const animation = setupAnimationFrame();

    render(
      <DeploymentShaderCanvas
        contractId="CCXJBN3A4L7BQ5B2K3A2C4D5E6F7G8H9"
        network="testnet"
      />,
    );

    expect(gl.shaderSource).toHaveBeenCalledWith(
      expect.anything(),
      VERTEX_SHADER_SOURCE,
    );
    expect(gl.shaderSource).toHaveBeenCalledWith(
      expect.anything(),
      FRAGMENT_SHADER_SOURCE,
    );
    expect(gl.compileShader).toHaveBeenCalledTimes(2);
    expect(gl.attachShader).toHaveBeenCalledTimes(2);
    expect(gl.linkProgram).toHaveBeenCalledTimes(1);

    animation.flush(1_000);

    expect(gl.drawArrays).toHaveBeenCalledWith(gl.POINTS, 0, 260);
    expect(gl.uniform3f).toHaveBeenCalled();
    expect(screen.getByTestId("celebration-contract-id")).toHaveTextContent(
      "CCXJBN3A4L7BQ5B2K3A2C4D5E6F7G8H9",
    );
    expect(screen.getByTestId("celebration-network")).toHaveTextContent(
      "testnet",
    );
  });

  it("releases WebGL resources and the context on unmount", () => {
    const gl = createFakeGL();
    jest
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(gl as unknown as RenderingContext);
    setupAnimationFrame();

    const { unmount } = render(
      <DeploymentShaderCanvas contractId="CABC123" network="mainnet" />,
    );

    unmount();

    expect(gl.deleteBuffer).toHaveBeenCalledTimes(4);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
    expect(gl.deleteShader).toHaveBeenCalledTimes(2);
    expect(gl.__loseContext).toHaveBeenCalledTimes(1);
  });

  it("auto-terminates the animation and releases the context after three seconds", () => {
    jest.useFakeTimers();
    const gl = createFakeGL();
    jest
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(gl as unknown as RenderingContext);
    const animation = setupAnimationFrame();
    const onClose = jest.fn();

    render(
      <DeploymentShaderCanvas
        contractId="CABC123"
        network="testnet"
        onClose={onClose}
      />,
    );

    animation.flush(1_000);
    animation.flush(4_000);

    expect(onClose).toHaveBeenCalled();
    expect(gl.deleteProgram).toHaveBeenCalled();
    expect(gl.__loseContext).toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(DEPLOYMENT_CELEBRATION_DURATION_MS);
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a static badge and skips WebGL when reduced motion is enabled", () => {
    mockReducedMotion(true);
    const getContext = jest.spyOn(HTMLCanvasElement.prototype, "getContext");

    render(<DeploymentShaderCanvas contractId="CABC123" network="testnet" />);

    expect(screen.getByTestId("deployment-static-badge")).toBeInTheDocument();
    expect(
      screen.queryByTestId("deployment-shader-canvas"),
    ).not.toBeInTheDocument();
    expect(getContext).not.toHaveBeenCalled();
  });

  it("dismisses on click and Escape", () => {
    const gl = createFakeGL();
    jest
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(gl as unknown as RenderingContext);
    setupAnimationFrame();
    const onClose = jest.fn();

    render(
      <DeploymentShaderCanvas
        contractId="CABC123"
        network="testnet"
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId("deployment-celebration"));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("falls back to the static badge when shader compilation fails", () => {
    const gl = createFakeGL({
      getShaderParameter: jest.fn(() => false),
      getShaderInfoLog: jest.fn(() => "syntax error"),
    });
    jest
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(gl as unknown as RenderingContext);

    render(<DeploymentShaderCanvas contractId="CABC123" network="testnet" />);

    expect(screen.getByTestId("deployment-static-badge")).toBeInTheDocument();
    expect(gl.deleteShader).toHaveBeenCalled();
    expect(gl.__loseContext).toHaveBeenCalled();
  });

  it("disposes a standalone WebGL resource bundle", () => {
    const gl = createFakeGL();
    const resources = createWebGLResources(
      gl as unknown as WebGLRenderingContext,
      16,
    );

    disposeWebGLResources(gl as unknown as WebGLRenderingContext, resources);

    expect(gl.deleteBuffer).toHaveBeenCalledTimes(4);
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
    expect(gl.deleteShader).toHaveBeenCalledTimes(2);
    expect(gl.__loseContext).toHaveBeenCalledTimes(1);
  });
});
