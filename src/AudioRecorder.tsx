import { useEffect, useRef, useState } from "react";
import { Check, Mic, Pause, Play, RotateCcw, Square, Trash2 } from "lucide-react";
import { Button } from "./ui";
import { AudioPlayer } from "./AudioPlayer";
import {
  AUDIO_BITS_PER_SECOND,
  AUDIO_MAX_SECONDS,
  AUDIO_WARN_SECONDS,
  formatDuration,
  pickRecorderMime,
} from "./task-audio";
import "./task-audio.css";

export type Recording = { blob: Blob; mime: string; seconds: number };
type Phase = "idle" | "starting" | "recording" | "paused" | "review";

/** Why the microphone didn't open, in words the person can act on. */
function micError(e: unknown) {
  const name = (e as DOMException)?.name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return "O navegador bloqueou o microfone. Clique no cadeado ao lado do endereço do site, permita o microfone e tente de novo.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "Nenhum microfone encontrado. Conecte um microfone e tente de novo.";
  if (name === "NotReadableError")
    return "Outro aplicativo está usando o microfone. Feche-o e tente de novo.";
  return "Não foi possível abrir o microfone neste navegador.";
}

/**
 * Records one audio: a live waveform and a timer (up to 5 minutes, with a
 * warning from 4:30), pause and resume, then listen before using it or
 * throw it away. Chrome and Firefox record WebM/Opus, Safari MP4/AAC.
 */
