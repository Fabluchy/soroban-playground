"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Sparkles, X } from "lucide-react";

export const DEPLOYMENT_CELEBRATION_DURATION_MS = 3000;
export const DEFAULT_PARTICLE_COUNT = 260;

export const VERTEX_SHADER_SOURCE = `
attribute vec2 a_position;
attribute vec2 a_velocity;
attribute float a_size;
attribute float a_seed;

uniform float u_time;
uniform float u_duration;
uniform float u_pixel_ratio;

varying float v_alpha;
varying float v_seed;

void main() {
  float t = u_time;
  float progress = clamp(t / max(u_duration, 0.001), 0.0, 1.0);
  vec2 position = a_position + a_velocity * t;
  position.y -= 0.11 * t * t;

  float twinkle = 0.7 + 0.3 * sin(a_seed * 6.28318 + t * 4.5);
  float fade = 1.0 - progress;
  float size = max(1.0, a_size * twinkle * fade * u_pixel_ratio);

  v_alpha = fade * twinkle;
  v_seed = a_seed;
  gl_PointSize = size;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER_SOURCE = `
precision mediump float;

varying float v_alpha;
varying float v_seed;

uniform vec3 u_accent;

void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  float distance_to_center = length(coord);
  float core = smoothstep(0.2, 0.0, distance_to_center);
  float halo = smoothstep(0.5, 0.0, distance_to_center);
  float horizontal_cross =
    smoothstep(0.035, 0.0, abs(coord.y)) *
    smoothstep(0.5, 0.0, abs(coord.x));
  float vertical_cross =
    smoothstep(0.035, 0.0, abs(coord.x)) *
    smoothstep(0.5, 0.0, abs(coord.y));

  vec3 cool = mix(vec3(0.32, 0.82, 1.0), u_accent, v_seed * 0.55);
  vec3 color = mix(cool, vec3(1.0, 0.92, 0.72), core);
  float alpha = (core + halo * 0.5 + (horizontal_cross + vertical_cross) * 0.35) * v_alpha;

  if (alpha <= 0.008) discard;
  gl_FragColor = vec4(color * (0.85 + core * 1.4), alpha);
}
`;

interface ParticleBuffers {
  positions: Float32Array;
  velocities: Float32Array;
  sizes: Float32Array;
  seeds: Float32Array;
}

export interface WebGLResources {
  program: WebGLProgram;
  vertexShader: WebGLShader;
  fragmentShader: WebGLShader;
  positionBuffer: WebGLBuffer;
  velocityBuffer: WebGLBuffer;
  sizeBuffer: WebGLBuffer;
  seedBuffer: WebGLBuffer;
  particleCount: number;
  attributes: {
    position: number;
    velocity: number;
    size: number;
    seed: number;
  };
  uniforms: {
    time: WebGLUniformLocation | null;
    duration: WebGLUniformLocation | null;
    pixelRatio: WebGLUniformLocation | null;
    accent: WebGLUniformLocation | null;
  };
}

function createParticles(count: number): ParticleBuffers {
  const positions = new Float32Array(count * 2);
  const velocities = new Float32Array(count * 2);
  const sizes = new Float32Array(count);
  const seeds = new Float32Array(count);

  for (let index = 0; index < count; index += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * 0.18;
    const speed = 0.12 + Math.random() * 0.55;
    const isConstellationStar = index % 4 === 0;

    positions[index * 2] = Math.cos(angle) * radius;
    positions[index * 2 + 1] = Math.sin(angle) * radius;

    if (isConstellationStar) {
      positions[index * 2] = (Math.random() - 0.5) * 1.8;
      positions[index * 2 + 1] = (Math.random() - 0.5) * 1.1;
      velocities[index * 2] = (Math.random() - 0.5) * 0.012;
      velocities[index * 2 + 1] = (Math.random() - 0.5) * 0.012;
    } else {
      velocities[index * 2] = Math.cos(angle) * speed;
      velocities[index * 2 + 1] = Math.sin(angle) * speed + 0.08;
    }

    sizes[index] = isConstellationStar
      ? 2 + Math.random() * 3.5
      : 2.5 + Math.random() * 7;
    seeds[index] = Math.random();
  }

  return { positions, velocities, sizes, seeds };
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to allocate WebGL shader");

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || "Unknown shader compile error";
    gl.deleteShader(shader);
    throw new Error(`Shader compilation failed: ${log}`);
  }

  return shader;
}

function createBuffer(
  gl: WebGLRenderingContext,
  data: Float32Array,
): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error("Unable to allocate WebGL buffer");

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return buffer;
}

export function createWebGLResources(
  gl: WebGLRenderingContext,
  particleCount = DEFAULT_PARTICLE_COUNT,
): WebGLResources {
  const vertexShader = compileShader(
    gl,
    gl.VERTEX_SHADER,
    VERTEX_SHADER_SOURCE,
  );
  let fragmentShader: WebGLShader | null = null;
  let program: WebGLProgram | null = null;

  try {
    fragmentShader = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      FRAGMENT_SHADER_SOURCE,
    );

    program = gl.createProgram();
    if (!program) throw new Error("Unable to allocate WebGL program");

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) || "Unknown program link error";
      throw new Error(`Shader program link failed: ${log}`);
    }

    const particles = createParticles(particleCount);
    const positionBuffer = createBuffer(gl, particles.positions);
    const velocityBuffer = createBuffer(gl, particles.velocities);
    const sizeBuffer = createBuffer(gl, particles.sizes);
    const seedBuffer = createBuffer(gl, particles.seeds);

    return {
      program,
      vertexShader,
      fragmentShader,
      positionBuffer,
      velocityBuffer,
      sizeBuffer,
      seedBuffer,
      particleCount,
      attributes: {
        position: gl.getAttribLocation(program, "a_position"),
        velocity: gl.getAttribLocation(program, "a_velocity"),
        size: gl.getAttribLocation(program, "a_size"),
        seed: gl.getAttribLocation(program, "a_seed"),
      },
      uniforms: {
        time: gl.getUniformLocation(program, "u_time"),
        duration: gl.getUniformLocation(program, "u_duration"),
        pixelRatio: gl.getUniformLocation(program, "u_pixel_ratio"),
        accent: gl.getUniformLocation(program, "u_accent"),
      },
    };
  } catch (error) {
    if (program) gl.deleteProgram(program);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    gl.deleteShader(vertexShader);
    throw error;
  }
}

function bindAttribute(
  gl: WebGLRenderingContext,
  buffer: WebGLBuffer,
  location: number,
  size: number,
) {
  if (location < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
}

export function renderWebGLFrame(
  gl: WebGLRenderingContext,
  resources: WebGLResources,
  elapsedSeconds: number,
  durationSeconds: number,
  pixelRatio: number,
  accent: [number, number, number],
) {
  gl.useProgram(resources.program);

  bindAttribute(gl, resources.positionBuffer, resources.attributes.position, 2);
  bindAttribute(gl, resources.velocityBuffer, resources.attributes.velocity, 2);
  bindAttribute(gl, resources.sizeBuffer, resources.attributes.size, 1);
  bindAttribute(gl, resources.seedBuffer, resources.attributes.seed, 1);

  gl.uniform1f(resources.uniforms.time, elapsedSeconds);
  gl.uniform1f(resources.uniforms.duration, durationSeconds);
  gl.uniform1f(resources.uniforms.pixelRatio, pixelRatio);
  gl.uniform3f(resources.uniforms.accent, accent[0], accent[1], accent[2]);

  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.POINTS, 0, resources.particleCount);
}

export function disposeWebGLResources(
  gl: WebGLRenderingContext | null,
  resources: WebGLResources | null,
) {
  if (gl) {
    if (resources) {
      gl.deleteBuffer(resources.positionBuffer);
      gl.deleteBuffer(resources.velocityBuffer);
      gl.deleteBuffer(resources.sizeBuffer);
      gl.deleteBuffer(resources.seedBuffer);
      gl.deleteProgram(resources.program);
      gl.deleteShader(resources.vertexShader);
      gl.deleteShader(resources.fragmentShader);
    }

    const loseContext = gl.getExtension("WEBGL_lose_context");
    loseContext?.loseContext();
  }
}

function accentFromContract(contractId: string): [number, number, number] {
  let hash = 0;
  for (let index = 0; index < contractId.length; index += 1) {
    hash = (hash * 31 + contractId.charCodeAt(index)) >>> 0;
  }

  return [
    0.35 + ((hash & 0xff) / 255) * 0.55,
    0.45 + (((hash >> 8) & 0xff) / 255) * 0.45,
    0.55 + (((hash >> 16) & 0xff) / 255) * 0.4,
  ];
}

function usePrefersReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;

    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mediaQuery.matches);

    const handleChange = (event: MediaQueryListEvent) => {
      setReducedMotion(event.matches);
    };

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener?.(handleChange);
    return () => mediaQuery.removeListener?.(handleChange);
  }, []);

  return reducedMotion;
}

export interface DeploymentShaderCanvasProps {
  contractId: string;
  network: string;
  onClose?: () => void;
  durationMs?: number;
  particleCount?: number;
}

export default function DeploymentShaderCanvas({
  contractId,
  network,
  onClose,
  durationMs = DEPLOYMENT_CELEBRATION_DURATION_MS,
  particleCount = DEFAULT_PARTICLE_COUNT,
}: DeploymentShaderCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onCloseRef = useRef(onClose);
  const reducedMotion = usePrefersReducedMotion();
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  const accent = useMemo(() => accentFromContract(contractId), [contractId]);

  onCloseRef.current = onClose;

  const dismiss = useCallback(() => {
    onCloseRef.current?.();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(dismiss, durationMs);
    return () => window.clearTimeout(timer);
  }, [dismiss, durationMs]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dismiss]);

  useEffect(() => {
    if (reducedMotion) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    let gl: WebGLRenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl", {
        alpha: true,
        antialias: true,
        premultipliedAlpha: false,
      }) as WebGLRenderingContext | null;
    } catch {
      gl = null;
    }

    if (!gl) {
      setWebglUnavailable(true);
      return;
    }

    const context = gl;
    let resources: WebGLResources | null = null;
    let frameId = 0;
    let disposed = false;
    let startTime: number | null = null;
    const durationSeconds = durationMs / 1000;

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (frameId) window.cancelAnimationFrame(frameId);
      disposeWebGLResources(context, resources);
      resources = null;
    };

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      setWebglUnavailable(true);
      dispose();
    };

    const resize = () => {
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(
        1,
        Math.floor((canvas.clientWidth || window.innerWidth || 1) * pixelRatio),
      );
      const height = Math.max(
        1,
        Math.floor(
          (canvas.clientHeight || window.innerHeight || 1) * pixelRatio,
        ),
      );

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      context.viewport(0, 0, width, height);
      return pixelRatio;
    };

    try {
      resources = createWebGLResources(context, particleCount);
    } catch {
      setWebglUnavailable(true);
      disposeWebGLResources(context, null);
      return;
    }

    context.disable(context.DEPTH_TEST);
    context.enable(context.BLEND);
    context.blendFunc(context.SRC_ALPHA, context.ONE);
    canvas.addEventListener("webglcontextlost", handleContextLost);
    window.addEventListener("resize", resize);

    const render = (timestamp: number) => {
      if (disposed || !resources) return;
      if (startTime === null) startTime = timestamp;

      const elapsedMs = timestamp - startTime;
      const elapsedSeconds = elapsedMs / 1000;
      const pixelRatio = resize();

      renderWebGLFrame(
        context,
        resources,
        elapsedSeconds,
        durationSeconds,
        pixelRatio,
        accent,
      );

      if (elapsedMs >= durationMs) {
        dispose();
        dismiss();
        return;
      }

      frameId = window.requestAnimationFrame(render);
    };

    frameId = window.requestAnimationFrame(render);

    return () => {
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      window.removeEventListener("resize", resize);
      dispose();
    };
  }, [accent, dismiss, durationMs, particleCount, reducedMotion]);

  const showStaticBadge = reducedMotion || webglUnavailable;

  return (
    <div
      data-testid="deployment-celebration"
      role="dialog"
      aria-modal="true"
      aria-label="Deployment successful celebration"
      onClick={dismiss}
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-slate-950/80 p-6 backdrop-blur-sm"
    >
      {!showStaticBadge && (
        <canvas
          ref={canvasRef}
          data-testid="deployment-shader-canvas"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
        />
      )}

      <div className="relative z-10 w-full max-w-lg overflow-hidden rounded-[28px] border border-white/15 bg-slate-950/85 p-8 text-center shadow-[0_30px_120px_rgba(2,8,23,0.9)]">
        <button
          type="button"
          aria-label="Dismiss deployment celebration"
          onClick={(event) => {
            event.stopPropagation();
            dismiss();
          }}
          className="absolute right-4 top-4 rounded-full border border-white/10 bg-white/5 p-2 text-slate-300 transition hover:bg-white/10 hover:text-white"
        >
          <X size={16} />
        </button>

        {showStaticBadge ? (
          <div
            data-testid="deployment-static-badge"
            className="mb-5 inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-200"
          >
            <CheckCircle2 size={16} />
            Deployment confirmed
          </div>
        ) : (
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200">
            <Sparkles size={16} />
            Stellar constellation
          </div>
        )}

        <h2 className="text-2xl font-semibold tracking-tight text-white">
          Contract deployed successfully
        </h2>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          Your Soroban contract is live. The celebration releases its graphics
          context automatically after three seconds.
        </p>

        <div className="mt-6 grid gap-3 text-left sm:grid-cols-[auto_1fr] sm:items-center">
          <span
            data-testid="celebration-network"
            className="inline-flex items-center justify-center rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-200"
          >
            {network}
          </span>
          <code
            data-testid="celebration-contract-id"
            title={contractId}
            className="truncate rounded-xl border border-emerald-400/20 bg-emerald-400/5 px-3 py-2 font-mono text-xs text-emerald-200"
          >
            {contractId}
          </code>
        </div>

        <p className="mt-5 text-[11px] uppercase tracking-[0.18em] text-slate-500">
          Click anywhere or press Escape to dismiss
        </p>
      </div>
    </div>
  );
}
