import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  ClipboardPaste,
  FileText,
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
    setBusy(true);
    setError("");
    backend
      .readBriefing(
        company,
        contract,
        tab === "meeting" ? { recording } : { text },
      )
      .then((r) => {
        setResult(r);
        setValues(r.fields);
        setChosen(new Set(defaultBriefingChoice(current, r.fields)));
        setUseObjective(!!r.objective && !currentObjective);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };
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

  return (
    <Modal
      title="Preencher o briefing com a IA"
      onClose={() => !busy && onClose()}
      busy={busy}
      className="sl-ai-dialog"
    >
      {!result ? (
        <div className="sl-ai-fill-modal">
          <p className="sl-muted">
            A IA lê o que o cliente disse e sugere os campos. Você escolhe o que
            entra; nada é salvo sem a sua revisão.
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
              <Sparkles size={15} /> {busy ? "Lendo…" : "Ler com a IA"}
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
              <small>Custo da IA: {formatUsd(result.cost_usd)}</small>
            </span>
          </p>
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
              A IA não encontrou nada novo para o briefing neste material.
            </p>
          )}
          {same > 0 && (
            <p className="sl-muted">
              {same} {same === 1 ? "campo já estava" : "campos já estavam"}{" "}
              igual ao que a IA leu.
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
