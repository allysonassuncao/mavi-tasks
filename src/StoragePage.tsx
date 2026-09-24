import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Building2,
  Link2,
  RefreshCw,
  Search,
  Trash2,
  UserRound,
} from "lucide-react";
import { Button, Input, Loading, Select, SelectOption } from "./ui";
import { Avatar, Empty, Modal } from "./components";
import { Pagination, usePagination } from "./Pagination";
import { contractProductLabel, fold, initials } from "./domain";
import { deleteAttachment } from "./attachments";
import {
  deleteDriveFile,
  formatBytes,
  logLinkCopied,
  publicFileUrl,
  setDriveVisibility,
} from "./drive";
import { useUrlState } from "./router";
import type { Client, Member, Snapshot } from "./types";
import {
  NO_CLIENT,
  STORAGE_UPLOADS_PAGE,
  demoClientFiles,
  demoClientRows,
  demoStorageRows,
  demoStorageUploads,
  emptyUsage,
  listClientFiles,
  listStorageUploads,
  storageKindLabel,
  storageKinds,
  storageUsage,
  storageUsageByClient,
  summarizeClients,
  summarizeStorage,
  driveSharing,
  type ClientFile,
  type DriveSharing,
  type StorageKind,
  type StorageUpload,
  type UsageTotals,
} from "./storage";

const count = new Intl.NumberFormat("pt-BR");
const roleLabel = {
  admin: "Administrador",
  manager: "Gestor",
  member: "Colaborador",
};
const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("pt-BR") : "—";
const dateTime = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });
const percent = (part: number, whole: number) =>
  whole
    ? `${((part / whole) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% do total`
    : "—";
/** Rows per page in the people and clients tables. */
const PAGE_SIZE = 25;
/** A client's uploads are never profile photos: that column is left out. */
const clientKinds = storageKinds.filter((k) => k.kind !== "avatar");

/** "33,62" and "GB": the headline figure, with two decimals. */
function sizeParts(bytes: number): [string, string] {
  if (bytes < 1024) return [count.format(bytes), "B"];
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return [
    value.toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
    units[unit],
  ];
}

/** One bar split by kind; `scale` is the byte count of a full bar. */
function UsageBar({
  totals,
  scale,
  compact = false,
}: {
  totals: UsageTotals;
  scale: number;
  compact?: boolean;
}) {
  return (
    <span
      className={`storage-bar ${compact ? "compact" : ""}`}
      role="img"
      aria-label={storageKinds
        .map((k) => `${k.label}: ${formatBytes(totals[k.kind])}`)
        .join(", ")}
    >
      {storageKinds.map(
        (k) =>
          totals[k.kind] > 0 && (
            <i
              key={k.kind}
              title={`${k.label}: ${formatBytes(totals[k.kind])}`}
              style={{
                background: k.color,
                width: `${(totals[k.kind] / (scale || 1)) * 100}%`,
              }}
            />
          ),
      )}
    </span>
  );
}

