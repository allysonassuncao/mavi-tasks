import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  FolderInput,
  Globe,
  Lock,
  Sparkles,
  Unlink,
  Users,
} from "lucide-react";
import { Modal } from "./components";
import { Button, Loading } from "./ui";
import { canCreateTaskIn } from "./domain";
import { moveDriveItems, previewDriveMove, type DriveMoveItems } from "./drive";
import { DriveFolderPicker, pickedPlace, placeLabel } from "./DriveFolderPicker";
import type {
  DriveFolder,
  DriveLocation,
  DriveMovePreview,
  Snapshot,
} from "./types";

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** Quem pode colocar itens num lugar (o mesmo que drive_can_write). */
export function canWriteAt(
  data: Snapshot,
  user: string,
  isLeader: boolean,
  contract: string | null | undefined,
) {
  return isLeader || (!!contract && canCreateTaskIn(data, contract, user));
}

/** Os avisos de uma movimentação, como a pessoa lê antes de confirmar. */
export function moveWarnings(data: Snapshot, p: DriveMovePreview) {
  const clientName = (id: string | null) =>
    id ? (data.clients.find((c) => c.id === id)?.name ?? "Cliente") : "Drive";
  const quote = (names: string[]) => names.map((n) => `“${n}”`).join(", ");
  const total = p.files + p.inner_files;
  const out: { icon: typeof Globe; tone: "mavi" | "warn" | "info"; text: string }[] = [];
  if (p.from_clients.length)
    out.push({
      icon: Sparkles,
      tone: "mavi",
      text: p.to.client_id
        ? `Vai de ${p.from_clients.map(clientName).join(", ")} para ${clientName(p.to.client_id)}. ${
            total
              ? `A MAVI passa a usar ${total === 1 ? "o arquivo" : `os ${total} arquivos`} só no contexto de ${clientName(p.to.client_id)}.`
              : "O que for colocado aqui passa a ser do novo cliente."
          }`
        : `Sai de ${p.from_clients.map(clientName).join(", ")} e fica fora de qualquer cliente. ${
            total ? "A MAVI deixa de usar estes arquivos no contexto do cliente." : ""
          }`.trim(),
    });
  if (p.enter_public.length)
    out.push({
      icon: Globe,
      tone: "warn",
      text: `Fica visível para quem tem o link público de ${quote(p.enter_public)}.`,
    });
  if (p.enter_people.length)
    out.push({
      icon: Users,
      tone: "warn",
      text: `Fica visível para as pessoas com quem ${quote(p.enter_people)} foi compartilhada.`,
    });
  if (p.leave_public.length)
    out.push({
      icon: Lock,
      tone: "info",
      text: `Sai do link público de ${quote(p.leave_public)}: quem tem o link deixa de ver.`,
    });
  if (p.leave_people.length)
    out.push({
      icon: Lock,
      tone: "info",
      text: `Deixa de aparecer para as pessoas com quem ${quote(p.leave_people)} foi compartilhada.`,
    });
  if (p.unshare.length)
    out.push({
      icon: Unlink,
      tone: "warn",
      text: `O compartilhamento de ${quote(p.unshare)} será desligado: fora de um produto, pastas não são compartilhadas.`,
    });
  return out;
}

/** "2 arquivos e 1 pasta (com 14 arquivos dentro)". */
export function moveSummary(p: DriveMovePreview) {
  const parts = [
    p.files ? plural(p.files, "arquivo", "arquivos") : "",
    p.folders ? plural(p.folders, "pasta", "pastas") : "",
  ].filter(Boolean);
  const inside = [
    p.inner_folders ? plural(p.inner_folders, "subpasta", "subpastas") : "",
    p.inner_files ? plural(p.inner_files, "arquivo", "arquivos") : "",
  ].filter(Boolean);
  return `${parts.join(" e ")}${inside.length ? ` (com ${inside.join(" e ")} dentro)` : ""}`;
}

/**
 * Mover arquivos e pastas: escolhe o destino navegando pelo Drive (raiz ›
 * clientes › produtos › pastas), confere com o banco o que acontece (troca
 * de cliente, links) e só então move. Com `fixed` (arrastar e soltar), o
 * destino já vem escolhido e a janela só confirma.
 */
