import { useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  File as FileIcon,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  HardDrive,
  Package,
  Search,
  Users,
  X,
} from "lucide-react";
import { Empty, Modal } from "./components";
import { Button, Checkbox, Loading } from "./ui";
import { contractProductLabel } from "./domain";
import {
  formatBytes,
  listDriveFiles,
  listDriveFolders,
  mySharedFolders,
  searchDriveFiles,
} from "./drive";
import type { DriveFile, DriveFolder, DriveLocation, Snapshot } from "./types";

// A mesma ordem do Drive (Z → A).
const byNameDesc = (a: { name: string }, b: { name: string }) =>
  b.name.localeCompare(a.name, "pt-BR", { numeric: true, sensitivity: "base" });
const fileIcon = (type: string) =>
  type.startsWith("image/")
    ? FileImage
    : type.startsWith("video/")
      ? FileVideo
      : /pdf|text|word|document|presentation|sheet/.test(type)
        ? FileText
        : FileIcon;

export type PickedDriveFile = Pick<
  DriveFile,
  "id" | "name" | "size_bytes" | "content_type"
>;

/**
 * Escolher arquivos que já estão no Drive, navegando pelas pastas como no
 * Drive (raiz › clientes › produtos contratados › pastas) ou buscando pelo
 * nome. Mostra só o que a pessoa pode abrir no Drive (o banco decide) e
 * permite escolher vários de uma vez.
 */
