import { useEffect, useRef, useState } from "react";
import { Download, Pause, Play } from "lucide-react";
import { formatDuration } from "./task-audio";
import "./task-audio.css";

const SPEEDS = [1, 1.5, 2];
// One audio at a time: starting one pauses the one playing.
let playing: HTMLAudioElement | null = null;

/**
 * A compact player for recorded audio: play/pause, a seek bar, the time and
 * the speed (1x, 1,5x, 2x). Recordings made in Chrome carry no duration in
 * the file (the bar would be endless), so the recorded one is used.
 */
export function AudioPlayer({
  src,
  duration,
  onDownload,
  label = "Áudio",
}: {
  src: string;
  /** Seconds, as recorded. */
  duration: number;
  onDownload?: () => void;
  label?: string;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  const [time, setTime] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [failed, setFailed] = useState(false);
  const [total, setTotal] = useState(duration);
  useEffect(() => setTotal(duration), [duration]);
  useEffect(
    () => () => {
      if (playing === audio.current) playing = null;
    },
    [],
  );

  function toggle() {
    const el = audio.current;
    if (!el) return;
    if (el.paused) {
      if (playing && playing !== el) playing.pause();
      playing = el;
      el.playbackRate = speed;
      void el.play().catch(() => setFailed(true));
    } else el.pause();
  }
  function seek(value: number) {
    const el = audio.current;
    if (!el) return;
    el.currentTime = value;
    setTime(value);
  }
  function nextSpeed() {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (audio.current) audio.current.playbackRate = next;
  }
  const speedLabel = `${String(speed).replace(".", ",")}x`;

  return (
    <div className={`audio-player${on ? " playing" : ""}`}>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={() => setOn(true)}
        onPause={() => setOn(false)}
        onEnded={() => {
          setOn(false);
          setTime(0);
        }}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setTotal(d);
        }}
        onError={() => setFailed(true)}
      />
      <button
        type="button"
        className="audio-play"
        onClick={toggle}
        aria-label={on ? `Pausar ${label}` : `Ouvir ${label}`}
        disabled={failed}
      >
        {on ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <input
        type="range"
        className="audio-seek"
        min={0}
        max={Math.max(total, 0.1)}
        step={0.1}
        value={Math.min(time, total)}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label={`Posição em ${label}`}
        aria-valuetext={`${formatDuration(time)} de ${formatDuration(total)}`}
        disabled={failed}
        style={{ ["--played" as string]: `${total ? (Math.min(time, total) / total) * 100 : 0}%` }}
      />
      <span className="audio-time">
        {failed ? "Não foi possível tocar" : `${formatDuration(time)} / ${formatDuration(total)}`}
      </span>
      <button
        type="button"
        className="audio-speed"
        onClick={nextSpeed}
        aria-label={`Velocidade ${speedLabel}. Trocar velocidade`}
        title="Velocidade"
      >
        {speedLabel}
      </button>
      {onDownload && (
        <button
          type="button"
          className="icon-btn"
          onClick={onDownload}
          aria-label={`Baixar ${label}`}
          title="Baixar"
        >
          <Download size={15} />
        </button>
      )}
    </div>
  );
}
