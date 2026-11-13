import { decodeScaled, loadVideoElement, seekTo } from "./device";
import { MUSIC_TRACKS, type MediaRef, type VideoPlan } from "./plan";

/**
 * Turns a VideoPlan into moving pictures and sound, entirely in the browser.
 * Frames are drawn on a <canvas>; sound (music, voice notes, video clip audio)
 * is mixed with Web Audio. The same storyboard can be played live (share page)
 * or recorded to a file with MediaRecorder. Recording is real-time, so the tab
 * should stay in the foreground while it renders.
 */

const FPS = 30;
const CARD_S = 2.5;
const MUSIC_LEVEL = 0.8;
const MUSIC_DUCKED = 0.18;

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

export function imageUrl(photo: { baseUrl?: string }, size = 2048) {
  return `/api/photos/image?u=${encodeURIComponent(photo.baseUrl ?? "")}&s=${size}`;
}

/** Fetches a shared (public blob) file, falling back to the same-origin proxy if CORS blocks it. */
async function fetchShared(url: string): Promise<Blob> {
  const direct = await fetch(url).catch(() => null);
  const res = direct?.ok ? direct : await fetch(`/api/shares/image?u=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`Could not load media (${res.status})`);
  return res.blob();
}

// ---- Loading ----

type Loaded =
  | { kind: "photo"; image: ImageBitmap }
  | { kind: "video"; el: HTMLVideoElement; objectUrl: string }
  | { kind: "audio"; buffer: AudioBuffer };

const decoder = () => new OfflineAudioContext(2, 1, 48000);
const musicCache = new Map<string, Promise<AudioBuffer>>();

async function decodeAudio(data: ArrayBuffer): Promise<AudioBuffer> {
  return decoder().decodeAudioData(data);
}

function loadMusic(id: string | undefined): Promise<AudioBuffer> | null {
  const track = MUSIC_TRACKS.find((t) => t.id === id);
  if (!track) return null;
  if (!musicCache.has(track.id)) {
    musicCache.set(
      track.id,
      fetch(track.src)
        .then((r) => r.arrayBuffer())
        .then(decodeAudio)
        .catch((err) => {
          musicCache.delete(track.id);
          throw err;
        }),
    );
  }
  return musicCache.get(track.id)!;
}

async function loadMedia(ref: MediaRef): Promise<Loaded> {
  if (ref.kind === "photo") {
    if (ref.file) return { kind: "photo", image: await decodeScaled(ref.file, 2048) };
    const blob = ref.url ? await fetchShared(ref.url) : await (await fetch(imageUrl(ref))).blob();
    return { kind: "photo", image: await createImageBitmap(blob) };
  }
  if (ref.kind === "video") {
    // Always play from a same-origin blob: URL so the canvas stays recordable.
    const blob = ref.file ?? (ref.url ? await fetchShared(ref.url) : null);
    if (!blob) throw new Error(`Video ${ref.id} is missing`);
    const objectUrl = URL.createObjectURL(blob);
    const el = await loadVideoElement(objectUrl, 30000);
    return { kind: "video", el, objectUrl };
  }
  const data = ref.file ? await ref.file.arrayBuffer() : ref.url ? await (await fetchShared(ref.url)).arrayBuffer() : null;
  if (!data) throw new Error(`Voice note ${ref.id} is missing`);
  return { kind: "audio", buffer: await decodeAudio(data) };
}

// ---- Timeline ----

type Base = { start: number; duration: number };
type PhotoSeg = Base & { kind: "photo"; image: ImageBitmap; motion: VideoPlan["scenes"][number]["motion"]; caption?: string };
type VideoSeg = Base & { kind: "video"; el: HTMLVideoElement; clipStart: number; clipAudio: boolean; caption?: string };
type CardSeg = Base & { kind: "card"; text: string };
type QuoteSeg = Base & { kind: "quote"; text: string; author: string; backdrop?: ImageBitmap | HTMLVideoElement };
type Segment = PhotoSeg | VideoSeg | CardSeg | QuoteSeg;
type Unstarted = Segment extends infer S ? (S extends Segment ? Omit<S, "start"> : never) : never;

function buildTimeline(plan: VideoPlan, loaded: Map<string, Loaded>) {
  const overlap = plan.transition === "crossfade" ? plan.transition_s : 0;
  const visual = (id: string) => {
    const l = loaded.get(id);
    return l?.kind === "photo" ? l.image : l?.kind === "video" ? l.el : undefined;
  };
  const quotesAfter = (index: number): Unstarted[] =>
    (plan.reactions ?? [])
      .filter((r) => Math.min(Math.max(r.after_scene, -1), plan.scenes.length - 1) === index)
      .map((r) => ({
        kind: "quote",
        text: r.text,
        author: r.author,
        backdrop: visual(plan.scenes[Math.max(index, 0)].media_id),
        duration: quoteDuration(r.text),
      }));

  const raw: Unstarted[] = [];
  const sceneSegIndex: number[] = [];
  if (plan.intro_text) raw.push({ kind: "card", text: plan.intro_text, duration: CARD_S });
  raw.push(...quotesAfter(-1));
  plan.scenes.forEach((s, i) => {
    const l = loaded.get(s.media_id);
    sceneSegIndex[i] = raw.length;
    if (l?.kind === "video") {
      raw.push({
        kind: "video",
        el: l.el,
        clipStart: s.clip_start_s ?? 0,
        clipAudio: s.clip_audio ?? false,
        caption: s.caption,
        duration: s.duration_s,
      });
    } else if (l?.kind === "photo") {
      raw.push({ kind: "photo", image: l.image, motion: s.motion, caption: s.caption, duration: s.duration_s });
    }
    raw.push(...quotesAfter(i));
  });
  if (plan.outro_text) raw.push({ kind: "card", text: plan.outro_text, duration: CARD_S });

  const segments: Segment[] = [];
  let t = 0;
  raw.forEach((seg, i) => {
    const start = i === 0 ? 0 : t - Math.min(overlap, seg.duration / 2, segments[i - 1].duration / 2);
    segments.push({ ...seg, start } as Segment);
    t = start + seg.duration;
  });

  // Voice notes start at their scene (plus offset).
  const voices = (plan.voice_notes ?? []).flatMap((v) => {
    const l = loaded.get(v.media_id);
    const seg = segments[sceneSegIndex[v.at_scene]];
    if (l?.kind !== "audio" || !seg) return [];
    const at = seg.start + (v.offset_s ?? 0);
    return [{ buffer: l.buffer, at, end: Math.min(at + l.buffer.duration, t) }];
  });
  return { segments, total: t, voices };
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

// ---- Drawing ----

type Drawable = ImageBitmap | HTMLVideoElement;
const sizeOf = (d: Drawable) => (d instanceof HTMLVideoElement ? { w: d.videoWidth, h: d.videoHeight } : { w: d.width, h: d.height });

function drawCover(ctx: CanvasRenderingContext2D, src: Drawable, W: number, H: number, zoom = 1, dx = 0, dy = 0) {
  const { w: iw, h: ih } = sizeOf(src);
  if (!iw || !ih) return;
  const cover = Math.max(W / iw, H / ih);
  const w = iw * cover * zoom;
  const h = ih * cover * zoom;
  ctx.drawImage(src, (W - w) / 2 - dx * (w - W), (H - h) / 2 - dy * (h - H), w, h);
}

function drawPhoto(ctx: CanvasRenderingContext2D, seg: PhotoSeg, p: number, W: number, H: number) {
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
  drawCover(ctx, seg.image, W, H, zoom, dx, dy);
  if (seg.caption) drawCaption(ctx, seg.caption, W, H);
}

function drawVideo(ctx: CanvasRenderingContext2D, seg: VideoSeg, W: number, H: number) {
  if (seg.el.readyState >= 2) drawCover(ctx, seg.el, W, H);
  if (seg.caption) drawCaption(ctx, seg.caption, W, H);
}

function drawCaption(ctx: CanvasRenderingContext2D, caption: string, W: number, H: number) {
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
  const lines = wrap(ctx, caption, W * 0.85);
  lines.forEach((line, i) => ctx.fillText(line, W / 2, H - size * 1.6 - (lines.length - 1 - i) * size * 1.25));
}

function drawCard(ctx: CanvasRenderingContext2D, text: string, W: number, H: number, color: string) {
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, color);
  grad.addColorStop(1, "#0b0b10");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  if (!text) return;
  const size = Math.round(Math.min(W, H) * 0.075);
  ctx.font = `700 ${size}px system-ui, -apple-system, Segoe UI, sans-serif`;
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lines = wrap(ctx, text, W * 0.8);
  lines.forEach((line, i) => ctx.fillText(line, W / 2, H / 2 + (i - (lines.length - 1) / 2) * size * 1.2));
}

/** Long enough to read comfortably: ~4 words per second plus a beat. */
function quoteDuration(text: string) {
  return Math.min(7, Math.max(3, 1.5 + text.split(/\s+/).length * 0.25));
}

function drawQuote(ctx: CanvasRenderingContext2D, seg: QuoteSeg, W: number, H: number, color: string) {
  if (seg.backdrop) {
    drawCover(ctx, seg.backdrop, W, H, 1.1);
    ctx.fillStyle = "rgba(8,8,14,0.72)";
    ctx.fillRect(0, 0, W, H);
  } else {
    drawCard(ctx, "", W, H, color);
  }
  const unit = Math.min(W, H);
  const size = Math.round(unit * (seg.text.length > 120 ? 0.045 : 0.06));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.font = `700 ${Math.round(unit * 0.16)}px Georgia, serif`;
  ctx.fillText("“", W / 2, H * 0.3);
  ctx.fillStyle = "#fff";
  ctx.font = `600 ${size}px system-ui, -apple-system, Segoe UI, sans-serif`;
  const lines = wrap(ctx, seg.text, W * 0.8, 6);
  lines.forEach((line, i) => ctx.fillText(line, W / 2, H * 0.5 + (i - (lines.length - 1) / 2) * size * 1.3));
  ctx.font = `500 ${Math.round(size * 0.75)}px system-ui, -apple-system, Segoe UI, sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fillText(`— ${seg.author}`, W / 2, H * 0.5 + ((lines.length + 1) / 2) * size * 1.3 + size * 0.6);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines = 3): string[] {
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
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] += "…";
    return kept;
  }
  return lines;
}

