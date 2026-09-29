import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  CircleCheck,
  ClipboardPaste,
  FileText,
  LoaderCircle,
  Sparkles,
  Video,
} from "lucide-react";
import { Modal } from "./components";
import { Button, Checkbox, Textarea } from "./ui";
import {
  briefingSteps,
  campaignObjectives,
  defaultBriefingChoice,
  formatUsd,
  transcriptFromFile,
  type BriefingFields,
  type BriefingKey,
  type BriefingSuggestion,
  type CampaignObjective,
} from "./social-leads";
import type { MeetingOption, SocialLeadsBackend } from "./social-leads-api";

/** Same limit as the server (api/_social-leads.ts, BRIEFING_MAX_CHARS). */
const MAX_CHARS = 200_000;
const labels = Object.fromEntries(
  briefingSteps.flatMap((s) => s.fields).map((f) => [f.key, f.label]),
) as Record<BriefingKey, string>;
const order = briefingSteps.flatMap((s) => s.fields.map((f) => f.key));
const minutes = (s: number | null) =>
  s ? `${Math.max(1, Math.round(s / 60))} min` : "";
const stepOf = Object.fromEntries(
  briefingSteps.flatMap((st) => st.fields.map((f) => [f.key, st.title])),
) as Record<BriefingKey, string>;
const clock = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * What the MAVI is doing while it reads: the material in numbers, then the
 * stages of the reading, the time so far and about how long it takes. The
 * reading is one call to the server; the stages advance with the expected
 * time (longer material, longer reading) and the last one waits for the
 * answer, so nothing claims to be done before it is.
 */
function ReadingProgress({
  what,
  size,
  expected,
  onCancel,
}: {
  what: string;
  size: string;
  /** Seconds the reading usually takes for this material. */
  expected: number;
  onCancel: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const start = useRef(Date.now());
  useEffect(() => {
    const t = window.setInterval(
      () => setElapsed((Date.now() - start.current) / 1000),
      250,
    );
    return () => window.clearInterval(t);
  }, []);
  const stages = [
    "Recebendo o material",
    "Lendo a conversa e separando o que o cliente disse",
    "Encontrando negócio, oferta, público e concorrentes",
    "Preenchendo os campos do briefing",
    "Conferindo de qual trecho veio cada campo",
  ];
  // Each stage takes its share of the expected time; the last one waits.
  const share = [0.06, 0.34, 0.3, 0.2];
  let acc = 0;
  let current = stages.length - 1;
  for (let i = 0; i < share.length; i++) {
    acc += share[i] * expected;
    if (elapsed < acc) {
      current = i;
      break;
    }
  }
  // Up to 92% by the expected time, then slowly toward 99%.
  const pct =
    elapsed <= expected
      ? (elapsed / expected) * 92
      : 92 + 7 * (1 - Math.exp(-(elapsed - expected) / 40));
  return (
    <div className="sl-ai-reading" role="status" aria-live="polite">
      <div className="sl-ai-reading-head">
        <span className="sl-ai-orb" aria-hidden="true">
          <Sparkles size={20} />
        </span>
        <span>
          <strong>A MAVI está lendo {what}</strong>
          <small>{size}</small>
        </span>
      </div>
      <div className="sl-ai-reading-bar" aria-hidden="true">
        <i style={{ width: `${Math.min(99, pct)}%` }} />
      </div>
      <ol className="sl-ai-stages">
        {stages.map((label, i) => (
          <li
            key={label}
            className={i < current ? "done" : i === current ? "current" : ""}
          >
            {i < current ? (
              <CircleCheck size={16} />
            ) : i === current ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <span className="sl-ai-dot" />
            )}
            {label}
          </li>
        ))}
      </ol>
      <p className="sl-ai-reading-foot">
        <span>
          {clock(elapsed)} · costuma levar cerca de {Math.round(expected)} s
        </span>
        {elapsed > expected * 1.15 && (
          <em>Material longo: a MAVI ainda está lendo, falta pouco.</em>
        )}
      </p>
      <div className="form-footer">
        <Button type="button" className="btn secondary" onClick={onCancel}>
          Cancelar a leitura
        </Button>
      </div>
    </div>
  );
}

/**
 * "Preencher com a IA": notes or a transcript (pasted, or from a .txt/.vtt/
 * .srt file) or a meeting of the client in "Gravações da MAVI" become
 * briefing fields. Nothing goes in without the team: each field shows what
 * the AI read, the passage it came from and what is there today; by default
 * only the empty fields are ticked.
 */
