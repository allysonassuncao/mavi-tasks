import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronUp,
  CheckSquare,
  Clock,
  Link2,
  ListChecks,
  Plus,
  Search,
  Send,
  Share2,
  Sparkles,
  Tags,
  Undo2,
  Users,
  Video,
  VideoOff,
  X,
  FileText,
  AlignLeft,
  Rewind,
  FastForward,
} from "lucide-react";
import { Loading } from "./ui";
import { canCreateTaskIn } from "./domain";
import { sourceLabel, type AiSource } from "./ai";
import { fold } from "./task-search";
import type { Snapshot } from "./types";
import type { FormPreset } from "./forms";
import {
  answerPieces,
  askMeeting,
  clock,
  deadlineDate,
  durationLabel,
  meetingKind,
  meetingTitle,
  meetingTranscript,
  meetingVideoUrl,
  nextSteps,
  recordingLink,
  segmentAt,
  stepDescription,
  type ChatTurn,
  type MeetingRecording,
  type MeetingSegment,
  type MeetingTranscript,
} from "./meetings";

type Tab = "transcript" | "summary" | "steps" | "ask";
const SPEEDS = [1, 1.25, 1.5, 2];
const SPEAKER_COLORS = [
  "#2d5a8c",
  "#7a4fb3",
  "#b5651d",
  "#2f7d5b",
  "#b83b5e",
  "#4f6d7a",
  "#8a6d1f",
  "#3b6fb8",
];
const SUGGESTIONS = [
  "O que ficou combinado e com quais prazos?",
  "Quais dúvidas ou objeções o cliente levantou?",
  "Resuma a reunião em 5 tópicos.",
  "Falaram de valores, verba ou orçamento?",
];

type Props = {
  recording: MeetingRecording;
  /** Segundo em que o vídeo começa (link de um momento). */
  start?: number;
  data: Snapshot;
  user: string;
  clientName: string;
  notify: (message: string) => void;
  onNewTask?: (preset: FormPreset) => void;
  onClose: () => void;
};

/**
 * Uma reunião gravada: vídeo com a transcrição acompanhando a fala, resumo,
 * próximos passos (viram tarefas) e perguntas à IA.
 */
