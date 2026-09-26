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
  Link2,
  ListChecks,
  MessageSquare,
  Plus,
  Search,
  Send,
  Sparkles,
  Trash2,
  Undo2,
  VideoOff,
  X,
  FileText,
  AlignLeft,
  Rewind,
  FastForward,
} from "lucide-react";
import { Loading } from "./ui";
import { canCreateTaskIn } from "./domain";
import { fold } from "./task-search";
import type { Snapshot } from "./types";
import type { FormPreset } from "./forms";
import {
  addMeetingComment,
  answerPieces,
  askMeeting,
  clock,
  deadlineDate,
  deleteMeetingComment,
  durationLabel,
  meetingComments,
  meetingKind,
  meetingTitle,
  meetingTranscript,
  meetingVideoUrl,
  nextSteps,
  recordingLink,
  segmentAt,
  type ChatTurn,
  type MeetingComment,
  type MeetingRecording,
  type MeetingSegment,
  type MeetingTranscript,
} from "./meetings";

type Tab = "transcript" | "summary" | "steps" | "ask" | "comments";
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
  isLeader: boolean;
  clientName: string;
  notify: (message: string) => void;
  onNewTask?: (preset: FormPreset) => void;
  onClose: () => void;
};

/**
 * Uma reunião gravada: vídeo com a transcrição acompanhando a fala, resumo,
 * próximos passos (viram tarefas), perguntas à IA e comentários no tempo.
 */