export function DriveMoveDialog({
  company,
  data,
  user,
  isLeader,
  folders,
  items,
  label,
  start,
  fixed,
  onClose,
  onMoved,
}: {
  company: string;
  data: Snapshot;
  user: string;
  isLeader: boolean;
  /** As pastas que a pessoa vê (as do Drive aberto). */
  folders: DriveFolder[];
  items: DriveMoveItems;
  /** O nome do item (um só) ou "3 itens". */
  label: string;
  start: DriveLocation;
  fixed?: { at: DriveLocation; preview: DriveMovePreview };
  onClose: () => void;
  onMoved: (result: DriveMovePreview) => void;
}) {
  const [at, setAt] = useState<DriveLocation>(fixed?.at ?? start);
  const [preview, setPreview] = useState<DriveMovePreview | null>(
    fixed?.preview ?? null,
  );
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const all = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const moving = useMemo(() => new Set(items.folders), [items.folders]);
  const { client, contract } = pickedPlace(at, all);
  const writable = canWriteAt(data, user, isLeader, contract);
  // A cada destino, o banco confere (permissão, ciclo, links, cliente).
  useEffect(() => {
    if (fixed) return;
    setPreview(null);
    setProblem("");
    if (!writable) return;
    let alive = true;
    const t = setTimeout(() => {
      previewDriveMove(company, items, at)
        .then((p) => alive && setPreview(p))
        .catch((e) => alive && setProblem((e as Error).message));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [company, items, at.client, at.contract, at.folder, writable, fixed]);

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      onMoved(await moveDriveItems(company, items, at));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const warnings = preview ? moveWarnings(data, preview) : [];
  const here = placeLabel(data, at, all);

  return (
    <Modal
      title={`Mover ${label}`}
      onClose={onClose}
      busy={busy}
      className="drive-pick-modal drive-move-modal"
    >
      <div className="drive-pick">
        {fixed ? (
          <p className="drive-move-route">
            <FolderInput size={16} aria-hidden="true" />
            <span>
              Mover para <strong>{preview?.to.label ?? here}</strong>
            </span>
          </p>
        ) : (
          <DriveFolderPicker
            data={data}
            folders={all}
            at={at}
            onPick={setAt}
            exclude={moving}
            emptyText={(h) => `Sem pastas aqui. Você pode mover para “${h}”.`}
          />
        )}
        <div className="drive-move-check" aria-live="polite">
          {!writable ? (
            <p className="drive-move-note">
              <Lock size={14} aria-hidden="true" />
              {contract
                ? "Só quem atende este cliente, ou um administrador ou gestor, coloca itens aqui."
                : client
                  ? "Aqui só administradores e gestores colocam itens. Entre num produto."
                  : "Aqui só administradores e gestores colocam itens. Entre num cliente e depois num produto."}
            </p>
          ) : problem ? (
            <p className="drive-move-note">
              <Lock size={14} aria-hidden="true" />
              {problem}
            </p>
          ) : !preview ? (
            <Loading compact />
          ) : (
            <>
              <p className="drive-move-summary">
                <ArrowRight size={14} aria-hidden="true" />
                <span>
                  {moveSummary(preview)}
                  {!fixed && (
                    <>
                      {" "}
                      para <strong>{preview.to.label}</strong>
                    </>
                  )}
                </span>
              </p>
              {warnings.map((w, i) => (
                <p key={i} className={`drive-move-warning ${w.tone}`}>
                  <w.icon size={15} aria-hidden="true" />
                  {w.text}
                </p>
              ))}
            </>
          )}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer drive-pick-footer">
          <small>O histórico guarda de onde e para onde.</small>
          <Button type="button" className="btn secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="button"
            className="btn primary"
            disabled={!preview || !!problem || !writable}
            loading={busy}
            onClick={() => void confirm()}
          >
            <FolderInput size={15} /> Mover aqui
          </Button>
        </div>
      </div>
    </Modal>
  );
}
