import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Copy,
  Globe,
  LayoutDashboard,
  Link2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import {
  Button,
  Checkbox,
  Input,
  Loading,
  Select,
  SelectOption,
  Textarea,
} from "./ui";
import { Empty, Modal } from "./components";
import { MultiPick, type PickOption } from "./MultiPick";
import { DashboardCanvas, type PanelLoader } from "./DashboardCanvas";
import { PanelChart } from "./DashboardCharts";
import { runPanel } from "./dashboard-engine";
import {
  buildDisplay,
  dashboardLinkUrl,
  dashboardMembers,
  deleteDashboard,
  filterLabels,
  freeSpot,
  getDashboard,
  groupsFor,
  listDashboards,
  newPanelId,
  panelData,
  parseFormula,
  previewPanel,
  rangeOptions,
  resolveRange,
  saveDashboard,
  setDashboardSharing,
  sources,
  starterPanels,
  vizOptions,
  compact,
  type Dashboard,
  type DashboardFilters,
  type DashboardRange,
  type DashboardVariables,
  type FilterField,
  type LinkAccess,
  type Panel,
  type PanelResult,
  type PanelSpec,
  type Query,
  type QueryFilter,
  type Source,
} from "./dashboards";
import { priorities, statuses, type Snapshot } from "./types";

type Notify = (message: string) => void;

// The demonstration keeps its dashboards in memory for the session.
let demoDashboards: Dashboard[] | null = null;
function demoList(company: string, user: string): Dashboard[] {
  if (!demoDashboards) {
    const now = new Date().toISOString();
    demoDashboards = [
      {
        id: "demo-operacao",
        company_id: company,
        name: "Visão da operação",
        description: "Entregas, ritmo, horas e atrasos da agência.",
        panels: starterPanels(),
        variables: { range: { preset: "30d" }, filters: {} },
        link_access: "none",
        share_token: "demo",
        has_password: false,
        version: 1,
        created_by: user,
        updated_by: user,
        created_at: now,
        updated_at: now,
      },
    ];
  }
  return demoDashboards;
}
function demoSave(
  company: string,
  user: string,
  d: Partial<Dashboard> &
    Pick<Dashboard, "name" | "description" | "panels" | "variables">,
) {
  const list = demoList(company, user);
  const now = new Date().toISOString();
  const existing = d.id ? list.find((x) => x.id === d.id) : undefined;
  const saved: Dashboard = existing
    ? ({
        ...existing,
        ...d,
        version: existing.version + 1,
        updated_at: now,
        updated_by: user,
      } as Dashboard)
    : ({
        id: `demo-${crypto.randomUUID()}`,
        company_id: company,
        link_access: "none",
        share_token: "demo",
        has_password: false,
        version: 1,
        created_by: user,
        updated_by: user,
        created_at: now,
        updated_at: now,
        ...d,
      } as Dashboard);
  demoDashboards = existing
    ? list.map((x) => (x.id === saved.id ? saved : x))
    : [saved, ...list];
  return saved;
}

const linkBadge: Record<LinkAccess, { label: string; Icon: typeof Lock }> = {
  none: { label: "Privado", Icon: Lock },
  password: { label: "Com senha", Icon: Lock },
  public: { label: "Público", Icon: Globe },
};

/**
 * Dashboards (leaders): the list, and each dashboard to view, edit and
 * share. People a dashboard is shared with open it by its link (view only).
 */
export function DashboardsPage({
  data,
  company,
  demo,
  isLeader,
  user,
  notify,
  dashboardId,
  onOpen,
  internalUrl,
}: {
  data: Snapshot;
  company: string;
  demo: boolean;
  isLeader: boolean;
  user: string;
  notify: Notify;
  dashboardId: string | null;
  onOpen: (id: string | null) => void;
  /** The in-app address of a dashboard, for people it is shared with. */
  internalUrl: (id: string) => string;
}) {
  if (dashboardId)
    return (
      <DashboardView
        key={dashboardId}
        id={dashboardId}
        data={data}
        company={company}
        demo={demo}
        isLeader={isLeader}
        user={user}
        notify={notify}
        onBack={isLeader ? () => onOpen(null) : undefined}
        onDeleted={() => onOpen(null)}
        internalUrl={internalUrl}
      />
    );
  if (!isLeader)
    return (
      <Empty
        title="Dashboards"
        body="Abra um dashboard pelo link que compartilharam com você."
      />
    );
  return (
    <DashboardList
      data={data}
      company={company}
      demo={demo}
      user={user}
      notify={notify}
      onOpen={onOpen}
    />
  );
}

