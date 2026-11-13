"use client";

import { useEffect, useRef, useState } from "react";

const MAX_SECONDS = 180;

function recorderType() {
  const types = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return types.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) ?? "";
}

/** Records a voice note with the microphone and hands it back as a File. */
export function VoiceRecorder({ onRecorded, onError }: { onRecorded: (file: File) => void; onError: (msg: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (recRef.current?.state === "recording") recRef.current.stop();
    },
    [],
  );

  const start = async () => {
    const type = recorderType();
    if (!navigator.mediaDevices?.getUserMedia || !type) {
      onError("This browser can't record audio. Use \"Voice note file\" instead.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onError("Microphone access was blocked. Allow it in your browser settings to record a voice note.");
      return;
    }
    const rec = new MediaRecorder(stream, { mimeType: type });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (timerRef.current) clearInterval(timerRef.current);
      setRecording(false);
      const baseType = type.split(";")[0];
      const blob = new Blob(chunks, { type: baseType });
      if (blob.size < 1000) return;
      const now = new Date();
      const stamp = `${now.getHours()}.${String(now.getMinutes()).padStart(2, "0")}`;
      const ext = baseType === "audio/mp4" ? "m4a" : baseType === "audio/ogg" ? "ogg" : "webm";
      onRecorded(new File([blob], `Voice note ${stamp}.${ext}`, { type: baseType, lastModified: now.getTime() }));
    };
    recRef.current = rec;
    rec.start();
    setSeconds(0);
    setRecording(true);
    const started = Date.now();
    timerRef.current = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS) rec.stop();
    }, 250);
  };

  const stop = () => recRef.current?.state === "recording" && recRef.current.stop();

  return recording ? (
    <button onClick={stop} className="rounded-xl border border-danger px-4 py-3 text-left font-medium text-danger">
      <span className="mr-1 inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-danger align-middle" aria-hidden />
      Stop recording · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
      <span className="block text-xs font-normal opacity-80">Up to 3 minutes</span>
    </button>
  ) : (
    <button onClick={() => void start()} className="rounded-xl border border-border px-4 py-3 text-left font-medium hover:bg-surface-2">
      Record a voice note
      <span className="block text-xs font-normal text-muted">Say a few words to include in the video</span>
    </button>
  );
}
