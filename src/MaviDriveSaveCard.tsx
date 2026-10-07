import { useState } from "react";
import { ExternalLink, HardDriveUpload, Loader2, Sparkles, X } from "lucide-react";
import { setActionState } from "./ai";
import { StateChip } from "./MaviCampaignAlertCard";
import { driveUrl, routeParts } from "./router";
import type { ActionArtifact, ActionProposal } from "./mavi-artifacts";
import type { ArtifactHost } from "./MaviArtifacts";

/**
 * O documento que a MAVI propôs salvar no Drive: o botão abre o documento
 * com a janela do Drive já no formato e no lugar que ela achou; a pessoa
 * confere (pode trocar) e salva. Quando salva, o cartão fica confirmado.
 */
const FORMAT: Record<string, string> = {
  pdf: "PDF",
  docx: "Word",
  pptx: "PowerPoint",
  html: "Página (.html)",
  md: "Markdown",
  xlsx: "Excel",
  csv: "CSV",
};

export function DriveSaveCard({ artifact, host }: { artifact: ActionArtifact; host: ArtifactHost }) {
  const a = artifact.action as Extract<ActionProposal, { kind: "drive_save" }>;
  const [state, setState] = useState(artifact.state);
  const [result, setResult] = useState(artifact.result);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const waiting = host.streaming || !host.conversation;
  const where = [a.client_name, a.contract_name, a.folder_name].filter(Boolean).join(" › ") || "Drive";
  function open() {
    setError("");
    const ok = host.onSaveToDrive?.(artifact, async (file) => {
      if (!host.conversation) return;
      try {
        await setActionState(host.conversation, artifact.id, "confirmed", { file_id: file });
        setState("confirmed");
        setResult({ file_id: file });
      } catch (e) {
        setError((e as Error).message);
      }
    });
    if (!ok) setError(`Não achei ${a.ref} nesta conversa.`);
  }
  async function cancel() {
    if (!host.conversation) return;
    setBusy(true);
    try {
      await setActionState(host.conversation, artifact.id, "cancelled", {});
      setState("cancelled");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const company = routeParts(window.location.pathname).company;
  const link = a.client_id
    ? driveUrl(a.folder_id ? { folder: a.folder_id } : { client: a.client_id, contract: a.contract_id }, company)
    : driveUrl({}, company);
  return (
    <section className={`mavi-card mavi-action ${state}`} aria-label="Salvar no Drive, proposta da MAVI">
      <header className="mavi-action-head">
        <span className="mavi-action-icon" aria-hidden="true">
          <HardDriveUpload size={16} />
        </span>
        <span>
          <small>
            <Sparkles size={11} aria-hidden="true" /> Salvar no Drive · proposta da MAVI
          </small>
          <strong>
            {a.file_name}.{a.format}
          </strong>
        </span>
        <StateChip state={state} />
      </header>
      <dl className="mavi-action-fields">
        <div>
          <dt>Documento</dt>
          <dd>{a.ref}</dd>
        </div>
        <div>
          <dt>Formato</dt>
          <dd>{FORMAT[a.format] ?? a.format}</dd>
        </div>
        <div>
          <dt>Onde</dt>
          <dd>{where}</dd>
        </div>
      </dl>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <footer className="mavi-action-foot">
        {state === "pending" ? (
          host.readOnly ? (
            <small>Só quem começou a conversa decide.</small>
          ) : !host.onSaveToDrive ? (
            <small>Para salvar no Drive, abra a conversa no módulo MAVI.</small>
          ) : (
            <>
              <button type="button" className="btn primary" disabled={waiting || busy} onClick={open}>
                <HardDriveUpload size={15} /> Conferir e salvar
              </button>
              <button type="button" className="btn secondary" disabled={waiting || busy} onClick={() => void cancel()}>
                {busy ? <Loader2 size={15} className="spin" /> : <X size={15} />} Agora não
              </button>
              {waiting && <small>Aguardando a MAVI terminar…</small>}
            </>
          )
        ) : (
          state === "confirmed" &&
          result?.file_id && (
            <a className="mavi-action-link" href={link}>
              <ExternalLink size={14} /> Abrir a pasta no Drive
            </a>
          )
        )}
      </footer>
    </section>
  );
}
