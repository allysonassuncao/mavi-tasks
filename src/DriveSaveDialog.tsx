import { useEffect, useMemo, useState } from "react";
import { HardDriveUpload, Lock } from "lucide-react";
import { Modal } from "./components";
import { Button, Input, Loading, Select, SelectOption } from "./ui";
import { listDriveFolders, uploadDriveFile } from "./drive";
import { canWriteAt } from "./DriveMoveDialog";
import { DriveFolderPicker, pickedPlace, placeLabel } from "./DriveFolderPicker";
import type { DriveFolder, DriveLocation, DriveVisibility, Snapshot } from "./types";
import "./identities.css";

/**
 * Salvar no Drive um arquivo que a MAVI gerou (PDF, Word, PowerPoint, .html,
 * Excel…): escolhe o formato, o nome e a pasta (raiz › cliente › produto ›
 * pastas) e envia pelo mesmo caminho do Drive — histórico, visibilidade,
 * permissões e a leitura pela MAVI como qualquer arquivo enviado.
 */

export type SaveFormat = {
  key: string;
  label: string;
  ext: string;
  make: () => Promise<Blob>;
};

const cleanName = (s: string) =>
  s
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);

export function DriveSaveDialog({
  company,
  data,
  user,
  isLeader,
  start,
  title,
  formats,
  initialFormat,
  onClose,
  onSaved,
  loadFolders = listDriveFolders,
}: {
  company: string;
  data: Snapshot;
  user: string;
  isLeader: boolean;
  /** Onde a janela abre (o cliente da conversa, ou a pasta que a MAVI sugeriu). */
  start: DriveLocation;
  /** O nome sugerido (sem a extensão). */
  title: string;
  formats: SaveFormat[];
  initialFormat?: string;
  onClose: () => void;
  onSaved: (file: string, where: string) => void;
  /** As pastas que a pessoa vê (trocado nos testes). */
  loadFolders?: (company: string) => Promise<DriveFolder[]>;
}) {
  const [folders, setFolders] = useState<DriveFolder[] | null>(null);
  const [at, setAt] = useState<DriveLocation>(start);
  const [format, setFormat] = useState(
    formats.find((f) => f.key === initialFormat)?.key ?? formats[0]?.key ?? "",
  );
  const [name, setName] = useState(cleanName(title) || "Documento");
  const [visibility, setVisibility] = useState<DriveVisibility>("private");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    loadFolders(company)
      .then((f) => alive && setFolders(f))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [company, loadFolders]);
  const all = useMemo(() => new Map((folders ?? []).map((f) => [f.id, f])), [folders]);
  const { client, contract } = pickedPlace(at, all);
  const writable = canWriteAt(data, user, isLeader, contract);
  const chosen = formats.find((f) => f.key === format);
  const busy = progress !== null;
  const where = placeLabel(data, at, all);

  async function save() {
    if (!chosen) return;
    const base = cleanName(name);
    if (!base) return setError("Dê um nome ao arquivo.");
    setError("");
    setProgress(0);
    try {
      const blob = await chosen.make();
      const file = new File([blob], `${base}.${chosen.ext}`, { type: blob.type || "application/octet-stream" });
      const id = await uploadDriveFile(company, at, file, visibility, setProgress);
      onSaved(id, where);
    } catch (e) {
      setError((e as Error).message || "Não foi possível salvar no Drive.");
      setProgress(null);
    }
  }

  return (
    <Modal title="Salvar no Drive" onClose={onClose} busy={busy} className="drive-pick-modal drive-save-modal">
      <div className="drive-pick">
        <div className="drive-save-fields">
          <label className="identity-field">
            <span className="identity-label">Formato</span>
            <Select aria-label="Formato" value={format} onValueChange={setFormat}>
              {formats.map((f) => (
                <SelectOption key={f.key} value={f.key}>
                  {f.label}
                </SelectOption>
              ))}
            </Select>
          </label>
          <label className="identity-field drive-save-name">
            <span className="identity-label">Nome do arquivo</span>
            <span className="drive-save-name-row">
              <Input aria-label="Nome do arquivo" value={name} maxLength={150} onChange={(e) => setName(e.target.value)} />
              <small>.{chosen?.ext}</small>
            </span>
          </label>
          <label className="identity-field">
            <span className="identity-label">Visibilidade</span>
            <Select aria-label="Visibilidade" value={visibility} onValueChange={(v) => setVisibility(v as DriveVisibility)}>
              <SelectOption value="private">Privado</SelectOption>
              <SelectOption value="public">Público (com link)</SelectOption>
            </Select>
          </label>
        </div>
        {folders === null ? (
          <Loading compact />
        ) : (
          <DriveFolderPicker
            data={data}
            folders={all}
            at={at}
            onPick={setAt}
            emptyText={(h) => `Sem pastas aqui. Você pode salvar em “${h}”.`}
          />
        )}
        {!writable && (
          <p className="drive-move-note">
            <Lock size={14} aria-hidden="true" />
            {contract
              ? "Só quem atende este cliente, ou um administrador ou gestor, coloca arquivos aqui."
              : client
                ? "Aqui só administradores e gestores colocam arquivos. Entre num produto."
                : "Aqui só administradores e gestores colocam arquivos. Entre num cliente e depois num produto."}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer drive-pick-footer">
          <small>
            {busy
              ? progress! < 0.02
                ? "Gerando o arquivo…"
                : `Enviando… ${Math.round(progress! * 100)}%`
              : "A MAVI passa a ler o arquivo como qualquer outro do Drive."}
          </small>
          <Button type="button" className="btn secondary" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>
          <Button type="button" className="btn primary" disabled={!writable || !chosen || !folders} loading={busy} onClick={() => void save()}>
            <HardDriveUpload size={15} /> Salvar em “{where}”
          </Button>
        </div>
      </div>
    </Modal>
  );
}
