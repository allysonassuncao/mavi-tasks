import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  BookMarked,
  BotMessageSquare,
  NotebookPen,
  Building2,
  ChevronRight,
  CloudUpload,
  Download,
  Eye,
  EllipsisVertical,
  Folder,
  FolderInput,
  FolderPlus,
  Globe,
  LayoutGrid,
  List,
  Share2,
  History,
  Link2,
  Lock,
  Package,
  Pencil,
  Search,
  Palette,
  Thermometer,
  Radar,
  Trash2,
  Video,
  MessageCircle,
  X,
} from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import { Button, Checkbox, Input, Select, SelectOption, Loading } from "./ui";
import { Empty } from "./components";
import { Paged } from "./Pagination";
import { DropOverlay, useFileDrop } from "./useFileDrop";
import { useMarqueeSelect } from "./useMarqueeSelect";
import { ShareFolderDialog } from "./ShareFolderDialog";
import { DriveThumb, FileTypeIcon } from "./DriveThumb";
import { thumbAfterUpload, useDriveThumbs } from "./drive-thumbs";
import type {
  DriveFile,
  DriveFolder,
  DriveLocation,
  DriveMovePreview,
  DriveVisibility,
  Snapshot,
} from "./types";
import { canCreateTaskIn, contractProductLabel } from "./domain";
import { DriveAudit, DriveItemHistory } from "./DriveAudit";
import { DriveMoveDialog, canWriteAt, moveWarnings } from "./DriveMoveDialog";
import { FileViewer } from "./FileViewer";
import { MeetingRecordings } from "./MeetingRecordings";
import { countMeetingRecordings, meetingRecording } from "./meetings";
import { WhatsappFolder } from "./WhatsappFolder";
import { ClientDossier } from "./ClientDossier";
import { ClientTemperature } from "./ClientTemperature";
import { ClientRadar } from "./ClientRadar";
import { BrandKit } from "./BrandKit";
import { ClientNotes } from "./ClientNotes";
import { countClientNotes, getClientNote } from "./client-notes";
import { countAgents } from "./agents";
// Agente Conversacional (dentro do produto): carrega só quando abre.
const AgentFolder = lazy(() =>
  import("./AgentsPage").then((m) => ({ default: m.AgentFolder })),
);
import {
  countClientGroups,
  whatsappGroupById,
  whatsappMessageById,
  type WhatsappMessage,
} from "./whatsapp";
import {
  driveLocationFromPath,
  driveUrl,
  navigate,
  routeParts,
  useLocation,
} from "./router";
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
  moveDriveItems,
  previewDriveMove,
  type DriveMoveItems,
} from "./drive";

type Upload = { key: string; name: string; progress: number; error?: string };
/** A janela de mover: o que vai, e (arrastar e soltar) o destino já conferido. */
type Moving = {
  items: DriveMoveItems;
  label: string;
  fixed?: { at: DriveLocation; preview: DriveMovePreview };
};
const NO_ITEMS: DriveMoveItems = { files: [], folders: [] };
/** O tipo do arrasto interno (não é "Files": não abre o envio de arquivos). */
const DRAG_TYPE = "application/x-mavi-drive";
type Editing =
  | { kind: "new-folder" }
  | { kind: "folder"; id: string }
  | { kind: "file"; id: string }
  | null;

/** Folder listings go by name, Z → A. */
const byNameDesc = (a: { name: string }, b: { name: string }) =>
  b.name.localeCompare(a.name, "pt-BR");