function UsageSummary({
  title,
  totals,
  kinds = storageKinds,
}: {
  title?: ReactNode;
  totals: UsageTotals;
  kinds?: typeof storageKinds;
}) {
  const [value, unit] = sizeParts(totals.bytes);
  return (
    <div className="storage-summary">
      {title && <h2>{title}</h2>}
      <div className="storage-headline">
        <span>
          Armazenamento usado: <strong>{value}</strong> {unit}
        </span>
        <small>
          {count.format(totals.files)}{" "}
          {totals.files === 1 ? "arquivo" : "arquivos"}
        </small>
      </div>
      <UsageBar totals={totals} scale={totals.bytes} />
      <ul className="storage-legend">
        {kinds.map((k) => (
          <li key={k.kind}>
            <i style={{ background: k.color }} aria-hidden="true" />
            {k.label}
            <strong>{formatBytes(totals[k.kind])}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

type UsageRowItem = {
  key: string;
  /** Sorts rows with the same usage. */
  name: string;
  /** What the first cell shows (avatar or logo, name, detail). */
  label: ReactNode;
  usage: UsageTotals;
};
const largestFirst = (a: UsageRowItem, b: UsageRowItem) =>
  b.usage.bytes - a.usage.bytes || a.name.localeCompare(b.name, "pt-BR");

/** People or clients, largest first, a page at a time. */
function UsageTable({
  heading,
  noun,
  rows,
  kinds,
  companyBytes,
  resetKey,
  onOpen,
}: {
  heading: string;
  noun: [string, string];
  rows: UsageRowItem[];
  kinds: typeof storageKinds;
  companyBytes: number;
  resetKey: string;
  onOpen: (key: string) => void;
}) {
  const top = useRef<HTMLDivElement>(null);
  const pages = usePagination(rows, PAGE_SIZE, resetKey);
  const largest = Math.max(0, ...rows.map((r) => r.usage.bytes));
  return (
    <>
      <div className="table-scroll" ref={top}>
        <table className="storage-table">
          <thead>
            <tr>
              <th>{heading}</th>
              <th>Armazenamento usado</th>
              <th className="num hide-mobile">Arquivos</th>
              {kinds.map((k) => (
                <th key={k.kind} className="num hide-mobile hide-narrow">
                  {k.label}
                </th>
              ))}
              <th className="hide-mobile">Último envio</th>
            </tr>
          </thead>
          <tbody>
            {pages.pageItems.map(({ key, label, usage: u }) => (
              <tr key={key || "sem-cliente"}>
                <td>
                  <button
                    type="button"
                    className="storage-person"
                    onClick={() => onOpen(key)}
                  >
                    {label}
                  </button>
                </td>
                <td className="storage-used">
                  <strong>{formatBytes(u.bytes)}</strong>
                  <UsageBar totals={u} scale={largest} compact />
                  <small>{percent(u.bytes, companyBytes)}</small>
                </td>
                <td className="num hide-mobile">{count.format(u.files)}</td>
                {kinds.map((k) => (
                  <td key={k.kind} className="num hide-mobile hide-narrow">
                    {u[k.kind] ? formatBytes(u[k.kind]) : "—"}
                  </td>
                ))}
                <td className="hide-mobile">{shortDate(u.last_upload_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        className="storage-pagination"
        page={pages.page}
        pageCount={pages.pageCount}
        pageSize={pages.pageSize}
        total={rows.length}
        noun={rows.length === 1 ? noun[0] : noun[1]}
        onPage={pages.setPage}
        anchor={top}
      />
    </>
  );
}

function ClientLogo({ client }: { client?: Client }) {
  return client ? (
    <span
      className="storage-client-logo"
      style={{ background: client.color + "20", color: client.color }}
      aria-hidden="true"
    >
      {initials(client.name)}
    </span>
  ) : (
    <span className="storage-client-logo none" aria-hidden="true">
      <Building2 size={14} />
    </span>
  );
}

/** "2 produtos" / "Sem produtos", under a client's name. */
function clientProducts(data: Snapshot, clientId: string) {
  const n = data.contracts.filter((k) => k.client_id === clientId).length;
  return n ? `${n} ${n === 1 ? "produto" : "produtos"}` : "Sem produtos";
}

type View = "pessoas" | "clientes";
type Usage = {
  company: UsageTotals;
  people: Map<string, UsageTotals>;
  clients: Map<string, UsageTotals>;
};

/**
 * Storage (leaders only): how much the company's uploads take, split by
 * kind, how much each person uploaded and how much each client's files
 * take — like the Google Workspace admin.
 */
export function StoragePage({
  data,
  company,
  demo,
  notify,
}: {
  data: Snapshot;
  company: string;
  demo: boolean;
  notify: (message: string) => void;
}) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [tick, setTick] = useState(0);
  const [view, setView] = useUrlState<View>("visualizacao", "pessoas");
  const [selected, setSelected] = useState<{ view: View; key: string }>();

  useEffect(() => {
    let current = true;
    setError("");
    const load = demo
      ? Promise.resolve([
          demoStorageRows(
            data.members.filter((m) => m.active).map((m) => m.user_id),
          ),
          demoClientRows(
            data.clients.filter((c) => !c.archived).map((c) => c.id),
          ),
        ] as const)
      : Promise.all([storageUsage(company), storageUsageByClient(company)]);
    load
      .then(([people, clients]) => {
        if (!current) return;
        const summary = summarizeStorage(people);
        setUsage({
          company: summary.company,
          people: new Map(summary.people.map((p) => [p.user_id, p])),
          clients: summarizeClients(clients),
        });
      })
      .catch((e) => current && setError((e as Error).message));
    return () => {
      current = false;
    };
    // The demo's figures only depend on who and which clients are in it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, demo, tick]);

  const q = fold(query.trim());

  // Everyone active shows up, even without uploads; people who left only
  // when their files still take space.
  const people = useMemo((): UsageRowItem[] => {
    if (!usage) return [];
    const ids = new Set([
      ...usage.people.keys(),
      ...data.members.filter((m) => m.active).map((m) => m.user_id),
    ]);
    return [...ids]
      .map((id) => {
        const member = data.members.find((m) => m.user_id === id);
        return {
          key: id,
          name: member?.name ?? "",
          usage: usage.people.get(id) ?? emptyUsage(),
          label: (
            <>
              <Avatar
                name={member?.name ?? "?"}
                src={member?.avatar_url}
                size="small"
              />
              <span>
                <strong>{member?.name ?? "Pessoa removida"}</strong>
                <small>
                  {member
                    ? member.active
                      ? roleLabel[member.role]
                      : "Acesso desativado"
                    : "Sem vínculo com o espaço"}
                </small>
              </span>
            </>
          ),
        };
      })
      .filter((p) => fold(p.name).includes(q))
      .sort(largestFirst);
  }, [usage, data.members, q]);

  // Active clients, even without files; archived ones while their files
  // still take space. Uploads with no client come last.
  const clients = useMemo((): UsageRowItem[] => {
    if (!usage) return [];
    const rows = data.clients
      .filter(
        (c) =>
          (!c.archived || (usage.clients.get(c.id)?.bytes ?? 0) > 0) &&
          fold(c.name).includes(q),
      )
      .map((c) => ({
        key: c.id,
        name: c.name,
        usage: usage.clients.get(c.id) ?? emptyUsage(),
        label: (
          <>
            <ClientLogo client={c} />
            <span>
              <strong>
                {c.name}
                {c.archived && <span className="archived-tag">Arquivado</span>}
              </strong>
              <small>{clientProducts(data, c.id)}</small>
            </span>
          </>
        ),
      }))
      .sort(largestFirst);
    const loose = usage.clients.get(NO_CLIENT);
    if (loose?.bytes && fold("sem cliente").includes(q))
      rows.push({
        key: NO_CLIENT,
        name: "",
        usage: loose,
        label: (
          <>
            <ClientLogo />
            <span>
              <strong>Sem cliente</strong>
              <small>Drive geral, imagens soltas e fotos de perfil</small>
            </span>
          </>
        ),
      });
    return rows;
  }, [usage, data, q]);

  if (error)
    return (
      <p className="form-error" role="alert">
        {error}
      </p>
    );
  if (!usage) return <Loading compact />;

  const companyName = data.companies.find((c) => c.id === company)?.name;
  // A deleted file stops counting: totals are reloaded.
  const actions = { demo, notify, onDeleted: () => setTick((v) => v + 1) };
  const byClient = view === "clientes";
  const rows = byClient ? clients : people;

  return (
    <div className="storage-page">
      <section className="panel">
        <UsageSummary
          title={
            <>
              Uso de armazenamento de{" "}
              <strong>{companyName ?? "toda a agência"}</strong>
            </>
          }
          totals={usage.company}
        />
      </section>

      <section className="panel storage-people">
        <div className="panel-heading">
          <div>
            <h2>{byClient ? "Uso por cliente" : "Uso por pessoa"}</h2>
            <p>
              {byClient
                ? "O que está guardado nas pastas e tarefas de cada cliente"
                : "O que cada pessoa enviou e ainda está guardado"}
            </p>
          </div>
          <div className="storage-tools">
            <div
              className="drive-view storage-view"
              role="tablist"
              aria-label="Ver uso por"
            >
              {(
                [
                  ["pessoas", "Pessoas", UserRound],
                  ["clientes", "Clientes", Building2],
                ] as const
              ).map(([key, label, Icon]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={view === key}
                  className={view === key ? "selected" : ""}
                  onClick={() => setView(key)}
                >
                  <Icon size={15} /> {label}
                </button>
              ))}
            </div>
            <span className="portfolio-search">
              <Input
                type="search"
                aria-label={byClient ? "Buscar cliente" : "Buscar pessoa"}
                placeholder={byClient ? "Buscar cliente" : "Buscar pessoa"}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                icon={Search}
              />
            </span>
            <Button
              className="icon-btn"
              aria-label="Atualizar"
              title="Atualizar"
              onClick={() => setTick((v) => v + 1)}
            >
              <RefreshCw size={15} />
            </Button>
          </div>
        </div>
        {rows.length ? (
          <UsageTable
            key={view}
            heading={byClient ? "Cliente" : "Pessoa"}
            noun={byClient ? ["cliente", "clientes"] : ["pessoa", "pessoas"]}
            rows={rows}
            kinds={byClient ? clientKinds : storageKinds}
            companyBytes={usage.company.bytes}
            resetKey={query}
            onOpen={(key) => setSelected({ view, key })}
          />
        ) : (
          <Empty
            title={
              byClient ? "Nenhum cliente encontrado" : "Ninguém encontrado"
            }
            body="Confira a grafia ou limpe a busca."
          />
        )}
      </section>
      {selected?.view === "pessoas" && (
        <PersonStorage
          company={company}
          demo={demo}
          usage={usage.people.get(selected.key) ?? emptyUsage()}
          userId={selected.key}
          member={data.members.find((m) => m.user_id === selected.key)}
          actions={actions}
          onClose={() => setSelected(undefined)}
        />
      )}
      {selected?.view === "clientes" && (
        <ClientStorage
          company={company}
          demo={demo}
          data={data}
          usage={usage.clients.get(selected.key) ?? emptyUsage()}
          clientId={selected.key}
          actions={actions}
          onClose={() => setSelected(undefined)}
        />
      )}
    </div>
  );
}

type ActionsContext = {
  demo: boolean;
  notify: (message: string) => void;
  /** Called after a file was deleted (to refresh the totals). */
  onDeleted: () => void;
};
type ActionFile = { source_id: string; kind: StorageKind; name: string };

/**
 * What can be done with a listed file: Drive files are made public or
 * private (with a link to copy) and deleted; task attachments are deleted.
 * Images in texts and profile photos are only listed — deleting them would
 * leave holes in descriptions and comments, or remove someone's photo.
 */
function useFileActions<F extends ActionFile>(
  files: F[] | null,
  { demo, notify, onDeleted }: ActionsContext,
  removed: (file: F) => void,
) {
  const [sharing, setSharing] = useState(new Map<string, DriveSharing>());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const driveIds = (files ?? [])
    .filter((f) => f.kind === "drive")
    .map((f) => f.source_id)
    .join(",");
  useEffect(() => {
    const ids = driveIds ? driveIds.split(",") : [];
    // The demo has no Drive: every file starts private.
    if (demo) {
      setSharing(
        (prev) =>
          new Map(
            ids.map((id) => [
              id,
              prev.get(id) ?? { visibility: "private", share_token: "demo" },
            ]),
          ),
      );
      return;
    }
    let current = true;
    driveSharing(ids)
      .then((map) => current && setSharing(map))
      .catch((e) => current && setError((e as Error).message));
    return () => {
      current = false;
    };
  }, [driveIds, demo]);

  async function run(file: F, action: () => Promise<void>) {
    setBusy(file.source_id);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  const setVisibility = (file: F, visibility: DriveSharing["visibility"]) =>
    run(file, async () => {
      if (!demo) await setDriveVisibility(file.source_id, visibility);
      setSharing((map) => {
        const next = new Map(map);
        const current = next.get(file.source_id);
        if (current) next.set(file.source_id, { ...current, visibility });
        return next;
      });
      notify(
        visibility === "public"
          ? "Arquivo público: qualquer pessoa com o link pode baixar."
          : "Arquivo privado: o link público deixou de funcionar.",
      );
    });
  async function copyLink(file: F) {
    const token = sharing.get(file.source_id)?.share_token;
    if (!token) return;
    const url = publicFileUrl({ share_token: token });
    try {
      await navigator.clipboard.writeText(url);
      notify("Link público copiado.");
      // Sharing a public link is part of the Drive audit trail.
      if (!demo) void logLinkCopied(file.source_id).catch(() => {});
    } catch {
      setError(`Copie o link: ${url}`);
    }
  }
  const remove = (file: F) => {
    const drive = file.kind === "drive";
    if (
      !window.confirm(
        drive
          ? `Excluir permanentemente "${file.name}"?\n\nO arquivo sai do Drive (e do link público, se houver) e não pode ser recuperado.`
          : `Excluir permanentemente o anexo "${file.name}"?\n\nEle sai da tarefa e não pode ser recuperado. A exclusão fica registrada no histórico da tarefa.`,
      )
    )
      return;
    return run(file, async () => {
      if (!demo) {
        if (drive) await deleteDriveFile(file.source_id);
        else await deleteAttachment(file.source_id);
      }
      removed(file);
      notify(
        demo
          ? "Exclusão simulada na demonstração."
          : "Arquivo excluído permanentemente.",
      );
      onDeleted();
    });
  };
  return { sharing, busy, error, setVisibility, copyLink, remove };
}
type FileActions<F extends ActionFile> = ReturnType<typeof useFileActions<F>>;

const accessNote: Record<StorageKind, [string, string]> = {
  drive: ["", ""],
  attachment: ["Pela tarefa", "Quem tem acesso à tarefa abre o anexo"],
  inline_image: ["Pelo texto", "Aparece na descrição ou no comentário"],
  avatar: ["Perfil", "Foto exibida para toda a equipe"],
};

/** Public or private (Drive files), or how the file is reached. */
function AccessCell<F extends ActionFile>({
  file,
  actions,
  active = true,
}: {
  file: F;
  actions: FileActions<F>;
  /** False for deleted or unfinished uploads. */
  active?: boolean;
}) {
  const share = actions.sharing.get(file.source_id);
  if (!active) return <span className="storage-access-note">—</span>;
  if (file.kind !== "drive") {
    const [label, hint] = accessNote[file.kind];
    return (
      <span className="storage-access-note" title={hint}>
        {label}
      </span>
    );
  }
  if (!share) return <span className="storage-access-note">—</span>;
  return (
    <Select
      aria-label={`Acesso de ${file.name}`}
      className={`visibility-select ${share.visibility}`}
      value={share.visibility}
      disabled={actions.busy === file.source_id}
      onValueChange={(v) =>
        void actions.setVisibility(file, v as DriveSharing["visibility"])
      }
    >
      <SelectOption value="private">Privado</SelectOption>
      <SelectOption value="public">Público</SelectOption>
    </Select>
  );
}

/** Copy the public link (public Drive files) and delete (Drive, attachments). */
function ActionsCell<F extends ActionFile>({
  file,
  actions,
  active = true,
}: {
  file: F;
  actions: FileActions<F>;
  active?: boolean;
}) {
  if (!active) return null;
  const busy = actions.busy === file.source_id;
  const deletable = file.kind === "drive" || file.kind === "attachment";
  return (
    <span className="drive-actions">
      {actions.sharing.get(file.source_id)?.visibility === "public" && (
        <Button
          className="icon-btn"
          aria-label={`Copiar link público de ${file.name}`}
          title="Copiar link público"
          onClick={() => void actions.copyLink(file)}
        >
          <Link2 size={15} />
        </Button>
      )}
      {deletable && (
        <Button
          className="icon-btn danger"
          aria-label={`Excluir permanentemente ${file.name}`}
          title="Excluir permanentemente"
          disabled={busy}
          onClick={() => void actions.remove(file)}
        >
          <Trash2 size={15} />
        </Button>
      )}
    </span>
  );
}

function FilesTable({
  head,
  children,
  full,
  order = "size",
}: {
  head: ReactNode;
  children: ReactNode;
  /** The list hit its limit: say it shows only part. */
  full: boolean;
  order?: "size" | "recent";
}) {
  return (
    <div className="table-scroll">
      <table className="storage-table storage-files">
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {full && (
        <p className="muted storage-files-limit">
          Mostrando os {STORAGE_UPLOADS_PAGE}{" "}
          {order === "size" ? "maiores" : "mais recentes"}.
        </p>
      )}
    </div>
  );
}

/** One person's usage and files: the largest in use, or recent uploads. */
function PersonStorage({
  company,
  demo,
  usage,
  userId,
  member,
  actions: context,
  onClose,
}: {
  company: string;
  demo: boolean;
  usage: UsageTotals;
  userId: string;
  member?: Member;
  actions: ActionsContext;
  onClose: () => void;
}) {
  const [order, setOrder] = useState<"size" | "recent">("size");
  const [files, setFiles] = useState<StorageUpload[] | null>(null);
  const [error, setError] = useState("");
  // Largest files: it leaves the list; recent uploads: it shows as deleted.
  const actions = useFileActions(files, context, (file) =>
    setFiles(
      (list) =>
        list &&
        (order === "size"
          ? list.filter((f) => f.id !== file.id)
          : list.map((f) =>
              f.id === file.id
                ? { ...f, deleted_at: new Date().toISOString() }
                : f,
            )),
    ),
  );
  useEffect(() => {
    let current = true;
    setFiles(null);
    setError("");
    (demo
      ? Promise.resolve(
          demoStorageUploads(userId)
            .filter((f) => order === "recent" || !f.deleted_at)
            .sort((a, b) =>
              order === "size"
                ? b.size_bytes - a.size_bytes
                : b.created_at.localeCompare(a.created_at),
            ),
        )
      : listStorageUploads(company, userId, order)
    )
      .then((rows) => current && setFiles(rows))
      .catch((e) => current && setError((e as Error).message));
    return () => {
      current = false;
    };
  }, [company, demo, userId, order]);
  const name = member?.name ?? "Pessoa removida";
  const shownError = error || actions.error;
  return (
    <Modal title={`Armazenamento de ${name}`} onClose={onClose} wide>
      <div className="storage-person-detail">
        <UsageSummary totals={usage} />
        <div className="storage-files-head">
          <h3>
            {order === "size" ? "Maiores arquivos" : "Envios mais recentes"}
          </h3>
          <Select
            aria-label="Ordenar arquivos"
            value={order}
            onValueChange={(v) => setOrder(v as "size" | "recent")}
          >
            <SelectOption value="size">Maiores arquivos</SelectOption>
            <SelectOption value="recent">
              Envios recentes (inclui excluídos)
            </SelectOption>
          </Select>
        </div>
        {shownError && (
          <p className="form-error" role="alert">
            {shownError}
          </p>
        )}
        {files === null ? (
          !error && <Loading compact />
        ) : files.length ? (
          <FilesTable
            full={files.length === STORAGE_UPLOADS_PAGE}
            order={order}
            head={
              <>
                <th>Arquivo</th>
                <th className="hide-mobile">Tipo</th>
                <th className="num hide-mobile">Tamanho</th>
                <th className="hide-mobile hide-narrow">Enviado em</th>
                <th>Acesso</th>
                <th>
                  <span className="sr-only">Ações</span>
                </th>
              </>
            }
          >
            {files.map((f) => {
              const active = !f.deleted_at && !!f.completed_at;
              return (
                <tr key={f.id} className={f.deleted_at ? "deleted" : ""}>
                  <td>
                    <strong className="storage-file-name">
                      {f.name || "Sem nome"}
                    </strong>
                    {f.deleted_at ? (
                      <small>Excluído em {dateTime(f.deleted_at)}</small>
                    ) : !f.completed_at ? (
                      <small>Envio não concluído</small>
                    ) : (
                      <small className="show-mobile-only">
                        {storageKindLabel(f.kind)} ·{" "}
                        {formatBytes(Number(f.size_bytes))}
                      </small>
                    )}
                  </td>
                  <td className="hide-mobile">{storageKindLabel(f.kind)}</td>
                  <td className="num hide-mobile">
                    {formatBytes(Number(f.size_bytes))}
                  </td>
                  <td className="hide-mobile hide-narrow">
                    {dateTime(f.created_at)}
                  </td>
                  <td>
                    <AccessCell file={f} actions={actions} active={active} />
                  </td>
                  <td className="storage-row-actions">
                    <ActionsCell file={f} actions={actions} active={active} />
                  </td>
                </tr>
              );
            })}
          </FilesTable>
        ) : (
          <Empty
            title="Nenhum arquivo"
            body="Os envios desta pessoa aparecem aqui."
          />
        )}
      </div>
    </Modal>
  );
}

/** One client's usage and its largest files, with product and uploader. */
function ClientStorage({
  company,
  demo,
  data,
  usage,
  clientId,
  actions: context,
  onClose,
}: {
  company: string;
  demo: boolean;
  data: Snapshot;
  usage: UsageTotals;
  /** NO_CLIENT for the uploads with no client. */
  clientId: string;
  actions: ActionsContext;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<ClientFile[] | null>(null);
  const [error, setError] = useState("");
  const actions = useFileActions(files, context, (file) =>
    setFiles((list) => list && list.filter((f) => f.id !== file.id)),
  );
  useEffect(() => {
    let current = true;
    setFiles(null);
    setError("");
    (demo
      ? Promise.resolve(
          demoClientFiles(
            clientId,
            data.members.map((m) => m.user_id),
            data.contracts
              .filter((k) => k.client_id === clientId)
              .map((k) => k.id),
          ),
        )
      : listClientFiles(company, clientId)
    )
      .then((rows) => current && setFiles(rows))
      .catch((e) => current && setError((e as Error).message));
    return () => {
      current = false;
    };
    // The demo's files only depend on the client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, demo, clientId]);
  const name = data.clients.find((c) => c.id === clientId)?.name ?? "Cliente";
  const who = (id: string) =>
    data.members.find((m) => m.user_id === id)?.name ?? "Pessoa removida";
  const where = (f: ClientFile) =>
    f.contract_id
      ? contractProductLabel(data, f.contract_id)
      : clientId !== NO_CLIENT
        ? "Pasta do cliente"
        : f.kind === "drive"
          ? "Drive geral"
          : f.kind === "avatar"
            ? "Foto de perfil"
            : "Imagem fora de tarefas";
  const shownError = error || actions.error;
  return (
    <Modal
      title={
        clientId === NO_CLIENT
          ? "Arquivos sem cliente"
          : `Armazenamento de ${name}`
      }
      onClose={onClose}
      wide
    >
      <div className="storage-person-detail">
        {clientId === NO_CLIENT && (
          <p className="muted storage-note">
            Arquivos do Drive fora das pastas de clientes, imagens coladas em
            textos que ainda não estão em uma tarefa e fotos de perfil.
          </p>
        )}
        <UsageSummary
          totals={usage}
          kinds={clientId === NO_CLIENT ? storageKinds : clientKinds}
        />
        <div className="storage-files-head">
          <h3>Maiores arquivos</h3>
        </div>
        {shownError && (
          <p className="form-error" role="alert">
            {shownError}
          </p>
        )}
        {files === null ? (
          !error && <Loading compact />
        ) : files.length ? (
          <FilesTable
            full={files.length === STORAGE_UPLOADS_PAGE}
            head={
              <>
                <th>Arquivo</th>
                <th className="hide-mobile hide-narrow">Tipo</th>
                <th className="hide-mobile">Enviado por</th>
                <th className="num hide-mobile">Tamanho</th>
                <th className="hide-mobile hide-narrow">Enviado em</th>
                <th>Acesso</th>
                <th>
                  <span className="sr-only">Ações</span>
                </th>
              </>
            }
          >
            {files.map((f) => (
              <tr key={f.id}>
                <td>
                  <strong className="storage-file-name">
                    {f.name || "Sem nome"}
                  </strong>
                  <small>{where(f)}</small>
                  <small className="show-mobile-only">
                    {formatBytes(Number(f.size_bytes))}
                  </small>
                </td>
                <td className="hide-mobile hide-narrow">
                  {storageKindLabel(f.kind)}
                </td>
                <td className="hide-mobile">{who(f.user_id)}</td>
                <td className="num hide-mobile">
                  {formatBytes(Number(f.size_bytes))}
                </td>
                <td className="hide-mobile hide-narrow">
                  {dateTime(f.created_at)}
                </td>
                <td>
                  <AccessCell file={f} actions={actions} />
                </td>
                <td className="storage-row-actions">
                  <ActionsCell file={f} actions={actions} />
                </td>
              </tr>
            ))}
          </FilesTable>
        ) : (
          <Empty
            title="Nenhum arquivo"
            body="Os arquivos das pastas e tarefas deste cliente aparecem aqui."
          />
        )}
      </div>
    </Modal>
  );
}