export function AudioRecorder({
  onUse,
  disabled,
  compact = false,
  label = "Gravar áudio",
  onActiveChange,
}: {
  /** The recording the person chose to keep. */
  onUse: (r: Recording) => void | Promise<void>;
  disabled?: boolean;
  /** A single mic button (comment composer) instead of the labelled one. */
  compact?: boolean;
  label?: string;
  /** Recording or reviewing: the form waits for the person to decide. */
  onActiveChange?: (active: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [take, setTake] = useState<(Recording & { url: string }) | null>(null);
  const [using, setUsing] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  // Time recorded so far (pauses don't count), and when the current stretch began.
  const elapsed = useRef(0);
  const since = useRef(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const context = useRef<AudioContext | null>(null);
  const frame = useRef(0);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  const activeChange = useRef(onActiveChange);
  activeChange.current = onActiveChange;
  useEffect(() => {
    onActiveChange?.(phase !== "idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);
  // The parent often unmounts the recorder right after onUse (e.g. the
  // comment composer swaps it for the preview), before phase goes back to
  // idle; without this it would think a recording is still in progress.
  useEffect(() => () => activeChange.current?.(false), []);
  useEffect(() => () => release(), []);
  useEffect(
    () => () => {
      if (take) URL.revokeObjectURL(take.url);
    },
    [take],
  );

  const now = () => elapsed.current + (since.current ? performance.now() - since.current : 0);
  function release() {
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
    cancelAnimationFrame(frame.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    void context.current?.close().catch(() => {});
    context.current = null;
    analyser.current = null;
  }
  function draw() {
    const el = canvas.current,
      node = analyser.current;
    if (!el || !node) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const ratio = window.devicePixelRatio || 1;
    const w = el.clientWidth,
      h = el.clientHeight;
    if (el.width !== w * ratio) el.width = w * ratio;
    if (el.height !== h * ratio) el.height = h * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const data = new Uint8Array(node.fftSize);
    node.getByteTimeDomainData(data);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = getComputedStyle(el).color;
    const bars = Math.max(12, Math.floor(w / 5));
    const step = Math.floor(data.length / bars);
    for (let i = 0; i < bars; i++) {
      let peak = 0;
      for (let j = 0; j < step; j++)
        peak = Math.max(peak, Math.abs(data[i * step + j] - 128) / 128);
      const bar = Math.max(2, Math.min(h, peak * h * 1.8));
      ctx.fillRect(i * 5, (h - bar) / 2, 3, bar);
    }
    frame.current = requestAnimationFrame(draw);
  }

  async function start() {
    setError("");
    const mime = pickRecorderMime();
    if (!supported || !mime) {
      setError("Este navegador não grava áudio. Use o Chrome, o Edge, o Firefox ou o Safari atualizados.");
      return;
    }
    setPhase("starting");
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      stream.current = media;
      const rec = new MediaRecorder(media, {
        mimeType: mime,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      });
      chunks.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      rec.onstop = () => {
        const total = Math.min(now(), AUDIO_MAX_SECONDS * 1000) / 1000;
        since.current = 0;
        release();
        const blob = new Blob(chunks.current, { type: rec.mimeType || mime });
        if (!blob.size || total < 0.5) {
          setPhase("idle");
          setError("A gravação ficou vazia. Tente de novo.");
          return;
        }
        setTake({ blob, mime: rec.mimeType || mime, seconds: total, url: URL.createObjectURL(blob) });
        setPhase("review");
      };
      recorder.current = rec;
      try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        context.current = new Ctx();
        const node = context.current.createAnalyser();
        node.fftSize = 1024;
        context.current.createMediaStreamSource(media).connect(node);
        analyser.current = node;
      } catch {
        // No waveform: the recording works the same.
      }
      elapsed.current = 0;
      since.current = performance.now();
      rec.start(1000);
      setSeconds(0);
      setPhase("recording");
      frame.current = requestAnimationFrame(draw);
      tick.current = setInterval(() => {
        const s = now() / 1000;
        setSeconds(s);
        if (s >= AUDIO_MAX_SECONDS && recorder.current?.state !== "inactive") stop();
      }, 250);
    } catch (e) {
      release();
      setPhase("idle");
      setError(micError(e));
    }
  }
  function pause() {
    const rec = recorder.current;
    if (rec?.state !== "recording") return;
    rec.pause();
    elapsed.current = now();
    since.current = 0;
    setPhase("paused");
  }
  function resume() {
    const rec = recorder.current;
    if (rec?.state !== "paused") return;
    since.current = performance.now();
    rec.resume();
    setPhase("recording");
  }
  function stop() {
    const rec = recorder.current;
    if (!rec || rec.state === "inactive") return;
    if (rec.state === "paused") since.current = 0;
    else {
      elapsed.current = now();
      since.current = 0;
    }
    rec.stop();
  }
  function discard() {
    if (recorder.current && recorder.current.state !== "inactive") {
      recorder.current.onstop = null;
      recorder.current.stop();
    }
    release();
    setTake(null);
    setSeconds(0);
    setPhase("idle");
  }
  async function use() {
    if (!take) return;
    setUsing(true);
    try {
      await onUse({ blob: take.blob, mime: take.mime, seconds: take.seconds });
      setTake(null);
      setPhase("idle");
    } finally {
      setUsing(false);
    }
  }

  if (phase === "idle" || phase === "starting")
    return (
      <div className={`audio-recorder idle${compact ? " compact" : ""}`}>
        <Button
          type="button"
          className={compact ? "icon-btn audio-mic" : "btn secondary audio-start"}
          onClick={() => void start()}
          disabled={disabled || phase === "starting"}
          aria-label={label}
          title={compact ? label : undefined}
        >
          <Mic size={compact ? 17 : 16} />
          {!compact && label}
        </Button>
        {error && (
          <p className="audio-recorder-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );

  if (phase === "review" && take)
    return (
      <div className="audio-recorder review" role="group" aria-label="Ouvir a gravação">
        <AudioPlayer src={take.url} duration={take.seconds} />
        <div className="audio-recorder-actions">
          <Button type="button" className="btn secondary" onClick={discard} disabled={using}>
            <Trash2 size={15} /> Descartar
          </Button>
          <Button
            type="button"
            className="btn secondary"
            onClick={() => {
              discard();
              void start();
            }}
            disabled={using}
          >
            <RotateCcw size={15} /> Gravar de novo
          </Button>
          <Button type="button" className="btn primary" onClick={() => void use()} loading={using}>
            <Check size={15} /> Usar áudio
          </Button>
        </div>
      </div>
    );

  const warn = seconds >= AUDIO_WARN_SECONDS;
  return (
    <div
      className={`audio-recorder live${phase === "paused" ? " paused" : ""}${warn ? " warn" : ""}`}
      role="group"
      aria-label="Gravando áudio"
    >
      <span className="audio-rec-dot" aria-hidden="true" />
      <canvas ref={canvas} className="audio-wave" aria-hidden="true" />
      <span className="audio-timer" role="timer" aria-label={`Tempo gravado: ${formatDuration(seconds)} de ${formatDuration(AUDIO_MAX_SECONDS)}`}>
        {formatDuration(seconds)}
        <small> / {formatDuration(AUDIO_MAX_SECONDS)}</small>
      </span>
      {phase === "recording" ? (
        <Button type="button" className="icon-btn" onClick={pause} aria-label="Pausar gravação" title="Pausar">
          <Pause size={17} />
        </Button>
      ) : (
        <Button type="button" className="icon-btn" onClick={resume} aria-label="Continuar gravação" title="Continuar">
          <Play size={17} />
        </Button>
      )}
      <Button type="button" className="icon-btn audio-stop" onClick={stop} aria-label="Parar e ouvir" title="Parar e ouvir">
        <Square size={15} />
      </Button>
      <Button type="button" className="icon-btn" onClick={discard} aria-label="Descartar gravação" title="Descartar">
        <Trash2 size={16} />
      </Button>
      {warn && (
        <small className="audio-warn" role="status">
          Faltam {formatDuration(AUDIO_MAX_SECONDS - seconds)}: a gravação para sozinha em 5 minutos.
        </small>
      )}
    </div>
  );
}
