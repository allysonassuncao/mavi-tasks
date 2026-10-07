import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ArrowRight, History } from "lucide-react";
import { Button, Input, Loading, Select, SelectOption } from "./ui";
import { Empty, Modal } from "./components";
import { contractProductLabel } from "./domain";
import { catalogEntry, featureInfo } from "./ai-providers";
import { EFFORT_OPTIONS } from "./AiProviders";
import type { Snapshot } from "./types";
import {
  AREA_LABELS,
  LOG_PAGE,
  actorName,
  describeEntry,
  settingsLog,
  type LogArea,
  type LogField,
  type LogFilters,
  type LogNames,
  type SettingsLogEntry,
} from "./ai-settings-log";

/**
 * Painel da MAVI › Quem usa qual modelo › Histórico de alterações: a seção
 * no fim da aba (filtros por seção, pessoa e período) e o ícone ao lado de
 * cada campo, que abre só o histórico dele. Administradores e gestores.
 */

type LogContext = { company: string; names: LogNames };
const Ctx = createContext<LogContext | null>(null);

function useNames(data: Snapshot, providers?: { id: string; name: string }[]): LogNames {
  return useMemo(() => {
    const library = new Map((providers ?? []).map((p) => [p.id, p.name]));
    const people = new Map(data.members.map((m) => [m.user_id, m.name]));
    const teams = new Map(data.teams.map((t) => [t.id, t.name]));
    return {
      person: (id) => people.get(id),
      team: (id) => teams.get(id),
      feature: (id) => featureInfo(id)?.label,
      scope: (area, id) => {
        if (area === "user") return people.get(id);
        if (area === "client")
          return data.clients.find((c) => c.id === id)?.name;
        if (area === "project")
          return data.projects.find((p) => p.id === id)?.name;
        if (area === "contract") {
          const k = data.contracts.find((c) => c.id === id);
          if (!k) return undefined;
          const client = data.clients.find((c) => c.id === k.client_id)?.name;
          return `${contractProductLabel(data, id)} · ${client ?? "?"}`;
        }
        return undefined;
      },
      kind: (kind) => catalogEntry(kind)?.label,
      effort: (effort) =>
        EFFORT_OPTIONS.find((o) => o.id === effort)?.label.split(" · ")[0],
      provider: (id) => library.get(id),
    };
  }, [data, providers]);
}

/** Liga os ícones de histórico (sem empresa, na demonstração: nada aparece). */
export function SettingsLogProvider({
  company,
  data,
  providers,
  children,
}: {
  company?: string;
  data: Snapshot;
  /** Os provedores da biblioteca (os nomes nas listas do roteador). */
  providers?: { id: string; name: string }[];
  children: ReactNode;
}) {
  const names = useNames(data, providers);
  const value = useMemo(
    () => (company ? { company, names } : null),
    [company, names],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });

