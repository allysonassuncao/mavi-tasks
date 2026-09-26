import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Building2,
  ChevronRight,
  CloudUpload,
  Download,
  Eye,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  Globe,
  Share2,
  History,
  Link2,
  Lock,
  Package,
  Pencil,
  Search,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { Button, Input, Select, SelectOption, Loading } from "./ui";
import { Empty } from "./components";
import { Paged } from "./Pagination";
import { DropOverlay, useFileDrop } from "./useFileDrop";
import { ShareFolderDialog } from "./ShareFolderDialog";
import type {
  DriveFile,
  DriveFolder,
  DriveLocation,
  DriveVisibility,
  Snapshot,
} from "./types";
import { canCreateTaskIn, contractProductLabel } from "./domain";
import { DriveAudit } from "./DriveAudit";
import { FileViewer } from "./FileViewer";
import { MeetingRecordings } from "./MeetingRecordings";
import { countMeetingRecordings, meetingRecording } from "./meetings";
import { navigate, useLocation } from "./router";
import { setAiPlace } from "./ai";
import type { FormPreset } from "./forms";
import {
  createDriveFolder,
  deleteDriveFile,
  deleteDriveFolder,
  driveViewUrl,
  formatBytes,
  listDriveFiles,
  listDriveFolders,
  logLinkCopied,
  openDriveFile,
  publicFileUrl,
  renameDriveFile,
  renameDriveFolder,
  searchDriveFiles,
  matchDriveFolders,
  setDriveVisibility,
  uploadDriveFile,
  mySharedFolders,
  shareableFolder,
  driveFile,
} from "./drive";

type Upload = { key: string; name: string; progress: number; error?: string };
type Editing =
  | { kind: "new-folder" }
  | { kind: "folder"; id: string }
  | { kind: "file"; id: string }
  | null;

function iconFor(type: string, name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (type.startsWith("image/")) return FileImage;
  if (type.startsWith("video/")) return FileVideo;
  if (type.startsWith("audio/")) return FileAudio;
  if (
    /zip|rar|7z|tar|gzip/.test(type) ||
    ["zip", "rar", "7z", "gz"].includes(ext)
  )
    return FileArchive;
  if (/sheet|excel|csv/.test(type) || ["xlsx", "xls", "csv"].includes(ext))
    return FileSpreadsheet;
  if (type.startsWith("text/") || /pdf|word|document|presentation/.test(type))
    return FileText;
  return FileIcon;
}

type DriveProps = {
  demo: boolean;
  /** Already limited to the clients the person may see. */
  data: Snapshot;
  company: string;
  user: string;
  isLeader: boolean;
  notify: (message: string) => void;
  /** Limits the tree to one client's folder (the Drive tab of a task). */
  root?: { client: string };
  /** Opens the new-task form (a recording's next steps). */
  onNewTask?: (preset: FormPreset) => void;
};

/**
 * Company Drive as a folder tree: root → clients → their contracted products
 * → folders people create. Leaders may add and change things anywhere;
 * everyone else only inside product folders (mirrors drive_can_write).
 */
export function Drive(props: DriveProps) {
  if (props.demo)
    return (
      <div className="panel drive-empty">
        <Empty
          title="Drive disponível na conta conectada"
          body="Os arquivos ficam no Google Cloud Storage da sua empresa; a demonstração não armazena arquivos."
        />
      </div>
    );
  return <DriveWithHistory {...props} />;
}

/** The Drive tab of a task: only the folder of the task's client. */
export function TaskDrive(props: DriveProps & { root: { client: string } }) {
  if (props.demo)
    return (
      <p className="muted centered">
        O Drive fica disponível na conta conectada; a demonstração não armazena
        arquivos.
      </p>
    );
  return (
    <div className="task-drive">
      <DriveTree key={props.root.client} {...props} />
    </div>
  );
}