export function DrivePicker({
  company,
  data,
  picked,
  max,
  onClose,
  onPick,
}: {
  company: string;
  data: Snapshot;
  /** Os que já estão anexados (aparecem marcados, sem repetir). */
  picked: string[];
  /** Quantos ainda cabem. */
  max: number;
  onClose: () => void;
  onPick: (files: PickedDriveFile[]) => void;
}) {
  const [at, setAt] = useState<DriveLocation>({});
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [shared, setShared] = useState<DriveFolder[]>([]);
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DriveFile[] | null>(null);
  const [chosen, setChosen] = useState<Map<string, DriveFile>>(new Map());
  const [error, setError] = useState("");

  useEffect(() => {
    listDriveFolders(company)
      .then(setFolders)
      .catch((e) => setError((e as Error).message));
    mySharedFolders(company)
      .then(setShared)
      .catch(() => setShared([]));
  }, [company]);
  useEffect(() => {
    setFiles(null);
    let alive = true;
    listDriveFiles(company, at)
      .then((list) => alive && setFiles(list.sort(byNameDesc)))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [company, at]);
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) return setResults(null);
    setResults(null);
    let alive = true;
    const t = setTimeout(() => {
      searchDriveFiles(company, text)
        .then((list) => alive && setResults(list.slice(0, 60)))
        .catch((e) => alive && setError((e as Error).message));
    }, 280);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [company, query]);

  const all = useMemo(() => {
    const m = new Map<string, DriveFolder>();
    for (const f of [...folders, ...shared]) m.set(f.id, f);
    return m;
  }, [folders, shared]);
  const current = at.folder ? all.get(at.folder) : undefined;
  const clientName = (id?: string | null) =>
    data.clients.find((c) => c.id === id)?.name ?? "Cliente";

  // O caminho até aqui, para voltar a qualquer nível.
  const crumbs: { label: string; to: DriveLocation }[] = [
    { label: "Drive", to: {} },
  ];
  const chain: DriveFolder[] = [];
  for (let f = current; f; f = f.parent_id ? all.get(f.parent_id) : undefined)
    chain.unshift(f);
  const client = current?.client_id ?? at.client;
  const contract = current?.contract_id ?? at.contract;
  if (client) crumbs.push({ label: clientName(client), to: { client } });
  if (contract)
    crumbs.push({
      label: contractProductLabel(data, contract),
      to: { client: client ?? undefined, contract },
    });
  for (const f of chain) crumbs.push({ label: f.name, to: { folder: f.id } });

  const atRoot = !at.client && !at.contract && !at.folder;
  const clients = atRoot
    ? data.clients.filter((c) => !c.archived).sort(byNameDesc)
    : [];
  const products =
    at.client && !at.contract && !at.folder
      ? data.contracts
          .filter((k) => k.client_id === at.client && !k.archived)
          .map((k) => ({ id: k.id, name: contractProductLabel(data, k.id) }))
          .sort(byNameDesc)
      : [];
  const subfolders = [...all.values()]
    .filter((f) =>
      at.folder
        ? f.parent_id === at.folder
        : !f.parent_id &&
          (f.client_id ?? undefined) === at.client &&
          (f.contract_id ?? undefined) === at.contract &&
          (!atRoot || !shared.some((s) => s.id === f.id)),
    )
    .sort(byNameDesc);
  const sharedHere = atRoot
    ? shared.filter((s) => !folders.some((f) => f.id === s.id))
    : [];

  const toggle = (f: DriveFile) =>
    setChosen((m) => {
      const next = new Map(m);
      if (next.has(f.id)) next.delete(f.id);
      else if (next.size < max) next.set(f.id, f);
      return next;
    });
  const go = (to: DriveLocation) => {
    setQuery("");
    setError("");
    setAt(to);
  };
  const list = query.trim().length >= 2 ? results : files;
  const searching = query.trim().length >= 2;

  const fileRow = (f: DriveFile) => {
    const already = picked.includes(f.id);
    const on = already || chosen.has(f.id);
    const Icon = fileIcon(f.content_type);
    return (
      <li key={f.id}>
        <label className={`drive-pick-file ${on ? "on" : ""}`}>
          <Checkbox
            checked={on}
            disabled={already || (!on && chosen.size >= max)}
            onCheckedChange={() => toggle(f)}
            aria-label={`Escolher ${f.name}`}
          />
          <Icon size={17} aria-hidden="true" />
          <span>
            {f.name}
            <small>
              {formatBytes(f.size_bytes)}
              {already ? " · já anexado" : ""}
              {searching && f.client_id ? ` · ${clientName(f.client_id)}` : ""}
            </small>
          </span>
        </label>
      </li>
    );
  };
  const folderRow = (
    key: string,
    label: string,
    Icon: typeof Folder,
    to: DriveLocation,
    note?: string,
  ) => (
    <li key={key}>
      <button
        type="button"
        className="drive-pick-folder"
        onClick={() => go(to)}
      >
        <Icon size={17} aria-hidden="true" />
        <span>
          {label}
          {note && <small>{note}</small>}
        </span>
        <ChevronRight size={15} aria-hidden="true" />
      </button>
    </li>
  );

  return (
    <Modal
      title="Anexar do Drive"
      onClose={onClose}
      className="drive-pick-modal"
    >
      <div className="drive-pick">
        <label className="cases-search drive-pick-search">
          <Search size={18} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar arquivos pelo nome em todo o Drive…"
            aria-label="Buscar no Drive"
            autoFocus
          />
          {query && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Limpar busca"
              onClick={() => setQuery("")}
            >
              <X size={15} />
            </button>
          )}
        </label>
        {!searching && (
          <nav className="drive-pick-crumbs" aria-label="Pasta atual">
            {crumbs.map((c, i) => (
              <span key={i}>
                {i > 0 && <ChevronRight size={13} aria-hidden="true" />}
                {i === crumbs.length - 1 ? (
                  <strong>
                    {i === 0 ? (
                      <HardDrive size={14} aria-hidden="true" />
                    ) : null}
                    {c.label}
                  </strong>
                ) : (
                  <button type="button" onClick={() => go(c.to)}>
                    {i === 0 ? (
                      <HardDrive size={14} aria-hidden="true" />
                    ) : null}
                    {c.label}
                  </button>
                )}
              </span>
            ))}
          </nav>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="drive-pick-list">
          {list === null ? (
            <Loading compact />
          ) : searching ? (
            list.length ? (
              <ul>{list.map(fileRow)}</ul>
            ) : (
              <Empty
                title="Nenhum arquivo com esse nome"
                body="Tente outra parte do nome."
              />
            )
          ) : (
            <ul>
              {sharedHere.map((f) =>
                folderRow(
                  `s-${f.id}`,
                  f.name,
                  Users,
                  { folder: f.id },
                  "Compartilhada com você",
                ),
              )}
              {clients.map((c) =>
                folderRow(`c-${c.id}`, c.name, FolderOpen, { client: c.id }),
              )}
              {products.map((p) =>
                folderRow(`p-${p.id}`, p.name, Package, {
                  client: at.client,
                  contract: p.id,
                }),
              )}
              {subfolders.map((f) =>
                folderRow(`f-${f.id}`, f.name, Folder, { folder: f.id }),
              )}
              {list.map(fileRow)}
              {!sharedHere.length &&
                !clients.length &&
                !products.length &&
                !subfolders.length &&
                !list.length && (
                  <li className="drive-pick-empty">Pasta vazia.</li>
                )}
            </ul>
          )}
        </div>
        <div className="form-footer drive-pick-footer">
          <small>
            {chosen.size
              ? `${chosen.size} ${chosen.size === 1 ? "arquivo escolhido" : "arquivos escolhidos"}`
              : "Escolha um ou mais arquivos."}
            {max <= chosen.size ? " Limite de anexos do aviso." : ""}
          </small>
          <Button type="button" className="btn secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="button"
            className="btn primary"
            disabled={!chosen.size}
            onClick={() => onPick([...chosen.values()])}
          >
            Anexar{chosen.size ? ` (${chosen.size})` : ""}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