// ---- Storyboard ----

export type PlaybackSession = {
  /** Keeps video clips in step with the timeline; call once per frame. */
  sync: (t: number) => void;
  stop: () => void;
  /** False if clip sound had to be muted (e.g. autoplay rules). */
  audioOk: () => boolean;
};

export type Storyboard = {
  width: number;
  height: number;
  total: number;
  hasAudio: boolean;
  /** Draws the frame at time t (seconds) onto ctx. */
  draw: (ctx: CanvasRenderingContext2D, t: number) => void;
  /** Starts sound and video clips at timeline position `from`, routing audio to `dest`. */
  start: (opts: { ac: AudioContext; dest: AudioNode; from: number }) => PlaybackSession;
  dispose: () => void;
};

const elementSources = new WeakMap<AudioContext, WeakMap<HTMLVideoElement, MediaElementAudioSourceNode>>();

/** Loads the media a plan needs and returns a frame-drawing + sound-scheduling storyboard. */
export async function prepareStoryboard(
  plan: VideoPlan,
  media: MediaRef[],
  onProgress?: (fraction: number, label: string) => void,
): Promise<Storyboard> {
  const byId = new Map(media.map((m) => [m.id, m]));
  const ids = [...new Set([...plan.scenes.map((s) => s.media_id), ...(plan.voice_notes ?? []).map((v) => v.media_id)])];
  const loaded = new Map<string, Loaded>();
  const musicPromise = loadMusic(plan.music);
  let done = 0;
  // A few at a time keeps memory in check on phones.
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const ref = byId.get(id);
      if (!ref) throw new Error(`${id} is not in the current selection`);
      loaded.set(id, await loadMedia(ref));
      onProgress?.(++done / ids.length, `Loading media ${done}/${ids.length}`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const music = musicPromise ? await musicPromise.catch(() => null) : null;

  const { width: W, height: H } = dimensions(plan.aspect);
  const { segments, total, voices } = buildTimeline(plan, loaded);
  const color = plan.accent_color ?? "#4f46e5";
  const videoSegs = segments.filter((s): s is VideoSeg => s.kind === "video");

  // Show each clip's first frame before playback starts.
  for (const seg of videoSegs) await seekTo(seg.el, seg.clipStart);

  const draw = (ctx: CanvasRenderingContext2D, t: number) => {
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    segments.forEach((seg, i) => {
      if (t < seg.start || t > seg.start + seg.duration) return;
      ctx.globalAlpha = alphaFor(seg, t, plan, i === 0, i === segments.length - 1);
      if (seg.kind === "card") drawCard(ctx, seg.text, W, H, color);
      else if (seg.kind === "quote") drawQuote(ctx, seg, W, H, color);
      else if (seg.kind === "video") drawVideo(ctx, seg, W, H);
      else drawPhoto(ctx, seg, (t - seg.start) / seg.duration, W, H);
    });
    ctx.globalAlpha = 1;
  };

  // Spans where speech should be heard over the music.
  const duckSpans = [
    ...voices.map((v) => [v.at, v.end] as const),
    ...videoSegs.filter((s) => s.clipAudio).map((s) => [s.start, s.start + s.duration] as const),
  ].sort((a, b) => a[0] - b[0]);

  const start = ({ ac, dest, from }: { ac: AudioContext; dest: AudioNode; from: number }): PlaybackSession => {
    const t0 = ac.currentTime - from; // audio-clock time of timeline 0
    const at = (t: number) => Math.max(ac.currentTime, t0 + t);
    const nodes: AudioScheduledSourceNode[] = [];
    let muted = false;

    if (music) {
      const src = ac.createBufferSource();
      src.buffer = music;
      src.loop = true;
      const gain = ac.createGain();
      const g = gain.gain;
      g.setValueAtTime(MUSIC_LEVEL, at(0));
      for (const [a, b] of duckSpans) {
        if (b <= from) continue;
        g.setValueAtTime(MUSIC_LEVEL, at(a - 0.3));
        g.linearRampToValueAtTime(MUSIC_DUCKED, at(a));
        g.setValueAtTime(MUSIC_DUCKED, at(b));
        g.linearRampToValueAtTime(MUSIC_LEVEL, at(b + 0.5));
      }
      const fadeAt = Math.max(from, total - 2.5);
      const ducked = duckSpans.some(([a, b]) => fadeAt >= a && fadeAt <= b);
      g.setValueAtTime(ducked ? MUSIC_DUCKED : MUSIC_LEVEL, at(fadeAt));
      g.linearRampToValueAtTime(0, at(total));
      src.connect(gain).connect(dest);
      src.start(ac.currentTime, from % music.duration);
      src.stop(at(total) + 0.05);
      nodes.push(src);
    }
    for (const v of voices) {
      if (v.end <= from) continue;
      const src = ac.createBufferSource();
      src.buffer = v.buffer;
      src.connect(dest);
      src.start(at(v.at), Math.max(0, from - v.at));
      nodes.push(src);
    }

    let perCtx = elementSources.get(ac);
    if (!perCtx) elementSources.set(ac, (perCtx = new WeakMap()));
    const gains: GainNode[] = [];
    for (const seg of videoSegs) {
      if (!seg.clipAudio || perCtx.has(seg.el)) continue;
      // Once routed through Web Audio, the element is heard only via this graph.
      const node = ac.createMediaElementSource(seg.el);
      const gain = ac.createGain();
      node.connect(gain).connect(dest);
      perCtx.set(seg.el, node);
      gains.push(gain);
    }

    const sync = (t: number) => {
      const active = new Set<HTMLVideoElement>();
      for (const seg of videoSegs) {
        if (t < seg.start || t >= seg.start + seg.duration) continue;
        active.add(seg.el);
        const want = seg.clipStart + (t - seg.start);
        seg.el.muted = !seg.clipAudio || muted;
        if (seg.el.paused) {
          seg.el.currentTime = want;
          seg.el.play().catch(() => {
            // Autoplay with sound was refused: keep the picture, drop the clip's sound.
            muted = true;
            seg.el.muted = true;
            void seg.el.play().catch(() => {});
          });
        } else if (Math.abs(seg.el.currentTime - want) > 0.35) {
          seg.el.currentTime = want;
        }
      }
      for (const seg of videoSegs) if (!active.has(seg.el) && !seg.el.paused) seg.el.pause();
    };

    const stop = () => {
      for (const n of nodes) {
        try {
          n.stop();
        } catch {
          /* already stopped */
        }
      }
      for (const seg of videoSegs) seg.el.pause();
      for (const g of gains) g.disconnect();
    };
    return { sync, stop, audioOk: () => !muted };
  };

  const dispose = () => {
    for (const l of loaded.values()) {
      if (l.kind === "photo") l.image.close();
      else if (l.kind === "video") {
        l.el.pause();
        l.el.removeAttribute("src");
        l.el.load();
        URL.revokeObjectURL(l.objectUrl);
      }
    }
  };

  const hasAudio = Boolean(music) || voices.length > 0 || videoSegs.some((s) => s.clipAudio);
  return { width: W, height: H, total, hasAudio, draw, start, dispose };
}

/** Plays a storyboard on a canvas with sound. Call from a tap so audio is allowed. */
export function playStoryboard(
  canvas: HTMLCanvasElement,
  sb: Storyboard,
  opts: { signal?: AbortSignal; from?: number; onTime?: (t: number) => void } = {},
): Promise<void> {
  canvas.width = sb.width;
  canvas.height = sb.height;
  const ctx = canvas.getContext("2d")!;
  const ac = new AudioContext();
  void ac.resume();
  const from = opts.from ?? 0;
  const session = sb.start({ ac, dest: ac.destination, from });
  const t0 = performance.now() - from * 1000;
  return new Promise<void>((resolve) => {
    const tick = () => {
      if (opts.signal?.aborted) return resolve();
      const t = Math.min((performance.now() - t0) / 1000, sb.total);
      session.sync(t);
      sb.draw(ctx, t);
      opts.onTime?.(t);
      if (t >= sb.total) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }).finally(() => {
    session.stop();
    void ac.close();
  });
}

/** Draws a single frame (e.g. a poster before playback starts). */
export function drawFrame(canvas: HTMLCanvasElement, sb: Storyboard, t: number) {
  canvas.width = sb.width;
  canvas.height = sb.height;
  sb.draw(canvas.getContext("2d")!, t);
}

export type RenderResult = { blob: Blob; mimeType: string; durationS: number; audioOk: boolean };

/** Records a plan to a video file (with its music, voice notes and clip sound). */
export async function renderVideo(opts: {
  plan: VideoPlan;
  media: MediaRef[];
  canvas: HTMLCanvasElement;
  onProgress?: (fraction: number, label: string) => void;
  signal?: AbortSignal;
}): Promise<RenderResult> {
  const { plan, media, canvas, onProgress, signal } = opts;
  const mimeType = pickMimeType();
  if (!mimeType) throw new Error("This browser can't record video. Try a recent Chrome, Edge, Firefox or Safari.");

  const sb = await prepareStoryboard(plan, media, (f, label) => onProgress?.(f * 0.1, label));
  const total = sb.total;
  canvas.width = sb.width;
  canvas.height = sb.height;
  const ctx = canvas.getContext("2d")!;
  sb.draw(ctx, 0);

  const stream = canvas.captureStream(FPS);
  const ac = new AudioContext();
  await ac.resume().catch(() => {});
  let audioOk = ac.state === "running" || !sb.hasAudio;
  const dest = ac.createMediaStreamDestination();
  if (sb.hasAudio) dest.stream.getAudioTracks().forEach((track) => stream.addTrack(track));

  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));

  recorder.start(1000);
  const session = sb.start({ ac, dest, from: 0 });
  const t0 = performance.now();
  await new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (signal?.aborted) return reject(new DOMException("Render cancelled", "AbortError"));
      const t = Math.min((performance.now() - t0) / 1000, total);
      session.sync(t);
      sb.draw(ctx, t);
      onProgress?.(0.1 + 0.9 * (t / total), `Rendering ${t.toFixed(1)}s / ${total.toFixed(1)}s`);
      if (t >= total) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }).finally(() => {
    audioOk = audioOk && session.audioOk();
    recorder.stop();
    session.stop();
    void ac.close();
    stream.getTracks().forEach((track) => track.stop());
    sb.dispose();
  });
  await stopped;

  return { blob: new Blob(chunks, { type: mimeType.split(";")[0] }), mimeType, durationS: total, audioOk };
}