function DriveWithHistory(props: DriveProps) {
  const [tab, setTab] = useState<"files" | "history">("files");
  return (
    <>
      {props.isLeader && (
        <div className="drive-view drive-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "files"}
            className={tab === "files" ? "selected" : ""}
            onClick={() => setTab("files")}
          >
            <Folder size={15} /> Arquivos
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "history"}
            className={tab === "history" ? "selected" : ""}
            onClick={() => setTab("history")}
          >
            <History size={15} /> Histórico
          </button>
        </div>
      )}
      {tab === "history" && props.isLeader ? (
        <DriveAudit data={props.data} company={props.company} />
      ) : (
        <DriveTree {...props} />
      )}
    </>
  );
}

function DriveTree({
  data,
  company,
  user,
  isLeader,
  notify,
  root,
  onNewTask,
}: DriveProps) {
  // Rooted trees start at (and never leave) the client's folder.
  const base: DriveLocation = root ? { client: root.client } : {};
  const [at, setAt] = useState<DriveLocation>(base);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DriveFile[] | null>(null);
  const [error, setError] = useState("");
  const [newVisibility, setNewVisibility] =
    useState<DriveVisibility>("private");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [busyId, setBusyId] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState("");
  const [viewer, setViewer] = useState<{
    list: DriveFile[];
    index: number;
  } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Folder sharing: the folder being shared, and folders others shared with
  // the person (listed at the Drive root).
  const [sharing, setSharing] = useState<DriveFolder | null>(null);
  const [sharedWithMe, setSharedWithMe] = useState<DriveFolder[]>([]);
  useEffect(() => {
    if (root) return;
    mySharedFolders(company)
      .then(setSharedWithMe)
      .catch(() => setSharedWithMe([]));
  }, [company, root]);

  const folderById = useMemo(
    () => new Map(folders.map((f) => [f.id, f])),
    [folders],
  );
  // A custom folder carries its own client/product.
  const current = at.folder ? folderById.get(at.folder) : undefined;
  const place = at.folder
    ? {
        client: current?.client_id ?? undefined,
        contract: current?.contract_id ?? undefined,
      }
    : at;
  const canWrite =
    !at.recordings &&
    (isLeader ||
      (!!place.contract && canCreateTaskIn(data, place.contract, user)));

  const loadFolders = useCallback(
    () =>
      listDriveFolders(company)
        .then(setFolders)
        .catch((e) => setError((e as Error).message)),
    [company],
  );
  const loadFiles = useCallback(() => {
    // Gravações da MAVI has no files of its own.
    if (at.recordings) return setFiles([]);
    setFiles(null);
    listDriveFiles(company, at)
      .then(setFiles)
      .catch((e) => setError((e as Error).message));
  }, [company, at]);
  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);
  useEffect(loadFiles, [loadFiles]);
  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setResults(null);
      return;
    }
    setResults(null);
    const id = setTimeout(() => {
      searchDriveFiles(company, text, root?.client)
        .then(setResults)
        .catch((e) => setError((e as Error).message));
    }, 300);
    return () => clearTimeout(id);
  }, [company, query, root?.client]);

  // Gravações da MAVI: how many the client has (its card), and the link of a
  // moment (?gravacao=<id>&t=<s>) opening the recording right there.
  const [recordingCount, setRecordingCount] = useState(0);
  const [openRecording, setOpenRecording] = useState<{
    recording: string;
    start?: number;
  } | null>(null);
  const showsProducts =
    !!at.client && !at.contract && !at.folder && !at.recordings;
  // O assistente de IA começa no cliente aberto aqui.
  const placeName = at.client
    ? (data.clients.find((c) => c.id === at.client)?.name ?? "")
    : "";
  useEffect(() => {
    if (!at.client) {
      setAiPlace(null);
      return;
    }
    setAiPlace({ client: at.client, label: placeName });
    return () => setAiPlace(null);
  }, [at.client, placeName]);
  useEffect(() => {
    setRecordingCount(0);
    if (!showsProducts || !at.client) return;
    let alive = true;
    countMeetingRecordings(company, at.client)
      .then((n) => alive && setRecordingCount(n))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [company, at.client, showsProducts]);
  // Links de outras telas (fontes citadas pela IA, tarefas):
  // ?gravacao=<id>&t=<s> abre a gravação; ?arquivo=<id> abre o arquivo.
  const location = useLocation();
  useEffect(() => {
    if (root) return;
    const params = new URLSearchParams(location.split("?")[1] ?? "");
    const recording = params.get("gravacao");
    const fileId = params.get("arquivo");
    if (!recording && !fileId) return;
    const start = Number(params.get("t")) || undefined;
    navigate(window.location.pathname, true);
    if (recording)
      meetingRecording(recording)
        .then((r) => {
          if (!r) throw Error("Gravação não encontrada ou sem acesso.");
          setAt({ client: r.client_id, recordings: true });
          setOpenRecording({ recording: r.id, start });
        })
        .catch((e) => setError((e as Error).message));
    else
      driveFile(company, fileId!)
        .then((f) => {
          if (!f) throw Error("Arquivo não encontrado ou sem acesso.");
          setAt({
            client: f.client_id ?? undefined,
            contract: f.contract_id ?? undefined,
            folder: f.folder_id ?? undefined,
          });
          setViewer({ list: [f], index: 0 });
        })
        .catch((e) => setError((e as Error).message));
  }, [root, location, company]);

  function go(next: DriveLocation) {
    setOpenRecording(null);
    setAt(root && !next.client ? base : next);
    setEditing(null);
    setQuery("");
    setError("");
  }
  function chainOf(folderId: string | null | undefined) {
    const chain: DriveFolder[] = [];
    let f = folderId ? folderById.get(folderId) : undefined;
    while (f) {
      chain.unshift(f);
      f = f.parent_id ? folderById.get(f.parent_id) : undefined;
    }
    return chain;
  }
  const clientName = (id?: string | null) =>
    data.clients.find((c) => c.id === id)?.name ?? "Cliente";
  function pathOf(item: {
    client_id: string | null;
    contract_id: string | null;
    folder_id: string | null;
  }) {
    return [
      ...(root ? [] : ["Drive"]),
      ...(item.client_id && !root ? [clientName(item.client_id)] : []),
      ...(item.contract_id
        ? [contractProductLabel(data, item.contract_id)]
        : []),
      ...chainOf(item.folder_id).map((f) => f.name),
    ].join(" › ");
  }

  // A search looks at folder names too (clients, products and folders), not
  // only at files.
  const searching = !!query.trim();
  const folderMatches = useMemo(
    () =>
      matchDriveFolders(
        data,
        [...folders, ...sharedWithMe],
        query,
        root?.client,
      ),
    [data, folders, sharedWithMe, query, root?.client],
  );
  function whereOf(m: (typeof folderMatches)[number]) {
    if (m.kind === "client") return "";
    if (m.kind === "product")
      return root ? "" : ["Drive", clientName(m.at.client)].join(" › ");
    return pathOf({
      client_id: m.folder?.client_id ?? null,
      contract_id: m.folder?.contract_id ?? null,
      folder_id: m.folder?.parent_id ?? null,
    });
  }

  // What is shown inside the current location.
  const locationKey = [at.client, at.contract, at.folder, at.recordings].join(
    "|",
  );
  const clients =
    !at.client && !at.folder
      ? data.clients
          .filter((c) => !c.archived)
          .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
      : [];
  const products = showsProducts
    ? data.contracts.filter((k) => k.client_id === at.client && !k.archived)
    : [];
  const subfolders = at.recordings
    ? []
    : folders.filter((f) =>
        at.folder
          ? f.parent_id === at.folder
          : !f.parent_id &&
            (f.client_id ?? undefined) === at.client &&
            (f.contract_id ?? undefined) === at.contract,
      );

  async function run(id: string, action: () => Promise<unknown>) {
    setBusyId(id);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId("");
    }
  }
  async function upload(list: FileList | File[]) {
    if (!canWrite) return;
    setError("");
    const target = { ...at };
    const batch = Array.from(list).map((file, i) => ({
      file,
      key: `${Date.now()}-${i}-${file.name}`,
    }));
    setUploads((u) => [
      ...u,
      ...batch.map(({ file, key }) => ({ key, name: file.name, progress: 0 })),
    ]);
    let sent = 0;
    for (const { file, key } of batch) {
      try {
        await uploadDriveFile(
          company,
          target,
          file,
          newVisibility,
          (progress) =>
            setUploads((u) =>
              u.map((x) => (x.key === key ? { ...x, progress } : x)),
            ),
        );
        sent++;
        setUploads((u) => u.filter((x) => x.key !== key));
      } catch (e) {
        setUploads((u) =>
          u.map((x) =>
            x.key === key ? { ...x, error: (e as Error).message } : x,
          ),
        );
      }
    }
    if (sent) {
      notify(sent === 1 ? "Arquivo enviado." : `${sent} arquivos enviados.`);
      loadFiles();
    }
  }
  function startEdit(next: Editing, value = "") {
    setEditing(next);
    setDraft(value);
  }
  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    const name = draft.trim();
    if (!editing || !name) return;
    const target = editing;
    await run(target.kind === "new-folder" ? "new" : target.id, async () => {
      if (target.kind === "new-folder") {
        await createDriveFolder(company, name, at);
        notify("Pasta criada.");
      } else if (target.kind === "folder") {
        await renameDriveFolder(target.id, name);
      } else {
        await renameDriveFile(target.id, name);
        setFiles(
          (list) =>
            list?.map((f) => (f.id === target.id ? { ...f, name } : f)) ?? null,
        );
      }
      setEditing(null);
      await loadFolders();
    });
  }
  async function removeFolder(folder: DriveFolder) {
    if (!window.confirm(`Excluir a pasta "${folder.name}"?`)) return;
    await run(folder.id, async () => {
      await deleteDriveFolder(folder.id);
      await loadFolders();
      notify("Pasta excluída.");
    });
  }
  async function removeFile(file: DriveFile) {
    if (
      !window.confirm(
        `Excluir "${file.name}"? Essa ação não pode ser desfeita.`,
      )
    )
      return;
    await run(file.id, async () => {
      await deleteDriveFile(file.id);
      setFiles((list) => list?.filter((f) => f.id !== file.id) ?? null);
      setResults((list) => list?.filter((f) => f.id !== file.id) ?? null);
      notify("Arquivo excluído.");
    });
  }
  async function changeVisibility(
    file: DriveFile,
    visibility: DriveVisibility,
  ) {
    await run(file.id, async () => {
      await setDriveVisibility(file.id, visibility);
      const patch = (list: DriveFile[] | null) =>
        list?.map((f) => (f.id === file.id ? { ...f, visibility } : f)) ?? null;
      setFiles(patch);
      setResults(patch);
      notify(
        visibility === "public"
          ? "Arquivo público: qualquer pessoa com o link pode baixar."
          : "Arquivo privado: só pessoas com acesso a esta pasta podem baixar.",
      );
    });
  }
  async function copyLink(file: DriveFile) {
    try {
      await navigator.clipboard.writeText(publicFileUrl(file));
      notify("Link público copiado.");
      // Sharing a public link is part of the audit trail.
      void logLinkCopied(file.id).catch(() => {});
    } catch {
      setError(`Copie o link: ${publicFileUrl(file)}`);
    }
  }
  const drop = useFileDrop((files) => void upload(files), canWrite);

  const who = (id: string) =>
    data.members.find((m) => m.user_id === id)?.name ?? "—";
  const nameForm = (label: string) => (
    <form className="drive-name-form" onSubmit={saveEdit}>
      <input
        autoFocus
        aria-label={label}
        value={draft}
        maxLength={255}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
      />
      <Button className="btn primary" loading={!!busyId}>
        Salvar
      </Button>
      <Button
        type="button"
        className="icon-btn"
        aria-label="Cancelar"
        onClick={() => setEditing(null)}
      >
        <X size={15} />
      </Button>
    </form>
  );

  const fileRows = (list: DriveFile[], showPath: boolean) => (
    <div className="panel drive-table-wrap">
      <table className="drive-table">
        <thead>
          <tr>
            <th>Nome</th>
            <th className="hide-mobile">Tamanho</th>
            <th className="hide-mobile">Enviado por</th>
            <th className="hide-mobile hide-narrow">Data</th>
            <th>Acesso</th>
            <th aria-label="Ações" />
          </tr>
        </thead>
        <tbody>
          {list.map((f) => {
            const Icon = iconFor(f.content_type, f.name);
            const owner = isLeader || f.uploaded_by === user;
            const writable =
              isLeader ||
              (!!f.contract_id && canCreateTaskIn(data, f.contract_id, user));
            const renaming = editing?.kind === "file" && editing.id === f.id;
            return (
              <tr key={f.id}>
                <td>
                  {renaming ? (
                    nameForm(`Novo nome de ${f.name}`)
                  ) : (
                    <span className="drive-row-name">
                      <Icon size={17} aria-hidden="true" />
                      <button
                        type="button"
                        className="drive-file-name"
                        title="Visualizar"
                        onClick={() =>
                          setViewer({ list, index: list.indexOf(f) })
                        }
                      >
                        {f.name}
                      </button>
                    </span>
                  )}
                  {showPath && (
                    <small className="drive-row-path">{pathOf(f)}</small>
                  )}
                  <small className="show-mobile">
                    {formatBytes(f.size_bytes)} · {who(f.uploaded_by)}
                  </small>
                </td>
                <td className="hide-mobile">{formatBytes(f.size_bytes)}</td>
                <td className="hide-mobile">{who(f.uploaded_by)}</td>
                <td className="hide-mobile hide-narrow">
                  {new Date(f.created_at).toLocaleDateString("pt-BR")}
                </td>
                <td>
                  {owner ? (
                    <Select
                      aria-label={`Acesso de ${f.name}`}
                      className={`visibility-select ${f.visibility}`}
                      value={f.visibility}
                      disabled={busyId === f.id}
                      onValueChange={(v) =>
                        void changeVisibility(f, v as DriveVisibility)
                      }
                    >
                      <SelectOption value="private">Privado</SelectOption>
                      <SelectOption value="public">Público</SelectOption>
                    </Select>
                  ) : (
                    <span className={`visibility-badge ${f.visibility}`}>
                      {f.visibility === "public" ? (
                        <Globe size={12} />
                      ) : (
                        <Lock size={12} />
                      )}
                      {f.visibility === "public" ? "Público" : "Privado"}
                    </span>
                  )}
                </td>
                <td>
                  <span className="drive-actions">
                    <Button
                      className="icon-btn"
                      aria-label={`Visualizar ${f.name}`}
                      title="Visualizar"
                      disabled={busyId === f.id}
                      onClick={() =>
                        setViewer({ list, index: list.indexOf(f) })
                      }
                    >
                      <Eye size={15} />
                    </Button>
                    <Button
                      className="icon-btn"
                      aria-label={`Baixar ${f.name}`}
                      title="Baixar"
                      disabled={busyId === f.id}
                      onClick={() => void run(f.id, () => openDriveFile(f.id))}
                    >
                      <Download size={15} />
                    </Button>
                    {f.visibility === "public" && (
                      <Button
                        className="icon-btn"
                        aria-label={`Copiar link público de ${f.name}`}
                        title="Copiar link público"
                        onClick={() => void copyLink(f)}
                      >
                        <Link2 size={15} />
                      </Button>
                    )}
                    {writable && !showPath && (
                      <Button
                        className="icon-btn"
                        aria-label={`Renomear ${f.name}`}
                        title="Renomear"
                        onClick={() =>
                          startEdit({ kind: "file", id: f.id }, f.name)
                        }
                      >
                        <Pencil size={14} />
                      </Button>
                    )}
                    {owner && (
                      <Button
                        className="icon-btn"
                        aria-label={`Excluir ${f.name}`}
                        title="Excluir"
                        disabled={busyId === f.id}
                        onClick={() => void removeFile(f)}
                      >
                        <Trash2 size={15} />
                      </Button>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const folderCard = (
    key: string,
    title: string,
    icon: "client" | "product" | "folder" | "recordings",
    open: () => void,
    color?: string,
    actions?: {
      rename?: () => void;
      remove?: () => void;
      share?: () => void;
    },
    isPublic = false,
    where = "",
  ) => {
    const Icon =
      icon === "client"
        ? Building2
        : icon === "product"
          ? Package
          : icon === "recordings"
            ? Video
            : Folder;
    return (
      <div className="drive-folder-card" key={key}>
        <button type="button" className="drive-folder" onClick={open}>
          <Icon
            size={20}
            style={{ color: color ?? "#9eb975" }}
            fill={icon === "folder" ? "currentColor" : "none"}
            fillOpacity={0.18}
          />
          <span>
            <strong>{title}</strong>
            <small>
              {icon === "client"
                ? "Cliente"
                : icon === "product"
                  ? "Produto"
                  : icon === "recordings"
                    ? `${recordingCount} ${recordingCount === 1 ? "reunião gravada" : "reuniões gravadas"}`
                    : "Pasta"}
              {isPublic && (
                <span className="drive-folder-badge" title="Link público ativo">
                  {" · "}
                  <Globe size={11} aria-hidden="true" /> Pública
                </span>
              )}
            </small>
            {where && (
              <small className="drive-folder-path" title={where}>
                {where}
              </small>
            )}
          </span>
        </button>
        {(actions?.rename || actions?.remove || actions?.share) && (
          <span className="drive-folder-actions">
            {actions.share && (
              <Button
                className="icon-btn"
                aria-label={`Compartilhar ${title}`}
                title="Compartilhar"
                onClick={actions.share}
              >
                <Share2 size={13} />
              </Button>
            )}
            {actions.rename && (
              <Button
                className="icon-btn"
                aria-label={`Renomear ${title}`}
                title="Renomear"
                onClick={actions.rename}
              >
                <Pencil size={13} />
              </Button>
            )}
            {actions.remove && (
              <Button
                className="icon-btn"
                aria-label={`Excluir ${title}`}
                title="Excluir pasta vazia"
                onClick={actions.remove}
              >
                <Trash2 size={13} />
              </Button>
            )}
          </span>
        )}
      </div>
    );
  };

  // Reached through a share, without access to the client: the path shown
  // starts at the shared folder, not at a client the person can't open.
  const viaShare =
    !root && !!place.client && !data.clients.some((c) => c.id === place.client);
  const empty =
    !(!at.client && !at.folder && sharedWithMe.length) &&
    !clients.length &&
    !products.length &&
    !recordingCount &&
    !subfolders.length &&
    files !== null &&
    !files.length &&
    editing?.kind !== "new-folder";

  return (
    <div
      className={`drive-page ${drop.active ? "dragging" : ""}`}
      {...drop.handlers}
    >
      {!at.recordings && (
        <div className="drive-toolbar">
          <span className="drive-search">
            <Input
              type="search"
              aria-label={
                root
                  ? "Buscar arquivos e pastas deste cliente"
                  : "Buscar arquivos e pastas"
              }
              placeholder={
                root
                  ? "Buscar arquivos e pastas deste cliente"
                  : "Buscar arquivos e pastas"
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              icon={Search}
            />
          </span>
          {canWrite && !searching && (
            <div className="drive-upload-controls">
              <Button
                className="btn secondary"
                onClick={() => startEdit({ kind: "new-folder" })}
              >
                <FolderPlus size={16} /> Nova pasta
              </Button>
              <Select
                aria-label="Visibilidade dos novos arquivos"
                value={newVisibility}
                onValueChange={(v) => setNewVisibility(v as DriveVisibility)}
              >
                <SelectOption value="private">Enviar como privado</SelectOption>
                <SelectOption value="public">Enviar como público</SelectOption>
              </Select>
              <Button
                className="btn primary"
                onClick={() => input.current?.click()}
              >
                <CloudUpload size={17} /> Enviar arquivos
              </Button>
              <input
                ref={input}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) void upload(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
          )}
        </div>
      )}

      <nav className="drive-breadcrumb" aria-label="Pasta atual">
        {!root && (
          <button type="button" onClick={() => go({})}>
            Drive
          </button>
        )}
        {viaShare && !searching && (
          <>
            <ChevronRight size={15} aria-hidden="true" />
            <span>Compartilhadas comigo</span>
          </>
        )}
        {!viaShare && (root || (!searching && at.client)) && (
          <>
            {!root && <ChevronRight size={15} aria-hidden="true" />}
            <button type="button" onClick={() => go({ client: at.client })}>
              {clientName(at.client)}
            </button>
          </>
        )}
        {!viaShare && !searching && place.contract && (
          <>
            <ChevronRight size={15} aria-hidden="true" />
            <button
              type="button"
              onClick={() =>
                go({ client: place.client, contract: place.contract })
              }
            >
              {contractProductLabel(data, place.contract)}
            </button>
          </>
        )}
        {!searching &&
          chainOf(at.folder).map((f) => (
            <span key={f.id} className="drive-crumb">
              <ChevronRight size={15} aria-hidden="true" />
              <button
                type="button"
                onClick={() =>
                  go({
                    client: f.client_id ?? undefined,
                    contract: f.contract_id ?? undefined,
                    folder: f.id,
                  })
                }
              >
                {f.name}
              </button>
            </span>
          ))}
        {!searching && at.recordings && (
          <>
            <ChevronRight size={15} aria-hidden="true" />
            <span>Gravações da MAVI</span>
          </>
        )}
        {searching && (
          <>
            <ChevronRight size={15} aria-hidden="true" />
            <span>Resultados da busca</span>
          </>
        )}
      </nav>

      {!canWrite && !searching && !at.recordings && (
        <p className="drive-readonly" role="note">
          <Lock size={13} />
          {place.client
            ? "Entre na pasta de um produto para criar pastas e enviar arquivos. Aqui, só administradores e gestores fazem alterações."
            : "Entre em um cliente e depois em um produto para criar pastas e enviar arquivos. Aqui, só administradores e gestores fazem alterações."}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {uploads.length > 0 && (
        <div className="panel drive-uploads" aria-live="polite">
          {uploads.map((u) => (
            <div key={u.key} className="drive-upload-row">
              <CloudUpload size={16} />
              <span>
                <strong>{u.name}</strong>
                {u.error ? (
                  <small className="drive-upload-error">{u.error}</small>
                ) : (
                  <progress value={u.progress} max={1} />
                )}
              </span>
              {u.error && (
                <Button
                  className="icon-btn"
                  aria-label={`Dispensar ${u.name}`}
                  onClick={() =>
                    setUploads((list) => list.filter((x) => x.key !== u.key))
                  }
                >
                  <X size={15} />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {at.recordings && at.client ? (
        <MeetingRecordings
          key={at.client}
          company={company}
          client={at.client}
          clientName={clientName(at.client)}
          data={data}
          user={user}
          isLeader={isLeader}
          notify={notify}
          onNewTask={onNewTask}
          initial={openRecording}
        />
      ) : searching ? (
        <>
          {folderMatches.length > 0 && (
            <Paged
              items={folderMatches}
              pageSize={48}
              noun="pastas"
              resetKey={query}
            >
              {(page) => (
                <div className="drive-folders">
                  {page.map((m) =>
                    folderCard(
                      m.key,
                      m.name,
                      m.kind,
                      () => go(m.at),
                      m.color,
                      undefined,
                      m.folder?.visibility === "public",
                      whereOf(m),
                    ),
                  )}
                </div>
              )}
            </Paged>
          )}
          {results === null ? (
            <Loading compact />
          ) : results.length ? (
            <Paged
              items={results}
              pageSize={50}
              noun="arquivos"
              resetKey={query}
            >
              {(page) => fileRows(page, true)}
            </Paged>
          ) : (
            !folderMatches.length && (
              <div className="panel drive-empty">
                <Empty
                  title="Nada encontrado"
                  body={
                    root
                      ? "A busca considera os arquivos e as pastas deste cliente que você acessa."
                      : "A busca considera os arquivos e as pastas que você acessa."
                  }
                />
              </div>
            )
          )}
        </>
      ) : (
        <>
          {(clients.length > 0 ||
            products.length > 0 ||
            recordingCount > 0 ||
            subfolders.length > 0 ||
            editing?.kind === "new-folder") && (
            <Paged
              items={
                [
                  ...clients.map(
                    (c) => () =>
                      folderCard(
                        c.id,
                        c.name,
                        "client",
                        () => go({ client: c.id }),
                        c.color,
                      ),
                  ),
                  ...(showsProducts && recordingCount > 0
                    ? [
                        () =>
                          folderCard(
                            "recordings",
                            "Gravações da MAVI",
                            "recordings",
                            () => go({ client: at.client, recordings: true }),
                            "#2d5a8c",
                          ),
                      ]
                    : []),
                  ...products.map(
                    (k) => () =>
                      folderCard(
                        k.id,
                        contractProductLabel(data, k.id),
                        "product",
                        () => go({ client: k.client_id, contract: k.id }),
                        data.products.find((p) => p.id === k.product_id)?.color,
                      ),
                  ),
                  ...subfolders.map(
                    (f) => () =>
                      editing?.kind === "folder" && editing.id === f.id ? (
                        <div className="drive-folder-card editing" key={f.id}>
                          {nameForm(`Novo nome de ${f.name}`)}
                        </div>
                      ) : (
                        folderCard(
                          f.id,
                          f.name,
                          "folder",
                          () =>
                            go({
                              client: f.client_id ?? undefined,
                              contract: f.contract_id ?? undefined,
                              folder: f.id,
                            }),
                          undefined,
                          {
                            rename: canWrite
                              ? () =>
                                  startEdit(
                                    { kind: "folder", id: f.id },
                                    f.name,
                                  )
                              : undefined,
                            remove:
                              canWrite && (isLeader || f.created_by === user)
                                ? () => void removeFolder(f)
                                : undefined,
                            // Same rule as the database: creator or leader.
                            share:
                              shareableFolder(f) &&
                              (isLeader || f.created_by === user)
                                ? () => setSharing(f)
                                : undefined,
                          },
                          f.visibility === "public",
                        )
                      ),
                  ),
                ] as (() => ReactNode)[]
              }
              pageSize={48}
              noun={clients.length ? "clientes" : "pastas"}
              resetKey={locationKey}
            >
              {(page) => (
                <div className="drive-folders">
                  {editing?.kind === "new-folder" && (
                    <div className="drive-folder-card editing">
                      {nameForm("Nome da nova pasta")}
                    </div>
                  )}
                  {page.map((card) => card())}
                </div>
              )}
            </Paged>
          )}
          {!root && !at.client && !at.folder && sharedWithMe.length > 0 && (
            <section
              className="drive-shared"
              aria-label="Pastas compartilhadas com você"
            >
              <h3>Compartilhadas comigo</h3>
              <div className="drive-folders">
                {sharedWithMe.map((f) =>
                  folderCard(`shared-${f.id}`, f.name, "folder", () =>
                    go({
                      client: f.client_id ?? undefined,
                      contract: f.contract_id ?? undefined,
                      folder: f.id,
                    }),
                  ),
                )}
              </div>
            </section>
          )}
          {files === null ? (
            <Loading compact />
          ) : files.length ? (
            <Paged
              items={files}
              pageSize={50}
              noun="arquivos"
              resetKey={locationKey}
            >
              {(page) => fileRows(page, false)}
            </Paged>
          ) : empty ? (
            <div className="panel drive-empty">
              <Empty
                title={
                  !at.client && !at.folder
                    ? "Nenhum cliente por aqui"
                    : "Pasta vazia"
                }
                body={
                  canWrite
                    ? "Arraste arquivos para esta área, use Enviar arquivos ou crie uma pasta."
                    : "Ainda não há itens nesta pasta."
                }
              />
            </div>
          ) : null}
        </>
      )}
      {sharing && (
        <ShareFolderDialog
          folder={sharing}
          data={data}
          user={user}
          notify={notify}
          onClose={() => setSharing(null)}
          onSaved={(saved) =>
            setFolders((list) =>
              list.map((f) =>
                f.id === sharing.id
                  ? {
                      ...f,
                      visibility: saved.visibility,
                      share_token: saved.share_token,
                    }
                  : f,
              ),
            )
          }
        />
      )}
      {viewer && (
        <FileViewer
          files={viewer.list.map((f) => ({
            key: f.id,
            name: f.name,
            contentType: f.content_type,
            size: f.size_bytes,
            load: () => driveViewUrl(f.id),
            download: () => openDriveFile(f.id),
            openOriginal: () => openDriveFile(f.id, true),
          }))}
          start={viewer.index}
          onClose={() => setViewer(null)}
        />
      )}
      {drop.active && (
        <DropOverlay
          label="Solte para enviar a esta pasta"
          hint={
            newVisibility === "public"
              ? "Os arquivos ficam públicos (acesso por link)"
              : "Os arquivos ficam privados"
          }
        />
      )}
    </div>
  );
}
