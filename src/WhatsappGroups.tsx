import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Eye,
  EyeOff,
  MessageCircle,
  RefreshCw,
  RotateCcw,
  Search,
} from "lucide-react";
import { Button, Input, Loading, Select, SelectOption } from "./ui";
import { Empty } from "./components";
import { MultiPick } from "./MultiPick";
import { Paged } from "./Pagination";
import type { Snapshot } from "./types";
import {
  ago,
  filterGroups,
  groupFilter,
  listWhatsappGroups,
  setWhatsappGroup,
  whatsappGroup,
  whatsappStatus,
  type GroupFilter,
  type WhatsappGroup,
  type WhatsappStatus,
} from "./whatsapp";

const TABS: [GroupFilter, string][] = [
  ["linked", "Ligados"],
  ["unlinked", "Sem cliente"],
  ["ignored", "Ignorados"],
];

/**
 * Configurações › Grupos do Whatsapp: cada grupo é ligado sozinho ao cliente
 * cujo código está no título; aqui o admin liga os que ficaram sem cliente,
 * corrige os errados e ignora os que não são de cliente.
 */
export function WhatsappGroupsPanel(props: {
  data: Snapshot;
  company: string;
  canEdit: boolean;
  demo: boolean;
  notify: (message: string) => void;
}) {
  if (props.demo)
    return (
      <section className="panel" id="config-whatsapp">
        <Empty
          title="Grupos do Whatsapp na conta conectada"
          body="Os grupos vêm do número de WhatsApp da sua empresa; a demonstração não se conecta a ele."
        />
      </section>
    );
  return <GroupsPanel {...props} />;
}