export function BriefingAiModal({
  company,
  contract,
  backend,
  current,
  currentObjective,
  onApply,
  onClose,
}: {
  company: string;
  contract: string;
  backend: SocialLeadsBackend;
  current: BriefingFields;
  currentObjective: CampaignObjective | null;
  onApply: (
    fields: BriefingFields,
    objective: CampaignObjective | null,
    count: number,
  ) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"text" | "meeting">("text");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [meetings, setMeetings] = useState<MeetingOption[] | null>(null);
  const [recording, setRecording] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<BriefingSuggestion | null>(null);
  const [values, setValues] = useState<BriefingFields>({});
  const [chosen, setChosen] = useState<Set<BriefingKey>>(new Set());
  const [useObjective, setUseObjective] = useState(false);
  // The reading in progress (a canceled one is ignored when it answers).
  const reading = useRef(0);

  useEffect(() => {
    let alive = true;
    void backend.meetings(company, contract).then((list) => {
      if (!alive) return;
      setMeetings(list);
      const first = list.find((m) => m.has_transcript);
      if (first) setRecording(first.id);
    });
    return () => {
      alive = false;
    };
  }, [backend, company, contract]);

  const read = () => {
    const mine = ++reading.current;
    setBusy(true);
    setError("");
    backend
      .readBriefing(
        company,
        contract,
        tab === "meeting" ? { recording } : { text },
      )
      .then((r) => {
        if (reading.current !== mine) return;
        setResult(r);
        setValues(r.fields);
        setChosen(new Set(defaultBriefingChoice(current, r.fields)));
        setUseObjective(!!r.objective && !currentObjective);
      })
      .catch((e) => reading.current === mine && setError((e as Error).message))
      .finally(() => reading.current === mine && setBusy(false));
  };
  const cancel = () => {
    reading.current++;
    setBusy(false);
  };
  const meeting = meetings?.find((m) => m.id === recording);
  // About how long the reading takes: the model reads ~4 thousand
  // characters a second of wall time, plus the answer (a meeting's
  // transcript is ~900 characters a minute).
  const chars =
    tab === "meeting" ? (meeting?.duration_seconds ?? 1800) * 15 : text.length;
  const expected = Math.min(110, Math.max(18, 14 + chars / 4000));
  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    if (
      !/\.(txt|md|vtt|srt|csv)$/i.test(file.name) &&
      !file.type.startsWith("text/")
    ) {
      setError("Envie um arquivo de texto: .txt, .md, .vtt ou .srt.");
      return;
    }
    setError("");
    setFileName(file.name);
    setText(transcriptFromFile(file.name, await file.text()));
  };

  const rows = useMemo(
    () =>
      result
        ? order.filter(
            (k) =>
              result.fields[k] &&
              result.fields[k]!.trim() !== (current[k] ?? "").trim(),
          )
        : [],
    [result, current],
  );
  const same = result
    ? order.filter(
        (k) =>
          result.fields[k] &&
          result.fields[k]!.trim() === (current[k] ?? "").trim(),
      ).length
    : 0;
  const objectiveChanges =
    !!result?.objective && result.objective !== currentObjective;
  const count =
    rows.filter((k) => chosen.has(k)).length +
    (objectiveChanges && useObjective ? 1 : 0);
  const fresh = rows.filter((k) => !current[k]?.trim()).length;

  return (
    <Modal
      title="Preencher o briefing com a MAVI"
      onClose={() => !busy && onClose()}
      busy={busy}
      className="sl-ai-dialog"
    >
      {busy ? (
        <ReadingProgress
          what={
            tab === "meeting"
              ? `a reunião “${meeting?.title || "com o cliente"}”`
              : fileName
                ? `o arquivo ${fileName}`
                : "o material colado"
          }
          size={
            tab === "meeting"
              ? [
                  meeting?.duration_seconds
                    ? `${minutes(meeting.duration_seconds)} de reunião`
                    : "",
                  meeting?.speakers?.length
                    ? `${meeting.speakers.length} ${meeting.speakers.length === 1 ? "pessoa" : "pessoas"} falando`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" · ") || "Transcrição da gravação"
              : `${text.length.toLocaleString("pt-BR")} caracteres · cerca de ${Math.max(1, Math.round(text.split(/\s+/).length / 150))} min de conversa`
          }
          expected={expected}
          onCancel={cancel}
        />
      ) : !result ? (
        <div className="sl-ai-fill-modal">
          <p className="sl-muted">
            A MAVI lê o que o cliente disse e sugere os campos. Você escolhe o
            que entra; nada é salvo sem a sua revisão.
          </p>
          <div className="sl-ai-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "text"}
              className={tab === "text" ? "selected" : ""}
              onClick={() => setTab("text")}
            >
              <ClipboardPaste size={15} /> Notas ou transcrição
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "meeting"}
              className={tab === "meeting" ? "selected" : ""}
              onClick={() => setTab("meeting")}
            >
              <Video size={15} /> Gravações da MAVI
              {!!meetings?.length && <small>{meetings.length}</small>}
            </button>
          </div>
          {tab === "text" ? (
            <div className="sl-ai-source">
              <Textarea
                rows={11}
                value={text}
                maxLength={MAX_CHARS}
                autoFocus
                aria-label="Notas ou transcrição"
                placeholder="Cole aqui as notas da reunião, a transcrição ou a conversa com o cliente."
                onChange={(e) => {
                  setText(e.target.value);
                  setFileName("");
                }}
              />
              <div className="sl-ai-source-foot">
                <label className="btn secondary sl-ai-file">
                  <FileText size={15} /> Enviar arquivo
                  <input
                    type="file"
                    accept=".txt,.md,.vtt,.srt,.csv,text/plain"
                    onChange={(e) => {
                      void loadFile(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
                <small>
                  {fileName ? `${fileName} · ` : ""}
                  {text.length.toLocaleString("pt-BR")} de{" "}
                  {MAX_CHARS.toLocaleString("pt-BR")} caracteres · .txt, .md,
                  .vtt ou .srt
                </small>
              </div>
            </div>
          ) : meetings === null ? (
            <p className="sl-muted">Procurando as reuniões do cliente…</p>
          ) : meetings.length ? (
            <ul className="sl-ai-meetings" role="radiogroup">
              {meetings.map((m) => (
                <li key={m.id}>
                  <label
                    className={`${recording === m.id ? "selected" : ""} ${m.has_transcript ? "" : "disabled"}`}
                  >
                    <input
                      type="radio"
                      name="recording"
                      checked={recording === m.id}
                      disabled={!m.has_transcript}
                      onChange={() => setRecording(m.id)}
                    />
                    <span>
                      <strong>
                        {m.title ||
                          `Reunião de ${new Date(m.recorded_at).toLocaleDateString("pt-BR")}`}
                      </strong>
                      <small>
                        {new Date(m.recorded_at).toLocaleDateString("pt-BR", {
                          day: "2-digit",
                          month: "2-digit",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                        {m.duration_seconds
                          ? ` · ${minutes(m.duration_seconds)}`
                          : ""}
                        {m.speakers?.length
                          ? ` · ${m.speakers.slice(0, 3).join(", ")}${m.speakers.length > 3 ? ` e mais ${m.speakers.length - 3}` : ""}`
                          : ""}
                      </small>
                      {m.overview && <em>{m.overview}</em>}
                      {!m.has_transcript && (
                        <small className="sl-ai-warn">
                          Ainda sem transcrição
                        </small>
                      )}
                      {m.has_transcript &&
                        m.duration_seconds !== null &&
                        m.duration_seconds < 120 && (
                          <small className="sl-ai-warn">
                            Reunião muito curta: pode ter pouco conteúdo
                          </small>
                        )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sl-muted">
              Nenhuma reunião deste cliente em Drive › Gravações da MAVI. Quando
              o gravador entrar numa reunião com ele, ela aparece aqui.
            </p>
          )}
          {error && <p className="sl-alert bad">{error}</p>}
          <div className="form-footer">
            <Button type="button" className="btn secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button
              className="btn primary"
              loading={busy}
              disabled={tab === "meeting" ? !recording : !text.trim()}
              onClick={read}
            >
              <Sparkles size={15} /> {busy ? "Lendo…" : "Ler com a MAVI"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="sl-ai-fill-modal">
          <p className="sl-ai-summary">
            <Sparkles size={15} />
            <span>
              <strong>{result.source}</strong>
              {result.summary && ` · ${result.summary}`}
              <small>Custo da MAVI: {formatUsd(result.cost_usd)}</small>
            </span>
          </p>
          <ul className="sl-ai-tally" aria-label="O que a MAVI encontrou">
            <li className="new">
              <strong>{fresh}</strong>
              {fresh === 1
                ? "campo vazio preenchido"
                : "campos vazios preenchidos"}
            </li>
            <li className="swap">
              <strong>{rows.length - fresh}</strong>
              {rows.length - fresh === 1
                ? "sugestão para o que já está"
                : "sugestões para o que já está"}
            </li>
            <li>
              <strong>{same}</strong>
              {same === 1 ? "já estava igual" : "já estavam iguais"}
            </li>
            <li className="ask">
              <strong>{result.missing.length}</strong>
              para perguntar ao cliente
            </li>
          </ul>
          {rows.length > 1 && (
            <div className="sl-ai-bulk">
              <button
                type="button"
                className="sl-link"
                onClick={() => setChosen(new Set(rows))}
              >
                Marcar todos
              </button>
              <button
                type="button"
                className="sl-link"
                onClick={() =>
                  setChosen(new Set(rows.filter((k) => !current[k]?.trim())))
                }
              >
                Só os vazios
              </button>
              <button
                type="button"
                className="sl-link"
                onClick={() => setChosen(new Set())}
              >
                Nenhum
              </button>
              <small>
                Você pode editar cada texto aqui e, depois de aplicar, em
                qualquer passo do briefing.
              </small>
            </div>
          )}
          {rows.length || objectiveChanges ? (
            <ul className="sl-ai-review">
              {objectiveChanges && (
                <li className={useObjective ? "on" : ""}>
                  <label className="sl-ai-check">
                    <Checkbox
                      checked={useObjective}
                      onCheckedChange={(v) => setUseObjective(v === true)}
                    />
                    <strong>Objetivo da campanha</strong>
                  </label>
                  <p className="sl-ai-value">
                    {campaignObjectives[result.objective!]}
                  </p>
                  {currentObjective && (
                    <small className="sl-ai-now">
                      Hoje: {campaignObjectives[currentObjective]}
                    </small>
                  )}
                </li>
              )}
              {rows.map((k) => (
                <li key={k} className={chosen.has(k) ? "on" : ""}>
                  <label className="sl-ai-check">
                    <Checkbox
                      checked={chosen.has(k)}
                      onCheckedChange={(v) =>
                        setChosen((c) => {
                          const next = new Set(c);
                          if (v === true) next.add(k);
                          else next.delete(k);
                          return next;
                        })
                      }
                    />
                    <strong>{labels[k]}</strong>
                    <small className="sl-ai-step">{stepOf[k]}</small>
                    {current[k]?.trim() ? (
                      <em>substitui o que já está</em>
                    ) : (
                      <em className="new">campo vazio</em>
                    )}
                  </label>
                  <Textarea
                    rows={Math.min(
                      4,
                      Math.ceil((values[k]?.length ?? 0) / 80) || 1,
                    )}
                    value={values[k] ?? ""}
                    aria-label={labels[k]}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [k]: e.target.value }))
                    }
                  />
                  {result.evidence[k] && (
                    <blockquote>“{result.evidence[k]}”</blockquote>
                  )}
                  {current[k]?.trim() && (
                    <small className="sl-ai-now">Hoje: {current[k]}</small>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="sl-alert info-soft">
              A MAVI não encontrou nada novo para o briefing neste material.
            </p>
          )}
          {!!result.missing.length && (
            <p className="sl-ai-missing">
              <strong>Perguntar ao cliente:</strong>{" "}
              {result.missing.map((k) => labels[k]).join(", ")}.
            </p>
          )}
          <div className="form-footer">
            <Button
              type="button"
              className="btn secondary"
              onClick={() => setResult(null)}
            >
              <ArrowLeft size={15} /> Ler outro material
            </Button>
            <Button
              className="btn primary"
              disabled={!count}
              onClick={() => {
                const fields: BriefingFields = {};
                for (const k of rows)
                  if (chosen.has(k) && values[k]?.trim())
                    fields[k] = values[k]!.trim();
                onApply(
                  fields,
                  objectiveChanges && useObjective ? result.objective : null,
                  count,
                );
              }}
            >
              <Check size={15} /> Aplicar {count}{" "}
              {count === 1 ? "campo" : "campos"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
