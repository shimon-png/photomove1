"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MUSIC_TRACKS, type MediaRef, type VideoPlan } from "@/lib/plan";
import { renderVideo } from "@/lib/render";
import { SharePanel, type ShareRequest } from "./SharePanel";

type Output = { url: string; ext: string; durationS: number; audioOk: boolean };
type MusicId = (typeof MUSIC_TRACKS)[number]["id"] | "none";

// Picked once per page load, so every new video starts with a random track.
const RANDOM_TRACK: MusicId = MUSIC_TRACKS[Math.floor(Math.random() * MUSIC_TRACKS.length)].id;

export function VideoPanel({
  plan,
  media,
  sharingEnabled = false,
  shareRequest = null,
  uploadMode = "blob",
}: {
  plan: VideoPlan;
  media: MediaRef[];
  sharingEnabled?: boolean;
  shareRequest?: ShareRequest | null;
  uploadMode?: "blob" | "direct";
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [music, setMusic] = useState<MusicId>(RANDOM_TRACK);
  const [progress, setProgress] = useState<{ f: number; label: string } | null>(null);
  const [output, setOutput] = useState<Output | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState(0);

  // The storyboard comes from Claude; the music comes from the picker below.
  const fullPlan = useMemo<VideoPlan>(() => ({ ...plan, music }), [plan, music]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = new AbortController();
    let url: string | null = null;
    setOutput(null);
    setError(null);
    renderVideo({
      plan: fullPlan,
      media,
      canvas,
      signal: controller.signal,
      onProgress: (f, label) => setProgress({ f, label }),
    })
      .then((res) => {
        url = URL.createObjectURL(res.blob);
        setOutput({ url, ext: res.mimeType.includes("mp4") ? "mp4" : "webm", durationS: res.durationS, audioOk: res.audioOk });
        setProgress(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Rendering failed");
        setProgress(null);
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [fullPlan, media, runId]);

  const fileName = `${plan.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "reel"}`;
  const clips = plan.scenes.filter((s) => s.media_id.startsWith("v")).length;
  const voices = plan.voice_notes?.length ?? 0;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">{plan.title}</h2>
        <span className="text-xs text-muted">
          {plan.aspect} · {plan.scenes.length} scenes{clips ? ` · ${clips} clip${clips > 1 ? "s" : ""}` : ""}
          {voices ? ` · ${voices} voice note${voices > 1 ? "s" : ""}` : ""}
        </span>
      </div>

      <div className={plan.aspect === "9:16" ? "mx-auto max-w-[280px]" : ""}>
        <canvas ref={canvasRef} className={`w-full rounded-lg bg-black ${output ? "hidden" : ""}`} />
        {output && <video src={output.url} controls playsInline className="w-full rounded-lg bg-black" />}
      </div>

      {progress && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded bg-surface-2">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(progress.f * 100)}%` }} />
          </div>
          <p className="mt-1 text-xs text-muted">{progress.label} — keep this tab open while it records.</p>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      {output && !output.audioOk && (
        <p className="mt-3 text-sm text-danger">
          Your browser blocked the sound while recording. Tap Re-render to record it with sound.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        {output && (
          <a href={output.url} download={`${fileName}.${output.ext}`} className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white">
            Download .{output.ext}
          </a>
        )}
        {(error || (output && !output.audioOk)) && (
          <button className="rounded-lg border border-border px-3 py-1.5" onClick={() => setRunId((n) => n + 1)}>
            Re-render
          </button>
        )}
      </div>

      <MusicPicker value={music} onChange={setMusic} disabled={false} />

      {sharingEnabled && <SharePanel plan={fullPlan} media={media} request={shareRequest} uploadMode={uploadMode} />}
    </div>
  );
}

function MusicPicker({ value, onChange, disabled }: { value: MusicId; onChange: (id: MusicId) => void; disabled: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);

  useEffect(() => () => audioRef.current?.pause(), []);

  const togglePreview = (id: string, src: string) => {
    audioRef.current ??= new Audio();
    const a = audioRef.current;
    if (previewing === id) {
      a.pause();
      setPreviewing(null);
      return;
    }
    a.src = src;
    a.currentTime = 0;
    a.onended = () => setPreviewing(null);
    void a.play().then(() => setPreviewing(id)).catch(() => setPreviewing(null));
  };

  const choose = (id: MusicId) => {
    if (id === value) return;
    audioRef.current?.pause();
    setPreviewing(null);
    onChange(id);
  };

  return (
    <div className="mt-4 border-t border-border pt-3">
      <p className="text-sm font-medium">Music</p>
      <ul className="mt-2 grid gap-1.5" role="radiogroup" aria-label="Background music">
        {MUSIC_TRACKS.map((t) => {
          const selected = value === t.id;
          return (
            <li
              key={t.id}
              className={`flex items-center gap-2 rounded-xl border px-2 py-1.5 ${selected ? "border-accent bg-surface-2" : "border-border"}`}
            >
              <button
                type="button"
                onClick={() => togglePreview(t.id, t.src)}
                aria-label={previewing === t.id ? `Stop preview of ${t.title}` : `Preview ${t.title}`}
                className="grid h-8 w-8 flex-none place-items-center rounded-full bg-surface-2 text-xs"
              >
                {previewing === t.id ? "❚❚" : "▶"}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled && !selected}
                onClick={() => choose(t.id)}
                className="flex flex-1 items-center justify-between gap-2 text-left text-sm disabled:opacity-60"
              >
                <span>{t.title}</span>
                <span className={`text-xs ${selected ? "font-medium text-accent" : "text-muted"}`}>{selected ? "Selected" : "Use"}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        disabled={disabled || value === "none"}
        onClick={() => choose("none")}
        className="mt-1.5 text-xs text-muted underline disabled:no-underline disabled:opacity-60"
      >
        {value === "none" ? "No music" : "Turn music off"}
      </button>
    </div>
  );
}