function GroupsPanel({
  data,
  company,
  canEdit,
  notify,
}: {
  data: Snapshot;
  company: string;
  canEdit: boolean;
  notify: (message: string) => void;
}) {
  const [groups, setGroups] = useState<WhatsappGroup[] | null>(null);
  const [status, setStatus] = useState<WhatsappStatus | null>(null);
  const [filter, setFilter] = useState<GroupFilter>("linked");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [g, s] = await Promise.all([
        listWhatsappGroups(company),
        whatsappStatus(company),
      ]);
      setGroups(g);
      setStatus(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [company]);
  useEffect(() => {
    void load();
  }, [load]);

  const clients = useMemo(
    () =>
      [...data.clients].sort((a, b) =>
        a.name.localeCompare(b.name, "pt-BR", { numeric: true }),
      ),
    [data.clients],
  );
  const clientName = useCallback(
    (id: string) => data.clients.find((c) => c.id === id)?.name ?? "",
    [data.clients],
  );
  // Os produtos que o cliente contrata: são as opções do grupo.
  const productsOf = useCallback(
    (client: string) => {
      const ids = new Set(
        data.contracts
          .filter((c) => c.client_id === client)
          .map((c) => c.product_id),
      );
      return data.products
        .filter((p) => ids.has(p.id))
        .map((p) => ({ value: p.id, label: p.name }));
    },
    [data.contracts, data.products],
  );

  const counts = useMemo(() => {
    const n: Record<GroupFilter, number> = {
      linked: 0,
      unlinked: 0,
      ignored: 0,
    };
    for (const g of groups ?? []) n[groupFilter(g)]++;
    return n;
  }, [groups]);
  const shown = useMemo(
    () => filterGroups(groups ?? [], filter, query, clientName),
    [groups, filter, query, clientName],
  );

  async function change(
    g: WhatsappGroup,
    next: Parameters<typeof setWhatsappGroup>[2],
    message: string,
  ) {
    setSaving(g.id);
    setError("");
    try {
      await setWhatsappGroup(company, g.id, next);
      const fresh = await whatsappGroup(company, g.id);
      if (fresh)
        setGroups(
          (list) => list?.map((x) => (x.id === g.id ? fresh : x)) ?? null,
        );
      notify(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving("");
    }
  }

  return (
    <section className="panel whatsapp-groups" id="config-whatsapp">
      <div className="panel-heading">
        <div>
          <h2>Grupos do Whatsapp</h2>
          <p>
            Cada grupo é ligado sozinho ao cliente cujo código está no título.
            Ajuste aqui os que ficaram sem cliente ou no cliente errado.
          </p>
        </div>
        <Button
          className="btn secondary"
          onClick={() => void load()}
          disabled={loading}
          aria-label="Atualizar a lista de grupos"
        >
          <RefreshCw size={16} /> Atualizar
        </Button>
      </div>

      {status && <SyncStatus status={status} />}

      <div className="whatsapp-groups-toolbar">
        <div
          className="scope-tabs"
          role="tablist"
          aria-label="Situação dos grupos"
        >
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={filter === id}
              className={filter === id ? "selected" : ""}
              onClick={() => setFilter(id)}
            >
              {label}
              <span>{counts[id]}</span>
            </button>
          ))}
        </div>
        <Input
          type="search"
          aria-label="Buscar grupo"
          placeholder="Buscar por título, código ou cliente…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          icon={Search}
        />
      </div>

      {error && (
        <p className="form-error whatsapp-groups-error" role="alert">
          {error}
        </p>
      )}
      {!groups ? (
        loading ? (
          <Loading compact />
        ) : null
      ) : !shown.length ? (
        <p className="template-empty">
          {query.trim()
            ? `Nenhum grupo encontrado para “${query.trim()}”.`
            : filter === "linked"
              ? "Nenhum grupo ligado a cliente ainda. A primeira varredura liga os grupos cujo título tem o código de um cliente."
              : filter === "unlinked"
                ? "Todos os grupos estão ligados a um cliente ou ignorados."
                : "Nenhum grupo ignorado."}
        </p>
      ) : (
        <Paged
          items={shown}
          pageSize={25}
          noun="grupos"
          resetKey={`${filter}|${query}`}
          className=""
        >
          {(page) =>
            page.map((g) => (
              <GroupRow
                key={g.id}
                group={g}
                clients={clients}
                products={g.client_id ? productsOf(g.client_id) : []}
                canEdit={canEdit}
                busy={saving === g.id}
                onChange={(next, message) => void change(g, next, message)}
              />
            ))
          }
        </Paged>
      )}
      <div className="panel-footer">
        <small>
          {canEdit
            ? "Grupos sem cliente não têm mensagens guardadas. Ao ligar um grupo, os últimos dias entram na próxima leitura."
            : "Só administradores ajustam os grupos."}
        </small>
      </div>
    </section>
  );
}

