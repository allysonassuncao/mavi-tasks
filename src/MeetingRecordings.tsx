import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, Search, Sparkles, X } from "lucide-react";
import { Input, Loading, Select, SelectOption } from "./ui";
import { Empty } from "./components";
import { Paged } from "./Pagination";
import { fold } from "./task-search";
import { dateKey } from "./domain";
import { askAi, openAiSource } from "./ai";
import type { Snapshot } from "./types";
import type { FormPreset } from "./forms";
import { MeetingPlayer } from "./MeetingPlayer";
import { AiChat, AnswerText } from "./AiChat";
import {
  clock,
  durationLabel,
  listMeetingRecordings,
  meetingKind,
  meetingTitle,
  searchMeetingSegments,
  type MeetingHit,
  type MeetingRecording,
} from "./meetings";

const CLIENT_SUGGESTIONS = [
  "O que já foi prometido ou combinado com este cliente?",
  "Quais problemas e reclamações apareceram ao longo das reuniões?",
  "Como evoluíram as metas e a verba do cliente?",
  "Qual foi o último próximo passo combinado?",
];

type Props = {
  company: string;
  client: string;
  clientName: string;
  data: Snapshot;
  user: string;
  isLeader: boolean;
  notify: (message: string) => void;
  onNewTask?: (preset: FormPreset) => void;
  /** Link de um momento: abre esta gravação já no ponto. */
  initial?: { recording: string; start?: number } | null;
};

/**
 * Drive › cliente › Gravações da MAVI: as reuniões do cliente, a busca nas
 * transcrições (com o minuto de cada trecho) e a IA sobre o histórico todo.
 */
