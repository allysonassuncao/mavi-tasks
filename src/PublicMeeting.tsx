import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  AlignLeft,
  CalendarX,
  Download,
  FastForward,
  FileText,
  Lock,
  Rewind,
  VideoOff,
} from "lucide-react";
import { Button, Input, Loading } from "./ui";
import { SPEEDS, SummaryPanel, TranscriptPanel } from "./MeetingPlayer";
import {
  clock,
  durationLabel,
  publicMeeting,
  publicMeetingVideo,
  summaryPlainText,
  transcriptPlainText,
  type MeetingRecording,
  type PublicMeeting as PublicMeetingView,
} from "./meetings";

type Ready = Extract<PublicMeetingView, { status: "ok" }>;
type Tab = "transcript" | "summary";

/** Um texto baixado como arquivo .txt. */
function saveText(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileBase = (title: string) =>
  title
    .replace(/[\\/:*?"<>|]+/g, "-")
    .trim()
    .slice(0, 120) || "Gravação";

/**
 * Uma gravação aberta pelo link público (/gravacao/<token>?t=segundos), sem
 * o app e sem login: o banco só manda o que o link mostra (vídeo,
 * transcrição, resumo), pede a senha quando o link tem uma e avisa quando
 * venceu. O vídeo vem por um link assinado pedido a /api/drive.
 */
export function PublicMeeting({ token }: { token: string }) {
  const start = Math.max(
    0,
    Number(new URLSearchParams(window.location.search).get("t")) || 0,
  );
  const [state, setState] = useState<PublicMeetingView | null | undefined>(
    undefined,
  );
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    publicMeeting(token, null, true)
      .then(setState)
      .catch(() => setState(null));
  }, [token]);
  useEffect(() => {
    if (state?.status === "ok")
      document.title = `${state.title} · ${state.company}`;
  }, [state]);

  async function unlock(e: FormEvent) {
    e.preventDefault();
    setChecking(true);
    setError("");
    try {
      const next = await publicMeeting(token, password, true);
      setState(next);
      if (next?.status === "ok") setAccepted(password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }

  if (state === undefined)
    return (
      <main className="public-meeting centered-page">
        <Loading variant="detail" />
      </main>
    );
  if (!state || state.status === "expired" || state.status === "locked")
    return (
      <main className="public-meeting centered-page">
        <div className="panel public-meeting-message">
          {state?.status === "expired" ? (
            <CalendarX size={26} aria-hidden="true" />
          ) : state?.status === "locked" ? (
            <Lock size={26} aria-hidden="true" />
          ) : (
            <VideoOff size={26} aria-hidden="true" />
          )}
          <h1>
            {state?.status === "expired"
              ? "Link vencido"
              : state?.status === "locked"
                ? "Muitas tentativas"
                : "Gravação indisponível"}
          </h1>
          <p>
            {state?.status === "expired"
              ? "A validade deste link terminou. Peça um novo link a quem o enviou."
              : state?.status === "locked"
                ? "Por segurança, este link ficou bloqueado por alguns minutos. Tente novamente mais tarde."
                : "Este link não existe mais ou foi desativado por quem o enviou."}
          </p>
        </div>
      </main>
    );
  if (state.status !== "ok")
    return (
      <main className="public-meeting centered-page">
        <form className="panel public-meeting-message" onSubmit={unlock}>
          <Lock size={24} aria-hidden="true" />
          <h1>Gravação protegida</h1>
          <p>Digite a senha que você recebeu junto com o link.</p>
          <label>
            Senha
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
            />
          </label>
          {state.status === "wrong" && (
            <p className="form-error" role="alert">
              Senha incorreta.
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button className="btn primary" type="submit" loading={checking}>
            Abrir gravação
          </Button>
        </form>
      </main>
    );
  return (
    <SharedRecording
      token={token}
      password={accepted}
      view={state}
      start={start}
    />
  );
}

export function SharedRecording({
  token,
  password,
  view,
  start,
}: {
  token: string;
  password: string | null;
  view: Ready;
  start: number;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoError, setVideoError] = useState("");
  const [time, setTime] = useState(start);
  const [duration, setDuration] = useState(view.duration_seconds ?? 0);
  const [rate, setRate] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tabs = [
    ...(view.show_transcript
      ? [{ id: "transcript" as Tab, label: "Transcrição", icon: AlignLeft }]
      : []),
    ...(view.show_summary
      ? [{ id: "summary" as Tab, label: "Resumo", icon: FileText }]
      : []),
  ];
  const [tab, setTab] = useState<Tab>(tabs[0]?.id ?? "transcript");

  useEffect(() => {
    if (!view.video) return;
    let alive = true;
    publicMeetingVideo(token, password, false)
      .then((u) => alive && setVideoUrl(u))
      .catch((e) => alive && setVideoError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [token, password, view.video]);

  const hasVideo = !!videoUrl && !videoError;
  const seek = useCallback(
    (seconds: number, play = true) => {
      setTime(seconds);
      const v = video.current;
      if (!v || !hasVideo) return;
      v.currentTime = seconds;
      if (play) void v.play().catch(() => {});
    },
    [hasVideo],
  );
  function changeRate(r: number) {
    setRate(r);
    if (video.current) video.current.playbackRate = r;
  }
  async function downloadVideo() {
    setBusy(true);
    setError("");
    try {
      window.location.assign(await publicMeetingVideo(token, password, true));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // A página pública não tem próximos passos nem convidados da agência.
  const recording: MeetingRecording = {
    id: "",
    client_id: "",
    title: view.title,
    recorded_at: view.recorded_at,
    duration_seconds: view.duration_seconds,
    recorded_by_email: "",
    attendees: [],
    speakers: view.speakers,
    meet_link: null,
    video_type: null,
    video_bytes: null,
    summary: view.summary ?? {},
  };
  const total = duration || view.duration_seconds || 0;
  const when = new Date(view.recorded_at).toLocaleString("pt-BR", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const base = fileBase(view.title);

  return (
    <main
      className="public-meeting"
      onKeyDown={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("input, textarea, button, video")) return;
        const v = video.current;
        if (!v || !hasVideo) return;
        if (e.key === " ") {
          e.preventDefault();
          if (v.paused) void v.play();
          else v.pause();
        } else if (e.key === "ArrowRight") seek(v.currentTime + 5, !v.paused);
        else if (e.key === "ArrowLeft")
          seek(Math.max(0, v.currentTime - 5), !v.paused);
      }}
    >
      <header className="meeting-player-head">
        <div>
          <small>{view.company} · Gravação compartilhada</small>
          <strong title={view.title}>{view.title}</strong>
          <span className="meeting-player-meta">
            {when}
            {total ? ` · ${durationLabel(total)}` : ""}
            {view.expires_at
              ? ` · link válido até ${new Date(view.expires_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`
              : ""}
          </span>
        </div>
        {view.download && (
          <span className="meeting-player-actions public-meeting-downloads">
            {view.video && (
              <Button
                type="button"
                className="btn secondary"
                onClick={() => void downloadVideo()}
                loading={busy}
              >
                <Download size={15} /> Vídeo
              </Button>
            )}
            {view.transcript && (
              <Button
                type="button"
                className="btn secondary"
                onClick={() =>
                  saveText(
                    `${base} - transcrição.txt`,
                    transcriptPlainText(view.title, view.transcript!),
                  )
                }
              >
                <Download size={15} /> Transcrição
              </Button>
            )}
            {view.summary && (
              <Button
                type="button"
                className="btn secondary"
                onClick={() =>
                  saveText(
                    `${base} - resumo.txt`,
                    summaryPlainText(view.title, view.summary!),
                  )
                }
              >
                <Download size={15} /> Resumo
              </Button>
            )}
          </span>
        )}
      </header>
      {error && (
        <p className="form-error meeting-player-error" role="alert">
          {error}
        </p>
      )}
      <div
        className={`meeting-player-body ${view.video ? "" : "no-video"} ${tabs.length ? "" : "no-side"}`}
      >
        {view.video && (
          <section className="meeting-stage" aria-label="Vídeo">
            {hasVideo ? (
              <video
                ref={video}
                src={videoUrl}
                controls
                playsInline
                preload="metadata"
                controlsList={view.download ? undefined : "nodownload"}
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  if (Number.isFinite(v.duration)) setDuration(v.duration);
                  v.playbackRate = rate;
                  if (start) v.currentTime = start;
                }}
                onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                onSeeked={(e) => setTime(e.currentTarget.currentTime)}
                onError={() =>
                  setVideoError(
                    "Não foi possível carregar o vídeo. Ele pode ter sido removido do armazenamento.",
                  )
                }
              />
            ) : !videoError ? (
              <div className="meeting-stage-empty">
                <Loading variant="media" />
              </div>
            ) : (
              <div className="meeting-stage-empty" role="status">
                <VideoOff size={34} aria-hidden="true" />
                <strong>Vídeo indisponível</strong>
                <p>{videoError}</p>
              </div>
            )}
            {hasVideo && (
              <div className="meeting-controls">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Voltar 10 segundos"
                  title="Voltar 10 s"
                  onClick={() =>
                    seek(Math.max(0, time - 10), !video.current?.paused)
                  }
                >
                  <Rewind size={16} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Avançar 10 segundos"
                  title="Avançar 10 s"
                  onClick={() => seek(time + 10, !video.current?.paused)}
                >
                  <FastForward size={16} />
                </button>
                <span
                  className="meeting-speeds"
                  role="group"
                  aria-label="Velocidade"
                >
                  {SPEEDS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={rate === s ? "selected" : ""}
                      aria-pressed={rate === s}
                      onClick={() => changeRate(s)}
                    >
                      {s}x
                    </button>
                  ))}
                </span>
                <span className="meeting-time">
                  {clock(time)}
                  {total ? ` / ${clock(total)}` : ""}
                </span>
              </div>
            )}
            {view.show_transcript && (
              <p className="meeting-shortcuts">
                Espaço pausa · ← → 5 s · clique numa frase para ir até ela
              </p>
            )}
          </section>
        )}

        {tabs.length > 0 && (
          <section className="meeting-side">
            {tabs.length > 1 && (
              <div className="meeting-tabs" role="tablist">
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={tab === t.id}
                    className={tab === t.id ? "selected" : ""}
                    onClick={() => setTab(t.id)}
                  >
                    <t.icon size={14} /> {t.label}
                  </button>
                ))}
              </div>
            )}
            <div className="meeting-panel" role="tabpanel">
              {tab === "transcript" ? (
                <TranscriptPanel
                  transcript={view.transcript}
                  time={time}
                  synced={hasVideo}
                  onSeek={seek}
                />
              ) : (
                <SummaryPanel
                  recording={recording}
                  transcript={view.transcript}
                  duration={total}
                  steps={0}
                  onSteps={() => {}}
                />
              )}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
