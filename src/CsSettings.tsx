import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Link2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { Modal } from "./components";
import { Button, Checkbox, Input, Loading, Select, SelectOption } from "./ui";
import { fold } from "./domain";
import {
  KIND_LABEL,
  RULE_LABEL,
  RUN_LABEL,
  STATUS_LABEL,
  TAB_LABEL,
  demoCs,
  monthName,
  realCs,
  runSummary,
  sheetUrl,
  sortedWarnings,
  when,
  type CsBackend,
  type CsClient,
  type CsLinkLog,
  type CsRun,
  type CsSettings,
  type CsSquad,
} from "./cs";
import type { Snapshot } from "./types";
import "./cs.css";

const RUN_ICON = { ok: CheckCircle2, warning: AlertTriangle, error: XCircle };
type Filter = "all" | "unlinked" | "manual";

/**
 * Equipe e configurações › Customer Success: a planilha mestre de CS (link,
 * leitura a cada 10 minutos, "Sincronizar agora", avisos) e a ligação de
 * cada cliente de CS ao cliente do MAVI. Administradores e gestores; só
 * administradores trocam a planilha.
 */
export function CsSettingsPanel({
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
  const [settings, setSettings] = useState<CsSettings | null>(null);
  const [clients, setClients] = useState<CsClient[] | null>(null);
  const [squads, setSquads] = useState<CsSquad[]>([]);
  const [error, setError] = useState("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const api = useMemo(() => (demo ? demoCs(data) : realCs), [demo]);
  const load = useCallback(() => {
    Promise.all([api.settings(company), api.clients(company), api.squads(company)])
      .then(([s, c, q]) => {
        setSettings(s);
        setClients(c);
        setSquads(q);
        setError("");
      })
      .catch((e) => setError((e as Error).message));
  }, [api, company]);
  useEffect(() => {
    load();
    let timer: number | undefined;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 400);
    };
    window.addEventListener("mavi:cs", onChange);
    return () => {
      window.removeEventListener("mavi:cs", onChange);
      window.clearTimeout(timer);
    };
  }, [load]);

  if (error && !settings)
    return (
      <section className="panel" id="config-cs">
        <p className="cs-error">{error}</p>
      </section>
    );
  if (!settings || !clients) return <Loading compact />;
  return (
    <div className="cs-settings" id="config-cs">
      <SheetCard api={api} company={company} settings={settings} onSettings={setSettings} onReload={load} notify={notify} />
      <ClientsCard
        api={api}
        data={data}
        clients={clients}
        squads={squads}
        onRow={(row) => {
          setClients((list) => list?.map((c) => (c.id === row.id ? row : c)) ?? null);
          api.settings(company).then(setSettings).catch(() => undefined);
        }}
        notify={notify}
      />
    </div>
  );
}

