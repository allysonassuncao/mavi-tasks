import { useCallback, useEffect, useState } from "react";
import {
  Copy,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  Link2,
  MessageCircle,
  Unlink,
} from "lucide-react";
import { Button, Input, Select, SelectOption } from "./ui";
import { formatBytes } from "./drive";
import {
  useLiveSocialLeads,
  type ProofFolder,
  type SocialLeadsBackend,
} from "./social-leads-api";
import type { MediaFile } from "./social-leads";

/**
 * Prova social pelo cliente: uma pasta do Drive do produto contratado com
 * link público que aceita envio. A equipe cria a pasta (ou escolhe uma que
 * já existe), manda o link ao cliente e vê aqui o que ele enviou; os
 * arquivos contam como prova social do briefing e a MAVI os considera ao
 * gerar o plano. Desligar tira o link do ar (os arquivos ficam no Drive).
 */
export function ProofFolderPanel({
  company,
  contract,
  clientName,
  folderId,
  contactWhats,
  backend,
  canWrite,
  onFiles,
  onChanged,
  notify,
}: {
  company: string;
  contract: string;
  clientName: string;
  /** The folder linked to the briefing (null: none yet). */
  folderId: string | null;
  contactWhats?: string;
  backend: SocialLeadsBackend;
  canWrite: boolean;
  onFiles: (files: MediaFile[]) => void;
  onChanged: () => void;
  notify: (m: string) => void;
}) {
  const [info, setInfo] = useState<ProofFolder | null | undefined>(undefined);
  const [mode, setMode] = useState<"idle" | "new" | "pick">("idle");
  const [name, setName] = useState(`Prova social · ${clientName}`);
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  const load = useCallback(() => {
    backend
      .proofFolder(company, folderId)
      .then((f) => {
        setInfo(f);
        onFiles(f?.files ?? []);
      })
      .catch(() => setInfo(null));
    // onFiles is a state setter of the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, company, folderId]);
  useEffect(load, [load]);
  // The client's uploads arrive as a live notice of this contract.
  useLiveSocialLeads(contract, load);

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await fn();
      notify(done);
      setMode("idle");
      onChanged();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const create = () =>
    void run(
      () => backend.setProofFolder(company, contract, null, name.trim(), true),
      "Pasta criada. Copie o link e mande para o cliente.",
    );
  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(
      () => notify(`${what} copiado.`),
      () => notify("Não foi possível copiar. Selecione o texto e copie."),
    );

  if (info === undefined)
    return (
      <div className="sl-proof-folder">
        <p className="sl-muted">Procurando a pasta do cliente…</p>
      </div>
    );

  if (!info || !info.url) {
    return (
      <div className="sl-proof-folder">
        <span className="sl-proof-head">
          <FolderOpen size={17} aria-hidden="true" />
          <strong>Pasta para o cliente enviar</strong>
        </span>
        <p className="sl-muted">
          Uma pasta no Drive do cliente com link público: ele envia depoimentos,
          fotos e vídeos sozinho, sem login.
        </p>
        {!canWrite ? null : mode === "new" ? (
          // Inside the briefing's own form: a group, not a nested <form>.
          <div className="sl-proof-form" role="group" aria-label="Nova pasta">
            <Input
              value={name}
              maxLength={120}
              aria-label="Nome da pasta"
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (name.trim()) create();
              }}
            />
            <span className="sl-proof-actions">
              <Button
                type="button"
                className="btn secondary"
                onClick={() => setMode("idle")}
              >
                Cancelar
              </Button>
              <Button
                type="button"
                className="btn primary"
                loading={busy}
                disabled={!name.trim()}
                onClick={create}
              >
                Criar e gerar o link
              </Button>
            </span>
          </div>
        ) : mode === "pick" ? (
          <div
            className="sl-proof-form"
            role="group"
            aria-label="Escolher pasta"
          >
            {folders.length ? (
              <Select value={picked} onValueChange={setPicked}>
                <SelectOption value="">Escolha a pasta</SelectOption>
                {folders.map((f) => (
                  <SelectOption key={f.id} value={f.id}>
                    {f.name}
                  </SelectOption>
                ))}
              </Select>
            ) : (
              <p className="sl-muted">
                Nenhuma pasta no produto deste cliente no Drive. Crie uma nova.
              </p>
            )}
            <span className="sl-proof-actions">
              <Button
                type="button"
                className="btn secondary"
                onClick={() => setMode("idle")}
              >
                Cancelar
              </Button>
              <Button
                type="button"
                className="btn primary"
                loading={busy}
                disabled={!picked}
                onClick={() =>
                  void run(
                    () =>
                      backend.setProofFolder(
                        company,
                        contract,
                        picked,
                        null,
                        true,
                      ),
                    "Pasta compartilhada. Copie o link e mande para o cliente.",
                  )
                }
              >
                Usar esta pasta
              </Button>
            </span>
          </div>
        ) : (
          <span className="sl-proof-actions">
            <Button
              type="button"
              className="btn secondary"
              onClick={() => setMode("new")}
            >
              <FolderPlus size={15} /> Criar pasta
            </Button>
            <Button
              type="button"
              className="btn secondary"
              onClick={() => {
                setMode("pick");
                backend
                  .contractFolders(company, contract)
                  .then(setFolders)
                  .catch(() => setFolders([]));
              }}
            >
              <FolderOpen size={15} /> Usar uma existente
            </Button>
          </span>
        )}
      </div>
    );
  }

  const first = clientName.split(" ")[0];
  const message = `Olá! Para os posts da ${first}, mande por aqui depoimentos de clientes, fotos e vídeos (pode ser pelo celular, sem senha): ${info.url}`;
  const phone = (contactWhats ?? "").replace(/\D/g, "");
  const wa = phone
    ? `https://wa.me/${phone.length <= 11 ? `55${phone}` : phone}?text=${encodeURIComponent(message)}`
    : "";
  return (
    <div className="sl-proof-folder on">
      <span className="sl-proof-head">
        <FolderOpen size={17} aria-hidden="true" />
        <strong>{info.name}</strong>
        <em className="sl-proof-live">Recebendo arquivos</em>
      </span>
      <span className="sl-copy-row">
        <Input
          readOnly
          value={info.url}
          icon={Link2}
          aria-label="Link da pasta para o cliente"
          onFocus={(e) => e.target.select()}
        />
        <Button
          type="button"
          className="btn secondary"
          onClick={() => void copy(info.url!, "Link")}
        >
          <Copy size={15} /> Copiar
        </Button>
      </span>
      <span className="sl-proof-actions">
        {wa && (
          <a
            className="btn secondary"
            href={wa}
            target="_blank"
            rel="noreferrer"
          >
            <MessageCircle size={15} /> Mandar no WhatsApp
          </a>
        )}
        <a
          className="btn secondary"
          href={info.url}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink size={15} /> Ver como o cliente
        </a>
      </span>
      <div className="sl-proof-files">
        <small>
          {info.files.length
            ? `${info.files.length} ${info.files.length === 1 ? "arquivo recebido" : "arquivos recebidos"} · contam como prova social para a MAVI`
            : "Nenhum arquivo ainda. Quando o cliente enviar, aparece aqui na hora."}
        </small>
        {!!info.files.length && (
          <ul>
            {info.files.slice(0, 8).map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  className="sl-link"
                  onClick={() => {
                    const tab = window.open("about:blank", "_blank");
                    if (tab) tab.opener = null;
                    backend
                      .mediaUrl(f)
                      .then((u) => {
                        if (tab) tab.location.href = u;
                      })
                      .catch(() => tab?.close());
                  }}
                >
                  {f.name}
                </button>
                <small>{formatBytes(f.size)}</small>
              </li>
            ))}
            {info.files.length > 8 && (
              <li className="sl-muted">
                e mais {info.files.length - 8} no Drive, na pasta {info.name}
              </li>
            )}
          </ul>
        )}
      </div>
      {canWrite &&
        (confirmOff ? (
          <span className="sl-confirm">
            O link para de funcionar (os arquivos ficam no Drive).
            <Button
              className="btn secondary"
              loading={busy}
              onClick={() =>
                void run(
                  () =>
                    backend.setProofFolder(
                      company,
                      contract,
                      info.id,
                      null,
                      false,
                    ),
                  "Link da pasta desligado.",
                ).then(() => setConfirmOff(false))
              }
            >
              Desligar
            </Button>
            <Button
              className="btn secondary"
              onClick={() => setConfirmOff(false)}
            >
              Cancelar
            </Button>
          </span>
        ) : (
          <button
            type="button"
            className="sl-link sl-proof-off"
            onClick={() => setConfirmOff(true)}
          >
            <Unlink size={13} /> Parar de receber pelo link
          </button>
        ))}
    </div>
  );
}