/** Files as thumbnail cards (as in Google Drive) or as a list; each person's choice. */
type FileView = "grid" | "list";
const VIEW_KEY = "mavi.drive.view";
function savedView(): FileView {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
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
  // No Drive, a pasta aberta vive na URL: cada pasta tem o seu endereço, que
  // pode ser compartilhado, e o Voltar do navegador volta à pasta anterior.
  // A aba Drive da tarefa não mexe na URL.
  const location = useLocation();
  const routePath = root ? "" : location.split("?")[0];
  const [localAt, setLocalAt] = useState<DriveLocation>(base);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [foldersReady, setFoldersReady] = useState(false);
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DriveFile[] | null>(null);
  const [searchTick, setSearchTick] = useState(0);
  const [error, setError] = useState("");
  const [newVisibility, setNewVisibility] =
    useState<DriveVisibility>("private");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [busyId, setBusyId] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [draft, setDraft] = useState("");
  const [fileView, setFileView] = useState<FileView>(savedView);
  function pickView(next: FileView) {
    setFileView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Private mode: the choice lasts this visit.
    }
  }
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
  // A custom folder carries its own client/product (the URL has only the folder).
  const routeFolder = routePath
    ? driveLocationFromPath(routePath)?.folder
    : undefined;
  const routeFolderRow = routeFolder ? folderById.get(routeFolder) : undefined;
  const at = useMemo<DriveLocation>(() => {
    if (root) return localAt;
    const routed = driveLocationFromPath(routePath) ?? {};
    return routed.folder
      ? {
          folder: routed.folder,
          client: routeFolderRow?.client_id ?? undefined,
          contract: routeFolderRow?.contract_id ?? undefined,
        }
      : routed;
  }, [
    root,
    localAt,
    routePath,
    routeFolderRow?.client_id,
    routeFolderRow?.contract_id,
  ]);
  const current = at.folder ? folderById.get(at.folder) : undefined;
  // Um link de pasta apagada ou de outra pessoa, sem compartilhamento.
  const missingFolder = !!at.folder && foldersReady && !current;
  const place = at.folder
    ? {
        client: current?.client_id ?? undefined,
        contract: current?.contract_id ?? undefined,
      }
    : at;
  // Pastas virtuais (Gravações da MAVI, Whatsapp, Dossiê da MAVI,
  // Termômetro, Radar, Agente Conversacional): sem arquivos próprios.
  const virtual =
    !!at.recordings ||
    !!at.whatsapp ||
    !!at.dossier ||
    !!at.temperature ||
    !!at.radar ||
    !!at.brand ||
    !!at.notes ||
    !!at.agent;
  const canWrite =
    !virtual &&
    (isLeader ||
      (!!place.contract && canCreateTaskIn(data, place.contract, user)));

  const loadFolders = useCallback(
    () =>
      listDriveFolders(company)
        .then((list) => {
          setFolders(list);
          setFoldersReady(true);
        })
        .catch((e) => setError((e as Error).message)),
    [company],
  );
  const loadFiles = useCallback(() => {
    // Gravações da MAVI and Whatsapp have no files of their own.
    if (
      at.recordings ||
      at.whatsapp ||
      at.dossier ||
      at.temperature ||
      at.radar ||
      at.brand ||
      at.notes ||
      at.agent
    )
      return setFiles([]);
    setFiles(null);
    listDriveFiles(company, at)
      .then((list) => setFiles(list.sort(byNameDesc)))
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
  }, [company, query, root?.client, searchTick]);

  // Gravações da MAVI: how many the client has (its card), and the link of a
  // moment (?gravacao=<id>&t=<s>) opening the recording right there.
  const [recordingCount, setRecordingCount] = useState(0);
  const [openRecording, setOpenRecording] = useState<{
    recording: string;
    start?: number;
  } | null>(null);
  const showsProducts = !!at.client && !at.contract && !at.folder && !virtual;
  // O Termômetro é um módulo: escondido da pessoa, o cartão também some.
  const showsTemperature = !data.members
    .find((m) => m.user_id === user)
    ?.hidden_pages?.includes("temperature");
  // O Radar segue a regra do Drive; escondido o módulo da pessoa, o cartão some.
  // ?radar=<cliente>&item=<item>: o item do Radar (o link da tarefa).
  const [radarItem, setRadarItem] = useState<string | null>(null);
  const showsRadar = !data.members
    .find((m) => m.user_id === user)
    ?.hidden_pages?.includes("radar");
  // Agente Conversacional: dentro do produto, quando ele tem fluxos do n8n
  // ligados ou é o produto MAVI (e o módulo não está escondido da pessoa).
  const [agentCount, setAgentCount] = useState(0);
  const atContract = !!at.contract && !at.folder && !virtual;
  const maviProduct =
    atContract &&
    /^\s*mavi\s*$/i.test(
      data.products.find(
        (p) =>
          p.id === data.contracts.find((k) => k.id === at.contract)?.product_id,
      )?.name ?? "",
    );
  const showsAgent =
    atContract &&
    (agentCount > 0 || maviProduct) &&
    !data.members
      .find((m) => m.user_id === user)
      ?.hidden_pages?.includes("agents");
  // Whatsapp: quantos grupos o cliente tem (o cartão) e o link de uma
  // mensagem (?whatsapp=<grupo>&msg=<mensagem>).
  const [groupCount, setGroupCount] = useState(0);
  // Anotações: quantas o cliente tem (o cartão) e a do link ?nota=<id>.
  const [noteCount, setNoteCount] = useState(0);
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [openWhatsapp, setOpenWhatsapp] = useState<{
    group: string;
    message?: WhatsappMessage;
  } | null>(null);
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
  useEffect(() => {
    setNoteCount(0);
    if (!showsProducts || !at.client) return;
    const client = at.client;
    let alive = true;
    const load = () =>
      countClientNotes(company, client)
        .then((n) => alive && setNoteCount(n))
        .catch(() => {});
    void load();
    const onNotice = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      if (!d.client || d.client === client) void load();
    };
    window.addEventListener("mavi:client-notes", onNotice);
    return () => {
      alive = false;
      window.removeEventListener("mavi:client-notes", onNotice);
    };
  }, [company, at.client, showsProducts]);
  useEffect(() => {
    setAgentCount(0);
    if (!atContract || !at.contract) return;
    let alive = true;
    countAgents(company, at.contract)
      .then((n) => alive && setAgentCount(n))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [company, at.contract, atContract]);
  useEffect(() => {
    setGroupCount(0);
    if (!showsProducts || !at.client) return;
    let alive = true;
    countClientGroups(company, at.client)
      .then((n) => alive && setGroupCount(n))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [company, at.client, showsProducts]);
  // Links de outras telas (fontes citadas pela IA, tarefas):
  // ?gravacao=<id>&t=<s> abre a gravação; ?arquivo=<id> abre o arquivo.
  useEffect(() => {
    // Leva à pasta pelo endereço dela, trocando o link de origem.
    const setAt = (next: DriveLocation) =>
      navigate(
        driveUrl(next, routeParts(window.location.pathname).company),
        true,
      );
    if (root) return;
    const params = new URLSearchParams(location.split("?")[1] ?? "");
    const recording = params.get("gravacao");
    const fileId = params.get("arquivo");
    const group = params.get("whatsapp");
    const message = params.get("msg");
    // ?termometro=<cliente>: o aviso de que o cliente esfriou.
    const thermo = params.get("termometro");
    // ?radar=<cliente>: a aba Radar do cliente.
    const radar = params.get("radar");
    // ?nota=<id>: uma anotação do cliente.
    const note = params.get("nota");
    if (!recording && !fileId && !group && !thermo && !radar && !note) return;
    const start = Number(params.get("t")) || undefined;
    navigate(window.location.pathname, true);
    // O acesso é conferido pelo banco, ao abrir o termômetro.
    if (thermo) setAt({ client: thermo, temperature: true });
    else if (note)
      getClientNote(note)
        .then((n) => {
          setAt({ client: n.client_id, notes: true });
          setOpenNote(n.id);
        })
        .catch(() => setError("Anotação não encontrada ou sem acesso."));
    else if (radar) {
      setAt({ client: radar, radar: true });
      setRadarItem(params.get("item"));
    }
    else if (group)
      Promise.all([
        whatsappGroupById(group),
        message ? whatsappMessageById(message) : null,
      ])
        .then(([g, m]) => {
          if (!g?.client_id)
            throw Error("Grupo do Whatsapp não encontrado ou sem acesso.");
          setAt({ client: g.client_id, whatsapp: true });
          setOpenWhatsapp({ group: g.id, message: m ?? undefined });
        })
        .catch((e) => setError((e as Error).message));
    else if (recording)
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
    setOpenWhatsapp(null);
    setOpenNote(null);
    if (root) setLocalAt(next.client ? next : base);
    else
      navigate(driveUrl(next, routeParts(window.location.pathname).company));
    setEditing(null);
    setQuery("");
    setError("");
  }
  // Voltar/Avançar do navegador troca de pasta: fecha o que estava aberto.
  useEffect(() => {
    if (root) return;
    const reset = () => {
      setOpenRecording(null);
      setOpenWhatsapp(null);
      setOpenNote(null);
      setEditing(null);
      setQuery("");
      setError("");
    };
    window.addEventListener("popstate", reset);
    return () => window.removeEventListener("popstate", reset);
  }, [root]);
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
  const locationKey = [
    at.client,
    at.contract,
    at.folder,
    at.recordings,
    at.whatsapp,
    at.dossier,
    at.temperature,
    at.radar,
    at.brand,
    at.notes,
    at.agent,
  ].join("|");
  const clients =
    !at.client && !at.folder
      ? data.clients.filter((c) => !c.archived).sort(byNameDesc)
      : [];
  const products = showsProducts
    ? data.contracts
        .filter((k) => k.client_id === at.client && !k.archived)
        .map((k) => ({ ...k, name: contractProductLabel(data, k.id) }))
        .sort(byNameDesc)
    : [];
  const subfolders = virtual
    ? []
    : folders
        .filter((f) =>
          at.folder
            ? f.parent_id === at.folder
            : !f.parent_id &&
              (f.client_id ?? undefined) === at.client &&
              (f.contract_id ?? undefined) === at.contract,
        )
        .sort(byNameDesc);

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
        const id = await uploadDriveFile(
          company,
          target,
          file,
          newVisibility,
          (progress) =>
            setUploads((u) =>
              u.map((x) => (x.key === key ? { ...x, progress } : x)),
            ),
        );
        thumbAfterUpload(id, file);
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

  // Mover: vários de uma vez (seleção), pelo menu ou arrastando até uma pasta.
  const [selected, setSelected] = useState<DriveMoveItems>(NO_ITEMS);
  const [moving, setMoving] = useState<Moving | null>(null);
  const [history, setHistory] = useState<{
    file?: string;
    folder?: string;
    name: string;
  } | null>(null);
  const [dragging, setDragging] = useState<DriveMoveItems | null>(null);
  const [dropKey, setDropKey] = useState("");
  useEffect(() => setSelected(NO_ITEMS), [locationKey, query]);
  const selectedCount = selected.files.length + selected.folders.length;
  const isSelected = (kind: keyof DriveMoveItems, id: string) =>
    selected[kind].includes(id);
  const toggleSelected = (kind: keyof DriveMoveItems, id: string) =>
    setSelected((s) => ({
      ...s,
      [kind]: s[kind].includes(id)
        ? s[kind].filter((x) => x !== id)
        : [...s[kind], id],
    }));
  /** Um item escolhido leva junto os outros escolhidos. */
  const itemsFor = (kind: keyof DriveMoveItems, id: string): DriveMoveItems =>
    isSelected(kind, id) ? selected : { ...NO_ITEMS, [kind]: [id] };
  function labelOf(items: DriveMoveItems) {
    const n = items.files.length + items.folders.length;
    if (n !== 1) return `${n} itens`;
    const name = items.files.length
      ? [...(files ?? []), ...(results ?? [])].find(
          (f) => f.id === items.files[0],
        )?.name
      : folderById.get(items.folders[0])?.name;
    return name ? `“${name}”` : "1 item";
  }
  const startMove = (items: DriveMoveItems) =>
    setMoving({ items, label: labelOf(items) });
  async function finishMove(result: DriveMovePreview) {
    setMoving(null);
    setSelected(NO_ITEMS);
    notify(`Movido para ${result.to.label}.`);
    await loadFolders();
    loadFiles();
    if (searching) setSearchTick((n) => n + 1);
  }
  async function dropOn(to: DriveLocation) {
    const items = dragging;
    setDragging(null);
    setDropKey("");
    if (!items || (to.folder && items.folders.includes(to.folder))) return;
    setError("");
    try {
      const preview = await previewDriveMove(company, items, to);
      // Sem nada a avisar, move direto; com troca de cliente ou de link, confirma.
      if (moveWarnings(data, preview).length)
        setMoving({ items, label: labelOf(items), fixed: { at: to, preview } });
      else await finishMove(await moveDriveItems(company, items, to));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const dragSource = (items: () => DriveMoveItems, allowed: boolean) =>
    allowed
      ? {
          draggable: true,
          onDragStart(e: DragEvent) {
            const list = items();
            setDragging(list);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(list));
          },
          onDragEnd() {
            setDragging(null);
            setDropKey("");
          },
        }
      : {};
  /** Uma pasta (ou um nível do caminho) que recebe o que se arrasta. */
  const dropTarget = (key: string, to: DriveLocation, allowed: boolean) =>
    dragging &&
    allowed &&
    !(to.folder && dragging.folders.includes(to.folder))
      ? {
          "data-drop-target": dropKey === key ? "over" : "ok",
          onDragOver(e: DragEvent) {
            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (dropKey !== key) setDropKey(key);
          },
          onDragLeave(e: DragEvent) {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null))
              setDropKey((k) => (k === key ? "" : k));
          },
          onDrop(e: DragEvent) {
            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            void dropOn(to);
          },
        }
      : {};
  const writableAt = (contract: string | null | undefined) =>
    canWriteAt(data, user, isLeader, contract);
  // O que dá para escolher na tela: arquivos que a pessoa edita e, fora da
  // busca, as pastas daqui (a mesma regra de renomear).
  const movableFiles = (searching ? (results ?? []) : (files ?? [])).filter(
    (f) => writableAt(f.contract_id),
  );
  const movableFolders = !searching && canWrite ? subfolders : [];
  const selectAll = () =>
    setSelected({
      files: movableFiles.map((f) => f.id),
      folders: movableFolders.map((f) => f.id),
    });
  // Clique e arraste no vazio: um retângulo escolhe o que toca.
  const marquee = useMarqueeSelect(
    !virtual && !moving && movableFiles.length + movableFolders.length > 0,
    selected,
    setSelected,
  );
  /** Marca o item para o retângulo de escolha (só os que se movem). */
  const selectable = (kind: keyof DriveMoveItems, id: string, allowed: boolean) =>
    allowed ? { "data-select-kind": kind, "data-select-id": id } : {};

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

  const fileList = (
    list: DriveFile[],
    showPath: boolean,
    thumb: (id: string) => string | undefined,
  ) => (
    <div className="panel drive-table-wrap">
      <table className="drive-table">
        <thead>
          <tr>
            <th className="drive-select-cell">
              {list.some((f) => writableAt(f.contract_id)) && (
                <Checkbox
                  aria-label="Escolher todos os arquivos da página"
                  checked={
                    list.every(
                      (f) =>
                        !writableAt(f.contract_id) || isSelected("files", f.id),
                    )
                      ? true
                      : list.some((f) => isSelected("files", f.id))
                        ? "indeterminate"
                        : false
                  }
                  onCheckedChange={(on) =>
                    setSelected((s) => {
                      const page = list
                        .filter((f) => writableAt(f.contract_id))
                        .map((f) => f.id);
                      const rest = s.files.filter((id) => !page.includes(id));
                      return { ...s, files: on === true ? [...rest, ...page] : rest };
                    })
                  }
                />
              )}
            </th>
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
            const owner = isLeader || f.uploaded_by === user;
            const writable =
              isLeader ||
              (!!f.contract_id && canCreateTaskIn(data, f.contract_id, user));
            const renaming = editing?.kind === "file" && editing.id === f.id;
            return (
              <tr
                key={f.id}
                className={isSelected("files", f.id) ? "selected" : ""}
                {...selectable("files", f.id, writable)}
                {...dragSource(
                  () => itemsFor("files", f.id),
                  writable && !renaming,
                )}
              >
                <td className="drive-select-cell">
                  {writable && (
                    <Checkbox
                      aria-label={`Escolher ${f.name}`}
                      checked={isSelected("files", f.id)}
                      onCheckedChange={() => toggleSelected("files", f.id)}
                    />
                  )}
                </td>
                <td>
                  {renaming ? (
                    nameForm(`Novo nome de ${f.name}`)
                  ) : (
                    <span className="drive-row-name">
                      <DriveThumb file={f} url={thumb(f.id)} variant="row" />
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
                    {formatBytes(f.size_bytes)} ·{" "}
                    <span data-person={f.uploaded_by}>{who(f.uploaded_by)}</span>
                  </small>
                </td>
                <td className="hide-mobile">{formatBytes(f.size_bytes)}</td>
                <td className="hide-mobile">
                  <span data-person={f.uploaded_by}>{who(f.uploaded_by)}</span>
                </td>
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
                    {writable && (
                      <Button
                        className="icon-btn"
                        aria-label={`Mover ${f.name}`}
                        title="Mover para…"
                        disabled={busyId === f.id}
                        onClick={() => startMove(itemsFor("files", f.id))}
                      >
                        <FolderInput size={15} />
                      </Button>
                    )}
                    <Button
                      className="icon-btn"
                      aria-label={`Histórico de ${f.name}`}
                      title="Histórico"
                      onClick={() =>
                        setHistory({ file: f.id, name: f.name })
                      }
                    >
                      <History size={15} />
                    </Button>
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

  const view = (list: DriveFile[], f: DriveFile) =>
    setViewer({ list, index: list.indexOf(f) });
  /** Um item dos menus ⋮ (arquivos e pastas). */
  const item = (
    label: string,
    icon: ReactNode,
    action: () => void,
    danger = false,
  ) => (
    <Popover.Close asChild>
      <button
        type="button"
        className={`drive-menu-item ${danger ? "danger" : ""}`}
        onClick={action}
      >
        {icon}
        {label}
      </button>
    </Popover.Close>
  );
  /** The ⋮ menu of a card: what the list shows as buttons. */
  const fileMenu = (
    list: DriveFile[],
    f: DriveFile,
    owner: boolean,
    writable: boolean,
    renamable: boolean,
  ) => {
    return (
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            className="icon-btn drive-card-more"
            aria-label={`Ações de ${f.name}`}
            title="Mais ações"
            disabled={busyId === f.id}
          >
            <EllipsisVertical size={16} />
          </button>
        </Popover.Trigger>
        {/* Not portaled: it must work inside the task dialog too. */}
        <Popover.Content
          className="drive-menu"
          align="end"
          sideOffset={4}
          collisionPadding={12}
        >
          {item("Visualizar", <Eye size={15} />, () => view(list, f))}
          {item(
            "Baixar",
            <Download size={15} />,
            () => void run(f.id, () => openDriveFile(f.id)),
          )}
          {f.visibility === "public" &&
            item(
              "Copiar link público",
              <Link2 size={15} />,
              () => void copyLink(f),
            )}
          {renamable &&
            item("Renomear", <Pencil size={14} />, () =>
              startEdit({ kind: "file", id: f.id }, f.name),
            )}
          {writable &&
            item("Mover para…", <FolderInput size={15} />, () =>
              startMove(itemsFor("files", f.id)),
            )}
          {item("Histórico", <History size={15} />, () =>
            setHistory({ file: f.id, name: f.name }),
          )}
          {owner &&
            (f.visibility === "public"
              ? item(
                  "Tornar privado",
                  <Lock size={15} />,
                  () => void changeVisibility(f, "private"),
                )
              : item(
                  "Tornar público",
                  <Globe size={15} />,
                  () => void changeVisibility(f, "public"),
                ))}
          {owner && (
            <>
              <hr />
              {item(
                "Excluir",
                <Trash2 size={15} />,
                () => void removeFile(f),
                true,
              )}
            </>
          )}
        </Popover.Content>
      </Popover.Root>
    );
  };
  /** Thumbnail cards, as in Google Drive. */
  const fileGrid = (
    list: DriveFile[],
    showPath: boolean,
    thumb: (id: string) => string | undefined,
  ) => (
    <div className="drive-cards">
      {list.map((f) => {
        const owner = isLeader || f.uploaded_by === user;
        const writable =
          isLeader ||
          (!!f.contract_id && canCreateTaskIn(data, f.contract_id, user));
        const renaming = editing?.kind === "file" && editing.id === f.id;
        return (
          <div
            key={f.id}
            className={`drive-card ${busyId === f.id ? "busy" : ""} ${
              isSelected("files", f.id) ? "selected" : ""
            }`}
            {...selectable("files", f.id, writable)}
            {...dragSource(() => itemsFor("files", f.id), writable && !renaming)}
          >
            <div className="drive-card-head">
              {renaming ? (
                nameForm(`Novo nome de ${f.name}`)
              ) : (
                <>
                  {writable && (
                    <Checkbox
                      className="drive-select"
                      aria-label={`Escolher ${f.name}`}
                      checked={isSelected("files", f.id)}
                      onCheckedChange={() => toggleSelected("files", f.id)}
                    />
                  )}
                  <FileTypeIcon file={f} size={16} />
                  <button
                    type="button"
                    className="drive-card-name"
                    title={f.name}
                    onClick={() => view(list, f)}
                  >
                    {f.name}
                  </button>
                  {f.visibility === "public" && (
                    <Globe
                      size={13}
                      className="drive-card-public"
                      aria-label="Público"
                    />
                  )}
                  {fileMenu(list, f, owner, writable, writable && !showPath)}
                </>
              )}
            </div>
            <button
              type="button"
              className="drive-card-preview"
              aria-label={`Visualizar ${f.name}`}
              onClick={() => view(list, f)}
            >
              <DriveThumb file={f} url={thumb(f.id)} variant="card" />
            </button>
            <small
              className="drive-card-meta"
              title={showPath ? pathOf(f) : undefined}
            >
              {showPath
                ? pathOf(f)
                : `${formatBytes(f.size_bytes)} · ${who(f.uploaded_by)} · ${new Date(
                    f.created_at,
                  ).toLocaleDateString("pt-BR")}`}
            </small>
          </div>
        );
      })}
    </div>
  );
  const fileRows = (list: DriveFile[], showPath: boolean) => (
    <DriveThumbs files={list}>
      {(thumb) =>
        fileView === "grid"
          ? fileGrid(list, showPath, thumb)
          : fileList(list, showPath, thumb)
      }
    </DriveThumbs>
  );

  const folderCard = (
    key: string,
    title: string,
    icon:
      | "client"
      | "product"
      | "folder"
      | "recordings"
      | "whatsapp"
      | "dossier"
      | "temperature"
      | "radar"
      | "brand"
      | "notes"
      | "agent",
    open: () => void,
    color?: string,
    actions?: {
      rename?: () => void;
      remove?: () => void;
      share?: () => void;
      move?: () => void;
      history?: () => void;
    },
    isPublic = false,
    where = "",
    /** Arrastar e soltar, e a caixa de escolher (pastas que se movem). */
    more?: { props?: object; select?: ReactNode; selected?: boolean },
  ) => {
    const Icon =
      icon === "client"
        ? Building2
        : icon === "product"
          ? Package
          : icon === "recordings"
            ? Video
            : icon === "whatsapp"
              ? MessageCircle
              : icon === "dossier"
                ? BookMarked
                : icon === "temperature"
                  ? Thermometer
                  : icon === "radar"
                    ? Radar
                  : icon === "brand"
                    ? Palette
                    : icon === "notes"
                      ? NotebookPen
                      : icon === "agent"
                        ? BotMessageSquare
                        : Folder;
    const detail =
      icon === "client"
        ? "Cliente"
        : icon === "product"
          ? "Produto"
          : icon === "recordings"
            ? `${recordingCount} ${recordingCount === 1 ? "reunião gravada" : "reuniões gravadas"}`
            : icon === "whatsapp"
              ? `${groupCount} ${groupCount === 1 ? "grupo" : "grupos"}`
              : icon === "dossier"
                ? "Gostos, regras e histórico"
                : icon === "temperature"
                  ? "Temperatura da relação"
                  : icon === "radar"
                    ? "Problemas e promessas"
                    : icon === "brand"
                      ? "Logos, fontes e cores"
                      : icon === "notes"
                        ? noteCount
                          ? `${noteCount} ${noteCount === 1 ? "anotação" : "anotações"}`
                          : "Acessos, links e combinados"
                        : icon === "agent"
                          ? agentCount
                            ? `${agentCount} ${agentCount === 1 ? "fluxo do n8n" : "fluxos do n8n"}`
                            : "Prompt do assistente de WhatsApp"
                          : "Pasta";
    const hasMenu = !!(
      actions?.rename ||
      actions?.remove ||
      actions?.share ||
      actions?.move ||
      actions?.history
    );
    return (
      <div
        className={`drive-folder-card ${more?.selected ? "selected" : ""} ${
          more?.select ? "has-select" : ""
        } ${hasMenu ? "has-menu" : ""}`}
        key={key}
        {...more?.props}
      >
        {more?.select}
        <button type="button" className="drive-folder" onClick={open}>
          <Icon
            className="drive-folder-icon"
            size={20}
            style={{ color: color ?? "#9eb975" }}
            fill={icon === "folder" ? "currentColor" : "none"}
            fillOpacity={0.18}
          />
          <span>
            <strong title={title}>{title}</strong>
            <small className="drive-folder-detail">
              {detail}
              {isPublic && (
                <>
                  {" · "}
                  <span
                    className="drive-folder-badge"
                    title="Link público ativo"
                  >
                    <Globe size={11} aria-hidden="true" /> Pública
                  </span>
                </>
              )}
            </small>
            {where && (
              <small className="drive-folder-path" title={where}>
                {where}
              </small>
            )}
          </span>
        </button>
        {hasMenu && (
          <Popover.Root>
            <Popover.Trigger asChild>
              <button
                type="button"
                className="icon-btn drive-folder-more"
                aria-label={`Ações de ${title}`}
                title="Mais ações"
              >
                <EllipsisVertical size={16} />
              </button>
            </Popover.Trigger>
            {/* Not portaled: it must work inside the task dialog too. */}
            <Popover.Content
              className="drive-menu"
              align="end"
              sideOffset={4}
              collisionPadding={12}
            >
              {actions?.share &&
                item("Compartilhar", <Share2 size={15} />, actions.share)}
              {actions?.move &&
                item("Mover para…", <FolderInput size={15} />, actions.move)}
              {actions?.rename &&
                item("Renomear", <Pencil size={14} />, actions.rename)}
              {actions?.history &&
                item("Histórico", <History size={15} />, actions.history)}
              {actions?.remove && (
                <>
                  <hr />
                  {item(
                    "Excluir pasta vazia",
                    <Trash2 size={15} />,
                    actions.remove,
                    true,
                  )}
                </>
              )}
            </Popover.Content>
          </Popover.Root>
        )}
      </div>
    );
  };
  /** Pastas, produtos e clientes seguem a mesma Grade/Lista dos arquivos. */
  const foldersClass = `drive-folders ${fileView === "list" ? "as-list" : ""}`;

  // Reached through a share, without access to the client: the path shown
  // starts at the shared folder, not at a client the person can't open.
  const viaShare =
    !root && !!place.client && !data.clients.some((c) => c.id === place.client);
  const empty =
    !(!at.client && !at.folder && sharedWithMe.length) &&
    !clients.length &&
    !products.length &&
    !recordingCount &&
    !showsAgent &&
    !subfolders.length &&
    files !== null &&
    !files.length &&
    editing?.kind !== "new-folder";

  return (
    <div
      className={`drive-page ${drop.active ? "dragging" : ""} ${
        selectedCount ? "selecting" : ""
      } ${dragging ? "moving" : ""}`}
      {...drop.handlers}
      ref={marquee.ref}
      onPointerDown={marquee.onPointerDown}
    >
      {marquee.box && (
        <div
          className="drive-marquee"
          aria-hidden="true"
          style={{
            left: marquee.box.left,
            top: marquee.box.top,
            width: marquee.box.width,
            height: marquee.box.height,
          }}
        />
      )}
      {!virtual && (
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
          <div
            className="drive-view drive-layout"
            role="group"
            aria-label="Exibir arquivos em"
          >
            <button
              type="button"
              className={fileView === "grid" ? "selected" : ""}
              aria-pressed={fileView === "grid"}
              title="Grade, com miniaturas"
              onClick={() => pickView("grid")}
            >
              <LayoutGrid size={15} />
              <span>Grade</span>
            </button>
            <button
              type="button"
              className={fileView === "list" ? "selected" : ""}
              aria-pressed={fileView === "list"}
              title="Lista"
              onClick={() => pickView("list")}
            >
              <List size={15} />
              <span>Lista</span>
            </button>
          </div>
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
          <button
            type="button"
            onClick={() => go({})}
            {...dropTarget("crumb-root", {}, isLeader && !!(at.client || at.folder))}
          >
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
            <button
              type="button"
              onClick={() => go({ client: at.client })}
              {...dropTarget(
                "crumb-client",
                { client: at.client },
                isLeader && !!(at.contract || at.folder),
              )}
            >
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
              {...dropTarget(
                "crumb-product",
                { client: place.client, contract: place.contract },
                !!at.folder && writableAt(place.contract),
              )}
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
                {...dropTarget(
                  `crumb-${f.id}`,
                  {
                    client: f.client_id ?? undefined,
                    contract: f.contract_id ?? undefined,
                    folder: f.id,
                  },
                  f.id !== at.folder && writableAt(f.contract_id),
                )}
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
        {!searching && at.whatsapp && (
          <>
            <ChevronRight size={15} aria-hidden="true" />
            <span>Whatsapp</span>
          </>
        )}
        {!searching && at.notes && (
          <>
            <ChevronRight size={15} aria-hidden="true" />
            <span>Anotações</span>
          </>
        )}
        {!searching && at.dossier && (
          <>
            <ChevronRight size={15} aria-hidden="true" />
            <span>Dossiê da MAVI</span>
          </>
        )}
        {!searching && at.brand && (
          <>
            <ChevronRight size={15} aria-hidden="true" />
            <span>Marca</span>
          </>
        )}
        {!searching && at.temperature && (
          <>
            <ChevronRight size={15} aria-hidden="true" />
            <span>Termômetro</span>
          </>
        )}
        {!searching && at.radar && (
          <>
            <ChevronRight size={15} aria-hidden="true" />
            <span>Radar</span>
          </>
        )}
        {!searching && at.agent && (
          <>
            <ChevronRight size={15} aria-hidden="true" />
            <span>Agente Conversacional</span>
          </>
        )}
        {searching && (
          <>
            <ChevronRight size={15} aria-hidden="true" />
            <span>Resultados da busca</span>
          </>
        )}
      </nav>

      {selectedCount > 0 && (
        <div
          className="drive-selection"
          role="region"
          aria-label="Itens escolhidos"
        >
          <strong>
            {selectedCount === 1 ? "1 escolhido" : `${selectedCount} escolhidos`}
          </strong>
          <small className="hide-mobile">
            Arraste até uma pasta ou use Mover para… · Shift, Ctrl ou ⌘ somam
            à escolha
          </small>
          {selectedCount < movableFiles.length + movableFolders.length && (
            <Button className="btn secondary" onClick={selectAll}>
              Escolher tudo
            </Button>
          )}
          <Button className="btn primary" onClick={() => startMove(selected)}>
            <FolderInput size={15} /> Mover para…
          </Button>
          <Button
            className="icon-btn"
            aria-label="Limpar escolha"
            title="Limpar escolha"
            onClick={() => setSelected(NO_ITEMS)}
          >
            <X size={15} />
          </Button>
        </div>
      )}

      {!canWrite && !searching && !virtual && (
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
      {missingFolder && !searching && (
        <p className="form-error" role="alert">
          Pasta não encontrada ou sem acesso.
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

      {at.agent && at.client && at.contract ? (
        <Suspense fallback={<Loading variant="table" />}>
          <AgentFolder
            key={at.contract}
            company={company}
            client={at.client}
            contract={at.contract}
            notify={notify}
          />
        </Suspense>
      ) : at.brand && at.client ? (
        <BrandKit
          key={at.client}
          company={company}
          client={at.client}
          clientName={clientName(at.client)}
          notify={notify}
        />
      ) : at.radar && at.client ? (
        <ClientRadar
          key={at.client}
          company={company}
          client={at.client}
          clientName={clientName(at.client)}
          members={data.members}
          isLeader={isLeader}
          data={data}
          user={user}
          onNewTask={onNewTask}
          notify={notify}
          initialItem={radarItem}
        />
      ) : at.temperature && at.client ? (
        <ClientTemperature
          key={at.client}
          company={company}
          client={at.client}
          clientName={clientName(at.client)}
        />
      ) : at.dossier && at.client ? (
        <ClientDossier
          key={at.client}
          company={company}
          client={at.client}
          clientName={clientName(at.client)}
          data={data}
          notify={notify}
        />
      ) : at.notes && at.client ? (
        <ClientNotes
          key={at.client}
          company={company}
          client={at.client}
          clientName={clientName(at.client)}
          notify={notify}
          initial={openNote}
        />
      ) : at.whatsapp && at.client ? (
        <WhatsappFolder
          key={at.client}
          company={company}
          client={at.client}
          clientName={clientName(at.client)}
          data={data}
          user={user}
          notify={notify}
          onNewTask={onNewTask}
          initial={openWhatsapp}
        />
      ) : at.recordings && at.client ? (
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
                <div className={foldersClass}>
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
            showsProducts ||
            products.length > 0 ||
            recordingCount > 0 ||
            groupCount > 0 ||
            showsAgent ||
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
                        undefined,
                        false,
                        "",
                        {
                          props: dropTarget(
                            `client-${c.id}`,
                            { client: c.id },
                            isLeader,
                          ),
                        },
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
                  ...(showsProducts
                    ? [
                        () =>
                          folderCard(
                            "dossier",
                            "Dossiê da MAVI",
                            "dossier",
                            () => go({ client: at.client, dossier: true }),
                            "#6b52b3",
                          ),
                      ]
                    : []),
                  ...(showsProducts
                    ? [
                        () =>
                          folderCard(
                            "notes",
                            "Anotações",
                            "notes",
                            () => go({ client: at.client, notes: true }),
                            "#7a5bc4",
                          ),
                      ]
                    : []),
                  ...(showsProducts
                    ? [
                        () =>
                          folderCard(
                            "brand",
                            "Marca",
                            "brand",
                            () => go({ client: at.client, brand: true }),
                            "#d9761c",
                          ),
                      ]
                    : []),
                  ...(showsProducts && showsTemperature
                    ? [
                        () =>
                          folderCard(
                            "temperature",
                            "Termômetro",
                            "temperature",
                            () => go({ client: at.client, temperature: true }),
                            "#e0673a",
                          ),
                      ]
                    : []),
                  ...(showsProducts && showsRadar
                    ? [
                        () =>
                          folderCard(
                            "radar",
                            "Radar",
                            "radar",
                            () => go({ client: at.client, radar: true }),
                            "#c8514f",
                          ),
                      ]
                    : []),
                  ...(showsProducts && groupCount > 0
                    ? [
                        () =>
                          folderCard(
                            "whatsapp",
                            "Whatsapp",
                            "whatsapp",
                            () => go({ client: at.client, whatsapp: true }),
                            "#2f8f57",
                          ),
                      ]
                    : []),
                  ...products.map(
                    (k) => () =>
                      folderCard(
                        k.id,
                        k.name,
                        "product",
                        () => go({ client: k.client_id, contract: k.id }),
                        data.products.find((p) => p.id === k.product_id)?.color,
                        undefined,
                        false,
                        "",
                        {
                          props: dropTarget(
                            `product-${k.id}`,
                            { client: k.client_id, contract: k.id },
                            writableAt(k.id),
                          ),
                        },
                      ),
                  ),
                  ...(showsAgent
                    ? [
                        () =>
                          folderCard(
                            "agent",
                            "Agente Conversacional",
                            "agent",
                            () =>
                              go({
                                client: at.client,
                                contract: at.contract,
                                agent: true,
                              }),
                            "#3b7d6e",
                          ),
                      ]
                    : []),
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
                            move: canWrite
                              ? () => startMove(itemsFor("folders", f.id))
                              : undefined,
                            history: () =>
                              setHistory({ folder: f.id, name: f.name }),
                          },
                          f.visibility === "public",
                          "",
                          {
                            selected: isSelected("folders", f.id),
                            select: canWrite && (
                              <Checkbox
                                className="drive-select"
                                aria-label={`Escolher ${f.name}`}
                                checked={isSelected("folders", f.id)}
                                onCheckedChange={() =>
                                  toggleSelected("folders", f.id)
                                }
                              />
                            ),
                            props: {
                              ...selectable("folders", f.id, canWrite),
                              ...dragSource(
                                () => itemsFor("folders", f.id),
                                canWrite,
                              ),
                              ...dropTarget(
                                `folder-${f.id}`,
                                {
                                  client: f.client_id ?? undefined,
                                  contract: f.contract_id ?? undefined,
                                  folder: f.id,
                                },
                                writableAt(f.contract_id),
                              ),
                            },
                          },
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
                <div className={foldersClass}>
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
              <div className={foldersClass}>
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
                      public_upload: saved.upload?.enabled ?? f.public_upload,
                    }
                  : f,
              ),
            )
          }
        />
      )}
      {moving && (
        <DriveMoveDialog
          company={company}
          data={data}
          user={user}
          isLeader={isLeader}
          folders={folders}
          items={moving.items}
          label={moving.label}
          start={at.folder ? { ...place, folder: at.folder } : place}
          fixed={moving.fixed}
          onClose={() => setMoving(null)}
          onMoved={(result) => void finishMove(result)}
        />
      )}
      {history && (
        <DriveItemHistory
          data={data}
          company={company}
          item={history}
          onClose={() => setHistory(null)}
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

/** Asks for the thumbnails of the files on screen (one page at a time). */
function DriveThumbs({
  files,
  children,
}: {
  files: DriveFile[];
  children: (thumb: (id: string) => string | undefined) => ReactNode;
}) {
  const thumb = useDriveThumbs(files);
  return <>{children(thumb)}</>;
}