export function MeetingRecordings({
  company,
  client,
  clientName,
  data,
  user,
  isLeader,
  notify,
  onNewTask,
  initial,
}: Props) {
  const [list, setList] = useState<MeetingRecording[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [who, setWho] = useState("all");
  const [kind, setKind] = useState("all");
  // Período escolhido pela pessoa (aaaa-mm-dd; vazio: sem limite).
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [hits, setHits] = useState<MeetingHit[] | null>(null);
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState<{
    recording: MeetingRecording;
    start?: number;
  } | null>(null);

  const load = useCallback(
    () =>
      listMeetingRecordings(company, client)
        .then(setList)
        .catch((e) => setError((e as Error).message)),
    [company, client],
  );
  useEffect(() => {
    setList(null);
    void load();
    // Gravações novas do cliente chegam ao vivo (o gravador grava direto no banco).
    const onNotice = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      if (!d.table || (d.table === "meeting_recordings" && d.client === client))
        void load();
    };
    window.addEventListener("mavi:meetings", onNotice);
    return () => window.removeEventListener("mavi:meetings", onNotice);
  }, [load, client]);

  // O link de um momento abre a gravação assim que a lista chega.
  useEffect(() => {
    if (!initial || !list) return;
    const r = list.find((x) => x.id === initial.recording);
    if (r) setOpen({ recording: r, start: initial.start });
    else setError("Gravação não encontrada ou sem acesso.");
  }, [initial, list]);

  // Busca nas transcrições (o banco devolve o trecho e o minuto).
  const text = query.trim();
  useEffect(() => {
    if (text.length < 3) {
      setHits(null);
      return;
    }
    setHits(null);
    const id = setTimeout(() => {
      searchMeetingSegments(company, client, text)
        .then(setHits)
        .catch((e) => setError((e as Error).message));
    }, 350);
    return () => clearTimeout(id);
  }, [company, client, text]);

  const memberName = useCallback(
    (email: string) =>
      data.members.find((m) => m.email?.toLowerCase() === email)?.name ??
      email.split("@")[0],
    [data.members],
  );
  const people = useMemo(
    () =>
      [...new Set((list ?? []).map((r) => r.recorded_by_email))]
        .map((email) => ({ email, name: memberName(email) }))
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [list, memberName],
  );
  const kinds = useMemo(
    () => [...new Set((list ?? []).map((r) => meetingKind(r.title)))].sort(),
    [list],
  );
  const folded = fold(text);
  const shown = useMemo(() => {
    return (list ?? []).filter(
      (r) =>
        (who === "all" || r.recorded_by_email === who) &&
        (kind === "all" || meetingKind(r.title) === kind) &&
        (!from || dateKey(new Date(r.recorded_at)) >= from) &&
        (!to || dateKey(new Date(r.recorded_at)) <= to) &&
        (!folded ||
          fold(
            [
              meetingTitle(r),
              r.title,
              ...(r.summary.keywords ?? []),
              ...r.speakers,
            ].join(" "),
          ).includes(folded)),
    );
  }, [list, who, kind, from, to, folded]);
  const byId = useMemo(
    () => new Map((list ?? []).map((r) => [r.id, r])),
    [list],
  );
  const hitGroups = useMemo(() => {
    const groups = new Map<string, MeetingHit[]>();
    for (const h of hits ?? []) {
      if (!byId.has(h.recording_id)) continue;
      groups.set(h.recording_id, [...(groups.get(h.recording_id) ?? []), h]);
    }
    return [...groups];
  }, [hits, byId]);

  const filtering = who !== "all" || kind !== "all" || !!from || !!to;
  const date = (iso: string) =>
    new Date(iso).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });

  if (error && !list)
    return (
      <p className="form-error" role="alert">
        {error}
      </p>
    );
  if (!list) return <Loading compact />;
  if (!list.length)
    return (
      <div className="panel drive-empty">
        <Empty
          title="Nenhuma gravação deste cliente"
          body="As reuniões gravadas e transcritas pela MAVI aparecem aqui automaticamente."
        />
      </div>
    );

  return (
    <div className="meetings">
      <div className="meetings-toolbar">
        <span className="drive-search">
          <Input
            type="search"
            aria-label="Buscar nas gravações"
            placeholder="Buscar por título, assunto ou algo dito na reunião"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            icon={Search}
          />
        </span>
        <Select aria-label="Quem gravou" value={who} onValueChange={setWho}>
          <SelectOption value="all">Todas as pessoas</SelectOption>
          {people.map((p) => (
            <SelectOption key={p.email} value={p.email}>
              {p.name}
            </SelectOption>
          ))}
        </Select>
        <Select
          aria-label="Tipo de reunião"
          value={kind}
          onValueChange={setKind}
        >
          <SelectOption value="all">Todos os tipos</SelectOption>
          {kinds.map((k) => (
            <SelectOption key={k} value={k}>
              {k}
            </SelectOption>
          ))}
        </Select>
        <div className="meetings-period" role="group" aria-label="Período">
          <label>
            De
            <Input
              type="date"
              aria-label="Gravadas a partir de"
              placeholder="dd/mm/aaaa"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            Até
            <Input
              type="date"
              aria-label="Gravadas até"
              placeholder="dd/mm/aaaa"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          {(from || to) && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Limpar período"
              title="Limpar período"
              onClick={() => {
                setFrom("");
                setTo("");
              }}
            >
              <X size={15} />
            </button>
          )}
        </div>
        <button
          type="button"
          className={`btn ${asking ? "primary" : "secondary"}`}
          onClick={() => setAsking((v) => !v)}
        >
          <Sparkles size={15} /> Perguntar ao histórico
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {asking && (
        <section
          className="panel meetings-ask"
          aria-label="Perguntar à IA sobre todas as reuniões"
        >
          <header>
            <strong>
              <Sparkles size={15} /> IA sobre o histórico de {clientName}
            </strong>
            <button
              type="button"
              className="icon-btn"
              aria-label="Fechar"
              onClick={() => setAsking(false)}
            >
              <X size={15} />
            </button>
          </header>
          <ClientChat
            company={company}
            client={client}
            onOpen={(id, start) => {
              const r = byId.get(id);
              if (r) setOpen({ recording: r, start });
            }}
          />
        </section>
      )}

      {text.length >= 3 && (
        <section
          className="meetings-hits"
          aria-label="Trechos encontrados nas transcrições"
        >
          <h3>Ditos nas reuniões</h3>
          {hits === null ? (
            <Loading compact />
          ) : hitGroups.length ? (
            <ul>
              {hitGroups.slice(0, 20).map(([id, list]) => {
                const r = byId.get(id)!;
                return (
                  <li key={id} className="panel">
                    <button
                      type="button"
                      className="meetings-hit-title"
                      onClick={() => setOpen({ recording: r })}
                    >
                      <strong>{meetingTitle(r)}</strong>
                      <small>{date(r.recorded_at)}</small>
                    </button>
                    {list.slice(0, 4).map((h, i) => (
                      <button
                        key={i}
                        type="button"
                        className="meetings-hit"
                        onClick={() =>
                          setOpen({
                            recording: r,
                            start: h.start_seconds ?? undefined,
                          })
                        }
                      >
                        {h.start_seconds != null && (
                          <span className="transcript-time">
                            {clock(h.start_seconds)}
                          </span>
                        )}
                        <span>{h.text}</span>
                      </button>
                    ))}
                    {list.length > 4 && (
                      <small className="muted">
                        + {list.length - 4} trechos nesta reunião
                      </small>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">
              Nada dito com esses termos nas transcrições.
            </p>
          )}
          <h3>Reuniões</h3>
        </section>
      )}

      {shown.length ? (
        <Paged
          items={shown}
          pageSize={30}
          noun="gravações"
          resetKey={[query, who, kind, from, to].join("|")}
        >
          {(page) => (
            <ul className="meetings-list">
              {page.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className="panel meeting-row"
                    onClick={() => setOpen({ recording: r })}
                  >
                    <DateBadge iso={r.recorded_at} />
                    <span className="meeting-row-main">
                      <span className="meeting-row-top">
                        <strong>{meetingTitle(r)}</strong>
                        <span className="meeting-kind">
                          {meetingKind(r.title)}
                        </span>
                      </span>
                      {r.summary.overview && (
                        <span className="meeting-row-overview">
                          {r.summary.overview}
                        </span>
                      )}
                      <small>
                        {weekdayTime(r.recorded_at)} ·{" "}
                        {memberName(r.recorded_by_email)}
                        {r.duration_seconds ? (
                          <>
                            {" · "}
                            <Clock size={11} aria-hidden="true" />{" "}
                            {durationLabel(r.duration_seconds)}
                          </>
                        ) : null}
                        {!r.video_type && " · só transcrição"}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Paged>
      ) : (
        <div className="panel drive-empty">
          <Empty
            title="Nenhuma gravação com esses filtros"
            body={
              filtering
                ? "Mude os filtros para ver outras reuniões."
                : "Tente outros termos."
            }
          />
        </div>
      )}

      {open && (
        <MeetingPlayer
          key={open.recording.id}
          recording={open.recording}
          start={open.start}
          data={data}
          user={user}
          clientName={clientName}
          notify={notify}
          onNewTask={onNewTask}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function ClientChat({
  company,
  client,
  onOpen,
}: {
  company: string;
  client: string;
  onOpen: (id: string, start?: number) => void;
}) {
  // A conversa fica salva (aparece também no histórico do assistente).
  const conversation = useRef<string | null>(null);
  return (
    <AiChat
      intro="A IA busca nas transcrições e nos resumos de todas as reuniões deste cliente (e nas tarefas dele) e mostra de onde tirou cada informação. Clique na fonte para abrir a gravação no minuto ou a tarefa."
      placeholder="Pergunte sobre o histórico deste cliente"
      suggestions={CLIENT_SUGGESTIONS}
      send={(q, _history, handlers) =>
        askAi(
          company,
          { client, module: "meetings" },
          q,
          conversation.current,
          handlers,
        )
      }
      onAnswer={(a) => (conversation.current = a.conversation)}
      renderAnswer={(text, sources) => (
        <AnswerText
          text={text}
          sources={sources}
          onSource={(s) =>
            s.type === "meeting" ? onOpen(s.id, s.start) : openAiSource(s)
          }
        />
      )}
    />
  );
}

/** Dia e mês da gravação (o ano só quando não é o atual). */
function DateBadge({ iso }: { iso: string }) {
  const d = new Date(iso);
  const part = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      ...o,
    }).format(d);
  const year = part({ year: "numeric" });
  return (
    <span
      className="meeting-date"
      aria-label={part({ day: "numeric", month: "long", year: "numeric" })}
    >
      <strong>{part({ day: "2-digit" })}</strong>
      <span>{part({ month: "short" }).replace(".", "")}</span>
      {year !== String(new Date().getFullYear()) && <small>{year}</small>}
    </span>
  );
}

/** "ter, 14:00". */
function weekdayTime(iso: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date(iso))
    .replace(".", "");
}
