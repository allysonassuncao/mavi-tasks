import { useCallback, useEffect, useState } from "react";
import { Download, Globe, Search } from "lucide-react";
import { Button, Input, Select, SelectOption, Loading } from "./ui";
import { Empty } from "./components";
import type { DriveAuditEntry, Snapshot } from "./types";
import { contractProductLabel } from "./domain";
import { DRIVE_AUDIT_PAGE, formatBytes, listDriveAudit } from "./drive";

export const auditActions: Record<string, string> = {
  upload_started: "Envio iniciado",
  upload_completed: "Arquivo enviado",
  file_viewed: "Arquivo visualizado",
  file_downloaded: "Arquivo baixado",
  public_viewed: "Visualizado pelo link público",
  public_downloaded: "Baixado pelo link público",
  link_copied: "Link público copiado",
  visibility_changed: "Acesso alterado",
  file_renamed: "Arquivo renomeado",
  file_deleted: "Arquivo excluído",
  folder_created: "Pasta criada",
  folder_renamed: "Pasta renomeada",
  folder_deleted: "Pasta excluída",
};
const visibilityLabel = (v: unknown) =>
  v === "public" ? "Público" : v === "private" ? "Privado" : String(v ?? "");

/** Drive audit trail (leaders only): who did what, where and from where. */
export function DriveAudit({
  data,
  company,
}: {
  data: Snapshot;
  company: string;
}) {
  const [entries, setEntries] = useState<DriveAuditEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [item, setItem] = useState("");
  const [itemQuery, setItemQuery] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setItemQuery(item.trim()), 300);
    return () => clearTimeout(id);
  }, [item]);
  const filters = { action, actor, item: itemQuery };
  const load = useCallback(() => {
    setEntries(null);
    setError("");
    listDriveAudit(company, filters)
      .then((rows) => {
        setEntries(rows);
        setMore(rows.length === DRIVE_AUDIT_PAGE);
      })
      .catch((e) => setError((e as Error).message));
  }, [company, action, actor, itemQuery]);
  useEffect(load, [load]);

  async function loadMore() {
    if (!entries?.length) return;
    setLoadingMore(true);
    try {
      const rows = await listDriveAudit(company, {
        ...filters,
        before: entries[entries.length - 1].id,
      });
      setEntries([...entries, ...rows]);
      setMore(rows.length === DRIVE_AUDIT_PAGE);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  const who = (id: string | null) =>
    id
      ? (data.members.find((m) => m.user_id === id)?.name ?? "Pessoa removida")
      : "Acesso público (sem login)";
  const where = (e: DriveAuditEntry) =>
    [
      e.client_id
        ? (data.clients.find((c) => c.id === e.client_id)?.name ?? "Cliente")
        : "Drive",
      ...(e.contract_id ? [contractProductLabel(data, e.contract_id)] : []),
    ].join(" › ");
  function describe(e: DriveAuditEntry) {
    const d = e.details;
    if (e.action === "visibility_changed")
      return `${visibilityLabel(d.from)} → ${visibilityLabel(d.to)}`;
    if (e.action === "file_renamed" || e.action === "folder_renamed")
      return `“${d.from}” → “${d.to}”`;
    if (
      e.action === "upload_started" ||
      e.action === "upload_completed" ||
      e.action === "file_deleted"
    )
      return [
        typeof d.size_bytes === "number" ? formatBytes(d.size_bytes) : "",
        d.visibility ? visibilityLabel(d.visibility) : "",
      ]
        .filter(Boolean)
        .join(" · ");
    return "";
  }
  const when = (iso: string) =>
    new Date(iso).toLocaleString("pt-BR", {
      dateStyle: "short",
      timeStyle: "medium",
    });

  function exportCsv() {
    if (!entries?.length) return;
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      [
        "Data",
        "Pessoa",
        "Ação",
        "Item",
        "Local",
        "Detalhes",
        "IP",
        "Navegador",
      ],
      ...entries.map((e) => [
        when(e.created_at),
        who(e.actor_id),
        auditActions[e.action] ?? e.action,
        e.item_name,
        where(e),
        describe(e),
        e.details.origin?.ip,
        e.details.origin?.user_agent,
      ]),
    ].map((row) => row.map(cell).join(";"));
    const url = URL.createObjectURL(
      new Blob(["\uFEFF" + lines.join("\n")], {
        type: "text/csv;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `historico-drive-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  return (
    <div className="drive-audit">
      <div className="drive-filters">
        <Select
          aria-label="Filtrar por ação"
          value={action}
          onValueChange={setAction}
        >
          <SelectOption value="">Todas as ações</SelectOption>
          {Object.entries(auditActions).map(([id, label]) => (
            <SelectOption key={id} value={id}>
              {label}
            </SelectOption>
          ))}
        </Select>
        <Select
          aria-label="Filtrar por pessoa"
          value={actor}
          onValueChange={setActor}
        >
          <SelectOption value="">Todas as pessoas</SelectOption>
          <SelectOption value="public">Acesso público (sem login)</SelectOption>
          {data.members.map((m) => (
            <SelectOption key={m.user_id} value={m.user_id}>
              {m.name}
            </SelectOption>
          ))}
        </Select>
        <span className="drive-search drive-audit-search">
          <Input
            type="search"
            aria-label="Buscar pelo nome do arquivo ou pasta"
            placeholder="Nome do arquivo ou pasta"
            value={item}
            onChange={(e) => setItem(e.target.value)}
            icon={Search}
          />
        </span>
        <Button
          className="btn secondary"
          disabled={!entries?.length}
          onClick={exportCsv}
        >
          <Download size={15} /> Exportar CSV
        </Button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {entries === null ? (
        <Loading compact />
      ) : entries.length ? (
        <>
          <div className="panel drive-table-wrap">
            <table className="drive-table drive-audit-table">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Pessoa</th>
                  <th>Ação</th>
                  <th>Item</th>
                  <th className="hide-mobile">Detalhes</th>
                  <th className="hide-mobile hide-narrow">Origem</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="drive-audit-when">{when(e.created_at)}</td>
                    <td>
                      {e.actor_id ? (
                        who(e.actor_id)
                      ) : (
                        <span className="drive-audit-public">
                          <Globe size={13} /> {who(null)}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`audit-action ${e.action}`}>
                        {auditActions[e.action] ?? e.action}
                      </span>
                    </td>
                    <td>
                      <strong className="drive-audit-item">
                        {e.item_name}
                      </strong>
                      <small className="drive-row-path">{where(e)}</small>
                    </td>
                    <td className="hide-mobile">{describe(e)}</td>
                    <td
                      className="hide-mobile hide-narrow drive-audit-origin"
                      title={e.details.origin?.user_agent}
                    >
                      {e.details.origin?.ip ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {more && (
            <Button
              className="btn secondary drive-audit-more"
              loading={loadingMore}
              onClick={() => void loadMore()}
            >
              Carregar mais
            </Button>
          )}
        </>
      ) : (
        <div className="panel drive-empty">
          <Empty
            title="Nenhum registro"
            body="As ações feitas no Drive aparecem aqui, das mais recentes para as mais antigas."
          />
        </div>
      )}
    </div>
  );
}