function SyncStatus({ status }: { status: WhatsappStatus }) {
  if (!status.configured)
    return (
      <p className="whatsapp-status-note" role="status">
        <AlertTriangle size={15} aria-hidden="true" /> A coleta ainda não foi
        ligada. Depois de configurar a Uazapi no servidor, a primeira varredura
        traz os grupos e os últimos {status.backfill_days} dias de mensagens.
      </p>
    );
  const items: [string, string][] = [
    [
      "Última varredura",
      status.last_sweep_at ? ago(status.last_sweep_at) : "ainda não",
    ],
    ["Grupos para ler", String(status.groups_pending)],
    ["Mensagens guardadas", status.messages.toLocaleString("pt-BR")],
    ["Mídias na fila", status.media_pending.toLocaleString("pt-BR")],
    ["Mídias perdidas", status.media_lost.toLocaleString("pt-BR")],
    [
      "Áudios e documentos lidos",
      (status.content_done ?? 0).toLocaleString("pt-BR"),
    ],
    ["Leituras na fila", (status.content_pending ?? 0).toLocaleString("pt-BR")],
  ];
  return (
    <>
      <dl className="whatsapp-status">
        {items.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {(status.last_sweep_error || status.groups_with_error > 0) && (
        <p className="whatsapp-status-note error" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          {status.last_sweep_error
            ? `A última varredura falhou: ${status.last_sweep_error}`
            : `${status.groups_with_error} ${status.groups_with_error === 1 ? "grupo teve" : "grupos tiveram"} erro na última leitura; eles são lidos de novo na próxima.`}
        </p>
      )}
    </>
  );
}

function GroupRow({
  group: g,
  clients,
  products,
  canEdit,
  busy,
  onChange,
}: {
  group: WhatsappGroup;
  clients: Snapshot["clients"];
  products: { value: string; label: string }[];
  canEdit: boolean;
  busy: boolean;
  onChange: (
    next: Parameters<typeof setWhatsappGroup>[2],
    message: string,
  ) => void;
}) {
  const details = [
    g.linked_by === "manual" ? "Ajustado" : "Automático",
    g.last_message_at && `última mensagem ${ago(g.last_message_at)}`,
    g.message_count > 0 &&
      `${g.message_count.toLocaleString("pt-BR")} ${g.message_count === 1 ? "mensagem" : "mensagens"}`,
  ].filter(Boolean);
  const title = g.title || "Grupo sem título";
  return (
    <div className="template-row whatsapp-group-row">
      <MessageCircle size={18} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <small>{details.join(" · ")}</small>
        {g.sync_error && (
          <small className="whatsapp-group-error">{g.sync_error}</small>
        )}
      </div>
      <div className="whatsapp-group-controls">
        {!g.ignored && (
          <div className="whatsapp-group-link">
            <Select
              aria-label={`Cliente do grupo ${title}`}
              value={g.client_id ?? ""}
              disabled={!canEdit || busy}
              onValueChange={(client) =>
                onChange(
                  { client: client || null, products: [], ignored: false },
                  client
                    ? "Grupo ligado ao cliente."
                    : "Grupo sem cliente: novas mensagens não são guardadas.",
                )
              }
            >
              <SelectOption value="">Sem cliente</SelectOption>
              {clients.map((c) => (
                <SelectOption key={c.id} value={c.id}>
                  {c.archived ? `${c.name} (arquivado)` : c.name}
                </SelectOption>
              ))}
            </Select>
            {g.client_id && products.length > 0 && (
              <MultiPick
                label={`Produtos do grupo ${title}`}
                allLabel="Todos os produtos"
                noun="produtos"
                options={products}
                value={g.product_ids.filter((p) =>
                  products.some((o) => o.value === p),
                )}
                disabled={!canEdit || busy}
                onChange={(next) =>
                  onChange(
                    { client: g.client_id, products: next, ignored: false },
                    "Produtos do grupo atualizados.",
                  )
                }
              />
            )}
          </div>
        )}
        {canEdit && (
          <div className="member-actions">
            {g.linked_by === "manual" && !g.ignored && (
              <Button
                className="icon-btn"
                title="Voltar à ligação automática"
                aria-label={`Voltar ${title} à ligação automática`}
                disabled={busy}
                onClick={() =>
                  onChange(
                    { auto: true },
                    "Grupo de volta à ligação automática.",
                  )
                }
              >
                <RotateCcw size={15} />
              </Button>
            )}
            <Button
              className="icon-btn"
              title={g.ignored ? "Voltar a guardar" : "Ignorar este grupo"}
              aria-label={
                g.ignored ? `Voltar a guardar ${title}` : `Ignorar ${title}`
              }
              disabled={busy}
              onClick={() =>
                g.ignored
                  ? onChange(
                      g.client_id
                        ? {
                            client: g.client_id,
                            products: g.product_ids,
                            ignored: false,
                          }
                        : { auto: true },
                      "O grupo volta a ser guardado.",
                    )
                  : onChange(
                      {
                        client: g.client_id,
                        products: g.product_ids,
                        ignored: true,
                      },
                      "Grupo ignorado: some do Drive e não é mais lido.",
                    )
              }
            >
              {g.ignored ? <Eye size={15} /> : <EyeOff size={15} />}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
