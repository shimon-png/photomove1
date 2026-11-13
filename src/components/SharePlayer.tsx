"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PhotoRef } from "@/lib/plan";
import { drawFrame, playStoryboard, prepareStoryboard, renderVideo, type Storyboard } from "@/lib/render";
import type { PublicShare } from "@/lib/shares";

const POLL_MS = 8000;

/**
 * Public page for a shared video. The video is drawn live from the
 * storyboard, so when a reaction is texted in, the next poll rebuilds it with
 * the new quote card — no re-encoding on the server.
 */
export function SharePlayer({ initial }: { initial: PublicShare }) {
  const [share, setShare] = useState(initial);
  const [sb, setSb] = useState<Storyboard | null>(null);
  const [loading, setLoading] = useState<string | null>("Loading photos…");
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [download, setDownload] = useState<{ url: string; ext: string } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recordRef = useRef<HTMLCanvasElement>(null);
  const playAbort = useRef<AbortController | null>(null);
  const versionRef = useRef(initial.version);

  const photos: PhotoRef[] = share.photos.map((p) => ({ id: p.id, url: p.url, createTime: p.createTime }));

  // (Re)build the storyboard whenever the share changes.
  useEffect(() => {
    let cancelled = false;
    let built: Storyboard | null = null;
    setLoading((l) => l ?? "Updating video…");
    prepareStoryboard(share.plan, share.photos.map((p) => ({ id: p.id, url: p.url })), (f, label) => setLoading(label))
      .then((next) => {
        if (cancelled) return next.dispose();
        built = next;
        setSb(next);
        setLoading(null);
        if (canvasRef.current) drawFrame(canvasRef.current, next, Math.min(next.total * 0.15, 1.5));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load the video");
      });
    return () => {
      cancelled = true;
      built?.dispose();
    };
  }, [share]);

  // Poll for new reactions.
  useEffect(() => {
    const timer = setInterval(async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(`/api/shares/${share.id}`, { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as PublicShare;
        if (next.version === versionRef.current) return;
        const newest = next.reactions.at(-1);
        const hadIt = share.reactions.some((r) => r.id === newest?.id && r.placed === newest?.placed);
        versionRef.current = next.version;
        setShare(next);
        if (newest && !hadIt) setToast(`${newest.author}'s reaction was added to the video`);
      } catch {
        /* offline; try again later */
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [share]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const play = useCallback(async () => {
    if (!sb || !canvasRef.current) return;
    playAbort.current?.abort();
    const ctrl = new AbortController();
    playAbort.current = ctrl;
    setPlaying(true);
    await playStoryboard(canvasRef.current, sb, { signal: ctrl.signal, onTime: setTime });
    if (!ctrl.signal.aborted) setPlaying(false);
  }, [sb]);

  const stop = () => {
    playAbort.current?.abort();
    setPlaying(false);
  };

  // A rebuilt storyboard (new reaction) interrupts playback; let the viewer restart.
  useEffect(() => stop, [sb]);

  const save = async () => {
    if (!recordRef.current) return;
    setSaving("Preparing…");
    setDownload(null);
    try {
      const res = await renderVideo({
        plan: share.plan,
        photos,
        canvas: recordRef.current,
        onProgress: (f) => setSaving(`Saving ${Math.round(f * 100)}% — keep this page open`),
      });
      setDownload({ url: URL.createObjectURL(res.blob), ext: res.mimeType.includes("mp4") ? "mp4" : "webm" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the video");
    } finally {
      setSaving(null);
    }
  };

  const vertical = share.plan.aspect === "9:16";
  const names = share.recipients.map((r) => r.name);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <p className="text-sm text-muted">
        A video from <span className="font-medium text-foreground">{share.senderName}</span>
        {names.length ? ` for ${formatNames(names)}` : ""}
      </p>
      <h1 className="mt-1 text-2xl font-semibold">{share.plan.title}</h1>

      <div className={`relative mt-4 ${vertical ? "mx-auto max-w-[360px]" : ""}`}>
        <canvas
          ref={canvasRef}
          onClick={() => (playing ? stop() : void play())}
          className="w-full cursor-pointer rounded-xl bg-black"
          style={{ aspectRatio: share.plan.aspect.replace(":", " / ") }}
        />
        {!playing && (
          <button
            onClick={() => void play()}
            disabled={!sb}
            className="absolute inset-0 m-auto grid h-16 w-16 place-items-center rounded-full bg-white/90 text-2xl text-black shadow disabled:opacity-50"
            aria-label="Play"
          >
            ▶
          </button>
        )}
        {loading && <p className="absolute inset-x-0 bottom-3 text-center text-sm text-white/80">{loading}</p>}
      </div>
      {sb && (
        <div className="mt-2 h-1 overflow-hidden rounded bg-surface-2">
          <div className="h-full bg-accent" style={{ width: `${(time / sb.total) * 100}%` }} />
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        {download ? (
          <a href={download.url} download={`${share.plan.title}.${download.ext}`} className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white">
            Download .{download.ext}
          </a>
        ) : (
          <button onClick={save} disabled={!sb || Boolean(saving)} className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-60">
            {saving ?? "Save video"}
          </button>
        )}
      </div>
      <canvas ref={recordRef} className="hidden" />

      <section className="mt-6 rounded-2xl border border-border bg-surface p-4">
        <h2 className="font-semibold">Reactions</h2>
        {share.reactions.length === 0 ? (
          <p className="mt-1 text-sm text-muted">Reply to the text message you got to add your reaction. It will show up in the video.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {share.reactions.map((r) => (
              <li key={r.id} className="rounded-xl bg-surface-2 px-3 py-2">
                <p className="whitespace-pre-wrap">“{r.text}”</p>
                <p className="mt-1 text-xs text-muted">
                  — {r.author}
                  {!r.placed && " · adding to the video…"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      {toast && (
        <div className="fixed inset-x-0 bottom-6 mx-auto w-fit rounded-full bg-foreground px-4 py-2 text-sm text-background shadow-lg">{toast}</div>
      )}
      <p className="mt-8 text-center text-xs text-muted">Made with Reelbot</p>
    </div>
  );
}

function formatNames(names: string[]) {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