/** A lista com "Carregar mais"; recarrega quando os filtros ou a versão mudam. */
function LogList({
  company,
  names,
  filters,
  version,
  showWhere = true,
  emptyBody,
}: {
  company: string;
  names: LogNames;
  filters: LogFilters;
  version?: unknown;
  showWhere?: boolean;
  emptyBody: string;
}) {
  const [items, setItems] = useState<SettingsLogEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const key = JSON.stringify(filters);
  const load = useCallback(() => {
    setError("");
    settingsLog(company, filters)
      .then((r) => {
        setItems(r);
        setMore(r.length === LOG_PAGE);
      })
      .catch((e) => {
        setItems([]);
        setError((e as Error).message);
      });
  }, [company, key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load, version]);

  async function loadMore() {
    if (!items?.length) return;
    setLoadingMore(true);
    try {
      const r = await settingsLog(company, {
        ...filters,
        before: items[items.length - 1].id,
      });
      setItems([...items, ...r]);
      setMore(r.length === LOG_PAGE);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {items === null ? (
        <Loading variant="table" />
      ) : items.length ? (
        <>
          <ol className="ai-log-list">
            {items.map((e) => {
              const d = describeEntry(e, names);
              return (
                <li key={e.id} className={`ai-log-item ${e.action}`}>
                  <div className="ai-log-head">
                    <strong>{actorName(e, names)}</strong>
                    <time dateTime={e.at}>{when(e.at)}</time>
                  </div>
                  <span className="ai-log-where">
                    {showWhere ? `${d.where} · ` : ""}
                    {d.field}
                  </span>
                  {d.text ? (
                    <span className="ai-log-change">{d.text}</span>
                  ) : (
                    <span className="ai-log-change">
                      {d.from !== undefined && (
                        <>
                          <s>{d.from}</s>
                          <ArrowRight size={13} aria-label="para" />
                        </>
                      )}
                      <b>{d.to}</b>
                    </span>
                  )}
                  {d.cause && <small className="ai-log-cause">{d.cause}</small>}
                </li>
              );
            })}
          </ol>
          {more && (
            <Button
              className="btn secondary ai-log-more"
              loading={loadingMore}
              onClick={() => void loadMore()}
            >
              Carregar mais
            </Button>
          )}
        </>
      ) : (
        !error && <Empty title="Nenhuma alteração" body={emptyBody} />
      )}
    </>
  );
}

/**
 * O ícone ao lado de um campo: o histórico só dele (fields vazio: todos os
 * campos da linha, como no cartão do provedor).
 */
export function FieldHistory({
  title,
  area,
  subject = "",
  fields,
}: {
  /** O nome do campo, para o título e o leitor de tela. */
  title: string;
  area: LogArea;
  subject?: string;
  fields?: LogField[];
}) {
  const ctx = useContext(Ctx);
  const [open, setOpen] = useState(false);
  if (!ctx) return null;
  return (
    <>
      <button
        type="button"
        className="icon-btn ai-log-btn"
        aria-label={`Histórico de ${title}`}
        title="Histórico de alterações"
        onClick={() => setOpen(true)}
      >
        <History size={15} />
      </button>
      {open && (
        <Modal
          title={`Histórico · ${title}`}
          onClose={() => setOpen(false)}
          className="ai-log-dialog"
        >
          <div className="ai-log-modal">
            <LogList
              company={ctx.company}
              names={ctx.names}
              filters={{ area, subject, fields }}
              showWhere={false}
              emptyBody="Nenhuma alteração neste campo desde que o histórico começou."
            />
          </div>
        </Modal>
      )}
    </>
  );
}

const AREAS = Object.keys(AREA_LABELS) as LogArea[];

/** A seção no fim da aba: tudo, com filtros resolvidos no banco. */
export function SettingsHistory({
  data,
  version,
}: {
  data: Snapshot;
  /** Muda depois de cada alteração na aba (recarrega a lista). */
  version?: unknown;
}) {
  const ctx = useContext(Ctx);
  const [area, setArea] = useState<LogArea | "">("");
  const [actor, setActor] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const leaders = useMemo(
    () =>
      data.members
        .filter((m) => m.role === "admin" || m.role === "manager")
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [data.members],
  );
  if (!ctx)
    return (
      <section className="panel ai-log" aria-label="Histórico de alterações">
        <header>
          <strong>
            <History size={15} aria-hidden="true" /> Histórico de alterações
          </strong>
          <small>No ambiente demonstrativo, o histórico não é gravado.</small>
        </header>
      </section>
    );
  const filtered = Boolean(area || actor || from || to);
  return (
    <section className="panel ai-log" aria-label="Histórico de alterações">
      <header>
        <strong>
          <History size={15} aria-hidden="true" /> Histórico de alterações
        </strong>
        <small>
          Toda alteração em cada campo desta aba e de Provedores e modelos: quem
          fez, quando, o que era e o que ficou. Também o que muda sozinho, como
          a regra que sai quando o provedor é excluído. Fica guardado para
          sempre e ninguém edita nem apaga.
        </small>
      </header>
      <div className="ai-log-filters">
        <Select
          aria-label="Filtrar por seção"
          value={area || "all"}
          onValueChange={(v) => setArea(v === "all" ? "" : (v as LogArea))}
        >
          <SelectOption value="all">Todas as seções</SelectOption>
          {AREAS.map((a) => (
            <SelectOption key={a} value={a}>
              {AREA_LABELS[a]}
            </SelectOption>
          ))}
        </Select>
        <Select
          aria-label="Filtrar por quem alterou"
          value={actor || "all"}
          onValueChange={(v) => setActor(v === "all" ? "" : v)}
        >
          <SelectOption value="all">Qualquer pessoa</SelectOption>
          {leaders.map((m) => (
            <SelectOption key={m.user_id} value={m.user_id}>
              {m.name}
            </SelectOption>
          ))}
        </Select>
        <Input
          type="date"
          aria-label="De"
          placeholder="De"
          value={from}
          max={to || undefined}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Input
          type="date"
          aria-label="Até"
          placeholder="Até"
          value={to}
          min={from || undefined}
          onChange={(e) => setTo(e.target.value)}
        />
        {filtered && (
          <button
            type="button"
            className="text-btn"
            onClick={() => {
              setArea("");
              setActor("");
              setFrom("");
              setTo("");
            }}
          >
            Limpar filtros
          </button>
        )}
      </div>
      <LogList
        company={ctx.company}
        names={ctx.names}
        filters={{
          area: area || undefined,
          actor: actor || undefined,
          from: from || undefined,
          to: to || undefined,
        }}
        version={version}
        emptyBody={
          filtered
            ? "Nenhuma alteração com estes filtros."
            : "As alterações aparecem aqui assim que alguém mudar um campo."
        }
      />
    </section>
  );
}