// ------------------------------------------------------------ planilha
function SheetCard({
  api,
  company,
  settings,
  onSettings,
  onReload,
  notify,
}: {
  api: CsBackend;
  company: string;
  settings: CsSettings;
  onSettings: (s: CsSettings) => void;
  onReload: () => void;
  notify: (message: string) => void;
}) {
  const [link, setLink] = useState(settings.sheet_id ? sheetUrl(settings.sheet_id) : "");
  const [enabled, setEnabled] = useState(settings.enabled || !settings.sheet_id);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [formError, setFormError] = useState("");
  const [runs, setRuns] = useState<CsRun[] | null>(null);
  const run = settings.last_run;
  const t = settings.totals;
  const changed = (settings.sheet_id ? sheetUrl(settings.sheet_id) : "") !== link || settings.enabled !== enabled;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError("");
    try {
      const s = await api.saveSettings(company, link, enabled);
      onSettings(s);
      setLink(s.sheet_id ? sheetUrl(s.sheet_id) : "");
      notify("Planilha de CS salva.");
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function sync(allowRemovals = false) {
    if (syncing) return;
    if (
      allowRemovals &&
      !window.confirm("Remover do MAVI o que sumiu da planilha? Ciclos, Health Score e eventos desses clientes saem junto.")
    )
      return;
    setSyncing(true);
    try {
      const r = await api.sync(company, allowRemovals);
      notify(r.status === "error" ? `A leitura falhou: ${r.error}` : `Planilha lida. ${runSummary(r)}`);
      onReload();
      if (runs) setRuns(await api.runs(company));
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }
  const Icon = run ? RUN_ICON[run.status] : RefreshCw;
  const warnings = run ? sortedWarnings(run.warnings) : [];
  const urgent = warnings.filter((w) => w.startsWith("⚠️"));
  const others = warnings.filter((w) => !w.startsWith("⚠️"));
  return (
    <section className="panel cs-sheet">
      <div className="panel-heading">
        <div>
          <h2>Planilha mestre de CS</h2>
          <p>
            A planilha continua sendo a fonte da verdade. O MAVI lê todas as abas a cada 10 minutos: o que muda lá
            muda aqui, e o que some de lá some daqui (com as salvaguardas do dash antigo).
          </p>
        </div>
        {settings.sheet_id && (
          <Button className="btn secondary" loading={syncing || settings.running} onClick={() => void sync()}>
            <RefreshCw size={16} /> Sincronizar agora
          </Button>
        )}
      </div>

      <form className="cs-sheet-form" onSubmit={save}>
        <label>
          Link da planilha
          <div className="cs-sheet-link">
            <Input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              readOnly={!settings.can_edit}
              aria-describedby="cs-sheet-hint"
            />
            {settings.sheet_id && (
              <a className="btn secondary" href={sheetUrl(settings.sheet_id)} target="_blank" rel="noreferrer">
                <ExternalLink size={15} /> Abrir
              </a>
            )}
          </div>
          <small id="cs-sheet-hint" className="cs-hint">
            {settings.can_edit
              ? "Compartilhe como “Qualquer pessoa com o link pode ver”. Abas ocultas não são lidas."
              : "Só administradores trocam a planilha."}
          </small>
        </label>
        {settings.can_edit && (
          <div className="cs-sheet-actions">
            <label className="checkbox-label">
              <Checkbox checked={enabled} onCheckedChange={(on) => setEnabled(on === true)} />
              <span>Ler sozinho a cada 10 minutos</span>
            </label>
            <Button className="btn primary" loading={saving} disabled={!changed}>
              Salvar
            </Button>
          </div>
        )}
        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}
      </form>

      {run && (
        <div className={`cs-run ${run.status}`}>
          <div className="cs-run-head">
            <Icon size={18} aria-hidden="true" />
            <div>
              <strong>
                {RUN_LABEL[run.status]} · {when(run.finished_at)}
              </strong>
              <small>
                {run.trigger === "manual" ? `Sincronizado por ${run.by_name ?? "alguém"}` : "Leitura automática"}
                {settings.running && " · lendo agora…"}
              </small>
            </div>
          </div>
          <p className="cs-run-summary">{run.status === "error" ? run.error : runSummary(run)}</p>
          {!!run.blocked?.length && (
            <div className="cs-blocked" role="alert">
              <strong>Sumiço em massa segurado</strong>
              {run.blocked.map((b, i) => (
                <p key={i}>
                  {b.items.length}{" "}
                  {b.kind === "clients" ? "clientes" : b.kind === "cycles" ? `ciclos de ${monthName(b.month!)}` : `notas de HS de ${monthName(b.month!)}`}
                  : {b.items.slice(0, 8).map((x) => x.name).join(", ")}
                  {b.items.length > 8 && ` e mais ${b.items.length - 8}`}
                </p>
              ))}
              <Button className="btn secondary danger" loading={syncing} onClick={() => void sync(true)}>
                Remover mesmo assim
              </Button>
            </div>
          )}
          {!!urgent.length && (
            <ul className="cs-warnings urgent">
              {urgent.map((w, i) => (
                <li key={i}>{w.replace(/^⚠️\s*/, "")}</li>
              ))}
            </ul>
          )}
          {!!others.length && (
            <details className="cs-warnings-more">
              <summary>
                {others.length === 1 ? "1 aviso da planilha" : `${others.length} avisos da planilha`}
              </summary>
              <ul className="cs-warnings">
                {others.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          {!!run.tabs.length && (
            <div className="cs-tabs" aria-label="Abas lidas">
              {run.tabs.map((tab) => (
                <span
                  key={tab.gid}
                  className={`cs-chip ${["template", "history", "instructions", "empty"].includes(tab.kind) ? "muted" : ""} ${tab.kind === "unknown" || tab.duplicate ? "bad" : ""}`}
                  title={tab.name}
                >
                  {TAB_LABEL[tab.kind] ?? tab.kind}
                  {tab.month && ` ${monthName(tab.month)}`}
                  {tab.duplicate && " (duplicada)"}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {!run && settings.sheet_id && (
        <p className="cs-run-summary pending">
          {settings.running ? "Lendo a planilha…" : "A primeira leitura sai em até 10 minutos, ou use “Sincronizar agora”."}
        </p>
      )}

      {settings.sheet_id && (
        <dl className="cs-totals">
          <div>
            <dt>Clientes de CS</dt>
            <dd>
              {t.clients} <small>{t.active} ativos</small>
            </dd>
          </div>
          <div>
            <dt>Ligados ao MAVI</dt>
            <dd>
              {t.linked} <small>de {t.clients}</small>
            </dd>
          </div>
          <div>
            <dt>Ciclos</dt>
            <dd>
              {t.cycles}{" "}
              <small>{t.months.length ? t.months.slice(0, 4).map((m) => monthName(m.month)).join(", ") : "—"}</small>
            </dd>
          </div>
          <div>
            <dt>Health Score</dt>
            <dd>
              {t.hs_months.length} <small>{t.hs_months.length === 1 ? "mês" : "meses"}</small>
            </dd>
          </div>
          <div>
            <dt>Metas</dt>
            <dd>{t.goals}</dd>
          </div>
        </dl>
      )}

      {settings.sheet_id && (
        <details
          className="cs-history"
          onToggle={(e) => {
            if ((e.target as HTMLDetailsElement).open && !runs)
              api.runs(company).then(setRuns).catch((err) => notify((err as Error).message));
          }}
        >
          <summary>Leituras anteriores</summary>
          {!runs && <Loading compact />}
          {runs && (
            <ul>
              {runs.map((r) => {
                const RunIcon = RUN_ICON[r.status];
                return (
                  <li key={r.id} className={r.status}>
                    <RunIcon size={14} aria-hidden="true" />
                    <span>{when(r.finished_at)}</span>
                    <span>{r.trigger === "manual" ? r.by_name ?? "Manual" : "Automática"}</span>
                    <span className="cs-history-summary">
                      {r.status === "error" ? r.error : runSummary(r)}
                      {!!r.warnings.length && ` · ${r.warnings.length} avisos`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </details>
      )}
    </section>
  );
}

// ------------------------------------------------------------ clientes
function ClientsCard({
  api,
  data,
  clients,
  squads,
  onRow,
  notify,
}: {
  api: CsBackend;
  data: Snapshot;
  clients: CsClient[];
  squads: CsSquad[];
  onRow: (row: CsClient) => void;
  notify: (message: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>(() => (clients.some((c) => !c.client_id) ? "unlinked" : "all"));
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<CsClient | null>(null);
  const squadOf = useMemo(() => new Map(squads.map((s) => [s.id, s])), [squads]);
  const counts = {
    all: clients.length,
    unlinked: clients.filter((c) => !c.client_id).length,
    manual: clients.filter((c) => c.link_mode === "manual").length,
  };
  const shown = useMemo(() => {
    const q = fold(query.trim());
    return clients.filter(
      (c) =>
        (filter === "all" || (filter === "unlinked" ? !c.client_id : c.link_mode === "manual")) &&
        (!q || fold(`${c.external_id} ${c.name} ${c.client_name ?? ""}`).includes(q)),
    );
  }, [clients, filter, query]);
  if (!clients.length) return null;
  return (
    <section className="panel cs-clients">
      <div className="panel-heading">
        <div>
          <h2>Clientes de CS no MAVI</h2>
          <p>
            Cada cliente da planilha é ligado ao cliente do MAVI pelo código do MASO (o número do começo do nome) ou
            pelo nome. Quando não há um único candidato, escolha à mão; a escolha vale até voltar ao automático.
          </p>
        </div>
      </div>
      <div className="cs-clients-toolbar">
        <div className="scope-tabs" role="tablist" aria-label="Filtrar clientes de CS">
          {(
            [
              ["unlinked", "Sem cliente do MAVI"],
              ["manual", "Escolhidos à mão"],
              ["all", "Todos"],
            ] as [Filter, string][]
          ).map(([id, label]) => (
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
        <label className="cs-search">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por ID ou nome"
            aria-label="Buscar cliente de CS"
          />
        </label>
      </div>
      {!shown.length ? (
        <p className="cs-empty-filter">
          {filter === "unlinked" && !query ? "Todos os clientes de CS estão ligados a um cliente do MAVI." : "Nenhum cliente encontrado."}
        </p>
      ) : (
        <div className="table-scroll">
          <table className="cs-clients-table stack-mobile">
            <thead>
              <tr>
                <th>Cliente de CS</th>
                <th>Squad</th>
                <th>Situação</th>
                <th>Cliente do MAVI</th>
                <th aria-label="Ações" />
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const squad = squadOf.get(c.squad_id);
                return (
                  <tr key={c.id} className={c.status === "INATIVO" ? "inactive" : ""}>
                    <td data-label="Cliente de CS">
                      <strong>{c.name}</strong>
                      <small>#{c.external_id}</small>
                    </td>
                    <td data-label="Squad">
                      {squad && (
                        <span className="cs-squad-name">
                          <span className="cs-squad-dot small" style={{ background: squad.color }} aria-hidden="true" />
                          {squad.name}
                        </span>
                      )}
                    </td>
                    <td data-label="Situação">
                      {STATUS_LABEL[c.status]}
                      <small>
                        {KIND_LABEL[c.kind]}
                        {c.kind === "TRIAL" && c.trial_month ? ` · M${c.trial_month}` : ""}
                      </small>
                    </td>
                    <td data-label="Cliente do MAVI">
                      {c.client_id ? (
                        <>
                          <strong className={c.client_archived ? "cs-archived" : ""}>{c.client_name}</strong>
                          <small>
                            {c.link_rule ? RULE_LABEL[c.link_rule] : ""}
                            {c.link_mode === "manual" && c.linked_by_name ? ` por ${c.linked_by_name}` : ""}
                            {c.client_archived ? " · cliente arquivado" : ""}
                          </small>
                        </>
                      ) : (
                        <>
                          <span className="cs-chip bad">Sem cliente</span>
                          <small>
                            {c.link_mode === "manual"
                              ? "marcado à mão"
                              : c.code_matches > 1
                                ? `${c.code_matches} clientes com o código ${c.external_id}`
                                : "nenhum com esse código ou nome"}
                          </small>
                        </>
                      )}
                    </td>
                    <td className="cs-actions">
                      <Button className="btn secondary" onClick={() => setEditing(c)}>
                        <Link2 size={14} /> {c.client_id ? "Trocar" : "Escolher"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <LinkDialog
          api={api}
          data={data}
          client={editing}
          onSaved={(row) => {
            onRow(row);
            setEditing(null);
            notify(row.client_name ? `${row.name} ligado a ${row.client_name}.` : `${row.name} ficou sem cliente do MAVI.`);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

const NONE = "__none__";
const AUTO = "__auto__";

function LinkDialog({
  api,
  data,
  client,
  onSaved,
  onClose,
}: {
  api: CsBackend;
  data: Snapshot;
  client: CsClient;
  onSaved: (row: CsClient) => void;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState(
    client.link_mode === "auto" ? AUTO : client.client_id ?? NONE,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [log, setLog] = useState<CsLinkLog[] | null>(null);
  useEffect(() => {
    api.linkLog(client.id).then(setLog).catch(() => setLog([]));
  }, [api, client.id]);
  // Os candidatos primeiro: mesmo código ou nome parecido.
  const options = useMemo(() => {
    const code = client.external_id;
    const name = fold(client.name);
    const score = (n: string) =>
      new RegExp(`^${code}(\\D|$)`).test(n.trim()) ? 0 : fold(n).includes(name) || name.includes(fold(n)) ? 1 : 2;
    return [...data.clients]
      .filter((c) => !c.archived || c.id === client.client_id)
      .sort((a, b) => score(a.name) - score(b.name) || a.name.localeCompare(b.name, "pt-BR"));
  }, [data.clients, client]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      onSaved(
        await api.setLink(client.id, choice === AUTO || choice === NONE ? null : choice, choice === AUTO),
      );
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }
  return (
    <Modal title={`Cliente do MAVI de ${client.name}`} onClose={() => !saving && onClose()} busy={saving}>
      <form className="entity-form" onSubmit={submit}>
        <fieldset className="create-fields" disabled={saving}>
          <p className="cs-link-about">
            #{client.external_id} na planilha de CS. Hoje:{" "}
            <strong>{client.client_name ?? "sem cliente do MAVI"}</strong>
            {client.link_rule && ` (${RULE_LABEL[client.link_rule]})`}.
          </p>
          <label>
            Cliente do MAVI
            <Select value={choice} onValueChange={setChoice} aria-label="Cliente do MAVI">
              <SelectOption value={AUTO}>Automático (pelo código ou pelo nome)</SelectOption>
              <SelectOption value={NONE}>Sem cliente no MAVI</SelectOption>
              {options.map((c) => (
                <SelectOption key={c.id} value={c.id}>
                  {c.name}
                </SelectOption>
              ))}
            </Select>
            <small className="cs-hint">
              A escolha à mão vale até alguém voltar ao automático; a leitura da planilha não mexe nela.
            </small>
          </label>
          {!!log?.length && (
            <div className="cs-link-log">
              <strong>Histórico</strong>
              <ul>
                {log.map((l, i) => (
                  <li key={i}>
                    {when(l.at)} · {l.client_name ?? "sem cliente"}
                    {l.mode === "auto" ? " (automático)" : ` (à mão${l.by_name ? `, ${l.by_name}` : ""})`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <Button type="button" className="btn secondary" disabled={saving} onClick={onClose}>
            Cancelar
          </Button>
          <Button className="btn primary" loading={saving}>
            Salvar
          </Button>
        </div>
      </form>
    </Modal>
  );
}
