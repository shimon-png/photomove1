"use client";

import { useEffect, useRef, useState } from "react";
import type { PhotoRef, VideoPlan } from "@/lib/plan";
import { renderVideo } from "@/lib/render";

type Output = { url: string; ext: string; durationS: number };

export function VideoPanel({ plan, photos }: { plan: VideoPlan; photos: PhotoRef[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [audio, setAudio] = useState<File | null>(null);
  const [progress, setProgress] = useState<{ f: number; label: string } | null>(null);
  const [output, setOutput] = useState<Output | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState(0);
  const [soundtrackOnNextRun, setSoundtrackOnNextRun] = useState<File | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = new AbortController();
    let url: string | null = null;
    setOutput(null);
    setError(null);
    renderVideo({
      plan,
      photos,
      canvas,
      audio: soundtrackOnNextRun,
      signal: controller.signal,
      onProgress: (f, label) => setProgress({ f, label }),
    })
      .then((res) => {
        url = URL.createObjectURL(res.blob);
        setOutput({ url, ext: res.mimeType.includes("mp4") ? "mp4" : "webm", durationS: res.durationS });
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
  }, [plan, photos, soundtrackOnNextRun, runId]);

  const fileName = `${plan.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "reel"}`;

  return (
    <div className="rounded-2xl border border-border bg-surface p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">{plan.title}</h2>
        <span className="text-xs text-muted">
          {plan.aspect} · {plan.scenes.length} photos
        </span>
      </div>

      <div className={plan.aspect === "9:16" ? "mx-auto max-w-[280px]" : ""}>
        <canvas ref={canvasRef} className={`w-full rounded-lg bg-black ${output ? "hidden" : ""}`} />
        {output && <video src={output.url} controls autoPlay className="w-full rounded-lg bg-black" />}
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

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        {output && (
          <a
            href={output.url}
            download={`${fileName}.${output.ext}`}
            className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white"
          >
            Download .{output.ext}
          </a>
        )}
        <label className="cursor-pointer rounded-lg border border-border px-3 py-1.5">
          {audio ? `♪ ${audio.name.slice(0, 24)}` : "Add soundtrack"}
          <input
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => setAudio(e.target.files?.[0] ?? null)}
          />
        </label>
        {(audio !== soundtrackOnNextRun || error) && (
          <button
            className="rounded-lg border border-border px-3 py-1.5"
            onClick={() => {
              setSoundtrackOnNextRun(audio);
              setRunId((n) => n + 1);
            }}
          >
            Re-render
          </button>
        )}
      </div>
    </div>
  );
}
