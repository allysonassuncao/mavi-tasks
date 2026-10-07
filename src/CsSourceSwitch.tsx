import { useState } from "react";
import { Modal } from "./components";
import { Button, Textarea } from "./ui";
import type { CsEntryAccess, CsEntryBackend } from "./cs-entry";

const errMsg = (e: unknown) => (e as Error)?.message ?? String(e);

/** A troca da fonte dos dados de CS (planilha ↔ MAVI), só administradores, com motivo. */
export function SourceSwitchDialog({
  api,
  company,
  access,
  onClose,
  onDone,
  notify,
}: {
  api: CsEntryBackend;
  company: string;
  access: Pick<CsEntryAccess, "source" | "has_sheet">;
  onClose: () => void;
  onDone: (a: CsEntryAccess) => void;
  notify: (m: string) => void;
}) {
  const to = access.source === "mavi" ? "sheet" : "mavi";
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={to === "mavi" ? "Virar a chave: Fonte MAVI" : "Voltar para a planilha"} onClose={() => !busy && onClose()} busy={busy}>
      <form className="entity-form" onSubmit={async (ev) => {
        ev.preventDefault();
        if (reason.trim().length < 3) return setError("Diga o motivo da troca.");
        setBusy(true);
        try {
          const a = await api.setSource(company, to, reason.trim());
          notify(to === "mavi" ? "Fonte: MAVI. A planilha não é mais lida." : "A planilha voltou a ser a fonte do CS.");
          onDone(a);
        } catch (e) {
          setError(errMsg(e));
          setBusy(false);
        }
      }}>
        {to === "mavi" ? (
          <ul className="cs-entry-list">
            <li>A leitura da planilha para agora; uma leitura que estiver em andamento não grava.</li>
            <li>Tudo o que já está no MAVI fica: clientes, ciclos, Health Score, metas e o histórico.</li>
            <li>Os lançamentos passam a ser feitos em Customer Success: líderes lançam tudo; quem está num squad, os ciclos e o
              Health Score dos clientes do seu squad.</li>
            <li>Dá para voltar à planilha depois — a próxima leitura sobrescreve o que ela tiver.</li>
          </ul>
        ) : (
          <ul className="cs-entry-list">
            <li>A planilha volta a mandar: a próxima leitura (em até 10 minutos) grava o que estiver nela.</li>
            <li>O que foi lançado no MAVI e não estiver na planilha some na leitura (com as salvaguardas de sumiço em massa).</li>
            {!access.has_sheet && <li><b>Configure o link da planilha antes.</b></li>}
          </ul>
        )}
        <label>
          Motivo
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} required
            placeholder={to === "mavi" ? "Ex.: time treinado, lançamentos de outubro já no MAVI" : "Ex.: conferir uma divergência"} />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <Button className="btn primary" type="submit" loading={busy}>{to === "mavi" ? "Virar para o MAVI" : "Voltar para a planilha"}</Button>
      </form>
    </Modal>
  );
}