// ------------------------------------------------------------ list
function DashboardList({
  data,
  company,
  demo,
  user,
  notify,
  onOpen,
}: {
  data: Snapshot;
  company: string;
  demo: boolean;
  user: string;
  notify: Notify;
  onOpen: (id: string) => void;
}) {
  const [list, setList] = useState<Dashboard[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let current = true;
    setError("");
    (demo ? Promise.resolve(demoList(company, user)) : listDashboards(company))
      .then((rows) => current && setList([...rows]))
      .catch((e) => current && setError((e as Error).message));
    return () => {
      current = false;
    };
  }, [company, demo, user, tick]);

  async function duplicate(d: Dashboard) {
    try {
      const copy = {
        name: `${d.name} (cópia)`.slice(0, 120),
        description: d.description,
        panels: d.panels,
        variables: d.variables,
      };
      const saved = demo
        ? demoSave(company, user, copy)
        : await saveDashboard(company, copy);
      notify("Dashboard duplicado.");
      onOpen(saved.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function remove(d: Dashboard) {
    if (
      !window.confirm(
        `Excluir o dashboard "${d.name}"? Os links compartilhados deixam de funcionar.`,
      )
    )
      return;
    try {
      if (demo)
        demoDashboards = demoList(company, user).filter((x) => x.id !== d.id);
      else await deleteDashboard(d.id);
      notify("Dashboard excluído.");
      setTick((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const who = (id: string | null) =>
    data.members.find((m) => m.user_id === id)?.name ?? "—";
  return (
    <div className="dash-list-page">
      <div className="section-top">
        <span>
          {list
            ? `${list.length} ${list.length === 1 ? "dashboard" : "dashboards"}`
            : ""}
        </span>
        <Button className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={16} /> Novo dashboard
        </Button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {list === null ? (
        !error && <Loading compact />
      ) : list.length ? (
        <div className="dash-cards">
          {list.map((d) => {
            const { label, Icon } = linkBadge[d.link_access];
            return (
              <article key={d.id} className="panel dash-card">
                <button
                  type="button"
                  className="dash-card-open"
                  onClick={() => onOpen(d.id)}
                >
                  <span className="dash-card-icon" aria-hidden="true">
                    <LayoutDashboard size={18} />
                  </span>
                  <span className="dash-card-text">
                    <strong>{d.name}</strong>
                    {d.description && <small>{d.description}</small>}
                  </span>
                </button>
                <footer>
                  <span
                    className={`visibility-badge ${d.link_access === "public" ? "public" : ""}`}
                  >
                    <Icon size={12} /> {label}
                  </span>
                  <small>
                    {d.panels.length}{" "}
                    {d.panels.length === 1 ? "painel" : "painéis"} · editado por{" "}
                    {who(d.updated_by ?? d.created_by)} em{" "}
                    {new Date(d.updated_at).toLocaleDateString("pt-BR")}
                  </small>
                  <span className="dash-card-actions">
                    <Button
                      className="icon-btn"
                      aria-label={`Duplicar ${d.name}`}
                      title="Duplicar"
                      onClick={() => void duplicate(d)}
                    >
                      <Copy size={15} />
                    </Button>
                    <Button
                      className="icon-btn danger"
                      aria-label={`Excluir ${d.name}`}
                      title="Excluir"
                      onClick={() => void remove(d)}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </span>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="panel">
          <Empty
            title="Seu primeiro dashboard"
            body="Monte painéis com indicadores de tarefas e horas da agência: números, gráficos e tabelas, com filtros por período, cliente, produto, equipe e pessoa."
            action={
              <Button className="btn primary" onClick={() => setCreating(true)}>
                <Plus size={16} /> Novo dashboard
              </Button>
            }
          />
        </div>
      )}
      {creating && (
        <CreateDashboard
          onClose={() => setCreating(false)}
          onCreate={async (name, description, template) => {
            const d = {
              name,
              description,
              panels: template ? starterPanels() : [],
              variables: { range: { preset: "30d" as const }, filters: {} },
            };
            const saved = demo
              ? demoSave(company, user, d)
              : await saveDashboard(company, d);
            notify("Dashboard criado.");
            onOpen(saved.id);
          }}
        />
      )}
    </div>
  );
}

function CreateDashboard({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (
    name: string,
    description: string,
    template: boolean,
  ) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title="Novo dashboard"
      onClose={() => !busy && onClose()}
      busy={busy}
    >
      <form
        className="entity-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await onCreate(name.trim(), description.trim(), template);
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <label>
          Nome
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
            maxLength={120}
            autoFocus
          />
        </label>
        <label>
          Descrição (opcional)
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            rows={2}
          />
        </label>
        <fieldset className="dash-template">
          <legend>Começar com</legend>
          <label className={template ? "selected" : ""}>
            <input
              type="radio"
              name="template"
              checked={template}
              onChange={() => setTemplate(true)}
            />
            <strong>Modelo: visão da operação</strong>
            <small>
              8 painéis prontos (criadas, entregas, no prazo, horas, ritmo,
              status, clientes e pessoas) para ajustar.
            </small>
          </label>
          <label className={!template ? "selected" : ""}>
            <input
              type="radio"
              name="template"
              checked={!template}
              onChange={() => setTemplate(false)}
            />
            <strong>Em branco</strong>
            <small>Adicione os painéis um a um.</small>
          </label>
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Button className="btn primary" type="submit" loading={busy}>
          <Plus size={16} /> Criar dashboard
        </Button>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------ view / edit
function useLookups(data: Snapshot) {
  return useMemo(() => {
    const byName = (a: PickOption, b: PickOption) =>
      a.label.localeCompare(b.label, "pt-BR");
    return {
      client: data.clients
        .map((c) => ({ value: c.id, label: c.name }))
        .sort(byName),
      product: data.products
        .map((p) => ({ value: p.id, label: p.name }))
        .sort(byName),
      project: data.projects
        .map((p) => ({ value: p.id, label: p.name }))
        .sort(byName),
      team: data.teams
        .map((t) => ({ value: t.id, label: t.name }))
        .sort(byName),
      person: data.members
        .map((m) => ({ value: m.user_id, label: m.name }))
        .sort(byName),
      creator: data.members
        .map((m) => ({ value: m.user_id, label: m.name }))
        .sort(byName),
      status: Object.entries(statuses).map(([k, s]) => ({
        value: k,
        label: s.label,
      })),
      priority: Object.entries(priorities).map(([k, l]) => ({
        value: k,
        label: l,
      })),
      entry_source: [
        { value: "timer", label: "Cronômetro" },
        { value: "manual", label: "Lançamento manual" },
      ],
      late: [],
    } satisfies Record<FilterField, PickOption[]>;
  }, [data]);
}

function DashboardView({
  id,
  data,
  company,
  demo,
  isLeader,
  user,
  notify,
  onBack,
  onDeleted,
  internalUrl,
}: {
  id: string;
  data: Snapshot;
  company: string;
  demo: boolean;
  isLeader: boolean;
  user: string;
  notify: Notify;
  onBack?: () => void;
  onDeleted: () => void;
  internalUrl: (id: string) => string;
}) {
  const tz =
    data.companies.find((c) => c.id === company)?.timezone ??
    "America/Sao_Paulo";
  const [saved, setSaved] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Dashboard | null>(null);
  const [vars, setVars] = useState<DashboardVariables>({});
  const [refresh, setRefresh] = useState(0);
  const [auto, setAuto] = useState(0);
  const [editingPanel, setEditingPanel] = useState<Panel | "new" | null>(null);
  const [sharing, setSharing] = useState(false);
  const [saving, setSaving] = useState(false);
  const lookups = useLookups(data);

  useEffect(() => {
    let current = true;
    (demo
      ? Promise.resolve(
          demoList(company, user).find((d) => d.id === id) ?? null,
        )
      : getDashboard(id)
    )
      .then((d) => {
        if (!current) return;
        if (!d) setError("Dashboard não encontrado ou sem acesso para você.");
        else {
          setSaved(d);
          setVars(d.variables ?? {});
        }
      })
      .catch((e) => current && setError((e as Error).message));
    return () => {
      current = false;
    };
  }, [id, demo, company, user]);

  // Auto refresh (like Grafana), skipped while the tab is hidden.
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") setRefresh((v) => v + 1);
    }, auto * 1000);
    return () => clearInterval(timer);
  }, [auto]);

  const dash = draft ?? saved;
  const range = useMemo(() => resolveRange(vars.range, tz), [vars.range, tz]);
  const filters = vars.filters ?? {};
  const editing = !!draft;
  const loadKey = JSON.stringify([range, isLeader ? filters : null, editing]);
  const loader: PanelLoader = useCallback(
    (panel, fresh) => {
      if (demo)
        return Promise.resolve(
          runPanel(
            data,
            panel.spec,
            range,
            isLeader ? filters : (saved?.variables.filters ?? {}),
            tz,
          ),
        );
      // Unsaved panels (editing) are computed from their spec; saved ones
      // through the dashboard, with the 60-second cache.
      if (editing) return previewPanel(company, panel.spec, range, { filters });
      return panelData(
        { kind: "app", dashboard: id },
        panel.id,
        range,
        isLeader ? vars : null,
        fresh,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo, data, range, loadKey, id, company, saved],
  );

  if (error)
    return (
      <div className="panel">
        <Empty title="Dashboard indisponível" body={error} />
      </div>
    );
  if (!dash) return <Loading compact />;

  const setPanels = (panels: Panel[]) =>
    setDraft((d) => (d ? { ...d, panels } : d));
  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const body = {
        id: draft.id,
        version: draft.version,
        name: draft.name,
        description: draft.description,
        panels: draft.panels,
        variables: vars,
      };
      const next = demo
        ? demoSave(company, user, body)
        : await saveDashboard(company, body);
      setSaved(next);
      setDraft(null);
      notify("Dashboard salvo.");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  function cancel() {
    if (
      draft &&
      JSON.stringify(draft) !== JSON.stringify(saved) &&
      !window.confirm("Descartar as alterações deste dashboard?")
    )
      return;
    setDraft(null);
    if (saved) setVars(saved.variables ?? {});
  }
  const { label: linkLabel, Icon: LinkIcon } = linkBadge[dash.link_access];
  return (
    <div className="dash-view">
      <div className="dash-view-head">
        {onBack && (
          <Button
            className="icon-btn"
            aria-label="Voltar aos dashboards"
            title="Voltar"
            onClick={() =>
              (!editing || window.confirm("Sair sem salvar?")) && onBack()
            }
          >
            <ArrowLeft size={18} />
          </Button>
        )}
        <div className="dash-view-title">
          {editing ? (
            <>
              <Input
                aria-label="Nome do dashboard"
                value={draft.name}
                maxLength={120}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <Input
                aria-label="Descrição"
                placeholder="Descrição (opcional)"
                value={draft.description}
                maxLength={500}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
              />
            </>
          ) : (
            <>
              <h2>{dash.name}</h2>
              {dash.description && <p>{dash.description}</p>}
            </>
          )}
        </div>
        {isLeader && (
          <div className="dash-view-actions">
            {editing ? (
              <>
                <Button
                  className="btn secondary"
                  onClick={cancel}
                  disabled={saving}
                >
                  <X size={15} /> Cancelar
                </Button>
                <Button
                  className="btn primary"
                  onClick={() => void save()}
                  loading={saving}
                >
                  <Save size={15} /> Salvar
                </Button>
              </>
            ) : (
              <>
                <span
                  className={`visibility-badge ${dash.link_access === "public" ? "public" : ""}`}
                >
                  <LinkIcon size={12} /> {linkLabel}
                </span>
                <Button
                  className="btn secondary"
                  onClick={() => setSharing(true)}
                >
                  <Share2 size={15} /> Compartilhar
                </Button>
                <Button
                  className="btn primary"
                  onClick={() => setDraft(structuredClone(dash))}
                >
                  <Pencil size={15} /> Editar
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      <VariablesBar
        vars={vars}
        tz={tz}
        onChange={setVars}
        canFilter={isLeader}
        lookups={lookups}
        onRefresh={() => setRefresh((v) => v + 1)}
        auto={auto}
        onAuto={setAuto}
        savedFilters={dash.variables.filters}
      />
      {editing && (
        <div className="dash-edit-bar">
          <span>
            Arraste um painel pelo título para mover e pelo canto para
            redimensionar. O período e os filtros atuais ficam como padrão ao
            salvar.
          </span>
          <Button
            className="btn secondary"
            onClick={() => setEditingPanel("new")}
          >
            <Plus size={15} /> Adicionar painel
          </Button>
        </div>
      )}
      {dash.panels.length ? (
        <DashboardCanvas
          panels={dash.panels}
          loader={loader}
          loadKey={loadKey}
          refresh={refresh}
          editing={editing}
          onLayout={setPanels}
          onEditPanel={(p) => setEditingPanel(p)}
          onDuplicatePanel={(p) => {
            if (!draft) return;
            const spot = freeSpot(draft.panels, p.w, p.h);
            setPanels([
              ...draft.panels,
              {
                ...structuredClone(p),
                ...spot,
                id: newPanelId(),
                title: `${p.title} (cópia)`.slice(0, 120),
              },
            ]);
          }}
          onDeletePanel={(p) => {
            if (draft && window.confirm(`Remover o painel "${p.title}"?`))
              setPanels(compact(draft.panels.filter((x) => x.id !== p.id)));
          }}
        />
      ) : (
        <div className="panel">
          <Empty
            title="Nenhum painel ainda"
            body={
              isLeader
                ? "Clique em Editar e adicione o primeiro painel."
                : "Este dashboard ainda não tem painéis."
            }
          />
        </div>
      )}
      {editingPanel && draft && (
        <PanelEditor
          panel={editingPanel === "new" ? null : editingPanel}
          lookups={lookups}
          onClose={() => setEditingPanel(null)}
          preview={(spec) =>
            demo
              ? Promise.resolve(runPanel(data, spec, range, filters, tz))
              : previewPanel(company, spec, range, { filters })
          }
          onSave={(panel) => {
            if (editingPanel === "new") {
              const spot = freeSpot(draft.panels, panel.w, panel.h);
              setPanels([...draft.panels, { ...panel, ...spot }]);
            } else
              setPanels(
                draft.panels.map((p) => (p.id === panel.id ? panel : p)),
              );
            setEditingPanel(null);
          }}
        />
      )}
      {sharing && saved && (
        <ShareDialog
          dashboard={saved}
          data={data}
          demo={demo}
          notify={notify}
          internalUrl={internalUrl(saved.id)}
          onClose={() => setSharing(false)}
          onSaved={(d) => setSaved(d)}
          onDeleted={onDeleted}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------ variables
function VariablesBar({
  vars,
  tz,
  onChange,
  canFilter,
  lookups,
  onRefresh,
  auto,
  onAuto,
  savedFilters,
}: {
  vars: DashboardVariables;
  tz: string;
  onChange: (v: DashboardVariables) => void;
  canFilter: boolean;
  lookups: ReturnType<typeof useLookups>;
  onRefresh: () => void;
  auto: number;
  onAuto: (seconds: number) => void;
  savedFilters?: DashboardFilters;
}) {
  const range = vars.range;
  const custom = !!range && "from" in range;
  const preset = custom ? "custom" : (range?.preset ?? "30d");
  const filters = vars.filters ?? {};
  const setFilter = (key: keyof DashboardFilters, value: string[]) =>
    onChange({ ...vars, filters: { ...filters, [key]: value } });
  const setRange = (r: DashboardRange) => onChange({ ...vars, range: r });
  const fixed = !canFilter
    ? (["clients", "products", "teams", "people"] as const).filter(
        (k) => savedFilters?.[k]?.length,
      )
    : [];
  return (
    <div className="dash-vars" role="group" aria-label="Filtros do dashboard">
      <Select
        aria-label="Período"
        value={preset}
        onValueChange={(v) => {
          if (v === "custom") {
            const r = resolveRange(range, tz);
            setRange({ from: r.from, to: r.to });
          } else setRange({ preset: v as never });
        }}
      >
        {rangeOptions.map((r) => (
          <SelectOption key={r.key} value={r.key}>
            {r.label}
          </SelectOption>
        ))}
        <SelectOption value="custom">Personalizado</SelectOption>
      </Select>
      {custom && range && "from" in range && (
        <span className="dash-custom-range">
          <Input
            type="date"
            aria-label="De"
            value={range.from}
            max={range.to}
            onChange={(e) =>
              e.target.value && setRange({ from: e.target.value, to: range.to })
            }
          />
          <span aria-hidden="true">–</span>
          <Input
            type="date"
            aria-label="Até"
            value={range.to}
            min={range.from}
            onChange={(e) =>
              e.target.value &&
              setRange({ from: range.from, to: e.target.value })
            }
          />
        </span>
      )}
      {canFilter && (
        <>
          <MultiPick
            label="Clientes"
            allLabel="Todos os clientes"
            noun="clientes"
            options={lookups.client}
            value={filters.clients ?? []}
            onChange={(v) => setFilter("clients", v)}
          />
          <MultiPick
            label="Produtos"
            allLabel="Todos os produtos"
            noun="produtos"
            options={lookups.product}
            value={filters.products ?? []}
            onChange={(v) => setFilter("products", v)}
          />
          <MultiPick
            label="Equipes"
            allLabel="Todas as equipes"
            noun="equipes"
            options={lookups.team}
            value={filters.teams ?? []}
            onChange={(v) => setFilter("teams", v)}
          />
          <MultiPick
            label="Pessoas"
            allLabel="Todas as pessoas"
            noun="pessoas"
            options={lookups.person}
            value={filters.people ?? []}
            onChange={(v) => setFilter("people", v)}
          />
        </>
      )}
      {fixed.length > 0 && (
        <small className="dash-fixed-filters">
          Filtros definidos por quem criou o dashboard.
        </small>
      )}
      <span className="dash-vars-end">
        <Select
          aria-label="Atualização automática"
          value={String(auto)}
          onValueChange={(v) => onAuto(Number(v))}
        >
          <SelectOption value="0">Atualização manual</SelectOption>
          <SelectOption value="60">A cada 1 min</SelectOption>
          <SelectOption value="300">A cada 5 min</SelectOption>
          <SelectOption value="900">A cada 15 min</SelectOption>
        </Select>
        <Button
          className="icon-btn"
          aria-label="Atualizar agora"
          title="Atualizar agora"
          onClick={onRefresh}
        >
          <RefreshCw size={15} />
        </Button>
      </span>
    </div>
  );
}

// ------------------------------------------------------------ panel editor
const REFS = ["A", "B", "C", "D", "E"];
/** A grouping that suits the visualization (numbers total, donuts split…). */
function groupForViz(
  viz: PanelSpec["viz"],
  current: PanelSpec["groupBy"],
): PanelSpec["groupBy"] {
  if (viz === "stat") return "none";
  if (
    (viz === "donut" || viz === "hbar") &&
    (current === "none" || current === "time")
  )
    return "client";
  if (current === "none") return viz === "table" ? "client" : "time";
  return current;
}
const blankQuery = (ref: string, source: Source = "tasks"): Query => ({
  ref,
  source,
  metric: sources[source].metrics[0].key,
  dateField: sources[source].dateFields[0].key,
  filters: [],
});

function PanelEditor({
  panel,
  lookups,
  onClose,
  onSave,
  preview,
}: {
  panel: Panel | null;
  lookups: ReturnType<typeof useLookups>;
  onClose: () => void;
  onSave: (panel: Panel) => void;
  preview: (spec: PanelSpec) => Promise<PanelResult>;
}) {
  const [title, setTitle] = useState(panel?.title ?? "Novo painel");
  const [spec, setSpec] = useState<PanelSpec>(
    () =>
      structuredClone(panel?.spec) ?? {
        viz: "line",
        groupBy: "time",
        interval: "auto",
        queries: [blankQuery("A")],
      },
  );
  const [result, setResult] = useState<PanelResult | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [loading, setLoading] = useState(false);
  const formula = spec.formula?.expr ? parseFormula(spec.formula.expr) : null;
  const formulaError =
    formula && !formula.ok
      ? formula.error
      : formula?.ok &&
          formula.refs.some((r) => !spec.queries.some((q) => q.ref === r))
        ? "A fórmula usa uma consulta que não existe."
        : "";
  const groups = groupsFor(spec.queries);
  const specKey = JSON.stringify(spec);
  const request = useRef(0);

  // Live preview, a moment after the last change.
  useEffect(() => {
    if (formulaError) return;
    const n = ++request.current;
    const timer = setTimeout(() => {
      setLoading(true);
      setPreviewError("");
      preview(spec)
        .then((r) => n === request.current && setResult(r))
        .catch(
          (e) => n === request.current && setPreviewError((e as Error).message),
        )
        .finally(() => n === request.current && setLoading(false));
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, formulaError]);

  const update = (patch: Partial<PanelSpec>) =>
    setSpec((s) => ({ ...s, ...patch }));
  const setQuery = (ref: string, patch: Partial<Query>) =>
    setSpec((s) => {
      const queries = s.queries.map((q) =>
        q.ref === ref ? { ...q, ...patch } : q,
      );
      // A grouping every query supports.
      const groupBy = groupsFor(queries).some((g) => g.key === s.groupBy)
        ? s.groupBy
        : "none";
      return { ...s, queries, groupBy };
    });
  const display = useMemo(
    () => (result ? buildDisplay(spec, result) : null),
    [result, specKey],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const categorical = !["none", "time"].includes(spec.groupBy);
  return (
    <Modal
      title={panel ? "Editar painel" : "Novo painel"}
      onClose={onClose}
      wide
    >
      <div className="dash-editor">
        <div className="dash-editor-form">
          <label>
            Título
            <Input
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <fieldset>
            <legend>Visualização</legend>
            <div
              className="dash-viz-options"
              role="radiogroup"
              aria-label="Visualização"
            >
              {vizOptions.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  role="radio"
                  aria-checked={spec.viz === v.key}
                  className={spec.viz === v.key ? "selected" : ""}
                  onClick={() =>
                    update({
                      viz: v.key,
                      groupBy: groupForViz(v.key, spec.groupBy),
                    })
                  }
                >
                  {v.label}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="dash-queries">
            {spec.queries.map((q) => (
              <QueryEditor
                key={q.ref}
                query={q}
                lookups={lookups}
                canHide={!!spec.formula}
                canRemove={spec.queries.length > 1}
                onChange={(patch) => setQuery(q.ref, patch)}
                onRemove={() =>
                  update({
                    queries: spec.queries.filter((x) => x.ref !== q.ref),
                  })
                }
              />
            ))}
            {spec.queries.length < 5 && (
              <Button
                className="btn secondary"
                onClick={() => {
                  const ref = REFS.find(
                    (r) => !spec.queries.some((q) => q.ref === r),
                  )!;
                  update({
                    queries: [
                      ...spec.queries,
                      blankQuery(ref, spec.queries[0]?.source),
                    ],
                  });
                }}
              >
                <Plus size={15} /> Consulta
              </Button>
            )}
          </div>

          <fieldset className="dash-formula">
            <label className="checkbox-label">
              <Checkbox
                checked={!!spec.formula}
                onCheckedChange={(on) =>
                  update({
                    formula:
                      on === true
                        ? {
                            expr: spec.queries.length > 1 ? "A / B * 100" : "A",
                            label: "",
                          }
                        : null,
                  })
                }
              />
              Calcular com uma fórmula
            </label>
            {spec.formula && (
              <>
                <div className="form-columns">
                  <label>
                    Fórmula
                    <Input
                      value={spec.formula.expr}
                      maxLength={200}
                      placeholder="A / B * 100"
                      onChange={(e) =>
                        update({
                          formula: { ...spec.formula!, expr: e.target.value },
                        })
                      }
                    />
                  </label>
                  <label>
                    Nome do resultado
                    <Input
                      value={spec.formula.label}
                      maxLength={80}
                      placeholder="Taxa de entrega"
                      onChange={(e) =>
                        update({
                          formula: { ...spec.formula!, label: e.target.value },
                        })
                      }
                    />
                  </label>
                </div>
                <small className={formulaError ? "form-error" : "muted"}>
                  {formulaError ||
                    "Use as letras das consultas (A a E), números, + − × ÷ e parênteses. Divisão por zero fica vazia."}
                </small>
              </>
            )}
          </fieldset>

          <div className="form-columns">
            <label>
              Agrupar por
              <Select
                value={spec.groupBy}
                onValueChange={(v) =>
                  update({ groupBy: v as PanelSpec["groupBy"] })
                }
                disabled={spec.viz === "stat"}
              >
                {groups.map((g) => (
                  <SelectOption key={g.key} value={g.key}>
                    {g.label}
                  </SelectOption>
                ))}
              </Select>
            </label>
            {spec.groupBy === "time" && (
              <label>
                Intervalo
                <Select
                  value={spec.interval ?? "auto"}
                  onValueChange={(v) =>
                    update({ interval: v as PanelSpec["interval"] })
                  }
                >
                  <SelectOption value="auto">Automático</SelectOption>
                  <SelectOption value="day">Dia</SelectOption>
                  <SelectOption value="week">Semana</SelectOption>
                  <SelectOption value="month">Mês</SelectOption>
                </Select>
              </label>
            )}
            {categorical && (
              <label>
                Mostrar os
                <Select
                  value={String(spec.limit ?? 10)}
                  onValueChange={(v) => update({ limit: Number(v) })}
                >
                  {[5, 10, 15, 20, 30, 50].map((n) => (
                    <SelectOption key={n} value={String(n)}>
                      {n} maiores
                    </SelectOption>
                  ))}
                </Select>
              </label>
            )}
          </div>
          <div className="form-columns">
            <label>
              Unidade
              <Select
                value={spec.unit ?? "auto"}
                onValueChange={(v) =>
                  update({
                    unit: v === "auto" ? undefined : (v as PanelSpec["unit"]),
                  })
                }
              >
                <SelectOption value="auto">Automática</SelectOption>
                <SelectOption value="number">Número</SelectOption>
                <SelectOption value="hours">Horas</SelectOption>
                <SelectOption value="days">Dias</SelectOption>
                <SelectOption value="percent">Porcentagem</SelectOption>
              </Select>
            </label>
            <label>
              Casas decimais
              <Select
                value={
                  spec.decimals === undefined ? "auto" : String(spec.decimals)
                }
                onValueChange={(v) =>
                  update({ decimals: v === "auto" ? undefined : Number(v) })
                }
              >
                <SelectOption value="auto">Automático</SelectOption>
                {[0, 1, 2].map((n) => (
                  <SelectOption key={n} value={String(n)}>
                    {n}
                  </SelectOption>
                ))}
              </Select>
            </label>
          </div>
          {spec.viz === "stat" && (
            <label className="checkbox-label">
              <Checkbox
                checked={!!spec.compare}
                onCheckedChange={(on) => update({ compare: on === true })}
              />
              Comparar com o período anterior
            </label>
          )}
        </div>

        <aside className="dash-editor-preview" aria-live="polite">
          <span className="dash-editor-preview-title">
            Prévia{" "}
            {loading && (
              <span className="dash-refreshing" aria-label="Calculando" />
            )}
          </span>
          <div
            className="dash-panel preview"
            style={{ ["--panel-rows" as string]: 5 }}
          >
            <header className="dash-panel-head">
              <h3>{title || "Sem título"}</h3>
            </header>
            <div className="dash-panel-body">
              {previewError ? (
                <p className="dash-error" role="alert">
                  {previewError}
                </p>
              ) : display ? (
                <PanelChart display={display} spec={spec} />
              ) : (
                <Loading compact />
              )}
            </div>
          </div>
          <small className="muted">
            Prévia com o período e os filtros atuais do dashboard.
          </small>
          <div className="dash-editor-actions">
            <Button className="btn secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button
              className="btn primary"
              disabled={!!formulaError || !title.trim()}
              onClick={() =>
                onSave({
                  id: panel?.id ?? newPanelId(),
                  title: title.trim(),
                  x: panel?.x ?? 0,
                  y: panel?.y ?? 0,
                  w: panel?.w ?? (spec.viz === "stat" ? 3 : 6),
                  h: panel?.h ?? (spec.viz === "stat" ? 3 : 5),
                  spec: {
                    ...spec,
                    queries: spec.queries.map((q) =>
                      spec.formula ? q : { ...q, hidden: undefined },
                    ),
                  },
                })
              }
            >
              <Save size={15} /> Aplicar
            </Button>
          </div>
        </aside>
      </div>
    </Modal>
  );
}

function QueryEditor({
  query,
  lookups,
  canHide,
  canRemove,
  onChange,
  onRemove,
}: {
  query: Query;
  lookups: ReturnType<typeof useLookups>;
  canHide: boolean;
  canRemove: boolean;
  onChange: (patch: Partial<Query>) => void;
  onRemove: () => void;
}) {
  const src = sources[query.source];
  const setFilter = (i: number, patch: Partial<QueryFilter>) =>
    onChange({
      filters: query.filters.map((f, j) => (j === i ? { ...f, ...patch } : f)),
    });
  const unused = src.filters.filter(
    (f) => !query.filters.some((x) => x.field === f),
  );
  return (
    <section className="dash-query" aria-label={`Consulta ${query.ref}`}>
      <header>
        <span className="dash-ref">{query.ref}</span>
        <Input
          aria-label={`Nome da consulta ${query.ref}`}
          placeholder="Nome (opcional)"
          value={query.label ?? ""}
          maxLength={60}
          onChange={(e) => onChange({ label: e.target.value })}
        />
        {canHide && (
          <label className="checkbox-label" title="Usada só na fórmula">
            <Checkbox
              checked={!!query.hidden}
              onCheckedChange={(on) => onChange({ hidden: on === true })}
            />
            Ocultar
          </label>
        )}
        {canRemove && (
          <Button
            className="icon-btn danger"
            aria-label={`Remover consulta ${query.ref}`}
            title="Remover consulta"
            onClick={onRemove}
          >
            <Trash2 size={14} />
          </Button>
        )}
      </header>
      <div className="dash-query-fields">
        <label>
          Dados
          <Select
            value={query.source}
            onValueChange={(v) => {
              const s = v as Source;
              onChange({
                source: s,
                metric: sources[s].metrics[0].key,
                dateField: sources[s].dateFields[0].key,
                filters: query.filters.filter((f) =>
                  sources[s].filters.includes(f.field),
                ),
              });
            }}
          >
            <SelectOption value="tasks">Tarefas</SelectOption>
            <SelectOption value="hours">Horas</SelectOption>
          </Select>
        </label>
        <label>
          Métrica
          <Select
            value={query.metric}
            onValueChange={(v) => onChange({ metric: v })}
          >
            {src.metrics.map((m) => (
              <SelectOption key={m.key} value={m.key}>
                {m.label}
              </SelectOption>
            ))}
          </Select>
        </label>
        <label>
          Período pela data de
          <Select
            value={query.dateField ?? src.dateFields[0].key}
            onValueChange={(v) => onChange({ dateField: v })}
            disabled={src.dateFields.length < 2}
          >
            {src.dateFields.map((d) => (
              <SelectOption key={d.key} value={d.key}>
                {d.label}
              </SelectOption>
            ))}
          </Select>
        </label>
      </div>
      {query.filters.map((f, i) => (
        <div key={f.field} className="dash-filter">
          <span className="dash-filter-field">{filterLabels[f.field]}</span>
          {f.field === "late" ? (
            <Select
              value={f.values[0] ?? "true"}
              onValueChange={(v) => setFilter(i, { values: [v], op: "in" })}
            >
              <SelectOption value="true">Somente atrasadas</SelectOption>
              <SelectOption value="false">Somente sem atraso</SelectOption>
            </Select>
          ) : (
            <>
              <Select
                value={f.op ?? "in"}
                onValueChange={(v) =>
                  setFilter(i, { op: v as QueryFilter["op"] })
                }
              >
                <SelectOption value="in">é</SelectOption>
                <SelectOption value="not_in">não é</SelectOption>
              </Select>
              <MultiPick
                label={filterLabels[f.field]}
                allLabel="Escolha"
                noun="itens"
                options={lookups[f.field]}
                value={f.values}
                onChange={(values) => setFilter(i, { values })}
              />
            </>
          )}
          <Button
            className="icon-btn"
            aria-label={`Remover filtro ${filterLabels[f.field]}`}
            onClick={() =>
              onChange({ filters: query.filters.filter((_, j) => j !== i) })
            }
          >
            <X size={14} />
          </Button>
        </div>
      ))}
      {unused.length > 0 && (
        <Select
          aria-label={`Adicionar filtro à consulta ${query.ref}`}
          value=""
          onValueChange={(v) =>
            v &&
            onChange({
              filters: [
                ...query.filters,
                {
                  field: v as FilterField,
                  op: "in",
                  values: v === "late" ? ["true"] : [],
                },
              ],
            })
          }
        >
          <SelectOption value="">+ Filtro</SelectOption>
          {unused.map((f) => (
            <SelectOption key={f} value={f}>
              {filterLabels[f]}
            </SelectOption>
          ))}
        </Select>
      )}
    </section>
  );
}

// ------------------------------------------------------------ sharing
function ShareDialog({
  dashboard,
  data,
  demo,
  notify,
  internalUrl,
  onClose,
  onSaved,
  onDeleted,
}: {
  dashboard: Dashboard;
  data: Snapshot;
  demo: boolean;
  notify: Notify;
  internalUrl: string;
  onClose: () => void;
  onSaved: (d: Dashboard) => void;
  onDeleted: () => void;
}) {
  const [access, setAccess] = useState<LinkAccess>(dashboard.link_access);
  const [password, setPassword] = useState("");
  const [users, setUsers] = useState<string[]>([]);
  const [teams, setTeams] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(demo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (demo) return;
    dashboardMembers(dashboard.id)
      .then((m) => {
        setUsers(m.users);
        setTeams(m.teams);
        setLoaded(true);
      })
      .catch((e) => setError((e as Error).message));
  }, [dashboard.id, demo]);
  const people = data.members
    .filter((m) => m.active && m.role === "member")
    .map((m) => ({ value: m.user_id, label: m.name }))
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  const teamOptions = data.teams.map((t) => ({ value: t.id, label: t.name }));
  const link = dashboardLinkUrl(dashboard.share_token);
  async function copy(text: string, message: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify(message);
    } catch {
      setError(`Copie: ${text}`);
    }
  }
  async function submit(newLink = false) {
    setBusy(true);
    setError("");
    try {
      const next = demo
        ? {
            ...dashboard,
            link_access: access,
            has_password: access === "password",
          }
        : await setDashboardSharing(dashboard.id, {
            link_access: access,
            password,
            users,
            teams,
            newLink,
          });
      onSaved(next);
      notify(
        newLink
          ? "Novo link gerado; o anterior deixou de funcionar."
          : "Compartilhamento salvo.",
      );
      if (!newLink) onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const needsPassword =
    access === "password" && !dashboard.has_password && !password;
  return (
    <Modal
      title="Compartilhar dashboard"
      onClose={() => !busy && onClose()}
      busy={busy}
    >
      <div className="entity-form dash-share">
        <fieldset>
          <legend>Na empresa</legend>
          <p className="muted">
            Administradores e gestores sempre veem. Escolha quem mais pode abrir
            este dashboard no app (só visualização).
          </p>
          <div className="form-columns">
            <label>
              Pessoas
              <MultiPick
                label="Pessoas"
                allLabel="Ninguém além dos gestores"
                noun="pessoas"
                options={people}
                value={users}
                onChange={setUsers}
                disabled={!loaded}
              />
            </label>
            <label>
              Equipes
              <MultiPick
                label="Equipes"
                allLabel="Nenhuma equipe"
                noun="equipes"
                options={teamOptions}
                value={teams}
                onChange={setTeams}
                disabled={!loaded}
              />
            </label>
          </div>
          <Button
            className="text-btn"
            onClick={() => void copy(internalUrl, "Link interno copiado.")}
          >
            <Link2 size={14} /> Copiar link interno
          </Button>
        </fieldset>
        <fieldset className="dash-link-access">
          <legend>Link de compartilhamento</legend>
          {(
            [
              [
                "none",
                "Desativado",
                "Só pessoas da empresa com acesso, pelo app.",
              ],
              [
                "password",
                "Com senha",
                "Quem tiver o link e a senha vê o dashboard, mesmo fora da empresa.",
              ],
              [
                "public",
                "Público",
                "Qualquer pessoa com o link vê o dashboard, sem login.",
              ],
            ] as const
          ).map(([key, label, hint]) => (
            <label key={key} className={access === key ? "selected" : ""}>
              <input
                type="radio"
                name="link-access"
                checked={access === key}
                onChange={() => setAccess(key)}
              />
              <strong>{label}</strong>
              <small>{hint}</small>
            </label>
          ))}
          {access === "password" && (
            <label>
              {dashboard.has_password
                ? "Nova senha (deixe em branco para manter)"
                : "Senha"}
              <Input
                type="password"
                autoComplete="new-password"
                value={password}
                minLength={6}
                maxLength={72}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          )}
          {access !== "none" && dashboard.link_access !== "none" && (
            <div className="dash-link-row">
              <Input
                readOnly
                value={link}
                aria-label="Link de compartilhamento"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                className="btn secondary"
                onClick={() => void copy(link, "Link copiado.")}
              >
                <Copy size={14} /> Copiar
              </Button>
            </div>
          )}
          {access !== "none" && dashboard.link_access === "none" && (
            <small className="muted">O link aparece depois de salvar.</small>
          )}
          {dashboard.link_access !== "none" && (
            <Button
              className="text-btn"
              onClick={() => void submit(true)}
              disabled={busy}
            >
              <RefreshCw size={14} /> Gerar novo link (o atual deixa de
              funcionar)
            </Button>
          )}
          <small className="muted">
            Quem abre pelo link vê os números do dashboard com os filtros salvos
            e pode mudar só o período.
          </small>
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dash-share-actions">
          <Button
            className="text-btn danger"
            onClick={async () => {
              if (!window.confirm(`Excluir o dashboard "${dashboard.name}"?`))
                return;
              try {
                if (demo)
                  demoDashboards = (demoDashboards ?? []).filter(
                    (x) => x.id !== dashboard.id,
                  );
                else await deleteDashboard(dashboard.id);
                notify("Dashboard excluído.");
                onDeleted();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <Trash2 size={14} /> Excluir dashboard
          </Button>
          <Button
            className="btn primary"
            onClick={() => void submit()}
            loading={busy}
            disabled={needsPassword || !loaded}
          >
            <Save size={15} /> Salvar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
