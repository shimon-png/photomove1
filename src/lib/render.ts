import { decodeScaled } from "./device";
import type { PhotoRef, VideoPlan } from "./plan";

/**
 * Renders a VideoPlan to a video file entirely in the browser: frames are
 * drawn on a <canvas> and recorded with MediaRecorder. No server compute, so
 * it runs fine on serverless hosting. Recording is real-time, so the tab
 * should stay in the foreground while it renders.
 */

const FPS = 30;
const CARD_S = 2.5;

export function dimensions(aspect: VideoPlan["aspect"]) {
  if (aspect === "9:16") return { width: 1080, height: 1920 };
  if (aspect === "1:1") return { width: 1080, height: 1080 };
  return { width: 1920, height: 1080 };
}

export function pickMimeType(): string {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) ?? "";
}

type Segment =
  | { kind: "card"; text: string; start: number; duration: number }
  | { kind: "photo"; image: ImageBitmap; motion: VideoPlan["scenes"][number]["motion"]; caption?: string; start: number; duration: number };

export function imageUrl(photo: PhotoRef, size = 2048) {
  return `/api/photos/image?u=${encodeURIComponent(photo.baseUrl ?? "")}&s=${size}`;
}

async function loadImage(photo: PhotoRef): Promise<ImageBitmap> {
  if (photo.file) return decodeScaled(photo.file, 2048);
  const res = await fetch(imageUrl(photo));
  if (!res.ok) throw new Error(`Could not load ${photo.filename ?? photo.id} (${res.status})`);
  return createImageBitmap(await res.blob());
}

function buildTimeline(plan: VideoPlan, images: Map<string, ImageBitmap>) {
  const overlap = plan.transition === "crossfade" ? plan.transition_s : 0;
  type Unstarted = Segment extends infer S ? (S extends Segment ? Omit<S, "start"> : never) : never;
  const raw: Unstarted[] = [];
  if (plan.intro_text) raw.push({ kind: "card", text: plan.intro_text, duration: CARD_S });
  for (const s of plan.scenes) {
    raw.push({ kind: "photo", image: images.get(s.photo_id)!, motion: s.motion, caption: s.caption, duration: s.duration_s });
  }
  if (plan.outro_text) raw.push({ kind: "card", text: plan.outro_text, duration: CARD_S });

  const segments: Segment[] = [];
  let t = 0;
  raw.forEach((seg, i) => {
    const start = i === 0 ? 0 : t - Math.min(overlap, seg.duration / 2, segments[i - 1].duration / 2);
    segments.push({ ...seg, start } as Segment);
    t = start + seg.duration;
  });
  return { segments, total: t };
}