export function MeetingPlayer({
  recording,
  start,
  data,
  user,
  isLeader,
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
  const [comments, setComments] = useState<MeetingComment[]>([]);
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

  const loadComments = useCallback(
    () =>
      meetingComments(recording.id)
        .then(setComments)
        .catch(() => {}),
    [recording.id],
  );
  useEffect(() => {
    void loadComments();
    // Comentários de outras pessoas chegam ao vivo (Realtime), sem consultar
    // o banco de tempos em tempos.
    const onNotice = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      if (
        !d.table ||
        (d.table === "meeting_comments" && d.recording === recording.id)
      )
        void loadComments();
    };
    window.addEventListener("mavi:meetings", onNotice);
    return () => window.removeEventListener("mavi:meetings", onNotice);
  }, [loadComments, recording.id]);

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
  async function copyMoment() {
    const link = recordingLink(recording.id, time);
    try {
      await navigator.clipboard.writeText(link);
      notify(
        time > 0
          ? `Link copiado: abre em ${clock(time)}.`
          : "Link da gravação copiado.",
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
    {
      id: "comments",
      label: "Comentários",
      icon: MessageSquare,
      count: comments.length,
    },
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
            onClick={() => void copyMoment()}
            title="Copiar link que abre a gravação neste momento"
          >
            <Link2 size={15} /> Link {time > 0 ? `em ${clock(time)}` : ""}
          </button>
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
          {total > 0 && (comments.length > 0 || steps.length > 0) && (
            <div
              className="meeting-markers"
              aria-label="Comentários na linha do tempo"
            >
              <span
                className="meeting-markers-progress"
                style={{ width: `${Math.min(100, (time / total) * 100)}%` }}
              />
              {comments.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="meeting-marker"
                  style={{
                    left: `${Math.min(100, (c.at_seconds / total) * 100)}%`,
                  }}
                  title={`${clock(c.at_seconds)} · ${c.body}`}
                  aria-label={`Comentário em ${clock(c.at_seconds)}`}
                  onClick={() => seek(c.at_seconds)}
                />
              ))}
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
              <SummaryPanel recording={recording} transcript={transcript} />
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
            {tab === "comments" && (
              <CommentsPanel
                recording={recording}
                comments={comments}
                time={time}
                data={data}
                user={user}
                isLeader={isLeader}
                onSeek={seek}
                onChanged={loadComments}
              />
            )}
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
function SummaryPanel({
  recording,
  transcript,
}: {
  recording: MeetingRecording;
  transcript: MeetingTranscript | null | undefined;
}) {
  const s = recording.summary;
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
  if (!s.overview && !s.notes?.length && !talk.length)
    return <p className="muted centered">Esta reunião não tem resumo.</p>;
  return (
    <div className="meeting-summary">
      {s.overview && <p className="meeting-overview">{s.overview}</p>}
      {(s.keywords?.length || s.tone?.length) && (
        <div className="meeting-chips">
          {s.tone?.map((t) => (
            <span key={`t-${t}`} className="meeting-chip tone">
              {t}
            </span>
          ))}
          {s.keywords?.map((k) => (
            <span key={`k-${k}`} className="meeting-chip">
              {k}
            </span>
          ))}
        </div>
      )}
      {!!s.notes?.length && (
        <>
          <h4>Assuntos</h4>
          <ul className="meeting-notes">
            {s.notes.map((n, i) => (
              <li key={i}>
                <strong>{n.title}</strong>
                <p>{n.description}</p>
              </li>
            ))}
          </ul>
        </>
      )}
      {talk.length > 1 && (
        <>
          <h4>Tempo de fala</h4>
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
        </>
      )}
      {(recording.speakers.length > 0 || recording.attendees.length > 0) && (
        <>
          <h4>Participantes</h4>
          <p className="meeting-people">
            {[...recording.speakers, ...recording.attendees].join(" · ")}
          </p>
        </>
      )}
      <p className="meeting-ai-note">
        Resumo gerado automaticamente pela IA do gravador; confira na
        transcrição.
      </p>
    </div>
  );
}

// ------------------------------------------------------------ próximos passos
const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

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
      description:
        `<p>${escapeHtml(step.description)}</p>` +
        (step.owner
          ? `<p><strong>Responsável na reunião:</strong> ${escapeHtml(step.owner)}</p>`
          : "") +
        (step.deadline
          ? `<p><strong>Prazo combinado:</strong> ${escapeHtml(step.deadline)}</p>`
          : "") +
        `<p>Da reunião <a href="${escapeHtml(link)}">${escapeHtml(meetingTitle(recording))}</a> com ${escapeHtml(clientName)} em ${date}.</p>`,
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
/** Resposta da IA com momentos [12:34] e reuniões [R3] clicáveis. */
export function AnswerText({
  text,
  onTime,
  onRef,
}: {
  text: string;
  onTime?: (seconds: number) => void;
  onRef?: (index: number) => void;
}) {
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
      ) : (
        <button
          key={i}
          type="button"
          className="answer-cite ref"
          onClick={() => onRef?.(p.index)}
          disabled={!onRef}
        >
          {p.label}
        </button>
      ),
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
  return <div className="answer-text">{out}</div>;
}

export function ChatBox({
  placeholder,
  suggestions,
  ask,
  renderAnswer,
  intro,
}: {
  placeholder: string;
  suggestions: string[];
  ask: (question: string, history: ChatTurn[]) => Promise<string>;
  renderAnswer: (text: string) => ReactNode;
  intro: string;
}) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
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
      const answer = await ask(q, history);
      setTurns((t) => [...t, { role: "assistant", content: answer }]);
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
              {renderAnswer(t.content)}
            </div>
          ),
        )}
        {busy && (
          <div className="chat-a chat-thinking" role="status">
            <Sparkles size={14} /> Lendo e respondendo…
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

// ------------------------------------------------------------ comentários
function CommentsPanel({
  recording,
  comments,
  time,
  data,
  user,
  isLeader,
  onSeek,
  onChanged,
}: {
  recording: MeetingRecording;
  comments: MeetingComment[];
  time: number;
  data: Snapshot;
  user: string;
  isLeader: boolean;
  onSeek: (s: number) => void;
  onChanged: () => Promise<unknown>;
}) {
  const [draft, setDraft] = useState("");
  const [at, setAt] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const moment = at ?? time;
  const name = (id: string) =>
    data.members.find((m) => m.user_id === id)?.name ?? "Alguém";
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setBusy("new");
    setError("");
    try {
      await addMeetingComment(recording.id, moment, draft.trim());
      setDraft("");
      setAt(null);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function remove(c: MeetingComment) {
    if (!window.confirm("Excluir este comentário?")) return;
    setBusy(c.id);
    try {
      await deleteMeetingComment(c.id);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="meeting-comments">
      <form className="meeting-comment-form" onSubmit={save}>
        <textarea
          rows={2}
          value={draft}
          maxLength={4000}
          placeholder={`Comentar em ${clock(moment)}`}
          aria-label="Novo comentário"
          // O momento fica preso enquanto a pessoa escreve.
          onFocus={() => at === null && setAt(time)}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div>
          <small>
            No momento <strong>{clock(moment)}</strong>
            {at !== null && (
              <button
                type="button"
                className="text-btn"
                onClick={() => setAt(time)}
              >
                usar o momento atual
              </button>
            )}
          </small>
          <button
            type="submit"
            className="btn primary"
            disabled={!draft.trim() || busy === "new"}
          >
            Comentar
          </button>
        </div>
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {comments.length ? (
        <ul>
          {comments.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="transcript-time"
                onClick={() => onSeek(c.at_seconds)}
              >
                {clock(c.at_seconds)}
              </button>
              <div>
                <small>
                  <strong>{name(c.author_id)}</strong> ·{" "}
                  {new Date(c.created_at).toLocaleDateString("pt-BR")}
                </small>
                <p>{c.body}</p>
              </div>
              {(c.author_id === user || isLeader) && (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Excluir comentário"
                  disabled={busy === c.id}
                  onClick={() => void remove(c)}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted centered">
          Nenhum comentário ainda. Pause no ponto que importa e comente para o
          time.
        </p>
      )}
    </div>
  );
}
