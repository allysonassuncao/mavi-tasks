import {
  usePage,
  useUrlState,
  useLocation,
  navigate,
  pageUrl,
  companySlug,
  safeReturnPath,
  loginDestination,
  resolvePage,
  type Page,
} from "./router";
import { Input, Select, SelectOption, Button } from "./ui";
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type FormEvent,
  type MouseEvent,
} from "react";
import type { Session } from "@supabase/supabase-js";
import {
  LayoutDashboard,
  CheckCheck,
  Users,
  FolderKanban,
  Clock3,
  ChartNoAxesCombined,
  Settings2,
  Search,
  Plus,
  ArrowUpRight,
  ChevronRight,
  ChevronLeft,
  ChevronsUpDown,
  Menu,
  LogOut,
  Check,
  ArrowRight,
  CalendarDays,
  List,
  Columns3,
  SlidersHorizontal,
  TriangleAlert,
  Timer,
  Play,
  Square,
  Paperclip,
  MessageSquare,
  Send,
  Download,
  RefreshCw,
  ExternalLink,
  Flag,
  X,
  ShieldCheck,
  Building2,
} from "lucide-react";
import { supabase } from "./supabase";
import * as api from "./api";
import { DemoStore } from "./demo-store";
import { demoUser } from "./demo";
import { Avatar, Badge, Modal, Empty, Loading } from "./components";
import {
  type Task,
  type Snapshot,
  type Comment,
  type Attachment,
  type TaskEvent,
  type Status,
  emptySnapshot,
  statuses,
  priorities,
} from "./types";
import {
  dateKey,
  dateLabel,
  duration,
  minutes,
  isLate,
  names,
  initials,
} from "./domain";
import { CreateForm, TaskDetail } from "./forms";