function alphaFor(seg: Segment, t: number, plan: VideoPlan, isFirst: boolean, isLast: boolean) {
  const local = t - seg.start;
  const T = plan.transition_s;
  if (plan.transition === "cut" || T === 0) return 1;
  if (plan.transition === "crossfade") {
    // Later segments are drawn on top and fade in; the first fades in from black, the last fades out.
    const fadeIn = isFirst ? Math.min(1, local / Math.min(T, 0.6)) : Math.min(1, local / T);
    const fadeOut = isLast ? Math.min(1, (seg.duration - local) / Math.min(T, 0.8)) : 1;
    return clamp(Math.min(fadeIn, fadeOut));
  }
  const half = T / 2;
  return clamp(Math.min(local / half, (seg.duration - local) / half, 1));
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const ease = (p: number) => p * p * (3 - 2 * p);

function drawPhoto(ctx: CanvasRenderingContext2D, seg: Extract<Segment, { kind: "photo" }>, p: number, W: number, H: number) {
  const img = seg.image;
  const cover = Math.max(W / img.width, H / img.height);
  const e = ease(clamp(p));
  let zoom = 1.08;
  let dx = 0;
  let dy = 0;
  switch (seg.motion) {
    case "zoom_in":
      zoom = 1 + 0.15 * e;
      break;
    case "zoom_out":
      zoom = 1.15 - 0.15 * e;
      break;
    case "pan_left":
      zoom = 1.15;
      dx = 0.5 - e;
      break;
    case "pan_right":
      zoom = 1.15;
      dx = e - 0.5;
      break;
    case "pan_up":
      zoom = 1.15;
      dy = 0.5 - e;
      break;
    case "pan_down":
      zoom = 1.15;
      dy = e - 0.5;
      break;
    case "none":
      zoom = 1;
      break;
  }
  const w = img.width * cover * zoom;
  const h = img.height * cover * zoom;
  const x = (W - w) / 2 - dx * (w - W);
  const y = (H - h) / 2 - dy * (h - H);
  ctx.drawImage(img, x, y, w, h);

  if (seg.caption) {
    const grad = ctx.createLinearGradient(0, H * 0.7, 0, H);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, "rgba(0,0,0,0.65)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, H * 0.7, W, H * 0.3);
    const size = Math.round(Math.min(W, H) * 0.045);
    ctx.font = `600 ${size}px system-ui, -apple-system, Segoe UI, sans-serif`;
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const lines = wrap(ctx, seg.caption, W * 0.85);
    lines.forEach((line, i) => ctx.fillText(line, W / 2, H - size * 1.6 - (lines.length - 1 - i) * size * 1.25));
  }
}

function drawCard(ctx: CanvasRenderingContext2D, text: string, W: number, H: number, color: string) {
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, color);
  grad.addColorStop(1, "#0b0b10");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  const size = Math.round(Math.min(W, H) * 0.075);
  ctx.font = `700 ${size}px system-ui, -apple-system, Segoe UI, sans-serif`;
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lines = wrap(ctx, text, W * 0.8);
  lines.forEach((line, i) => ctx.fillText(line, W / 2, H / 2 + (i - (lines.length - 1) / 2) * size * 1.2));
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

export type RenderResult = { blob: Blob; mimeType: string; durationS: number };

export async function renderVideo(opts: {
  plan: VideoPlan;
  photos: PhotoRef[];
  canvas: HTMLCanvasElement;
  audio?: File | null;
  onProgress?: (fraction: number, label: string) => void;
  signal?: AbortSignal;
}): Promise<RenderResult> {
  const { plan, photos, canvas, audio, onProgress, signal } = opts;
  const mimeType = pickMimeType();
  if (!mimeType) throw new Error("This browser can't record video. Try a recent Chrome, Edge, Firefox or Safari.");

  // 1. Load images
  const byId = new Map(photos.map((p) => [p.id, p]));
  const ids = [...new Set(plan.scenes.map((s) => s.photo_id))];
  const images = new Map<string, ImageBitmap>();
  let loaded = 0;
  // A few at a time keeps memory in check on phones.
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const ref = byId.get(id);
      if (!ref) throw new Error(`Photo ${id} is not in the current selection`);
      images.set(id, await loadImage(ref));
      onProgress?.((++loaded / ids.length) * 0.1, `Loading photos ${loaded}/${ids.length}`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  const { width: W, height: H } = dimensions(plan.aspect);
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const { segments, total } = buildTimeline(plan, images);
  const color = plan.accent_color ?? "#4f46e5";

  const draw = (t: number) => {
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    segments.forEach((seg, i) => {
      if (t < seg.start || t > seg.start + seg.duration) return;
      ctx.globalAlpha = alphaFor(seg, t, plan, i === 0, i === segments.length - 1);
      if (seg.kind === "card") drawCard(ctx, seg.text, W, H, color);
      else drawPhoto(ctx, seg, (t - seg.start) / seg.duration, W, H);
    });
    ctx.globalAlpha = 1;
  };
  draw(0);

  // 2. Set up recording (video from canvas, optional soundtrack)
  const stream = canvas.captureStream(FPS);
  let audioCtx: AudioContext | null = null;
  let audioSource: AudioBufferSourceNode | null = null;
  if (audio) {
    audioCtx = new AudioContext();
    const buffer = await audioCtx.decodeAudioData(await audio.arrayBuffer());
    const dest = audioCtx.createMediaStreamDestination();
    const gain = audioCtx.createGain();
    audioSource = audioCtx.createBufferSource();
    audioSource.buffer = buffer;
    audioSource.loop = buffer.duration < total;
    audioSource.connect(gain).connect(dest);
    const now = audioCtx.currentTime;
    gain.gain.setValueAtTime(1, now);
    gain.gain.setValueAtTime(1, now + Math.max(0, total - 2));
    gain.gain.linearRampToValueAtTime(0, now + total);
    dest.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
  }

  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));

  // 3. Play the timeline in real time while recording
  recorder.start(1000);
  audioSource?.start();
  const t0 = performance.now();
  await new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (signal?.aborted) return reject(new DOMException("Render cancelled", "AbortError"));
      const t = (performance.now() - t0) / 1000;
      draw(Math.min(t, total));
      onProgress?.(0.1 + 0.9 * Math.min(1, t / total), `Rendering ${Math.min(t, total).toFixed(1)}s / ${total.toFixed(1)}s`);
      if (t >= total) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }).finally(() => {
    recorder.stop();
    audioSource?.stop();
    void audioCtx?.close();
    stream.getTracks().forEach((track) => track.stop());
    images.forEach((img) => img.close());
  });
  await stopped;

  return { blob: new Blob(chunks, { type: mimeType.split(";")[0] }), mimeType, durationS: total };
}