export function MeetingPlayer({
  recording,
  start,
  data,
  user,
  clientName,
  notify,
  onNewTask,
  onClose,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoError, setVideoError] = useState(
    recording.video_type ? "" : "none",
  );
  const [transcript, setTranscript] = useState<
    MeetingTranscript | null | undefined
  >(undefined);
  const [tab, setTab] = useState<Tab>("transcript");
  const [time, setTime] = useState(start ?? 0);
  const [duration, setDuration] = useState(recording.duration_seconds ?? 0);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState("");

  useEffect(() => {
    const d = dialog.current;
    d?.showModal();
    return () => d?.close();
  }, []);

  useEffect(() => {
    let alive = true;
    meetingTranscript(recording.id)
      .then((t) => alive && setTranscript(t))
      .catch(
        (e) => alive && (setTranscript(null), setError((e as Error).message)),
      );
    if (recording.video_type)
      meetingVideoUrl(recording.id)
        .then((u) => alive && setVideoUrl(u))
        .catch((e) => alive && setVideoError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [recording.id, recording.video_type]);

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
  /** O link da reunião (do início) ou do momento atual. */
  async function copyLink(atMoment: boolean) {
    const link = recordingLink(recording.id, atMoment ? time : undefined);
    try {
      await navigator.clipboard.writeText(link);
      notify(
        atMoment
          ? `Link copiado: abre a gravação em ${clock(time)}.`
          : "Link da gravação copiado. Quem tem acesso a este cliente consegue abrir.",
      );
    } catch {
      setError(`Copie o link: ${link}`);
    }
  }

  const steps = nextSteps(recording.summary);
  const title = meetingTitle(recording);
  const who =
    data.members.find(
      (m) => m.email?.toLowerCase() === recording.recorded_by_email,
    )?.name ?? recording.recorded_by_email.split("@")[0];
  const when = new Date(recording.recorded_at).toLocaleString("pt-BR", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const tabs: {
    id: Tab;
    label: string;
    icon: typeof FileText;
    count?: number;
  }[] = [
    { id: "transcript", label: "Transcrição", icon: AlignLeft },
    { id: "summary", label: "Resumo", icon: FileText },
    {
      id: "steps",
      label: "Próximos passos",
      icon: ListChecks,
      count: steps.length,
    },
    { id: "ask", label: "Perguntar à IA", icon: Sparkles },
  ];
  const total = duration || recording.duration_seconds || 0;

  return createPortal(
    <dialog
      ref={dialog}
      className="meeting-player"
      aria-label={`Gravação: ${title}`}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        const target = e.target as HTMLElement;
        if (
          target.closest(
            "input, textarea, button, [contenteditable='true'], video",
          )
        )
          return;
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
          <small>{clientName} · Gravações da MAVI</small>
          <strong title={title}>{title}</strong>
          <span className="meeting-player-meta">
            <span className="meeting-kind">{meetingKind(recording.title)}</span>
            {when} · gravada por {who}
            {recording.title && recording.title !== title
              ? ` · ${recording.title}`
              : ""}
            {total ? ` · ${durationLabel(total)}` : ""}
          </span>
        </div>
        <span className="meeting-player-actions">
          <button
            type="button"
            className="btn secondary"
            onClick={() => void copyLink(false)}
            title="Copiar o link desta reunião para enviar a outra pessoa"
          >
            <Share2 size={15} /> Copiar link
          </button>
          {time > 0 && (
            <button
              type="button"
              className="btn secondary"
              onClick={() => void copyLink(true)}
              title="Copiar o link que abre a gravação neste momento"
            >
              <Link2 size={15} /> Link em {clock(time)}
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label="Fechar gravação"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </span>
      </header>
      {error && (
        <p className="form-error meeting-player-error" role="alert">
          {error}
        </p>
      )}
      <div className="meeting-player-body">
        <section className="meeting-stage" aria-label="Vídeo">
          {hasVideo ? (
            <video
              ref={video}
              src={videoUrl}
              controls
              playsInline
              preload="metadata"
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
          ) : recording.video_type && !videoError ? (
            <div className="meeting-stage-empty">
              <Loading compact />
            </div>
          ) : (
            <div className="meeting-stage-empty" role="status">
              <VideoOff size={34} aria-hidden="true" />
              <strong>Vídeo indisponível</strong>
              <p>
                {videoError && videoError !== "none"
                  ? videoError
                  : "O vídeo desta reunião não está mais guardado. A transcrição, o resumo e a IA continuam disponíveis."}
              </p>
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
          <p className="meeting-shortcuts">
            Espaço pausa · ← → 5 s · clique numa frase para ir até ela
          </p>
        </section>

        <section className="meeting-side">
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
                {t.count ? (
                  <span className="meeting-tab-count">{t.count}</span>
                ) : null}
              </button>
            ))}
          </div>
          <div className="meeting-panel" role="tabpanel">
            {tab === "transcript" && (
              <TranscriptPanel
                transcript={transcript}
                time={time}
                synced={hasVideo}
                onSeek={seek}
              />
            )}
            {tab === "summary" && (
              <SummaryPanel
                recording={recording}
                transcript={transcript}
                duration={total}
                steps={steps.length}
                onSteps={() => setTab("steps")}
              />
            )}
            {tab === "steps" && (
              <StepsPanel
                recording={recording}
                steps={steps}
                data={data}
                user={user}
                clientName={clientName}
                onNewTask={onNewTask}
              />
            )}
            {tab === "ask" && <AskPanel recording={recording} onSeek={seek} />}
          </div>
        </section>
      </div>
    </dialog>,
    document.body,
  );
}

// ------------------------------------------------------------ transcrição
type Block = { speaker: number | null; start: number | null; items: number[] };
function blocksOf(segments: MeetingSegment[]) {
  const blocks: Block[] = [];
  segments.forEach((s, i) => {
    const last = blocks[blocks.length - 1];
    if (last && last.speaker === s[2] && last.items.length < 12)
      last.items.push(i);
    else blocks.push({ speaker: s[2], start: s[0], items: [i] });
  });
  return blocks;
}
function speakerName(speakers: string[], i: number | null) {
  return i != null && speakers[i] ? speakers[i] : `Falante ${(i ?? 0) + 1}`;
}
function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const folded = fold(text);
  const parts: ReactNode[] = [];
  let from = 0;
  for (
    let at = folded.indexOf(query);
    at >= 0;
    at = folded.indexOf(query, at + query.length)
  ) {
    parts.push(
      text.slice(from, at),
      <mark key={at}>{text.slice(at, at + query.length)}</mark>,
    );
    from = at + query.length;
  }
  parts.push(text.slice(from));
  return parts;
}

const TranscriptBlock = memo(function TranscriptBlock({
  block,
  segments,
  speakers,
  active,
  query,
  current,
  onSeek,
}: {
  block: Block;
  segments: MeetingSegment[];
  speakers: string[];
  /** Trecho tocando, se estiver neste bloco. */
  active: number;
  query: string;
  /** Resultado da busca selecionado, se estiver neste bloco. */
  current: number;
  onSeek: (s: number) => void;
}) {
  const color = SPEAKER_COLORS[(block.speaker ?? 0) % SPEAKER_COLORS.length];
  return (
    <div className="transcript-block">
      <div className="transcript-who">
        <strong style={{ color }}>
          {speakerName(speakers, block.speaker)}
        </strong>
        {block.start != null && (
          <button
            type="button"
            className="transcript-time"
            onClick={() => onSeek(block.start!)}
          >
            {clock(block.start)}
          </button>
        )}
      </div>
      <p>
        {block.items.map((i) => {
          const [start, , , text] = segments[i];
          return (
            <span
              key={i}
              data-seg={i}
              className={[
                "transcript-seg",
                i === active ? "on" : "",
                i === current ? "found" : "",
                start != null ? "timed" : "",
              ].join(" ")}
              onClick={start != null ? () => onSeek(start) : undefined}
            >
              {highlight(text, query)}{" "}
            </span>
          );
        })}
      </p>
    </div>
  );
});

function TranscriptPanel({
  transcript,
  time,
  synced,
  onSeek,
}: {
  transcript: MeetingTranscript | null | undefined;
  time: number;
  synced: boolean;
  onSeek: (s: number, play?: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [find, setFind] = useState("");
  const [hit, setHit] = useState(0);
  const segments = transcript?.segments ?? [];
  const blocks = useMemo(() => blocksOf(segments), [segments]);
  const timed = !!transcript?.timed;
  const active = synced && timed ? segmentAt(segments, time) : -1;
  const query = fold(find.trim());
  const matches = useMemo(
    () =>
      query.length >= 2
        ? segments.flatMap((s, i) => (fold(s[3]).includes(query) ? [i] : []))
        : [],
    [segments, query],
  );
  const currentHit = matches.length
    ? matches[Math.min(hit, matches.length - 1)]
    : -1;

  const scrollTo = (i: number, smooth = true) => {
    const el = box.current?.querySelector<HTMLElement>(`[data-seg="${i}"]`);
    el?.scrollIntoView({
      block: "center",
      behavior: smooth ? "smooth" : "auto",
    });
  };
  // Acompanha a fala: a frase que está tocando fica no meio da tela.
  useEffect(() => {
    if (follow && active >= 0 && !query) scrollTo(active);
  }, [active, follow, query]);
  useEffect(() => {
    if (currentHit >= 0) scrollTo(currentHit);
  }, [currentHit]);

  if (transcript === undefined) return <Loading compact />;
  if (!transcript || !segments.length)
    return <p className="muted centered">Esta reunião não tem transcrição.</p>;
  const stepHit = (d: number) =>
    setHit((h) => (h + d + matches.length) % matches.length);
  return (
    <div className="transcript">
      <div className="transcript-tools">
        <span className="transcript-find">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            placeholder="Buscar na transcrição"
            aria-label="Buscar na transcrição"
            value={find}
            onChange={(e) => {
              setFind(e.target.value);
              setHit(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches.length) {
                e.preventDefault();
                stepHit(e.shiftKey ? -1 : 1);
              }
            }}
          />
          {query.length >= 2 && (
            <small>
              {matches.length
                ? `${Math.min(hit, matches.length - 1) + 1} de ${matches.length}`
                : "nenhum"}
            </small>
          )}
          {matches.length > 1 && (
            <>
              <button
                type="button"
                className="icon-btn"
                aria-label="Anterior"
                onClick={() => stepHit(-1)}
              >
                <ChevronUp size={14} />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Próximo"
                onClick={() => stepHit(1)}
              >
                <ChevronDown size={14} />
              </button>
            </>
          )}
        </span>
        {!timed && (
          <small className="muted">Transcrição sem marcação de tempo.</small>
        )}
      </div>
      <div
        ref={box}
        className="transcript-list"
        onWheel={() => follow && active >= 0 && setFollow(false)}
        onTouchMove={() => follow && active >= 0 && setFollow(false)}
      >
        {blocks.map((b, k) => (
          <TranscriptBlock
            key={k}
            block={b}
            segments={segments}
            speakers={transcript.speakers}
            active={b.items.includes(active) ? active : -1}
            current={b.items.includes(currentHit) ? currentHit : -1}
            query={query.length >= 2 ? query : ""}
            onSeek={onSeek}
          />
        ))}
      </div>
      {!follow && active >= 0 && (
        <button
          type="button"
          className="transcript-follow"
          onClick={() => {
            setFollow(true);
            scrollTo(active);
          }}
        >
          <Undo2 size={14} /> Voltar para o momento atual
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------ resumo
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

function SummaryPanel({
  recording,
  transcript,
  duration,
  steps,
  onSteps,
}: {
  recording: MeetingRecording;
  transcript: MeetingTranscript | null | undefined;
  duration: number;
  steps: number;
  onSteps: () => void;
}) {
  const s = recording.summary;
  const notes = s.notes ?? [];
  const tags = [...(s.tone ?? []), ...(s.keywords ?? [])];
  const [open, setOpen] = useState<Set<number>>(() => new Set([0]));
  const [allTags, setAllTags] = useState(false);
  const [fullOverview, setFullOverview] = useState(false);
  // Quanto cada pessoa falou (pela soma das frases com tempo).
  const talk = useMemo(() => {
    if (!transcript?.timed) return [];
    const totals = new Map<number, number>();
    for (const [start, end, speaker] of transcript.segments)
      if (start != null && end != null && end > start)
        totals.set(
          speaker ?? 0,
          (totals.get(speaker ?? 0) ?? 0) + (end - start),
        );
    const sum = [...totals.values()].reduce((a, b) => a + b, 0);
    return [...totals]
      .sort((a, b) => b[1] - a[1])
      .map(([speaker, seconds]) => ({
        speaker,
        name: speakerName(transcript.speakers, speaker),
        seconds,
        share: sum ? seconds / sum : 0,
      }));
  }, [transcript]);
  const people = [...new Set(recording.speakers)];
  if (!s.overview && !notes.length && !talk.length)
    return <p className="muted centered">Esta reunião não tem resumo.</p>;
  const longOverview = (s.overview?.length ?? 0) > 420;
  const allOpen = notes.length > 0 && open.size === notes.length;
  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  return (
    <div className="meeting-summary">
      {s.overview && (
        <section className="summary-card summary-overview">
          <h4>
            <Sparkles size={14} aria-hidden="true" /> Em resumo
          </h4>
          <p className={longOverview && !fullOverview ? "clamped" : ""}>
            {s.overview}
          </p>
          {longOverview && (
            <button
              type="button"
              className="text-btn"
              onClick={() => setFullOverview((v) => !v)}
            >
              {fullOverview ? "Mostrar menos" : "Ler tudo"}
            </button>
          )}
        </section>
      )}

      <div className="summary-facts">
        {duration > 0 && (
          <div>
            <Clock size={15} aria-hidden="true" />
            <strong>{durationLabel(duration)}</strong>
            <small>de reunião</small>
          </div>
        )}
        {people.length > 0 && (
          <div>
            <Users size={15} aria-hidden="true" />
            <strong>{people.length}</strong>
            <small>
              {people.length === 1 ? "participante" : "participantes"}
            </small>
          </div>
        )}
        {notes.length > 0 && (
          <div>
            <AlignLeft size={15} aria-hidden="true" />
            <strong>{notes.length}</strong>
            <small>{notes.length === 1 ? "assunto" : "assuntos"}</small>
          </div>
        )}
        {steps > 0 && (
          <button type="button" onClick={onSteps}>
            <ListChecks size={15} aria-hidden="true" />
            <strong>{steps}</strong>
            <small>{steps === 1 ? "próximo passo" : "próximos passos"}</small>
          </button>
        )}
      </div>

      {notes.length > 0 && (
        <section className="summary-section">
          <header>
            <h4>Assuntos discutidos</h4>
            {notes.length > 1 && (
              <button
                type="button"
                className="text-btn"
                onClick={() =>
                  setOpen(allOpen ? new Set() : new Set(notes.map((_, i) => i)))
                }
              >
                {allOpen ? "Recolher todos" : "Abrir todos"}
              </button>
            )}
          </header>
          <ol className="summary-topics">
            {notes.map((n, i) => (
              <li key={i} className={open.has(i) ? "open" : ""}>
                <button
                  type="button"
                  aria-expanded={open.has(i)}
                  onClick={() => toggle(i)}
                >
                  <span className="summary-topic-n">{i + 1}</span>
                  <strong>{n.title || `Assunto ${i + 1}`}</strong>
                  <ChevronDown size={15} aria-hidden="true" />
                </button>
                {open.has(i) && n.description && <p>{n.description}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {tags.length > 0 && (
        <section className="summary-section">
          <header>
            <h4>
              <Tags size={13} aria-hidden="true" /> Temas
            </h4>
          </header>
          <div className="meeting-chips">
            {(allTags ? tags : tags.slice(0, 8)).map((t, i) => (
              <span
                key={`${t}-${i}`}
                className={`meeting-chip ${i < (s.tone?.length ?? 0) ? "tone" : ""}`}
              >
                {t}
              </span>
            ))}
            {tags.length > 8 && (
              <button
                type="button"
                className="meeting-chip more"
                onClick={() => setAllTags((v) => !v)}
              >
                {allTags ? "menos" : `+${tags.length - 8}`}
              </button>
            )}
          </div>
        </section>
      )}

      {talk.length > 1 && (
        <section className="summary-section">
          <header>
            <h4>Quem mais falou</h4>
          </header>
          <ul className="meeting-talk">
            {talk.map((t) => (
              <li key={t.speaker}>
                <span>{t.name}</span>
                <span className="meeting-talk-bar">
                  <span
                    style={{
                      width: `${Math.round(t.share * 100)}%`,
                      background:
                        SPEAKER_COLORS[t.speaker % SPEAKER_COLORS.length],
                    }}
                  />
                </span>
                <small>
                  {Math.round(t.share * 100)}% ·{" "}
                  {durationLabel(t.seconds) || "< 1 min"}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}

      {people.length > 0 && (
        <section className="summary-section">
          <header>
            <h4>Participantes</h4>
          </header>
          <ul className="summary-people">
            {people.map((p, i) => (
              <li key={p}>
                <span
                  className="summary-avatar"
                  style={{
                    background: SPEAKER_COLORS[i % SPEAKER_COLORS.length],
                  }}
                  aria-hidden="true"
                >
                  {initials(p)}
                </span>
                {p}
              </li>
            ))}
          </ul>
          {recording.attendees.length > 0 && (
            <p className="summary-invited">
              Convidados da agência: {recording.attendees.join(", ")}
            </p>
          )}
        </section>
      )}

      <p className="meeting-ai-note">
        Resumo gerado automaticamente pela IA do gravador; confira na
        transcrição.
      </p>
    </div>
  );
}

// ------------------------------------------------------------ próximos passos
function StepsPanel({
  recording,
  steps,
  data,
  user,
  clientName,
  onNewTask,
}: {
  recording: MeetingRecording;
  steps: ReturnType<typeof nextSteps>;
  data: Snapshot;
  user: string;
  clientName: string;
  onNewTask?: (preset: FormPreset) => void;
}) {
  const contract = data.contracts.find(
    (k) =>
      k.client_id === recording.client_id &&
      !k.archived &&
      canCreateTaskIn(data, k.id, user),
  );
  if (!steps.length)
    return (
      <p className="muted centered">
        O resumo desta reunião não tem próximos passos.
      </p>
    );
  function createTask(step: (typeof steps)[number]) {
    const link = recordingLink(recording.id);
    const date = new Date(recording.recorded_at).toLocaleDateString("pt-BR");
    onNewTask?.({
      contract: contract?.id,
      title: step.description.slice(0, 240),
      due: deadlineDate(step.deadline),
      description: stepDescription(step, {
        title: meetingTitle(recording),
        clientName,
        date,
        link,
      }),
    });
  }
  return (
    <div className="meeting-steps">
      <ul>
        {steps.map((s, i) => (
          <li key={i}>
            <div>
              <p>{s.description}</p>
              <small>{[s.owner, s.deadline].filter(Boolean).join(" · ")}</small>
            </div>
            {onNewTask && contract && (
              <button
                type="button"
                className="btn secondary"
                onClick={() => createTask(s)}
              >
                <Plus size={14} /> Criar tarefa
              </button>
            )}
          </li>
        ))}
      </ul>
      {onNewTask && !contract && (
        <p className="muted">
          Para criar tarefas, você precisa ter acesso a um produto contratado
          deste cliente.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------ IA
/**
 * Resposta da IA com momentos [12:34] e fontes [S3] clicáveis, e a lista
 * das fontes citadas no fim.
 */
export function AnswerText({
  text,
  onTime,
  sources = [],
  onSource,
}: {
  text: string;
  onTime?: (seconds: number) => void;
  sources?: AiSource[];
  onSource?: (source: AiSource) => void;
}) {
  const byRef = new Map(sources.map((s) => [s.ref, s]));
  const lines = text.split("\n");
  const render = (line: string) =>
    answerPieces(line).map((p, i) =>
      p.kind === "text" ? (
        p.bold ? (
          <strong key={i}>{p.text}</strong>
        ) : (
          <span key={i}>{p.text}</span>
        )
      ) : p.kind === "time" ? (
        <button
          key={i}
          type="button"
          className="answer-cite"
          onClick={() => onTime?.(p.seconds)}
          disabled={!onTime}
        >
          {p.label}
        </button>
      ) : byRef.has(p.ref) ? (
        <button
          key={i}
          type="button"
          className={`answer-cite ${byRef.get(p.ref)!.type}`}
          title={byRef.get(p.ref)!.title}
          onClick={() => onSource?.(byRef.get(p.ref)!)}
          disabled={!onSource}
        >
          {sourceLabel(byRef.get(p.ref)!)}
        </button>
      ) : null,
    );
  const out: ReactNode[] = [];
  let list: ReactNode[] = [];
  const flush = () => {
    if (list.length) out.push(<ul key={`l${out.length}`}>{list}</ul>);
    list = [];
  };
  lines.forEach((line, i) => {
    const item = line.match(/^\s*(?:[-•*]|\d+[.)])\s+(.*)$/);
    if (item) list.push(<li key={i}>{render(item[1])}</li>);
    else {
      flush();
      if (line.trim())
        out.push(<p key={i}>{render(line.replace(/^#+\s*/, ""))}</p>);
    }
  });
  flush();
  return (
    <div className="answer-text">
      {out}
      {sources.length > 0 && (
        <div className="answer-sources">
          <small>Fontes</small>
          <ul>
            {sources.map((s) => (
              <li key={s.ref}>
                <button
                  type="button"
                  onClick={() => onSource?.(s)}
                  disabled={!onSource}
                  title={sourceLabel(s)}
                >
                  {s.type === "meeting" ? (
                    <Video size={13} aria-hidden="true" />
                  ) : (
                    <CheckSquare size={13} aria-hidden="true" />
                  )}
                  <span>{s.title}</span>
                  <small>{sourceLabel(s)}</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

type ChatEntry = ChatTurn & { sources?: AiSource[] };

export function ChatBox({
  placeholder,
  suggestions,
  ask,
  renderAnswer,
  intro,
  thinking = "Lendo e respondendo…",
}: {
  placeholder: string;
  suggestions: string[];
  /** A resposta (texto) ou a resposta com as fontes citadas. */
  ask: (
    question: string,
    history: ChatTurn[],
  ) => Promise<string | { answer: string; sources: AiSource[] }>;
  renderAnswer: (text: string, sources: AiSource[]) => ReactNode;
  intro: string;
  thinking?: string;
}) {
  const [turns, setTurns] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns, busy]);
  async function send(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setError("");
    setBusy(true);
    setDraft("");
    const history = turns;
    setTurns([...history, { role: "user", content: q }]);
    try {
      const reply = await ask(
        q,
        history.map(({ role, content }) => ({ role, content })),
      );
      const entry: ChatEntry =
        typeof reply === "string"
          ? { role: "assistant", content: reply }
          : {
              role: "assistant",
              content: reply.answer,
              sources: reply.sources,
            };
      setTurns((t) => [...t, entry]);
    } catch (e) {
      setError((e as Error).message);
      setTurns(history);
      setDraft(q);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="meeting-chat">
      <div className="meeting-chat-log">
        {!turns.length && (
          <div className="meeting-chat-intro">
            <Sparkles size={18} aria-hidden="true" />
            <p>{intro}</p>
            <div className="meeting-chat-suggestions">
              {suggestions.map((s) => (
                <button key={s} type="button" onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <p key={i} className="chat-q">
              {t.content}
            </p>
          ) : (
            <div key={i} className="chat-a">
              {renderAnswer(t.content, t.sources ?? [])}
            </div>
          ),
        )}
        {busy && (
          <div className="chat-a chat-thinking" role="status">
            <Sparkles size={14} /> {thinking}
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div ref={end} />
      </div>
      <form
        className="meeting-chat-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <textarea
          rows={2}
          value={draft}
          maxLength={2000}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        <button
          type="submit"
          className="btn primary"
          disabled={busy || draft.trim().length < 2}
          aria-label="Perguntar"
        >
          <Send size={15} />
        </button>
      </form>
    </div>
  );
}

function AskPanel({
  recording,
  onSeek,
}: {
  recording: MeetingRecording;
  onSeek: (s: number) => void;
}) {
  return (
    <ChatBox
      intro="Pergunte qualquer coisa sobre esta reunião. A IA lê a transcrição inteira e mostra o minuto de onde tirou cada resposta."
      placeholder="Pergunte sobre esta reunião"
      suggestions={SUGGESTIONS}
      ask={(q, history) => askMeeting(recording.id, q, history)}
      renderAnswer={(text) => <AnswerText text={text} onTime={onSeek} />}
    />
  );
}