const navigation = [
  { id: "overview", label: "Visão geral", icon: LayoutDashboard },
  { id: "tasks", label: "Tarefas", icon: CheckCheck },
  { id: "clients", label: "Clientes", icon: Users },
  { id: "projects", label: "Projetos", icon: FolderKanban },
  { id: "hours", label: "Controle de horas", icon: Clock3 },
  { id: "reports", label: "Relatórios", icon: ChartNoAxesCombined },
] as const;
export default function App() {
  const demoStore = useRef(new DemoStore());
  const [needsPassword, setNeedsPassword] = useState(
    new URLSearchParams(window.location.search).get("setup") === "1" ||
      new URLSearchParams(window.location.hash.slice(1)).get("type") ===
        "recovery",
  );
  const [demo, setDemo] = useState(false),
    [session, setSession] = useState<Session | null>(null),
    [authReady, setAuthReady] = useState(!supabase);
  const [data, setData] = useState<Snapshot>(
      demo ? demoStore.current.data : emptySnapshot,
    ),
    [companyRef, setCompanyRef] = useUrlState<string>("empresa", "");
  const location = useLocation();
  const isLogin = location.split("?")[0].replace(/\/+$/, "") === "/login";
  const requestedCompany = data.companies.find(
    (c) => c.id === companyRef || companySlug(c, data.companies) === companyRef,
  );
  const activeCompany = companyRef ? requestedCompany : data.companies[0];
  const company = activeCompany?.id ?? "";
  const companyPath = activeCompany
    ? companySlug(activeCompany, data.companies)
    : companyRef;
  function setCompany(id: string) {
    const next = data.companies.find((c) => c.id === id);
    setCompanyRef(next ? companySlug(next, data.companies) : "");
  }
  const page = usePage();
  const [sidebar, setSidebar] = useState(false),
    [viewValue, setView] = useUrlState<string>("visualizacao", "list");
  const view = ["list", "board", "calendar"].includes(viewValue)
    ? viewValue
    : "list";
  const [search, setSearch] = useUrlState<string>("busca", ""),
    [query, setQuery] = useState(search),
    [status, setStatus] = useUrlState<string>("status", ""),
    [product, setProduct] = useUrlState<string>("produto", ""),
    [mine, setMine] = useUrlState<boolean>("minhas", false),
    [late, setLate] = useUrlState<boolean>("atrasadas", false),
    [clientFilter, setClientFilter] = useUrlState<string>("cliente", ""),
    [projectFilter, setProjectFilter] = useUrlState<string>("projeto", ""),
    [offset, setOffset] = useUrlState<number>("pagina", 0),
    [count, setCount] = useState(0);
  const [selected, setSelected] = useState<string | null>(null),
    [form, setForm] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [companiesReady, setCompaniesReady] = useState(!supabase),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [summary, setSummary] = useState<api.Summary | null>(null),
    [tick, setTick] = useState(Date.now());
  const request = useRef(0),
    user = demo ? demoUser : (session?.user.id ?? "");
  const currentCompany = data.companies.find((c) => c.id === company),
    member = data.members.find((m) => m.user_id === user),
    isAdmin = member?.role === "admin";
  const today = dateKey(new Date(), currentCompany?.timezone),
    activeTimer = data.hours.find((h) => h.user_id === user && !h.ended_at);
  const [periodValue, setPeriod] = useUrlState<string>("periodo", "");
  const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(periodValue)
    ? periodValue
    : dateKey().slice(0, 7);
  useEffect(() => {
    if (!authReady || (session && needsPassword)) return;
    if (!demo && !session && !isLogin) {
      navigate(loginDestination(location), true);
    } else if ((demo || session) && isLogin) {
      navigate(
        safeReturnPath(
          new URLSearchParams(window.location.search).get("retorno"),
        ),
        true,
      );
    }
  }, [authReady, demo, session, isLogin, location, needsPassword]);
  useEffect(() => {
    if (
      !authReady ||
      (!demo && !session) ||
      !page ||
      !activeCompany ||
      needsPassword
    )
      return;
    if (
      companyRef !== companyPath ||
      new URLSearchParams(window.location.search).has("empresa")
    )
      setCompanyRef(companyPath);
  }, [
    authReady,
    demo,
    session,
    page,
    companyRef,
    companyPath,
    activeCompany,
    needsPassword,
    setCompanyRef,
  ]);
  useEffect(() => {
    const id = setTimeout(() => {
      setQuery(search);
    }, 250);
    return () => clearTimeout(id);
  }, [search]);
  useEffect(() => {
    setSelected(null);
    setForm(null);
    setSidebar(false);
  }, [page]);
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data, error }) => {
      if (error) setError(error.message);
      setSession(data.session);
      setAuthReady(true);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY") setNeedsPassword(true);
      setSession(s);
      setAuthReady(true);
      if (!s) {
        setData(emptySnapshot);
        setSelected(null);
      }
    });
    return () => subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (demo || !session) return;
    let alive = true;
    setCompaniesReady(false);
    api
      .companies()
      .then((list) => {
        if (alive) {
          setData((d) => ({ ...d, companies: list }));
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setCompaniesReady(true);
      });
    return () => {
      alive = false;
    };
  }, [demo, session]);
  useEffect(() => {
    if (demo) {
      setData({ ...demoStore.current.data });
      setLoading(false);
      return;
    }
    if (!company || !session) return;
    const id = ++request.current;
    setLoading(true);
    setError("");
    api
      .snapshot(company, {
        search: page === "tasks" ? query : "",
        status: page === "tasks" ? status : "",
        product: page === "tasks" ? product : "",
        mine: page === "tasks" ? mine : false,
        user,
        page: page === "tasks" ? offset : 0,
        late: page === "tasks" ? late : false,
        client: page === "tasks" ? clientFilter : "",
        project: page === "tasks" ? projectFilter : "",
      })
      .then((r) => {
        if (id === request.current) {
          setData(r.data);
          setCount(r.count);
        }
      })
      .catch((e) => {
        if (id === request.current) {
          // A shared link may reference a page removed by later data changes.
          if (e.code === "PGRST103" && offset > 0) setOffset(0);
          else setError(e.message);
        }
      })
      .finally(() => {
        if (id === request.current) setLoading(false);
      });
    return () => {
      request.current++;
    };
  }, [
    demo,
    company,
    session,
    query,
    status,
    product,
    mine,
    user,
    offset,
    late,
    clientFilter,
    projectFilter,
    refresh,
    page,
  ]);
  useEffect(() => {
    if (demo || !company || !session) return;
    let alive = true;
    setSummary(null);
    api
      .rpc("report_summary", {
        p_company: company,
        p_start: new Date(period + "-01T00:00:00").toISOString(),
        p_end: new Date(
          Number(period.slice(0, 4)),
          Number(period.slice(5, 7)),
          1,
        ).toISOString(),
      })
      .then((s) => {
        if (alive) setSummary(s);
      })
      .catch((e) => setError(e.message));
    return () => {
      alive = false;
    };
  }, [demo, company, session, period, refresh]);
  const notify = useCallback((message: string) => setToast(message), []);
  async function mutate(name: string, args: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const result = demo
        ? demoStore.current.mutate(name, args)
        : await api.rpc(name, args);
      if (demo) setData({ ...demoStore.current.data });
      setRefresh((v) => v + 1);
      notify(demo ? "Alteração feita na demonstração." : "Alteração salva.");
      return result;
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message
          : ((e as { message?: string }).message ?? "Não foi possível salvar.");
      setError(message);
      throw Error(message);
    } finally {
      setBusy(false);
    }
  }
  function go(next: Page) {
    navigate(pageUrl(next, companyPath));
    setSidebar(false);
    setSelected(null);
    setForm(null);
    setQuery("");
  }
  function followLink(event: MouseEvent<HTMLAnchorElement>, next: Page) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    go(next);
  }
  async function logout() {
    if (demo) {
      setDemo(false);
      setData(emptySnapshot);
      navigate("/login", true);
      return;
    }
    await supabase?.auth.signOut();
    navigate("/login", true);
  }
  const selectedTask = data.tasks.find((t) => t.id === selected);
  const filtered = data.tasks.filter(
    (t) =>
      (!clientFilter ||
        data.contracts.find((c) => c.id === t.contract_id)?.client_id ===
          clientFilter) &&
      (!projectFilter || t.project_id === projectFilter) &&
      (!query || t.title.toLowerCase().includes(query.toLowerCase())) &&
      (!status || t.status === status) &&
      (!mine || t.assignee_id === user) &&
      (!late || isLate(t, today)) &&
      (!product ||
        data.contracts.find((c) => c.id === t.contract_id)?.product_id ===
          product),
  );
  const periodHours = data.hours.filter(
    (h) => h.started_at.slice(0, 7) === period,
  );
  const stats = demo
    ? {
        total: data.tasks.length,
        late: data.tasks.filter((t) => isLate(t, today)).length,
        review: data.tasks.filter((t) => t.status === "review").length,
        done: data.tasks.filter((t) => t.delivered_at?.slice(0, 7) === period)
          .length,
        minutes: periodHours.reduce((sum, h) => sum + minutes(h, tick), 0),
      }
    : summary;
  const focus = data.tasks
    .filter((t) => t.status !== "done")
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
    .slice(0, 6);
  const byClient = demo
    ? data.clients.map((c) => ({
        id: c.id,
        name: c.name,
        minutes: periodHours
          .filter(
            (h) =>
              names(
                data,
                data.tasks.find((t) => t.id === h.task_id)!,
              ).client?.id === c.id,
          )
          .reduce((s, h) => s + minutes(h, tick), 0),
      }))
    : (summary?.by_client ?? []);
  const byPerson = demo
    ? data.members.map((m) => ({
        id: m.user_id,
        name: m.name,
        tasks: data.tasks.filter(
          (t) => t.assignee_id === m.user_id && t.status !== "done",
        ).length,
        estimated: data.tasks
          .filter((t) => t.assignee_id === m.user_id && t.status !== "done")
          .reduce((s, t) => s + t.estimated_minutes, 0),
      }))
    : (summary?.by_person ?? []);
  if (!authReady) return <Loading />;
  if (!demo && session && needsPassword)
    return (
      <SetPassword
        onDone={() => {
          setNeedsPassword(false);
          const url = new URL(window.location.href);
          url.searchParams.delete("setup");
          navigate(url.pathname + url.search, true);
        }}
      />
    );
  if (!demo && !session && !isLogin) return <Loading />;
  if (!demo && !session && isLogin)
    return (
      <Login
        onDemo={() => {
          setDemo(true);
          setData(demoStore.current.data);
          const target = safeReturnPath(
            new URLSearchParams(window.location.search).get("retorno"),
          );
          const demoCompany = demoStore.current.data.companies[0];
          navigate(
            pageUrl(
              resolvePage(target.split("?")[0]) ?? "overview",
              companySlug(demoCompany, demoStore.current.data.companies),
            ),
            true,
          );
        }}
        notify={notify}
      />
    );
  if (isLogin) return <Loading />;
  if (!page)
    return (
      <Empty
        title="Página não encontrada"
        body="Confira o endereço ou volte para a visão geral."
        action={
          <a className="btn primary" href={pageUrl("overview", companyPath)}>
            Ir para visão geral
          </a>
        }
      />
    );
  if (
    !demo &&
    companyRef &&
    companiesReady &&
    data.companies.length &&
    !currentCompany
  )
    return (
      <Empty
        title="Empresa indisponível"
        body="Este link pertence a uma empresa à qual sua conta não tem acesso."
        action={
          <Button
            className="btn primary"
            onClick={() => setCompany(data.companies[0].id)}
          >
            Abrir minha empresa
          </Button>
        }
      />
    );
  return (
    <div className="app-shell">
      {sidebar && (
        <Button
          className="sidebar-backdrop"
          aria-label="Fechar menu"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className={`sidebar ${sidebar ? "visible" : ""}`}>
        <a
          href="#"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            go("overview");
          }}
        >
          <span className="brand-mark">M</span>
          <span>
            mavi<span className="brand-period">.</span>
          </span>
          <span className="brand-label">WORKSPACE</span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">
            <Building2 size={19} />
          </span>
          <div>
            <small>Seu espaço de trabalho</small>
            <Select
              aria-label="Empresa ativa"
              value={company}
              onValueChange={(value) => {
                setData({ ...emptySnapshot, companies: data.companies });
                setSelected(null);
                setCompany(value);
                setOffset(0);
              }}
            >
              {data.companies.map((c) => (
                <SelectOption key={c.id} value={c.id}>
                  {c.name}
                </SelectOption>
              ))}
            </Select>
          </div>
          <ChevronsUpDown size={14} />
        </div>
        <span className="nav-label">PRINCIPAL</span>
        <nav aria-label="Navegação principal">
          {navigation.map((item) => (
            <a
              key={item.id}
              href={pageUrl(item.id, companyPath)}
              aria-current={page === item.id ? "page" : undefined}
              className={page === item.id ? "active" : ""}
              onClick={(event) => followLink(event, item.id)}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
              {item.id === "tasks" && !!stats?.total && (
                <span className="nav-count">{stats.total}</span>
              )}
            </a>
          ))}
        </nav>
        <div className="sidebar-products">
          <span className="nav-label">PRODUTOS</span>
          {data.products.map((p) => (
            <Button
              key={p.id}
              onClick={() => {
                go("tasks");
                setProduct(p.id);
              }}
            >
              <span className="product-dot" style={{ background: p.color }} />
              {p.name}
              <ChevronRight size={13} />
            </Button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <a
            className={
              page === "settings" ? "settings-link active" : "settings-link"
            }
            href={pageUrl("settings", companyPath)}
            aria-current={page === "settings" ? "page" : undefined}
            onClick={(event) => followLink(event, "settings")}
          >
            <Settings2 size={18} /> Equipe e configurações
          </a>
          <div className="profile">
            <Avatar name={member?.name ?? "Usuário"} />
            <div>
              <strong>{member?.name ?? session?.user.email}</strong>
              <small>
                {member?.role === "admin"
                  ? "Administrador"
                  : member?.role === "manager"
                    ? "Gestor"
                    : "Colaborador"}
              </small>
            </div>
            {supabase && (
              <Button
                className="icon-btn"
                aria-label="Sair"
                onClick={() => void logout()}
              >
                <LogOut size={17} />
              </Button>
            )}
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <Button
              className="icon-btn menu-toggle"
              aria-label="Abrir menu"
              onClick={() => setSidebar(true)}
            >
              <Menu size={21} />
            </Button>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>
              {navigation.find((n) => n.id === page)?.label ?? "Configurações"}
            </strong>
          </div>
          <div className="topbar-right">
            {activeTimer && (
              <Button
                className="timer-live"
                onClick={() => {
                  go("hours");
                }}
              >
                <span className="pulse" />
                {duration(minutes(activeTimer, tick))}
              </Button>
            )}
            <span className="online-label">
              <span /> {demo ? "Demonstração" : "Conectado"}
            </span>
            <Avatar name={member?.name ?? "Usuário"} size="small" />
          </div>
        </header>
        {demo && (
          <div className="demo-banner">
            <span>
              <span className="demo-tag">DEMO</span> Dados ilustrativos. As
              alterações desta sessão não são salvas.
            </span>
            {supabase ? (
              <Button onClick={() => void logout()}>
                Entrar na minha conta <ArrowRight size={14} />
              </Button>
            ) : (
              <span className="demo-detail">Conexão com Supabase pendente</span>
            )}
          </div>
        )}
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {new Date().toLocaleDateString("pt-BR", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })}
              </div>
              <h1>
                {page === "overview"
                  ? "Visão geral"
                  : (navigation.find((n) => n.id === page)?.label ??
                    "Equipe e configurações")}
              </h1>
              <p>
                {
                  {
                    overview:
                      "Uma visão clara do trabalho. Mais espaço para criar.",
                    tasks: "Organize prioridades e acompanhe cada entrega.",
                    clients:
                      "Relacionamentos, produtos e trabalho em um só lugar.",
                    projects: "Do primeiro briefing à última entrega.",
                    hours: "Seu tempo, registrado com clareza.",
                    reports: "Entenda o ritmo e os resultados da operação.",
                    settings: "Pessoas e produtos do seu espaço de trabalho.",
                  }[page]
                }
              </p>
            </div>
            <Button
              className="btn primary"
              onClick={() =>
                setForm(
                  page === "clients"
                    ? "client"
                    : page === "projects"
                      ? "project"
                      : page === "hours"
                        ? "time"
                        : page === "settings"
                          ? "team"
                          : "task",
                )
              }
            >
              <Plus size={18} />
              {page === "clients"
                ? "Novo cliente"
                : page === "projects"
                  ? "Novo projeto"
                  : page === "hours"
                    ? "Registrar horas"
                    : page === "settings"
                      ? "Nova equipe"
                      : "Nova tarefa"}
            </Button>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <TriangleAlert size={18} />
              <span>{error}</span>
              <Button
                className="icon-btn"
                aria-label="Fechar erro"
                onClick={() => setError("")}
              >
                <X size={16} />
              </Button>
            </div>
          )}
          {!company && !loading && (demo || companiesReady) ? (
            <Empty
              title="Seu acesso está quase pronto"
              body="Peça ao administrador para vincular sua conta a uma empresa."
            />
          ) : loading || (!demo && !companiesReady) ? (
            <Loading />
          ) : (
            <>
              {(page === "overview" || page === "reports") && (
                <>
                  <div className="section-top">
                    <span className="section-caption">
                      {page === "overview"
                        ? "O PULSO DA SUA OPERAÇÃO"
                        : "INDICADORES DO PERÍODO"}
                    </span>
                    <label className="period">
                      <CalendarDays size={16} />
                      <Input
                        aria-label="Período dos relatórios"
                        type="month"
                        value={period}
                        onChange={(e) => setPeriod(e.target.value)}
                      />
                    </label>
                  </div>
                  <div className="stats-grid">
                    <Stat
                      label="Tarefas em atraso"
                      value={stats?.late}
                      icon={TriangleAlert}
                      tone="orange"
                      caption="Precisam de atenção"
                      onClick={() => {
                        go("tasks");
                        setLate(true);
                      }}
                    />
                    <Stat
                      label="Aguardando validação"
                      value={stats?.review}
                      icon={CheckCheck}
                      tone="purple"
                      caption="O próximo passo é aprovar"
                      onClick={() => {
                        go("tasks");
                        setStatus("review");
                      }}
                    />
                    <Stat
                      label="Entregas no período"
                      value={stats?.done}
                      icon={Check}
                      tone="green"
                      caption="Trabalho que chegou ao destino"
                      onClick={() => {
                        go("tasks");
                        setStatus("done");
                      }}
                    />
                    <Stat
                      label="Horas registradas"
                      value={stats ? duration(stats.minutes) : undefined}
                      icon={Clock3}
                      tone="blue"
                      caption="Tempo dedicado à operação"
                      onClick={() => go("hours")}
                    />
                  </div>
                </>
              )}
              {page === "overview" && (
                <div className="dashboard-grid">
                  <section className="panel focus-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>
                          Entregas em foco{" "}
                          <span className="small-counter">{focus.length}</span>
                        </h2>
                        <p>Os próximos passos da sua equipe</p>
                      </div>
                      <Button className="text-btn" onClick={() => go("tasks")}>
                        Ver tarefas <ArrowUpRight size={16} />
                      </Button>
                    </div>
                    <TaskTable
                      tasks={focus}
                      data={data}
                      today={today}
                      onSelect={setSelected}
                    />
                    <div className="panel-footer">
                      <span>
                        <span className="legend-dot" /> Prazos ordenados por
                        prioridade de data
                      </span>
                      <Button
                        className="text-btn"
                        onClick={() => setForm("task")}
                      >
                        <Plus size={15} /> Adicionar tarefa
                      </Button>
                    </div>
                  </section>
                  <aside className="dashboard-aside">
                    <section className="spotlight">
                      <span className="section-caption">SEU DIA, EM ORDEM</span>
                      <h2>
                        O que vem
                        <br />
                        primeiro?
                      </h2>
                      <p>
                        {
                          data.tasks.filter(
                            (t) =>
                              t.assignee_id === user && t.status !== "done",
                          ).length
                        }{" "}
                        tarefas suas nesta seleção.
                      </p>
                      <Button
                        onClick={() => {
                          go("tasks");
                          setMine(true);
                        }}
                      >
                        Abrir minhas tarefas <ArrowUpRight size={18} />
                      </Button>
                      <div className="spotlight-lines" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </div>
                    </section>
                    <section className="panel team-panel">
                      <div className="panel-heading">
                        <h2>Sua equipe</h2>
                        <span className="small-counter">
                          {data.members.filter((m) => m.active).length}
                        </span>
                      </div>
                      {data.members
                        .filter((m) => m.active)
                        .slice(0, 4)
                        .map((m) => (
                          <div className="team-person" key={m.user_id}>
                            <Avatar name={m.name} />
                            <div>
                              <strong>{m.name}</strong>
                              <small>
                                {m.role === "manager"
                                  ? "Gestão"
                                  : m.role === "admin"
                                    ? "Administração"
                                    : "Colaboração"}
                              </small>
                            </div>
                            <Button
                              className="icon-btn"
                              title={`Ver equipe de ${m.name}`}
                              onClick={() => go("settings")}
                            >
                              <ArrowUpRight size={16} />
                            </Button>
                          </div>
                        ))}
                    </section>
                  </aside>
                  <section className="panel projects-overview">
                    <div className="panel-heading">
                      <div>
                        <h2>Projetos em movimento</h2>
                        <p>Um olhar sobre as próximas entregas</p>
                      </div>
                      <Button
                        className="text-btn"
                        onClick={() => go("projects")}
                      >
                        Ver projetos <ArrowUpRight size={16} />
                      </Button>
                    </div>
                    <div className="mini-projects">
                      {data.projects.slice(0, 3).map((p, i) => {
                        const contract = data.contracts.find(
                            (c) => c.id === p.contract_id,
                          ),
                          client = data.clients.find(
                            (c) => c.id === contract?.client_id,
                          );
                        return (
                          <Button
                            key={p.id}
                            className="mini-project"
                            onClick={() => go("projects")}
                          >
                            <div>
                              <span className={`project-icon color-${i}`}>
                                <FolderKanban size={21} />
                              </span>
                              <ArrowUpRight size={17} />
                            </div>
                            <h3>{p.name}</h3>
                            <p>{client?.name}</p>
                            <footer>
                              <span>{dateLabel(p.due_date)}</span>
                              <span>
                                Ver projeto <ChevronRight size={14} />
                              </span>
                            </footer>
                          </Button>
                        );
                      })}
                    </div>
                  </section>
                </div>
              )}
              {page === "tasks" && (
                <section className="panel work-panel">
                  <div className="work-toolbar">
                    <div
                      className="view-switch"
                      role="group"
                      aria-label="Visualização"
                    >
                      {[
                        { id: "list", label: "Lista", icon: List },
                        { id: "board", label: "Quadro", icon: Columns3 },
                        { id: "calendar", label: "Agenda", icon: CalendarDays },
                      ].map((v) => (
                        <Button
                          key={v.id}
                          className={view === v.id ? "selected" : ""}
                          onClick={() => setView(v.id)}
                        >
                          <v.icon size={16} />
                          {v.label}
                        </Button>
                      ))}
                    </div>
                    <Button
                      className={`filter-chip ${mine ? "selected" : ""}`}
                      onClick={() => {
                        setMine(!mine);
                        setOffset(0);
                      }}
                    >
                      <Users size={15} /> Minhas tarefas
                    </Button>
                  </div>
                  {(clientFilter || projectFilter) && (
                    <div className="active-context">
                      <span>
                        {clientFilter
                          ? data.clients.find((c) => c.id === clientFilter)
                              ?.name
                          : data.projects.find((p) => p.id === projectFilter)
                              ?.name}
                      </span>
                      <Button
                        className="text-btn"
                        onClick={() => {
                          setClientFilter("");
                          setProjectFilter("");
                          setOffset(0);
                        }}
                      >
                        Limpar seleção <X size={14} />
                      </Button>
                    </div>
                  )}
                  <div className="filterbar">
                    <label className="searchbox">
                      <Search size={17} />
                      <Input
                        placeholder="Buscar tarefa…"
                        value={search}
                        onChange={(e) => {
                          setSearch(e.target.value);
                          setOffset(0);
                        }}
                      />
                    </label>
                    <Select
                      aria-label="Filtrar status"
                      value={status}
                      onValueChange={(value) => {
                        setStatus(value);
                        setOffset(0);
                      }}
                    >
                      <SelectOption value="">Todos os status</SelectOption>
                      {Object.entries(statuses).map(([k, v]) => (
                        <SelectOption key={k} value={k}>
                          {v.label}
                        </SelectOption>
                      ))}
                    </Select>
                    <Select
                      aria-label="Filtrar produto"
                      value={product}
                      onValueChange={(value) => {
                        setProduct(value);
                        setOffset(0);
                      }}
                    >
                      <SelectOption value="">Todos os produtos</SelectOption>
                      {data.products.map((p) => (
                        <SelectOption key={p.id} value={p.id}>
                          {p.name}
                        </SelectOption>
                      ))}
                    </Select>
                    <Button
                      className={`filter-chip ${late ? "selected" : ""}`}
                      onClick={() => {
                        setLate(!late);
                        setOffset(0);
                      }}
                    >
                      <SlidersHorizontal size={15} /> Atrasadas
                    </Button>
                  </div>
                  {view === "list" ? (
                    <TaskTable
                      tasks={filtered}
                      data={data}
                      today={today}
                      onSelect={setSelected}
                    />
                  ) : view === "board" ? (
                    <div className="board">
                      {Object.entries(statuses).map(([key, value]) => (
                        <section className="board-column" key={key}>
                          <h3>
                            <i style={{ background: value.color }} />
                            {value.label}
                            <span>
                              {filtered.filter((t) => t.status === key).length}
                            </span>
                          </h3>
                          {filtered
                            .filter((t) => t.status === key)
                            .map((t) => {
                              const n = names(data, t);
                              return (
                                <Button
                                  className="task-card"
                                  key={t.id}
                                  onClick={() => setSelected(t.id)}
                                >
                                  <small>
                                    {n.client?.name} · {n.product?.name}
                                  </small>
                                  <h4>{t.title}</h4>
                                  <footer>
                                    <span
                                      className={isLate(t, today) ? "late" : ""}
                                    >
                                      <CalendarDays size={14} />
                                      {dateLabel(t.due_date)}
                                    </span>
                                    <Avatar
                                      name={n.member?.name ?? "?"}
                                      size="small"
                                    />
                                  </footer>
                                </Button>
                              );
                            })}
                        </section>
                      ))}
                    </div>
                  ) : (
                    <div className="agenda">
                      {[...new Set(filtered.map((t) => t.due_date))]
                        .sort()
                        .map((d) => (
                          <section key={d}>
                            <h3>
                              {dateLabel(d)}{" "}
                              <span>{d === today ? "Hoje" : ""}</span>
                            </h3>
                            {filtered
                              .filter((t) => t.due_date === d)
                              .map((t) => (
                                <Button
                                  onClick={() => setSelected(t.id)}
                                  key={t.id}
                                >
                                  <span>{t.title}</span>
                                  <Badge status={t.status} />
                                  <Avatar
                                    name={names(data, t).member?.name ?? "?"}
                                    size="small"
                                  />
                                </Button>
                              ))}
                          </section>
                        ))}
                    </div>
                  )}
                  {!filtered.length && view !== "list" && (
                    <Empty
                      title="Nenhuma tarefa encontrada"
                      body="Altere os filtros ou crie uma tarefa."
                    />
                  )}
                  <div className="pagination">
                    <span>
                      {demo ? filtered.length : count} tarefas ·{" "}
                      {demo ? "demonstração" : `página ${offset + 1}`}
                    </span>
                    <div>
                      <Button
                        className="icon-btn"
                        disabled={offset === 0 || demo}
                        aria-label="Página anterior"
                        onClick={() => setOffset((v) => v - 1)}
                      >
                        <ChevronLeft size={18} />
                      </Button>
                      <Button
                        className="icon-btn"
                        disabled={demo || (offset + 1) * 50 >= count}
                        aria-label="Próxima página"
                        onClick={() => setOffset((v) => v + 1)}
                      >
                        <ChevronRight size={18} />
                      </Button>
                    </div>
                  </div>
                </section>
              )}
              {page === "clients" && (
                <>
                  <div className="section-top">
                    <span>{data.clients.length} clientes no espaço</span>
                    <Button
                      className="btn secondary"
                      disabled={!isAdmin}
                      onClick={() => setForm("contract")}
                    >
                      <Plus size={16} /> Vincular produto
                    </Button>
                  </div>
                  <div className="client-grid">
                    {data.clients.map((c) => {
                      const contracts = data.contracts.filter(
                        (k) => k.client_id === c.id,
                      );
                      return (
                        <article className="panel client-card" key={c.id}>
                          <div className="client-card-top">
                            <span
                              className="client-logo"
                              style={{
                                background: c.color + "20",
                                color: c.color,
                              }}
                            >
                              {initials(c.name)}
                            </span>
                            <span className="subtle-label">CLIENTE</span>
                          </div>
                          <h2>{c.name}</h2>
                          <p>{c.email || "E-mail não informado"}</p>
                          <div className="client-products">
                            {contracts.map((k) => (
                              <span key={k.id}>
                                {
                                  data.products.find(
                                    (p) => p.id === k.product_id,
                                  )?.name
                                }
                              </span>
                            ))}
                            {!contracts.length && (
                              <small>Nenhum produto vinculado</small>
                            )}
                          </div>
                          <footer>
                            <span>{contracts.length} produtos contratados</span>
                            <Button
                              className="text-btn"
                              onClick={() => {
                                go("tasks");
                                setClientFilter(c.id);
                              }}
                            >
                              Ver trabalho <ArrowUpRight size={17} />
                            </Button>
                          </footer>
                        </article>
                      );
                    })}
                  </div>
                  {!data.clients.length && (
                    <Empty
                      title="Seu primeiro cliente começa aqui"
                      body="Cadastre um cliente e vincule os produtos contratados."
                    />
                  )}
                </>
              )}
              {page === "projects" && (
                <div className="client-grid">
                  {data.projects.map((p) => {
                    const k = data.contracts.find(
                        (c) => c.id === p.contract_id,
                      ),
                      client = data.clients.find((c) => c.id === k?.client_id),
                      tasks = data.tasks.filter((t) => t.project_id === p.id),
                      projectStats = summary?.by_project?.find(
                        (s) => s.id === p.id,
                      ),
                      total = demo ? tasks.length : (projectStats?.total ?? 0),
                      done = demo
                        ? tasks.filter((t) => t.status === "done").length
                        : (projectStats?.done ?? 0);
                    return (
                      <article className="panel project-card" key={p.id}>
                        <div className="client-card-top">
                          <span className="project-icon">
                            <FolderKanban size={23} />
                          </span>
                          <span className="subtle-label">
                            {
                              data.products.find((d) => d.id === k?.product_id)
                                ?.name
                            }
                          </span>
                        </div>
                        <h2>{p.name}</h2>
                        <p>{client?.name}</p>
                        <div className="project-progress">
                          <span>
                            {done} de {total} tarefas entregues
                          </span>
                          <progress value={done} max={total || 1} />
                        </div>
                        <footer>
                          <span>
                            <CalendarDays size={15} /> {dateLabel(p.due_date)}
                          </span>
                          <Button
                            className="text-btn"
                            onClick={() => {
                              go("tasks");
                              setProjectFilter(p.id);
                            }}
                          >
                            Ver tarefas <ArrowUpRight size={16} />
                          </Button>
                        </footer>
                      </article>
                    );
                  })}
                  {!data.projects.length && (
                    <Empty
                      title="Nenhum projeto ainda"
                      body="Crie um projeto dentro de um produto contratado."
                    />
                  )}
                </div>
              )}
              {page === "hours" && (
                <>
                  <section className="timer-panel">
                    <div className="timer-icon">
                      <Timer size={30} />
                    </div>
                    <div>
                      <small>
                        {activeTimer
                          ? "CRONÔMETRO EM ANDAMENTO"
                          : "TEMPO DE CONCENTRAÇÃO"}
                      </small>
                      <h2>
                        {activeTimer
                          ? duration(minutes(activeTimer, tick))
                          : "Pronto para começar?"}
                      </h2>
                      <p>
                        {activeTimer
                          ? (data.tasks.find(
                              (t) => t.id === activeTimer.task_id,
                            )?.title ?? "Tarefa em andamento")
                          : "Abra uma tarefa para iniciar o cronômetro ou registre suas horas manualmente."}
                      </p>
                    </div>
                    {activeTimer ? (
                      <Button
                        className="btn primary"
                        disabled={busy}
                        loading={busy}
                        onClick={() =>
                          void mutate("stop_timer", {
                            p_entry: activeTimer.id,
                          }).catch(() => {})
                        }
                      >
                        <Square size={15} /> Encerrar
                      </Button>
                    ) : (
                      <Button
                        className="btn primary"
                        onClick={() => go("tasks")}
                      >
                        <Play size={16} /> Escolher tarefa
                      </Button>
                    )}
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Apontamentos recentes</h2>
                        <p>
                          Até 100 registros mais recentes autorizados para você
                        </p>
                      </div>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Tarefa</th>
                            <th>Pessoa</th>
                            <th>Data</th>
                            <th>Origem</th>
                            <th>Tempo</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.hours.map((h) => (
                            <tr key={h.id}>
                              <td>
                                {data.tasks.find((t) => t.id === h.task_id)
                                  ?.title ?? "Tarefa fora da seleção atual"}
                                <small className="cell-note">{h.note}</small>
                              </td>
                              <td>
                                {
                                  data.members.find(
                                    (m) => m.user_id === h.user_id,
                                  )?.name
                                }
                              </td>
                              <td>
                                {new Date(h.started_at).toLocaleDateString(
                                  "pt-BR",
                                )}
                              </td>
                              <td>
                                {h.source === "timer" ? "Cronômetro" : "Manual"}
                              </td>
                              <td>
                                <strong>{duration(minutes(h, tick))}</strong>
                                {!h.ended_at && (
                                  <span className="running-label">
                                    {" "}
                                    em andamento
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!data.hours.length && (
                      <Empty
                        title="Nenhum apontamento"
                        body="Registre o tempo dedicado às suas tarefas."
                      />
                    )}
                  </section>
                </>
              )}
              {page === "reports" && (
                <div className="report-grid">
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Horas por cliente</h2>
                        <p>Tempo registrado no período selecionado</p>
                      </div>
                      <Clock3 size={20} />
                    </div>
                    <div className="bar-list">
                      {byClient.map((c) => (
                        <div className="bar-row" key={c.id}>
                          <div>
                            <span>{c.name}</span>
                            <strong>{duration(c.minutes)}</strong>
                          </div>
                          <div className="bar-track">
                            <span
                              style={{
                                width: `${(c.minutes / Math.max(...byClient.map((x) => x.minutes), 1)) * 100}%`,
                              }}
                            />
                          </div>
                        </div>
                      ))}
                      {!byClient.length && (
                        <Empty
                          title="Sem horas no período"
                          body="Selecione outro mês ou registre um apontamento."
                        />
                      )}
                    </div>
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Carga de trabalho</h2>
                        <p>Tarefas abertas e horas estimadas totais</p>
                      </div>
                      <Users size={20} />
                    </div>
                    <div className="workload">
                      {byPerson.map((p) => (
                        <div key={p.id}>
                          <Avatar name={p.name} />
                          <span>
                            <strong>{p.name}</strong>
                            <small>{p.tasks} tarefas abertas</small>
                          </span>
                          <b>{duration(p.estimated)}</b>
                        </div>
                      ))}
                    </div>
                  </section>
                  <div className="report-note">
                    <ShieldCheck size={18} /> Os relatórios respeitam suas
                    permissões. Estimativas não representam capacidade
                    disponível.
                  </div>
                </div>
              )}
              {page === "settings" && (
                <>
                  <div className="settings-grid">
                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Pessoas do espaço</h2>
                          <p>Perfis e vínculos ativos</p>
                        </div>
                      </div>
                      {data.members.map((m) => (
                        <div className="member-row" key={m.user_id}>
                          <Avatar name={m.name} />
                          <strong>{m.name}</strong>
                          <span className="role-tag">
                            {m.role === "admin"
                              ? "Administrador"
                              : m.role === "manager"
                                ? "Gestor"
                                : "Colaborador"}
                          </span>
                          <span>{m.active ? "Ativo" : "Inativo"}</span>
                        </div>
                      ))}
                      <div className="panel-footer">
                        <small>
                          Convites serão habilitados após a conexão e
                          configuração do Supabase.
                        </small>
                      </div>
                    </section>
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>Catálogo de produtos</h2>
                        <Button
                          className="icon-btn"
                          disabled={!isAdmin}
                          aria-label="Novo produto"
                          onClick={() => setForm("product")}
                        >
                          <Plus size={20} />
                        </Button>
                      </div>
                      {data.products.map((p) => (
                        <div className="product-row" key={p.id}>
                          <span
                            className="product-dot"
                            style={{ background: p.color }}
                          />
                          {p.name}
                        </div>
                      ))}
                    </section>
                    <section className="panel">
                      <div className="panel-heading">
                        <h2>Equipes</h2>
                      </div>
                      {data.teams.map((t) => (
                        <div className="team-config" key={t.id}>
                          <strong>{t.name}</strong>
                          <div className="avatar-stack">
                            {data.teamMembers
                              .filter((m) => m.team_id === t.id)
                              .map((tm) => (
                                <Avatar
                                  key={tm.user_id}
                                  name={
                                    data.members.find(
                                      (m) => m.user_id === tm.user_id,
                                    )?.name ?? "?"
                                  }
                                  size="small"
                                />
                              ))}
                          </div>
                        </div>
                      ))}
                    </section>
                  </div>
                  <div className="security-note">
                    <ShieldCheck size={22} />
                    <div>
                      <strong>Permissões verificadas no backend</strong>
                      <p>
                        {demo
                          ? "Você está em um ambiente demonstrativo."
                          : "Acesso limitado aos dados e equipes autorizados da sua empresa."}
                      </p>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
          <footer className="app-footer">
            <span>
              MAVI <span>·</span> Gestão de trabalho
            </span>
            <span>
              {demo ? "Ambiente demonstrativo" : "Seu trabalho, em um só lugar"}
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
      {form && (
        <CreateForm
          kind={form}
          data={data}
          company={company}
          user={user}
          busy={busy}
          mutate={mutate}
          onClose={() => setForm(null)}
        />
      )}
      {selectedTask && (
        <TaskDetail
          key={selectedTask.id}
          task={selectedTask}
          data={data}
          user={user}
          busy={busy}
          demo={demo}
          demoStore={demoStore.current}
          refresh={refresh}
          mutate={mutate}
          onClose={() => setSelected(null)}
          notify={notify}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  tone,
  caption,
  onClick,
}: {
  label: string;
  value?: string | number;
  icon: typeof Clock3;
  tone: string;
  caption: string;
  onClick: () => void;
}) {
  return (
    <Button className={`stat-card ${tone}`} onClick={onClick}>
      <div>
        <span>{label}</span>
        <Icon size={20} />
      </div>
      <strong>{value ?? "—"}</strong>
      <footer>
        <span>{caption}</span>
        <ArrowUpRight size={16} />
      </footer>
    </Button>
  );
}
function TaskTable({
  tasks,
  data,
  today,
  onSelect,
}: {
  tasks: Task[];
  data: Snapshot;
  today: string;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      <div className="table-scroll">
        <table className="task-table">
          <thead>
            <tr>
              <th>Tarefa</th>
              <th>Status</th>
              <th>Prazo</th>
              <th>Responsável</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => {
              const n = names(data, t);
              return (
                <tr key={t.id}>
                  <td>
                    <Button
                      className="task-title"
                      onClick={() => onSelect(t.id)}
                    >
                      <span
                        className={`task-check ${t.status === "done" ? "complete" : ""}`}
                      >
                        {t.status === "done" && <Check size={13} />}
                      </span>
                      <span>
                        <strong>{t.title}</strong>
                        <small>
                          {n.client?.name} <span> / </span> {n.product?.name}
                        </small>
                        <span className="mobile-status">
                          <Badge status={t.status} />
                        </span>
                      </span>
                    </Button>
                  </td>
                  <td>
                    <Badge status={t.status} />
                  </td>
                  <td>
                    <span className={`due ${isLate(t, today) ? "late" : ""}`}>
                      <CalendarDays size={14} />
                      {t.due_date === today ? "Hoje" : dateLabel(t.due_date)}
                      {isLate(t, today) && <span className="late-dot" />}
                    </span>
                  </td>
                  <td>
                    <Avatar name={n.member?.name ?? "?"} size="small" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!tasks.length && (
        <Empty
          title="Tudo livre por aqui"
          body="Nenhuma tarefa corresponde a esta seleção."
        />
      )}
    </>
  );
}
function Login({
  onDemo,
  notify,
}: {
  onDemo: () => void;
  notify: (s: string) => void;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      if (!supabase)
        throw Error("A conexão com Supabase ainda não foi configurada.");
      const { error } = await supabase.auth.signInWithPassword({
        email: String(fd.get("email")),
        password: String(fd.get("password")),
      });
      if (error) throw error;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-art">
        <a className="brand" href="#">
          <span className="brand-mark">M</span>mavi.
        </a>
        <h1>
          O trabalho flui.
          <br />
          As ideias crescem.
        </h1>
        <p>
          Clientes, projetos e entregas.
          <br />
          Tudo no mesmo espaço.
        </p>
        <span>GESTÃO PARA QUEM CRIA</span>
      </div>
      <div className="login-form">
        <small>SEU ESPAÇO DE TRABALHO</small>
        <h2>Bom ter você aqui.</h2>
        <p>Entre com o acesso enviado pela sua equipe.</p>
        <form onSubmit={submit}>
          <label>
            E-mail
            <Input
              name="email"
              type="email"
              autoComplete="email"
              placeholder="voce@agencia.com.br"
              required
            />
          </label>
          <label>
            Senha
            <Input
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Sua senha"
              required
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button className="btn primary" disabled={busy} loading={busy}>
            Entrar no workspace
            <ArrowRight size={17} />
          </Button>
        </form>
        <Button className="text-btn demo-login" onClick={onDemo}>
          Explorar demonstração <ExternalLink size={15} />
        </Button>
        <small>
          Acesso por convite. Entre em contato com seu administrador.
        </small>
      </div>
    </div>
  );
}

function SetPassword({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget),
      password = String(fd.get("password"));
    if (password !== fd.get("confirm")) {
      setError("As senhas precisam ser iguais.");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase!.auth.updateUser({ password });
      if (error) throw error;
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="password-page">
      <div className="login-form">
        <h2>Defina sua senha</h2>
        <p>Conclua seu acesso ao espaço de trabalho.</p>
        <form onSubmit={submit}>
          <label>
            Nova senha
            <Input
              name="password"
              type="password"
              minLength={12}
              required
              autoComplete="new-password"
            />
          </label>
          <label>
            Confirme a senha
            <Input
              name="confirm"
              type="password"
              minLength={12}
              required
              autoComplete="new-password"
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button className="btn primary" disabled={busy} loading={busy}>
            Salvar e entrar
          </Button>
        </form>
      </div>
    </div>
  );
}
