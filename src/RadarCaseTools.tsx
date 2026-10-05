import { Suspense, lazy, useState } from "react";
import { BotMessageSquare, CheckCircle2, ExternalLink, Trash2 } from "lucide-react";
import { Button, Textarea } from "./ui";
import {
  AGENT_STATUS_LABEL,
  REMOVE_LABEL,
  REMOVE_UNDOES_TEMPERATURE,
  type AgentCheck,
  type RemoveReason,
} from "./agent-check";
import "./radar-case.css";

/**
 * O que os dois Radares mostram em cada caso (migration
 * 20270512090000_radar_agents_learning): a conferência com a base do Agente
 * Conversacional do cliente — com o trecho do prompt e o ajuste sugerido,
 * que abre o editor do prompt para revisar e publicar — e a exclusão do caso.
 */

const AgentPromptSheet = lazy(() => import("./AgentsPage").then((m) => ({ default: m.AgentPromptSheet })));

export function AgentCheckCard({
  check,
  notify,
}: {
  check: AgentCheck;
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState<{ prompt: string; suggest: boolean } | null>(null);
  const s = check.suggestion;
  return (
    <section className={`radar-agent status-${check.status}`} aria-label="Agente Conversacional">
      <header>
        <BotMessageSquare size={15} aria-hidden="true" />
        <strong>{AGENT_STATUS_LABEL[check.status]}</strong>
        <span className="muted">· base do Agente Conversacional</span>
      </header>
      {check.note && <p>{check.note}</p>}
      {!!check.evidence?.length && (
        <ul className="radar-agent-evidence">
          {check.evidence.map((e, i) => (
            <li key={i}>
              <q>{e.excerpt}</q>
              <button type="button" className="radar-agent-link" onClick={() => setOpen({ prompt: e.prompt_id, suggest: false })}>
                {e.workflow} › {e.node} <ExternalLink size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {s && (
        <div className="radar-agent-suggestion">
          <span className="muted">Ajuste sugerido no prompt{s.why ? ` — ${s.why}` : ""}</span>
          {s.before && (
            <p className="del">
              <q>{s.before}</q>
            </p>
          )}
          <p className="add">
            <q>{s.after}</q>
          </p>
          <Button className="btn secondary compact" onClick={() => setOpen({ prompt: s.prompt_id, suggest: true })}>
            Revisar e publicar no robô
          </Button>
        </div>
      )}
      {check.done && (
        <p className="radar-agent-done">
          <CheckCircle2 size={13} aria-hidden="true" /> Fechado pela MAVI: o robô já estava assim, não havia mais nada a fazer.
        </p>
      )}
      {open && (
        <Suspense fallback={null}>
          <AgentPromptSheet
            promptId={open.prompt}
            onClose={() => setOpen(null)}
            notify={notify}
            suggestion={open.suggest && s ? { before: s.before, after: s.after, why: s.why } : undefined}
          />
        </Suspense>
      )}
    </section>
  );
}

/** Excluir um caso: o motivo (e o que ele faz com o Termômetro). */
export function RemoveCaseForm({
  name,
  scope,
  onConfirm,
  onCancel,
}: {
  name: string;
  /** Quem deixa de ver o caso. */
  scope: string;
  onConfirm: (reason: RemoveReason, note: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState<RemoveReason>("mavi_error");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const undo = REMOVE_UNDOES_TEMPERATURE.includes(reason);
  return (
    <div className="radar-remove" role="group" aria-label={`Excluir ${name}`}>
      <fieldset>
        <legend>Por que excluir? {scope}</legend>
        {(Object.keys(REMOVE_LABEL) as RemoveReason[]).map((r) => (
          <label key={r}>
            <input type="radio" name={`remove-${name}`} checked={reason === r} onChange={() => setReason(r)} />
            {REMOVE_LABEL[r]}
          </label>
        ))}
      </fieldset>
      <p className="muted">
        {undo
          ? "O Termômetro do cliente lê de novo a conversa sem as falas deste caso, e a MAVI aprende a não anotar algo assim."
          : "O Termômetro não muda."}
      </p>
      <Textarea
        rows={2}
        maxLength={1000}
        value={note}
        placeholder={reason === "other" ? "Conte o motivo (obrigatório)." : "Se quiser, explique para a MAVI (opcional)."}
        onChange={(e) => setNote(e.target.value)}
      />
      {error && <p className="form-error">{error}</p>}
      <div className="radar-remove-actions">
        <Button
          className="btn danger compact"
          loading={busy}
          disabled={reason === "other" && !note.trim()}
          onClick={() => {
            setBusy(true);
            setError("");
            onConfirm(reason, note.trim())
              .catch((e) => setError((e as Error).message))
              .finally(() => setBusy(false));
          }}
        >
          <Trash2 size={14} aria-hidden="true" /> Excluir caso
        </Button>
        <Button className="btn secondary compact" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}
