import { calendarDays, monthRange } from "./schedule";
import { EditEntityForm, type EntityEdit } from "./EditEntityForm";
import { dashboardIdFromPath, taskIdFromPath, taskUrl } from "./router";
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
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type FormEvent,
  type MouseEvent,
} from "react";
import type { Session } from "@supabase/supabase-js";
import {
  LayoutDashboard,
  Users,
  CheckCheck,
  FolderKanban,
  Clock3,
  ChartNoAxesCombined,
  Database,
  HardDrive,
  PanelsTopLeft,
  Megaphone,
  Bell,
  BellOff,
  BellRing,
  Lightbulb,
  Settings2,
  Search,
  Plus,
  ArrowUpRight,
  ChevronRight,
  ChevronsUpDown,
  ChevronsLeft,
  ChevronsRight,
  Menu,
  LogOut,
  Check,
  ArrowLeft,
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
  Flag,
  X,
  ShieldCheck,
  Building2,
  Package,
  Pencil,
  ChartNoAxesGantt,
  UserPlus,
  KeyRound,
  Mail,
  TextSearch,
  MonitorDown,
  Share,
} from "lucide-react";
import { supabase } from "./supabase";
import * as api from "./api";
import * as cache from "./cache";
import { DemoStore } from "./demo-store";
import { demoUser } from "./demo";
import {
  Avatar,
  Badge,
  Modal,
  Empty,
  Loading,
  LiveDuration,
} from "./components";
import {
  type Task,
  type AppNotification,
  type Project,
  type Snapshot,
  type TimeEntry,
  type Comment,
  type Attachment,
  type TaskEvent,
  type Status,
  type Company,
  type Member,
  emptySnapshot,
  statuses,
  listedStatuses,
  priorities,
} from "./types";
import {
  dateKey,
  dateLabel,
  duration,
  minutes,
  isLate,
  namesFrom,
  buildNameLookup,
  canSeeTask,
  TASK_SCOPES,
  myTeams,
  taskScope,
  taskTeamName,
  type TaskScope,
  taskMatchesSearch,
  durationWithSeconds,
  upsertById,
  initials,
  byId,
  type NameLookup,
} from "./domain";
import { useNow } from "./useClock";
import { Expandable, Paged, Pagination } from "./Pagination";
import { TaskTemplatesPanel } from "./TaskTemplates";
import { SuggestionDialog, SuggestionSettingsPanel } from "./SuggestionDialog";
import { SidebarNav, type NavTarget } from "./SidebarNav";
import { requestPasswordReset } from "./profile";
import { pushActive, syncPush } from "./push";
import {
  CreateForm,
  type FormPreset,
  TaskDetail,
  ResetPasswordModal,
  UpdateEmailModal,
} from "./forms";
import { TaskCreateForm } from "./TaskCreateForm";
import { ClientPortfolio } from "./ClientPortfolio";
import { ProjectsBrowser } from "./ProjectsBrowser";
import { TeamForm } from "./TeamForm";
import { Drive } from "./DrivePage";
import { CampaignsPage } from "./CampaignsPage";
import { StoragePage } from "./StoragePage";
import { ProfilePage } from "./ProfilePage";
import { MemberForm } from "./MemberForm";
import { TaskSearch } from "./TaskSearch";
import { useInstall } from "./pwa";
import { useTaskSeconds } from "./useTaskTime";
import { NotificationInbox } from "./NotificationInbox";
import { OnlineMembers, PresenceDot } from "./OnlineMembers";
import { usePresence } from "./presence";
import {
  notificationState,
  showNotification,
  toggleNotifications,
  type NotificationState,
} from "./notifications";
import {
  canCreateTaskIn,
  contractParts,
  contractProductLabel,
  teamClientIds,
} from "./domain";

const TaskSchedule = lazy(() =>
  import("./TaskSchedule").then((m) => ({ default: m.TaskSchedule })),
);
const ScheduleNavigation = lazy(() =>
  import("./TaskSchedule").then((m) => ({ default: m.ScheduleNavigation })),
);
const Reports = lazy(() => import("./Reports"));
// Leaders only, and heavy (editor, charts): loaded when first opened.
const DashboardsPage = lazy(() =>
  import("./DashboardsPage").then((m) => ({ default: m.DashboardsPage })),
);

const navigation = [
  { id: "overview", label: "Visão geral", icon: LayoutDashboard },
  { id: "tasks", label: "Tarefas", icon: CheckCheck },
  { id: "clients", label: "Clientes", icon: Users },
  { id: "products", label: "Produtos", icon: Package },
  { id: "projects", label: "Projetos", icon: FolderKanban },
  { id: "campaigns", label: "Campanhas", icon: Megaphone },
  { id: "hours", label: "Controle de horas", icon: Clock3 },
  { id: "reports", label: "Relatórios", icon: ChartNoAxesCombined },
  { id: "drive", label: "Drive", icon: HardDrive },
  { id: "storage", label: "Armazenamento", icon: Database },
  { id: "dashboards", label: "Dashboards", icon: PanelsTopLeft },
] as const;
// Mutations that return the affected row (see the RPCs in
// supabase/migrations/20260921120000_performance_optimizations.sql) patch
// local state directly instead of forcing a full snapshot refetch — the task
// list and dashboards no longer flash a loading state for a one-row change.
const TASK_ROW_MUTATIONS = new Set([
  "transition_task",
  "update_task",
  "set_task_custom_fields",
]);
const TIMER_ROW_MUTATIONS = new Set(["start_timer", "stop_timer"]);
const SELF_HANDLED_MUTATIONS = new Set(["add_comment"]);
// Collaborators see these modules scoped to them: clients/projects they serve
// (read-only, plus creating tasks) and only their own hours and reports.
const MEMBER_PAGES: readonly Page[] = [
  "tasks",
  "search",
  "clients",
  "projects",
  "hours",
  "reports",
  "drive",
  "profile",
];
// Modules exclusive to the company's administrators (not even managers).
const ADMIN_PAGES: readonly Page[] = ["campaigns"];
function canOpenPage(page: Page, isAdmin: boolean, isLeader: boolean) {
  if (ADMIN_PAGES.includes(page)) return isAdmin;
  return isLeader || MEMBER_PAGES.includes(page);
}
// A UI preference, not cached data: it lives outside the "mavi:cache:" prefix
// that logout clears, so it survives signing out.
const SIDEBAR_KEY = "mavi:sidebar-collapsed";
function readSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}
export default function App() {
  // Created once: `useRef(new DemoStore())` would build (and discard) a whole
  // demo snapshot on every render.
  const [demoStoreInstance] = useState(() => new DemoStore());
  const demoStore = useRef(demoStoreInstance);
  const [needsPassword, setNeedsPassword] = useState(
    new URLSearchParams(window.location.search).get("setup") === "1" ||
      new URLSearchParams(window.location.hash.slice(1)).get("type") ===
        "recovery",
  );
  const [demo, setDemo] = useState(false),
    [session, setSession] = useState<Session | null>(null),
    [authReady, setAuthReady] = useState(!supabase);
  // The user whose access was confirmed active; deactivated people are
  // signed out (see the my_access check below) with this notice.
  const [accessUser, setAccessUser] = useState(""),
    [accessNotice, setAccessNotice] = useState("");
  const [data, setData] = useState<Snapshot>(() => {
      if (demo) return demoStore.current.data;
      const cachedCompanies = cache.get<Company[]>("companies");
      return cachedCompanies && cachedCompanies.length
        ? { ...emptySnapshot, companies: cachedCompanies }
        : emptySnapshot;
    }),
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
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [notifications, setNotifications] =
    useState<NotificationState>(notificationState);
  // Registers this browser for push (notifications with the app closed)
  // whenever the signed-in person has notifications on; removes it when off.
  const pushUser = demo ? "" : (session?.user.id ?? "");
  useEffect(() => {
    if (!pushUser || notifications === "unsupported") return;
    void syncPush(notifications === "on");
  }, [pushUser, notifications]);
  // A click on a push notification, with the app already open (sw.js).
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null;
      if (data?.type !== "mavi:open" || !data.url) return;
      const id = taskIdFromPath(data.url);
      if (id) setSelected(id);
      else navigate(data.url);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () =>
      navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);
  function toggleCollapsed() {
    setCollapsed((was) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, was ? "0" : "1");
      } catch {
        // Blocked storage: the choice just won't persist.
      }
      return !was;
    });
  }
  const [sidebar, setSidebar] = useState(false),
    [viewValue, setView] = useUrlState<string>("visualizacao", "list");
  const view = ["list", "board", "calendar", "gantt"].includes(viewValue)
    ? viewValue
    : "list";
  const [scheduleMonthValue, setScheduleMonth] = useUrlState<string>(
    "mes",
    dateKey().slice(0, 7),
  );
  const scheduleMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(scheduleMonthValue)
    ? scheduleMonthValue
    : dateKey().slice(0, 7);
  const scheduleView = view === "calendar" || view === "gantt";
  const [search, setSearch] = useUrlState<string>("busca", ""),
    [query, setQuery] = useState(search),
    [status, setStatus] = useUrlState<string>("status", ""),
    [product, setProduct] = useUrlState<string>("produto", ""),
    // Old "Minhas tarefas" links (?minhas=1) open the "Para você" tab.
    [legacyMine, setLegacyMine] = useUrlState<boolean>("minhas", false),
    [scopeParam, setScope] = useUrlState<string>("escopo", ""),
    [late, setLate] = useUrlState<boolean>("atrasadas", false),
    [clientFilter, setClientFilter] = useUrlState<string>("cliente", ""),
    [projectFilter, setProjectFilter] = useUrlState<string>("projeto", ""),
    [offset, setOffset] = useUrlState<number>("pagina", 0),
    [count, setCount] = useState(0);
  const [entityEdit, setEntityEdit] = useState<EntityEdit | null>(null);
  const [editMember, setEditMember] = useState<Member | null>(null);
  const [resetPasswordMember, setResetPasswordMember] = useState<Member | null>(
    null,
  );
  const [updateEmailMember, setUpdateEmailMember] = useState<Member | null>(
    null,
  );
  const [formPreset, setFormPreset] = useState<FormPreset>({});
  const selected = taskIdFromPath(location.split("?")[0]);
  // People a dashboard is shared with open it by its link (the module itself
  // is for leaders).
  const openDashboard = dashboardIdFromPath(location.split("?")[0]);
  const taskBackground = useRef<string | null>(null);
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  function setSelected(id: string | null) {
    if (!id) {
      if (selected)
        navigate(taskBackground.current ?? pageUrl("tasks", companyPath), true);
      taskBackground.current = null;
      return;
    }
    const target = data.tasks.find((t) => t.id === id);
    taskBackground.current = location;
    navigate(
      taskUrl(target ?? { id, title: "tarefa" }, companyPath) +
        window.location.search,
    );
  }
  const [form, setForm] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [companiesReady, setCompaniesReady] = useState(() => {
      if (!supabase) return true;
      const cached = cache.get<Company[]>("companies");
      return Boolean(cached && cached.length > 0);
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [refresh, setRefresh] = useState(0),
    // Live updates (see the subscription below): reload the task views, the
    // open task, its comments/history, and the person's running timer —
    // without forcing a refetch of the catalogs, as `refresh` does.
    [liveTick, setLiveTick] = useState(0),
    [detailTick, setDetailTick] = useState(0),
    [extrasTick, setExtrasTick] = useState(0),
    [timerTick, setTimerTick] = useState(0),
    [reportRefresh, setReportRefresh] = useState(0);
  useEffect(() => {
    if (!legacyMine) return;
    setLegacyMine(false);
    setScope("mine");
  }, [legacyMine, setLegacyMine, setScope]);
  const [summary, setSummary] = useState<api.Summary | null>(null);
  // Only components that actually display a running clock subscribe to time
  // ticking (see useNow/LiveDuration) — demoNow is the one exception, since the
  // demo-mode stat cards below derive a live total from it directly.
  const demoNow = useNow(demo);
  const request = useRef(0),
    user = demo ? demoUser : (session?.user.id ?? "");
  const currentCompany = data.companies.find((c) => c.id === company),
    member = data.members.find((m) => m.user_id === user),
    isAdmin = member?.role === "admin",
    isManager = member?.role === "manager",
    isLeader = isAdmin || isManager;
  // Who from the company has the app open (joined once the person's
  // membership is known).
  const presence = usePresence(member ? company : "", user, demo, data.members);
  // Task list tabs (see TASK_SCOPES): "" is every task. Collaborators only
  // see their own tasks, the ones they take part in and, when they supervise
  // a team, that team's (the tasks policy) — so "Outras equipes" never
  // applies to them, and "Suas equipes" only to supervisors.
  const supervises = data.teamMembers.some(
    (tm) => tm.user_id === user && tm.supervisor,
  );
  const scopeTabs = isLeader
    ? TASK_SCOPES
    : TASK_SCOPES.filter(
        (t) => t.id !== "others" && (t.id !== "teams" || supervises),
      );
  const listScope: TaskScope | "" = scopeTabs.some((t) => t.id === scopeParam)
    ? (scopeParam as TaskScope)
    : "";
  const today = dateKey(new Date(), currentCompany?.timezone);
  const [periodValue, setPeriod] = useUrlState<string>("periodo", "");
  const [currentRunning, setCurrentRunning] = useState<
    import("./types").TimeEntry | null
  >(null);
  const activeTimer = currentRunning;
  const playingTimer: Playing | null = activeTimer
    ? { entry: activeTimer, hours: data.hours, company, demo }
    : null;
  useEffect(() => {
    let alive = true;
    async function syncTimer() {
      if (demo) {
        setCurrentRunning(
          demoStore.current.data.hours.find(
            (h) => h.user_id === user && !h.ended_at,
          ) ?? null,
        );
        return;
      }
      if (!session) {
        setCurrentRunning(null);
        return;
      }
      try {
        const timer = await api.currentTimer();
        if (alive) setCurrentRunning(timer);
      } catch {
        /* Keep the last confirmed timer on temporary connectivity loss. */
      }
    }
    void syncTimer();
    const interval = setInterval(syncTimer, 10000);
    const focus = () => void syncTimer();
    window.addEventListener("focus", focus);
    return () => {
      alive = false;
      clearInterval(interval);
      window.removeEventListener("focus", focus);
    };
  }, [demo, session, user, refresh, timerTick]);
  useEffect(() => {
    let alive = true;
    setDetailError("");
    if (!selected || !company || (!demo && !session)) {
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
    const promise = demo
      ? Promise.resolve(
          demoStore.current.data.tasks.find((t) => t.id === selected) ?? null,
        )
      : api.taskById(company, selected);
    promise
      .then((t) => {
        if (alive) {
          if (
            !t ||
            // The database only returns visible tasks (leaders, creator,
            // assignee, the team's supervisors); the demo mirrors that.
            (demo && !canSeeTask(demoStore.current.data, t, user))
          ) {
            setDetailTask(null);
            setDetailError(
              "Tarefa não encontrada ou você não tem acesso a ela.",
            );
          } else {
            setDetailTask(t);
          }
        }
      })
      .catch((e) => {
        if (alive) setDetailError(e.message);
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selected, company, demo, session, refresh, detailTick, isLeader, user]);
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
    if (!authReady || !member || isLogin) return;
    if (
      page &&
      !canOpenPage(page, isAdmin, isLeader) &&
      !(page === "dashboards" && openDashboard)
    ) {
      navigate(pageUrl(isLeader ? "overview" : "tasks", companyPath), true);
    }
  }, [
    authReady,
    member,
    isAdmin,
    isLeader,
    page,
    companyPath,
    isLogin,
    openDashboard,
  ]);
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
    setForm(null);
    setEntityEdit(null);
    setSidebar(false);
  }, [page]);
  // Products are now linked to clients inside the Clients page.
  useEffect(() => {
    if (page === "contracts") navigate(pageUrl("clients", companyPath), true);
  }, [page, companyPath]);
  function openForm(kind: string, preset: FormPreset = {}) {
    setFormPreset(preset);
    setForm(kind);
  }
  // "N" opens a new task from anywhere, unless the user is typing or a
  // dialog is already open.
  useEffect(() => {
    if (!company) return;
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== "n" || e.metaKey || e.ctrlKey || e.altKey)
        return;
      const target = e.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, select, [contenteditable='true']") ||
        document.querySelector("dialog[open]")
      )
        return;
      e.preventDefault();
      openForm("task");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [company]);
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
      if (event === "SIGNED_OUT" || !s) {
        api.clearAllCaches();
        setData(emptySnapshot);
      }
      setSession(s);
      setAuthReady(true);
    });
    return () => subscription.unsubscribe();
  }, []);
  const sessionUser = session?.user.id ?? "";
  useEffect(() => {
    if (demo || !sessionUser || !supabase) return;
    let alive = true;
    async function check() {
      const access = await api.myAccess().catch(() => null);
      if (!alive) return;
      if (access !== "inactive") {
        // A failed check never locks anyone out; RLS still guards the data.
        setAccessUser(sessionUser);
        return;
      }
      setAccessNotice(DEACTIVATED);
      api.clearAllCaches();
      setData(emptySnapshot);
      await syncPush(false);
      await supabase!.auth.signOut({ scope: "local" }).catch(() => {});
    }
    void check();
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    const id = setInterval(check, 5 * 60 * 1000);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
      clearInterval(id);
    };
  }, [demo, sessionUser]);
  useEffect(() => {
    if (!company || demo) return;
    const cached = api.getCachedSnapshot(company);
    if (cached) {
      setData((d) => ({
        ...d,
        ...cached,
        companies: d.companies.length ? d.companies : cached.companies,
      }));
    }
  }, [company, demo]);
  useEffect(() => {
    if (demo || !session) return;
    let alive = true;
    if (!data.companies.length) setCompaniesReady(false);
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
      const demoData = demoStore.current.data;
      const demoMember = demoData.members.find((m) => m.user_id === user);
      const isDemoLeader =
        demoMember?.role === "admin" || demoMember?.role === "manager";
      const tasks = isDemoLeader
        ? demoData.tasks
        : demoData.tasks.filter((t) => canSeeTask(demoData, t, user));
      setData({ ...demoData, tasks });
      setLoading(false);
      return;
    }
    if (!company || !session) return;
    const id = ++request.current;
    const hasData = data.members.length > 0;
    if (!hasData || page === "tasks") {
      setLoading(true);
    }
    setError("");
    const forceRefresh = refresh > 0;
    api
      .snapshot(
        company,
        {
          search: page === "tasks" ? query : "",
          status: page === "tasks" ? status : "",
          hideDone: page === "tasks" && !status,
          product: page === "tasks" ? product : "",
          mine: false,
          scope: page === "tasks" && listScope ? listScope : undefined,
          user,
          page: page === "tasks" ? offset : 0,
          late: page === "tasks" ? late : false,
          client: page === "tasks" ? clientFilter : "",
          project: page === "tasks" ? projectFilter : "",
          onlyMineOrCreated: !isLeader,
          schedule:
            page === "tasks" && scheduleView
              ? {
                  view: view as "calendar" | "gantt",
                  start:
                    view === "calendar"
                      ? calendarDays(scheduleMonth)[0]
                      : monthRange(scheduleMonth).start,
                  end:
                    view === "calendar"
                      ? calendarDays(scheduleMonth).at(-1)!
                      : monthRange(scheduleMonth).end,
                }
              : undefined,
        },
        forceRefresh,
      )
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
    user,
    offset,
    late,
    clientFilter,
    projectFilter,
    refresh,
    liveTick,
    isLeader,
    listScope,
    page === "tasks",
    page === "tasks" ? view : "list",
    page === "tasks" ? scheduleMonth : "",
  ]);
  // How many tasks each tab holds, with the list's other filters applied.
  const [scopeCounts, setScopeCounts] = useState<Record<
    TaskScope,
    number
  > | null>(null);
  useEffect(() => {
    if (demo || page !== "tasks" || !company || !session) return;
    let alive = true;
    api
      .taskScopeCounts(
        company,
        {
          search: query,
          status,
          hideDone: !status,
          product,
          mine: false,
          user,
          page: 0,
          late,
          client: clientFilter,
          project: projectFilter,
          onlyMineOrCreated: false,
        },
        refresh > 0,
      )
      .then((c) => {
        if (alive) setScopeCounts(c);
      })
      .catch(() => {
        if (alive) setScopeCounts(null);
      });
    return () => {
      alive = false;
    };
  }, [
    demo,
    isLeader,
    page,
    company,
    session,
    query,
    status,
    product,
    user,
    late,
    clientFilter,
    projectFilter,
    refresh,
    liveTick,
  ]);
  useEffect(() => {
    if (demo || !company || !session) return;
    let alive = true;
    api
      .reportSummary(company, period, refresh > 0 || reportRefresh > 0)
      .then((s) => {
        if (alive) setSummary(s);
      })
      .catch((e) => setError(e.message));
    return () => {
      alive = false;
    };
  }, [demo, company, session, period, refresh, reportRefresh]);

  // Latest values for the long-lived realtime subscription below.
  // Inbox: who mentioned the person, and where.
  const [inbox, setInbox] = useState<AppNotification[]>([]);
  const loadInbox = useCallback(() => {
    if (!company || (!demo && !session)) return;
    if (demo) {
      setInbox(demoStore.current.inbox(user));
      return;
    }
    api
      .myNotifications(company)
      .then(setInbox)
      .catch(() => {});
  }, [company, demo, session, user]);
  useEffect(loadInbox, [loadInbox]);
  function openNotification(n: AppNotification) {
    setSelected(n.task_id);
    if (n.read_at) return;
    const at = new Date().toISOString();
    setInbox((list) =>
      list.map((x) => (x.id === n.id ? { ...x, read_at: at } : x)),
    );
    if (demo) demoStore.current.readNotifications(user, [n.id]);
    else void api.readNotifications(company, [n.id]).catch(() => {});
  }
  function readAllNotifications() {
    const at = new Date().toISOString();
    setInbox((list) => list.map((x) => ({ ...x, read_at: x.read_at ?? at })));
    if (demo) demoStore.current.readNotifications(user);
    else void api.readNotifications(company).catch(() => {});
  }

  // Latest values for the long-lived realtime subscription below.
  const supervisesTeam = data.teamMembers.some(
    (tm) => tm.user_id === user && tm.supervisor,
  );
  const liveState = {
    user,
    isLeader,
    supervisesTeam,
    tasks: data.tasks,
    selected,
    openTask: setSelected,
    loadInbox,
  };
  const live = useRef(liveState);
  live.current = liveState;
  // Whether live notices are arriving; while not, views refetch on focus.
  const liveOk = useRef(false);
  // Live updates. The database announces each change (ids only) on the
  // company's private topic; this app keeps the ones that concern the person
  // (their tasks, their teams' when supervising, everything for leaders, or
  // whatever is on screen), forgets those tasks from the cache, and reloads
  // only what is shown. One move sends a few notices (task, history,
  // comment, timer), so they are gathered for a moment and applied once.
  useEffect(() => {
    if (!company || demo || !session) return;
    const pending = {
      tasks: new Set<string>(),
      extras: new Set<string>(),
      hours: false,
      timer: false,
      lookups: false,
    };
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let lookupsTimer: ReturnType<typeof setTimeout> | undefined;
    const reloadLookups = () => {
      clearTimeout(lookupsTimer);
      // Catalog edits come in bursts (an import, a team change): wait for
      // them to settle before refetching the (possibly large) catalogs.
      lookupsTimer = setTimeout(() => {
        api
          .companyLookups(company, true)
          .then((lookups) => setData((d) => ({ ...d, ...lookups })))
          .catch(() => {});
      }, 1500);
    };
    const flush = () => {
      const { tasks, extras, hours, timer, lookups } = pending;
      const open = live.current.selected;
      if (tasks.size || hours) {
        setLiveTick((v) => v + 1);
        setReportRefresh((v) => v + 1);
      }
      if (open && tasks.has(open)) setDetailTick((v) => v + 1);
      if (open && (tasks.has(open) || extras.has(open)))
        setExtrasTick((v) => v + 1);
      if (timer) setTimerTick((v) => v + 1);
      if (lookups) reloadLookups();
      pending.tasks = new Set();
      pending.extras = new Set();
      pending.hours = pending.timer = pending.lookups = false;
    };
    const schedule = () => {
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, 350);
    };
    // Everything may be stale (missed notices, or none arriving at all).
    const resync = () => {
      api.forgetTaskData(company);
      // Notifications announced while offline aren't replayed either.
      live.current.loadInbox();
      pending.hours = pending.timer = pending.lookups = true;
      const open = live.current.selected;
      if (open) pending.tasks.add(open);
      else pending.tasks.add("*");
      schedule();
    };
    const unsubscribe = api.subscribeToCompanyChanges(company, {
      user,
      // A new task for the person, a mention or a reply: the inbox row
      // arrives here while the app is open. With push on, the browser already shows
      // the system notification (same tag), so only the toast is added.
      onNotification: (row) => {
        live.current.loadInbox();
        api
          .myNotifications(company)
          .then((list) => {
            const n = list.find((x) => x.id === row.id);
            if (!n) return;
            const who = n.actor_name ?? "Alguém";
            const assigned = n.kind === "assigned";
            const said =
              n.kind === "reply" ? "respondeu um comentário" : "mencionou você";
            notify(
              assigned
                ? `Nova tarefa para você: ${n.task_title}`
                : `${who} ${said} em ${n.task_title}`,
            );
            if (pushActive()) return;
            showNotification(
              assigned ? "Nova tarefa para você" : `${who} ${said}`,
              {
                body: assigned
                  ? `${who} criou: ${n.task_title}`
                  : n.excerpt
                    ? `${n.task_title}: ${n.excerpt}`
                    : n.task_title,
                tag: n.id,
                url: `/tarefas/${n.task_id}`,
                onClick: () => live.current.openTask(n.task_id),
              },
            );
          })
          .catch(() => {});
      },
      onChange: (change) => {
        if (change.kind === "lookup") {
          api.invalidateLookupsCache(company);
          pending.lookups = true;
          return schedule();
        }
        const l = live.current;
        const mine = change.users.includes(l.user);
        if (
          !api.liveChangeConcerns(change, {
            ...l,
            onScreen: (id) =>
              l.selected === id || l.tasks.some((t) => t.id === id),
          })
        )
          return;
        if (change.kind === "task") {
          api.forgetTask(company, change.task);
          pending.tasks.add(change.task);
        } else if (change.kind === "extras") {
          api.invalidateTaskExtras(change.task);
          pending.extras.add(change.task);
        } else {
          api.invalidateHoursCache(company);
          api.invalidateTaskExtras(change.task);
          pending.hours = true;
          pending.extras.add(change.task);
          // A timer of the person may have been paused (status change).
          if (mine) pending.timer = true;
        }
        schedule();
      },
      onResync: resync,
      onStatus: (ok) => {
        liveOk.current = ok;
      },
    });
    // Without live notices (connection down, or blocked), refetch what is on
    // screen when the person comes back to the tab, at most every 15s.
    let lastCatchUp = Date.now();
    const catchUp = () => {
      if (document.visibilityState !== "visible" || liveOk.current) return;
      if (Date.now() - lastCatchUp < 15000) return;
      lastCatchUp = Date.now();
      resync();
    };
    window.addEventListener("focus", catchUp);
    document.addEventListener("visibilitychange", catchUp);
    return () => {
      unsubscribe();
      clearTimeout(flushTimer);
      clearTimeout(lookupsTimer);
      liveOk.current = false;
      window.removeEventListener("focus", catchUp);
      document.removeEventListener("visibilitychange", catchUp);
    };
  }, [company, demo, session]);

  const notify = useCallback((message: string) => setToast(message), []);
  async function mutate(name: string, args: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      if (name === "invite_user") {
        const email = String(args.p_email ?? "").trim();
        const userName = String(args.p_name ?? "").trim();
        const role = String(args.p_role ?? "member") as
          "admin" | "manager" | "member";
        const teams = Array.isArray(args.p_teams)
          ? (args.p_teams as string[])
          : [];

        let userId = "";
        if (demo) {
          userId = demoStore.current.mutate(name, args) as string;
          setData({ ...demoStore.current.data });
          setRefresh((v) => v + 1);
        } else {
          const res = await api.inviteUser(
            company,
            email,
            userName,
            role,
            teams,
          );
          userId = res.user_id;
          const newMember = {
            company_id: company,
            user_id: userId,
            name: userName,
            role,
            active: true,
          };
          setData((d) => ({
            ...d,
            members: [
              ...d.members.filter((m) => m.user_id !== userId),
              newMember,
            ],
            teamMembers: [
              ...d.teamMembers,
              ...teams.map((tid) => ({
                company_id: company,
                team_id: tid,
                user_id: userId,
              })),
            ],
          }));
        }
        notify(`Convite enviado para ${email}`);
        return userId;
      }
      const result = demo
        ? demoStore.current.mutate(name, args)
        : await api.rpc(name, args);
      if (demo) {
        setData({ ...demoStore.current.data });
        setCurrentRunning(
          demoStore.current.data.hours.find(
            (h) => h.user_id === user && !h.ended_at,
          ) ?? null,
        );
        setRefresh((v) => v + 1);
      } else if (TASK_ROW_MUTATIONS.has(name) && result) {
        const updated = result as Task;
        setData((d) => ({
          ...d,
          tasks: d.tasks.map((t) => (t.id === updated.id ? updated : t)),
        }));
        setDetailTask((t) => (t && t.id === updated.id ? updated : t));
        // Lists are refetched, not patched: the task may now belong in other
        // ones (status, assignee, tab). With live notices on, the database's
        // notice of this very change triggers that reload.
        api.forgetTask(company, updated.id);
        // …and the fresh row is kept as the task's detail.
        api.patchCachedTask(company, updated);
        setExtrasTick((v) => v + 1);
        setReportRefresh((v) => v + 1);
        if (!liveOk.current) setLiveTick((v) => v + 1);
        // A status change pauses every timer on the task (in the database).
        api.invalidateHoursCache(company);
        setTimerTick((v) => v + 1);
      } else if (TIMER_ROW_MUTATIONS.has(name) && result) {
        const entry = result as TimeEntry;
        setCurrentRunning(entry.ended_at ? null : entry);
        setData((d) => ({ ...d, hours: upsertById(d.hours, entry) }));
        api.patchCachedHours(company, entry);
      } else if (name === "add_comment" && args.p_task) {
        api.invalidateTaskExtras(args.p_task as string);
      } else if (!SELF_HANDLED_MUTATIONS.has(name)) {
        if (
          (name === "create_task" || name === "submit_suggestion") &&
          result
        ) {
          const newTask = await api.taskById(company, result as string, true);
          if (newTask) {
            api.forgetTask(company, newTask.id);
            if (!liveOk.current) setLiveTick((v) => v + 1);
            setData((d) => ({
              ...d,
              tasks: [newTask, ...d.tasks.filter((t) => t.id !== newTask.id)],
            }));
          }
          setReportRefresh((v) => v + 1);
        } else if (
          name.startsWith("create_client") ||
          name.startsWith("update_client") ||
          name === "set_client_archived" ||
          name.startsWith("create_product") ||
          name.startsWith("update_product") ||
          name.startsWith("create_contract") ||
          name.startsWith("update_contract") ||
          name.startsWith("create_project") ||
          name.startsWith("update_project") ||
          name.startsWith("create_team") ||
          name.startsWith("update_team") ||
          name === "save_task_template" ||
          name === "save_suggestion_settings" ||
          name === "delete_task_template" ||
          name === "update_my_profile" ||
          name === "update_member" ||
          name === "set_my_avatar"
        ) {
          api.invalidateLookupsCache(company);
          const lookups = await api.companyLookups(company, true);
          setData((d) => ({ ...d, ...lookups }));
        } else if (name === "log_time") {
          api.invalidateHoursCache(company);
          const hours = await api.companyHours(company, true);
          setData((d) => ({ ...d, hours }));
          setReportRefresh((v) => v + 1);
        } else {
          api.invalidateCompanyCache(company);
          setRefresh((v) => v + 1);
        }
      }
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

  async function handleResetPassword(
    targetMember: Member,
    mode: "send_link" | "set_password",
    newPassword?: string,
  ) {
    setBusy(true);
    setError("");
    try {
      if (demo) {
        demoStore.current.mutate("reset_password", {
          p_user: targetMember.user_id,
          p_mode: mode,
          p_new_password: newPassword,
        });
        notify(
          mode === "set_password"
            ? `Senha de ${targetMember.name} redefinida com sucesso.`
            : `Link de recuperação enviado para ${targetMember.email || targetMember.name}.`,
        );
      } else {
        const res = await api.resetUserPassword(
          company,
          targetMember.user_id,
          mode,
          newPassword,
        );
        notify(
          res.message ||
            (mode === "set_password"
              ? `Senha de ${targetMember.name} atualizada com sucesso.`
              : `Link de recuperação enviado com sucesso.`),
        );
      }
    } catch (e) {
      const msg = (e as Error).message || "Erro ao redefinir senha.";
      setError(msg);
      throw Error(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateEmail(targetMember: Member, newEmail: string) {
    setBusy(true);
    setError("");
    try {
      if (demo) {
        demoStore.current.mutate("update_user_email", {
          p_user: targetMember.user_id,
          p_new_email: newEmail,
        });
        setData((d) => ({
          ...d,
          members: d.members.map((m) =>
            m.user_id === targetMember.user_id ? { ...m, email: newEmail } : m,
          ),
        }));
        notify(`E-mail de ${targetMember.name} atualizado para ${newEmail}`);
      } else {
        await api.updateUserEmail(company, targetMember.user_id, newEmail);
        setData((d) => ({
          ...d,
          members: d.members.map((m) =>
            m.user_id === targetMember.user_id ? { ...m, email: newEmail } : m,
          ),
        }));
        notify(`E-mail de ${targetMember.name} atualizado para ${newEmail}`);
      }
    } catch (e) {
      const msg = (e as Error).message || "Erro ao atualizar e-mail.";
      setError(msg);
      throw Error(msg);
    } finally {
      setBusy(false);
    }
  }

  function projectProgress(p: Project) {
    if (demo) {
      const tasks = data.tasks.filter((t) => t.project_id === p.id);
      return {
        total: tasks.length,
        done: tasks.filter((t) => t.status === "done").length,
      };
    }
    const stats = summary?.by_project?.find((s) => s.id === p.id);
    return { total: stats?.total ?? 0, done: stats?.done ?? 0 };
  }
  function go(next: Page) {
    navigate(pageUrl(next, companyPath));
    setSidebar(false);
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
  /** A menu destination as a link: page, filters and settings section. */
  function navHref(to: NavTarget) {
    const query = to.query ? new URLSearchParams(to.query).toString() : "";
    return (
      pageUrl(to.page, companyPath) +
      (query ? `?${query}` : "") +
      (to.hash ? `#${to.hash}` : "")
    );
  }
  function openNav(to: NavTarget) {
    navigate(navHref(to));
    setSidebar(false);
    setForm(null);
    setQuery("");
    if (!to.hash) return;
    // The section appears once the page has rendered.
    let tries = 0;
    const scroll = () => {
      const el = document.getElementById(to.hash!);
      if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
      else if (tries++ < 20) setTimeout(scroll, 50);
    };
    scroll();
  }
  async function logout() {
    api.clearAllCaches();
    if (demo) {
      setDemo(false);
      setData(emptySnapshot);
      navigate("/login", true);
      return;
    }
    try {
      // This browser stops receiving the person's notifications.
      await syncPush(false);
      await supabase?.auth.signOut();
    } finally {
      api.clearAllCaches();
      setData(emptySnapshot);
      navigate("/login", true);
    }
  }
  const selectedTask =
    detailTask?.id === selected && detailTask.company_id === company
      ? detailTask
      : undefined;
  const nameLookup: NameLookup = useMemo(() => buildNameLookup(data), [data]);
  const taskLookup = useMemo(
    () => new Map(data.tasks.map((t) => [t.id, t])),
    [data.tasks],
  );
  // Every filter but the leaders' scope tab (the tabs count from this).
  const unscoped = useMemo(
    () =>
      data.tasks.filter(
        (t) =>
          (!clientFilter ||
            nameLookup.contracts.get(t.contract_id)?.client_id ===
              clientFilter) &&
          (!projectFilter || t.project_id === projectFilter) &&
          taskMatchesSearch(nameLookup, t, query) &&
          // Delivered tasks only appear when filtering by "Entregue".
          (status ? t.status === status : t.status !== "done") &&
          (!late || isLate(t, today)) &&
          (!product ||
            nameLookup.contracts.get(t.contract_id)?.product_id === product),
      ),
    [
      data.tasks,
      nameLookup,
      clientFilter,
      projectFilter,
      query,
      status,
      user,
      late,
      today,
      product,
    ],
  );
  const teamsOfMine = useMemo(() => myTeams(data, user), [data, user]);
  const filtered = useMemo(
    () =>
      listScope
        ? unscoped.filter(
            (t) => taskScope(data, t, user, teamsOfMine) === listScope,
          )
        : unscoped,
    [unscoped, listScope, data, user, teamsOfMine],
  );
  // Tab counts: from the server, or from the demo's (complete) task list.
  const tabCounts = useMemo(() => {
    if (!demo) return scopeCounts;
    const counts: Record<TaskScope, number> = {
      mine: 0,
      created: 0,
      participating: 0,
      teams: 0,
      others: 0,
    };
    for (const t of unscoped) counts[taskScope(data, t, user, teamsOfMine)]++;
    return counts;
  }, [demo, scopeCounts, unscoped, data, user, teamsOfMine]);
  // "Todas": the page split by scope; team tabs: split by team.
  const listGroups = useMemo(() => {
    if (!listScope)
      return scopeTabs
        .map((sc) => ({
          key: sc.id,
          label: sc.label,
          hint: sc.hint,
          tasks: filtered.filter(
            (t) => taskScope(data, t, user, teamsOfMine) === sc.id,
          ),
        }))
        .filter((g) => g.tasks.length);
    if (listScope === "teams" || listScope === "others") {
      const byTeam = new Map<string, Task[]>();
      for (const t of filtered) {
        const name = taskTeamName(data, t);
        byTeam.set(name, [...(byTeam.get(name) ?? []), t]);
      }
      return [...byTeam.entries()]
        .sort(([a], [b]) =>
          a === "Sem equipe" ? 1 : b === "Sem equipe" ? -1 : a.localeCompare(b),
        )
        .map(([name, tasks]) => ({
          key: name,
          label: name,
          hint:
            name === "Sem equipe" ? "Tarefas sem equipe definida" : "Equipe",
          tasks,
        }));
    }
    return undefined;
  }, [scopeTabs, listScope, filtered, data, user, teamsOfMine]);
  // Collaborators only see their own entries and tasks (RLS already scopes
  // them; this keeps demo mode and cached data consistent with that).
  const visibleHours = useMemo(
    () =>
      isLeader ? data.hours : data.hours.filter((h) => h.user_id === user),
    [isLeader, data.hours, user],
  );
  // Collaborators browse only the clients their teams serve (and those
  // clients' products and projects). RLS still returns clients of tasks
  // assigned to them elsewhere, which the task list needs for names.
  const catalogData = useMemo(() => {
    if (isLeader) return data;
    const clients = teamClientIds(data, user);
    const contracts = data.contracts.filter((k) => clients.has(k.client_id));
    const contractIds = new Set(contracts.map((k) => k.id));
    return {
      ...data,
      clients: data.clients.filter((c) => clients.has(c.id)),
      contracts,
      projects: data.projects.filter((p) => contractIds.has(p.contract_id)),
    };
  }, [isLeader, data, user]);
  const reportTasks = useMemo(
    () =>
      isLeader
        ? data.tasks
        : data.tasks.filter(
            (t) => t.assignee_id === user || t.creator_id === user,
          ),
    [isLeader, data.tasks, user],
  );
  const periodHours = useMemo(
    () => visibleHours.filter((h) => h.started_at.slice(0, 7) === period),
    [visibleHours, period],
  );
  const stats = useMemo(
    () =>
      demo
        ? {
            total: reportTasks.length,
            late: reportTasks.filter((t) => isLate(t, today)).length,
            review: reportTasks.filter((t) => t.status === "review").length,
            done: reportTasks.filter(
              (t) => t.delivered_at?.slice(0, 7) === period,
            ).length,
            minutes: periodHours.reduce(
              (sum, h) => sum + minutes(h, demoNow),
              0,
            ),
          }
        : summary,
    [demo, reportTasks, today, period, periodHours, demoNow, summary],
  );
  const focus = useMemo(
    () =>
      data.tasks
        .filter((t) => t.status !== "done")
        .sort((a, b) => a.due_date.localeCompare(b.due_date))
        .slice(0, 6),
    [data.tasks],
  );
  const byClient = useMemo(
    () =>
      demo
        ? data.clients.map((c) => ({
            id: c.id,
            name: c.name,
            minutes: periodHours
              .filter((h) => {
                const task = taskLookup.get(h.task_id);
                return task && namesFrom(nameLookup, task).client?.id === c.id;
              })
              .reduce((s, h) => s + minutes(h, demoNow), 0),
          }))
        : (summary?.by_client ?? []),
    [demo, data.clients, periodHours, taskLookup, nameLookup, demoNow, summary],
  );
  const byPerson = useMemo(
    () =>
      demo
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
        : (summary?.by_person ?? []),
    [demo, data.members, data.tasks, summary],
  );
  const reportPeople = isLeader
    ? byPerson
    : byPerson.filter((p) => p.id === user);
  if (!authReady) return <Loading />;
  if (!demo && session && needsPassword)
    return (
      <SetPassword
        onDone={() => {
          setNeedsPassword(false);
          const url = new URL(window.location.href);
          url.searchParams.delete("setup");
          url.searchParams.delete("reset");
          navigate(url.pathname + url.search, true);
        }}
      />
    );
  if (!demo && session && accessUser !== session.user.id) return <Loading />;
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
        notice={accessNotice}
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
    <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      {sidebar && (
        <Button
          className="sidebar-backdrop"
          aria-label="Fechar menu"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className={`sidebar ${sidebar ? "visible" : ""}`}>
        <div className="sidebar-head">
          <a
            href="#"
            className="brand"
            title="Visão geral"
            onClick={(e) => {
              e.preventDefault();
              go("overview");
            }}
          >
            <span className="brand-mark">W</span>
            <span className="brand-name">
              workspace<span className="brand-period">.</span>
            </span>
          </a>
        </div>
        <div className="workspace">
          <span
            className="workspace-icon"
            title={currentCompany?.name ?? "Espaço de trabalho"}
          >
            <Building2 size={19} />
          </span>
          <div>
            <small>Seu espaço de trabalho</small>
            <Select
              aria-label="Empresa ativa"
              value={company}
              onValueChange={(value) => {
                setData({ ...emptySnapshot, companies: data.companies });
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
        <div className="sidebar-scroll">
          <SidebarNav
            page={page ?? "overview"}
            params={new URLSearchParams(location.split("?")[1] ?? "")}
            isLeader={isLeader}
            allowed={(p) => canOpenPage(p, isAdmin, isLeader)}
            taskCount={stats?.total}
            products={data.products.filter(
              (p) =>
                isLeader ||
                data.tasks.some(
                  (t) =>
                    data.contracts.find((c) => c.id === t.contract_id)
                      ?.product_id === p.id,
                ),
            )}
            href={navHref}
            onNavigate={openNav}
          />
        </div>
        <div className="sidebar-bottom">
          <button
            type="button"
            className="sidebar-collapse"
            aria-expanded={!collapsed}
            title={collapsed ? "Expandir menu" : "Recolher menu"}
            onClick={toggleCollapsed}
          >
            {collapsed ? (
              <ChevronsRight size={18} />
            ) : (
              <ChevronsLeft size={18} />
            )}
            <span className="sidebar-text">Recolher menu</span>
          </button>
          <div className="profile">
            <a
              className={`profile-link ${page === "profile" ? "active" : ""}`}
              href={pageUrl("profile", companyPath)}
              title="Meu perfil"
              aria-current={page === "profile" ? "page" : undefined}
              onClick={(event) => followLink(event, "profile")}
            >
              <Avatar
                name={member?.name ?? "Usuário"}
                src={member?.avatar_url}
              />
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
            </a>
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
              {page === "profile"
                ? "Meu perfil"
                : page === "search"
                  ? "Busca avançada"
                  : (navigation.find((n) => n.id === page)?.label ??
                    "Configurações")}
            </strong>
          </div>
          <div className="topbar-right">
            {playingTimer && (
              <Button
                className="timer-live"
                title="Tempo total da tarefa em execução"
                onClick={() => {
                  go("hours");
                }}
              >
                <span className="pulse" />
                <TaskTotal playing={playingTimer} />
              </Button>
            )}
            <InstallApp notify={notify} />
            <button
              type="button"
              className="inbox-toggle"
              title="Sugestões: nova funcionalidade ou bug"
              aria-label="Sugestões"
              onClick={() => setForm("suggestion")}
            >
              <Lightbulb size={17} />
            </button>
            <NotificationInbox
              items={inbox}
              members={data.members}
              onOpen={openNotification}
              onReadAll={readAllNotifications}
            />
            {notifications !== "unsupported" && (
              <Button
                className={`notify-toggle ${notifications}`}
                disabled={notifications === "denied"}
                aria-pressed={notifications === "on"}
                title={
                  {
                    default:
                      "Receber um aviso quando uma tarefa for criada para você ou quando mencionarem você",
                    on: "Notificações ativadas — clique para pausar",
                    off: "Notificações pausadas — clique para ativar",
                    denied:
                      "Notificações bloqueadas. Libere-as nas configurações do navegador para este site.",
                  }[notifications]
                }
                onClick={() =>
                  void toggleNotifications().then(setNotifications)
                }
              >
                {notifications === "on" ? (
                  <BellRing size={17} />
                ) : notifications === "default" ? (
                  <Bell size={17} />
                ) : (
                  <BellOff size={17} />
                )}
                {notifications === "default" && (
                  <span>Ativar notificações</span>
                )}
              </Button>
            )}
            <OnlineMembers
              members={data.members}
              presence={presence}
              user={user}
              demo={demo}
            />
            <button
              type="button"
              className="topbar-avatar"
              title="Meu perfil"
              aria-label="Meu perfil"
              onClick={() => go("profile")}
            >
              <Avatar
                name={member?.name ?? "Usuário"}
                src={member?.avatar_url}
                size="small"
              />
            </button>
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
                  : page === "profile"
                    ? "Meu perfil"
                    : page === "search"
                      ? "Tarefas"
                      : (navigation.find((n) => n.id === page)?.label ??
                        "Equipe e configurações")}
              </h1>
              <p>
                {
                  {
                    overview:
                      "Uma visão clara do trabalho. Mais espaço para criar.",
                    tasks: "Organize prioridades e acompanhe cada entrega.",
                    search:
                      "Encontre qualquer tarefa pelo que foi escrito nela.",
                    clients:
                      "Cada cliente com os produtos que contratou e os projetos de cada um.",
                    products:
                      "O catálogo do que a agência vende. Adicione cada produto aos clientes que o contrataram.",
                    contracts:
                      "Serviços ativos de cada cliente. Cada serviço pode ter projetos e tarefas avulsas.",
                    projects:
                      "Campanhas e entregas com começo e fim, organizadas por cliente.",
                    campaigns:
                      "Campanhas de tráfego pago de cada cliente e seus ciclos de verba.",
                    hours: "Seu tempo, registrado com clareza.",
                    drive:
                      "Arquivos da equipe, privados ou compartilhados por link.",
                    storage:
                      "Quanto espaço os arquivos enviados ocupam, na agência, por pessoa e por cliente.",
                    dashboards:
                      "Indicadores personalizados de tarefas e horas, em painéis que você monta e compartilha.",
                    profile: "Seu nome, sua foto e sua senha.",
                    reports: isLeader
                      ? "Entenda o ritmo e os resultados da operação."
                      : "Seu ritmo e seus resultados no período.",
                    settings: "Pessoas e produtos do seu espaço de trabalho.",
                  }[page]
                }
              </p>
            </div>
            {page !== "drive" &&
              page !== "profile" &&
              page !== "campaigns" &&
              page !== "storage" &&
              page !== "dashboards" &&
              (![
                "products",
                "contracts",
                "clients",
                "projects",
                "settings",
              ].includes(page) ||
                isLeader) && (
                <Button
                  className="btn primary"
                  onClick={() =>
                    openForm(
                      page === "contracts"
                        ? "contract"
                        : page === "products"
                          ? "product"
                          : page === "clients"
                            ? "client"
                            : page === "projects"
                              ? "project"
                              : page === "hours"
                                ? "time"
                                : page === "settings"
                                  ? "user"
                                  : "task",
                    )
                  }
                >
                  {page === "settings" ? (
                    <UserPlus size={18} />
                  ) : (
                    <Plus size={18} />
                  )}
                  {page === "contracts"
                    ? "Adicionar produto contratado"
                    : page === "products"
                      ? "Novo produto"
                      : page === "clients"
                        ? "Novo cliente"
                        : page === "projects"
                          ? "Novo projeto"
                          : page === "hours"
                            ? "Registrar horas"
                            : page === "settings"
                              ? "Convidar usuário"
                              : "Nova tarefa"}
                  {![
                    "contracts",
                    "products",
                    "clients",
                    "projects",
                    "hours",
                    "settings",
                  ].includes(page) && (
                    <kbd className="kbd-hint" title="Atalho: tecla N">
                      N
                    </kbd>
                  )}
                </Button>
              )}
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
          ) : (!data.members.length && loading && page !== "tasks") ||
            (!demo && !companiesReady) ? (
            <Loading />
          ) : (
            <>
              {page &&
                !canOpenPage(page, isAdmin, isLeader) &&
                !(page === "dashboards" && openDashboard) && (
                  <Empty
                    title="Acesso restrito"
                    body={
                      ADMIN_PAGES.includes(page)
                        ? "Esta área é exclusiva de administradores. Redirecionando..."
                        : "Esta área é exclusiva de administradores e gestores. Redirecionando..."
                    }
                  />
                )}
              {((isLeader && page === "overview") || page === "reports") && (
                <>
                  <div className="section-top">
                    <span className="section-caption">
                      {page === "overview"
                        ? "O PULSO DA SUA OPERAÇÃO"
                        : isLeader
                          ? "INDICADORES DO PERÍODO"
                          : "SEUS INDICADORES DO PERÍODO"}
                    </span>
                    <div className="period">
                      <Input
                        aria-label="Período dos relatórios"
                        type="month"
                        value={period}
                        onChange={(e) => setPeriod(e.target.value)}
                      />
                    </div>
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
                      caption={
                        isLeader
                          ? "O próximo passo é aprovar"
                          : "Suas tarefas em validação"
                      }
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
                      caption="Histórico disponível do último mês"
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
                      caption={
                        isLeader
                          ? "Tempo dedicado à operação"
                          : "Seu tempo registrado"
                      }
                      onClick={() => go("hours")}
                    />
                  </div>
                </>
              )}
              {isLeader && page === "overview" && (
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
                      me={user}
                      lookup={nameLookup}
                      today={today}
                      playing={playingTimer}
                      onSelect={setSelected}
                    />
                    <div className="panel-footer">
                      <span>
                        <span className="legend-dot" /> Prazos ordenados por
                        prioridade de data
                      </span>
                      <Button
                        className="text-btn"
                        onClick={() => openForm("task")}
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
                          setScope("mine");
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
                            <Avatar name={m.name} src={m.avatar_url} />
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
                            {isLeader && (
                              <Button
                                className="icon-btn"
                                title={`Ver equipe de ${m.name}`}
                                onClick={() => go("settings")}
                              >
                                <ArrowUpRight size={16} />
                              </Button>
                            )}
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
              {page === "search" && (
                <TaskSearch
                  data={data}
                  company={company}
                  user={user}
                  demo={demo}
                  demoComments={() => demoStore.current.comments}
                  onOpen={setSelected}
                  onBack={() => go("tasks")}
                />
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
                        {
                          id: "calendar",
                          label: "Calendário",
                          icon: CalendarDays,
                        },
                        { id: "gantt", label: "Gantt", icon: ChartNoAxesGantt },
                      ].map((v) => (
                        <Button
                          key={v.id}
                          className={view === v.id ? "selected" : ""}
                          onClick={() => {
                            setView(v.id);
                            setOffset(0);
                          }}
                        >
                          <v.icon size={16} />
                          {v.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div
                    className="scope-tabs"
                    role="tablist"
                    aria-label="De quem são as tarefas"
                  >
                    {[
                      {
                        id: "" as const,
                        label: "Todas",
                        hint: "Todas as tarefas, separadas por seção",
                      },
                      ...scopeTabs,
                    ].map((tab) => {
                      const n = tabCounts
                        ? tab.id
                          ? tabCounts[tab.id]
                          : scopeTabs.reduce(
                              (sum, t) => sum + tabCounts[t.id],
                              0,
                            )
                        : null;
                      return (
                        <button
                          key={tab.id || "all"}
                          type="button"
                          role="tab"
                          aria-selected={listScope === tab.id}
                          className={listScope === tab.id ? "selected" : ""}
                          title={tab.hint}
                          onClick={() => {
                            setScope(tab.id);
                            setOffset(0);
                          }}
                        >
                          {tab.label}
                          {n !== null && <span>{n}</span>}
                        </button>
                      );
                    })}
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
                    <div className="searchbox">
                      <Input
                        type="search"
                        aria-label="Buscar por tarefa, cliente ou projeto"
                        placeholder="Buscar tarefa, cliente ou projeto…"
                        value={search}
                        onChange={(e) => {
                          setSearch(e.target.value);
                          setOffset(0);
                        }}
                      />
                      {search && (
                        <Button
                          className="icon-btn"
                          aria-label="Limpar busca"
                          onClick={() => {
                            setSearch("");
                            setOffset(0);
                          }}
                        >
                          <X size={16} />
                        </Button>
                      )}
                    </div>
                    <Button
                      className="filter-chip advanced-search-link"
                      title="Buscar também na descrição e nos comentários, incluindo entregues"
                      onClick={() => {
                        // Carries what was typed in the quick search.
                        const term = search.trim();
                        go("search");
                        if (term)
                          navigate(
                            `${pageUrl("search", companyPath)}?termo=${encodeURIComponent(term)}`,
                            true,
                          );
                      }}
                    >
                      <TextSearch size={15} /> Busca avançada
                    </Button>
                    <Select
                      aria-label="Filtrar status"
                      value={status}
                      onValueChange={(value) => {
                        setStatus(value);
                        setOffset(0);
                      }}
                    >
                      <SelectOption value="">
                        Todos os status (exceto entregues)
                      </SelectOption>
                      {listedStatuses.map((k) => (
                        <SelectOption key={k} value={k}>
                          {statuses[k].label}
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
                  {scheduleView && (
                    <Suspense fallback={<Loading compact />}>
                      <ScheduleNavigation
                        month={scheduleMonth}
                        onChange={setScheduleMonth}
                      />
                    </Suspense>
                  )}
                  {loading ? (
                    <Loading compact />
                  ) : view === "list" ? (
                    <TaskTable
                      tasks={filtered}
                      groups={listGroups}
                      me={user}
                      lookup={nameLookup}
                      today={today}
                      playing={playingTimer}
                      onSelect={setSelected}
                    />
                  ) : view === "board" ? (
                    <div className="board">
                      {listedStatuses
                        .filter((key) => key !== "done" || status === "done")
                        .map((key) => [key, statuses[key]] as const)
                        .map(([key, value]) => (
                          <section className="board-column" key={key}>
                            <h3>
                              <i style={{ background: value.color }} />
                              {value.label}
                              <span>
                                {
                                  filtered.filter((t) => t.status === key)
                                    .length
                                }
                              </span>
                            </h3>
                            {filtered
                              .filter((t) => t.status === key)
                              .map((t) => {
                                const n = namesFrom(nameLookup, t),
                                  playing = activeTimer?.task_id === t.id;
                                return (
                                  <Button
                                    className={`task-card${playing ? " is-playing" : ""}`}
                                    key={t.id}
                                    onClick={() => setSelected(t.id)}
                                  >
                                    <small>
                                      {n.client?.name} · {n.product?.name}
                                    </small>
                                    <h4>{t.title}</h4>
                                    {playing && playingTimer && (
                                      <PlayingBadge playing={playingTimer} />
                                    )}
                                    <footer>
                                      <span
                                        className={
                                          isLate(t, today) ? "late" : ""
                                        }
                                      >
                                        <CalendarDays size={14} />
                                        {dateLabel(t.due_date)}
                                      </span>
                                      <Avatar
                                        name={n.member?.name ?? "?"}
                                        src={n.member?.avatar_url}
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
                    <Suspense fallback={<Loading compact />}>
                      <TaskSchedule
                        view={view as "calendar" | "gantt"}
                        month={scheduleMonth}
                        tasks={filtered}
                        lookup={nameLookup}
                        onSelect={setSelected}
                      />
                    </Suspense>
                  )}
                  {!loading && !filtered.length && view === "board" && (
                    <Empty
                      title="Nenhuma tarefa encontrada"
                      body="Altere os filtros ou crie uma tarefa."
                    />
                  )}
                  {!scheduleView && (
                    <Pagination
                      always
                      page={demo ? 0 : offset}
                      pageCount={demo ? 1 : Math.max(1, Math.ceil(count / 50))}
                      pageSize={50}
                      total={demo ? filtered.length : count}
                      noun={
                        (demo ? filtered.length : count) === 1
                          ? "tarefa"
                          : "tarefas"
                      }
                      disabled={loading}
                      onPage={setOffset}
                    />
                  )}
                </section>
              )}
              {page === "products" && (
                <section className="panel product-catalog">
                  <div className="panel-heading">
                    <h2>Catálogo de produtos</h2>
                    <span>{data.products.length} produtos</span>
                  </div>
                  {!isLeader && (
                    <p className="catalog-note">
                      O cadastro de produtos é feito pelos administradores da
                      agência.
                    </p>
                  )}
                  {data.products.length ? (
                    data.products.map((p) => {
                      const contracts = data.contracts
                        .filter((c) => c.product_id === p.id && !c.archived)
                        .sort((a, b) =>
                          (
                            byId(data.clients).get(a.client_id)?.name ?? ""
                          ).localeCompare(
                            byId(data.clients).get(b.client_id)?.name ?? "",
                            "pt-BR",
                          ),
                        );
                      return (
                        <div className="catalog-row" key={p.id}>
                          <span
                            className="product-dot"
                            style={{ background: p.color }}
                          />
                          <div>
                            <strong>{p.name}</strong>
                            <small>
                              {contracts.length
                                ? `Contratado por ${new Set(contracts.map((c) => c.client_id)).size} cliente(s)`
                                : "Nenhum cliente contratou ainda"}
                            </small>
                            {contracts.length > 0 && (
                              <div className="catalog-clients">
                                <Expandable items={contracts} noun="clientes">
                                  {(shown) =>
                                    shown.map((k) => (
                                      <span key={k.id}>
                                        {
                                          byId(data.clients).get(k.client_id)
                                            ?.name
                                        }
                                      </span>
                                    ))
                                  }
                                </Expandable>
                              </div>
                            )}
                          </div>
                          {isLeader && (
                            <div className="catalog-actions">
                              <Button
                                className="btn secondary"
                                onClick={() =>
                                  setEntityEdit({ kind: "product", entity: p })
                                }
                              >
                                <Pencil size={15} /> Editar
                              </Button>
                              <Button
                                className="btn secondary"
                                onClick={() =>
                                  openForm("contract", { product: p.id })
                                }
                              >
                                <Plus size={16} /> Adicionar a cliente
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <Empty
                      title="Cadastre seu primeiro produto"
                      body="Adicione os serviços oferecidos pela agência, como Make Ads, Make CRM e Social Leads."
                      action={
                        isLeader ? (
                          <Button
                            className="btn primary"
                            onClick={() => openForm("product")}
                          >
                            <Plus size={17} /> Cadastrar produto
                          </Button>
                        ) : undefined
                      }
                    />
                  )}
                </section>
              )}
              {page === "clients" && (
                <ClientPortfolio
                  data={catalogData}
                  canManage={isLeader}
                  projectProgress={projectProgress}
                  onEditClient={(c) =>
                    setEntityEdit({ kind: "client", entity: c })
                  }
                  onArchiveClient={(c, archived) =>
                    void mutate("set_client_archived", {
                      p_client: c.id,
                      p_archived: archived,
                    }).catch(() => {
                      /* mutate shows the error */
                    })
                  }
                  onEditContract={(k) =>
                    setEntityEdit({ kind: "contract", entity: k })
                  }
                  onEditProject={(p) =>
                    setEntityEdit({ kind: "project", entity: p })
                  }
                  onAddContract={(client) => openForm("contract", { client })}
                  onAddProject={(contract) => openForm("project", { contract })}
                  onNewTask={(contract, project) =>
                    openForm("task", { contract, project })
                  }
                  canCreateTask={(contract) =>
                    canCreateTaskIn(data, contract, user)
                  }
                  onViewClient={(id) => {
                    go("tasks");
                    setClientFilter(id);
                  }}
                  onViewProject={(id) => {
                    go("tasks");
                    setProjectFilter(id);
                  }}
                />
              )}
              {page === "projects" && (
                <ProjectsBrowser
                  data={catalogData}
                  today={today}
                  canManage={isLeader}
                  projectProgress={projectProgress}
                  onEditProject={(p) =>
                    setEntityEdit({ kind: "project", entity: p })
                  }
                  onViewProject={(id) => {
                    go("tasks");
                    setProjectFilter(id);
                  }}
                  onNewTask={(contract, project) =>
                    openForm("task", { contract, project })
                  }
                  canCreateTask={(contract) =>
                    canCreateTaskIn(data, contract, user)
                  }
                  onNewProject={(contract) =>
                    openForm("project", contract ? { contract } : {})
                  }
                />
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
                        {activeTimer ? (
                          <LiveDuration entry={activeTimer} />
                        ) : (
                          "Pronto para começar?"
                        )}
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
                        <Square size={15} /> Parar
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
                          {isLeader
                            ? "Os 100 registros mais recentes"
                            : "Seus 100 registros mais recentes"}
                        </p>
                      </div>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Tarefa</th>
                            {isLeader && <th>Pessoa</th>}
                            <th>Data</th>
                            <th>Origem</th>
                            <th>Tempo</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleHours.map((h) => (
                            <tr key={h.id}>
                              <td>
                                {data.tasks.find((t) => t.id === h.task_id)
                                  ?.title ?? "Tarefa fora da seleção atual"}
                                <small className="cell-note">{h.note}</small>
                              </td>
                              {isLeader && (
                                <td>
                                  {
                                    data.members.find(
                                      (m) => m.user_id === h.user_id,
                                    )?.name
                                  }
                                </td>
                              )}
                              <td>
                                {new Date(h.started_at).toLocaleDateString(
                                  "pt-BR",
                                )}
                              </td>
                              <td>
                                {h.source === "timer" ? "Cronômetro" : "Manual"}
                              </td>
                              <td>
                                <strong>
                                  <LiveDuration entry={h} />
                                </strong>
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
                    {!visibleHours.length && (
                      <Empty
                        title="Nenhum apontamento"
                        body="Registre o tempo dedicado às suas tarefas."
                      />
                    )}
                  </section>
                </>
              )}
              {page === "profile" && (
                <ProfilePage
                  data={data}
                  user={user}
                  email={session?.user.email ?? member?.email ?? ""}
                  demo={demo}
                  mutate={mutate}
                  notify={notify}
                />
              )}
              {page === "campaigns" && isAdmin && (
                <CampaignsPage
                  key={company}
                  demo={demo}
                  data={catalogData}
                  company={company}
                  user={user}
                  notify={notify}
                />
              )}
              {page === "drive" && (
                <Drive
                  key={company}
                  demo={demo}
                  data={catalogData}
                  company={company}
                  user={user}
                  isLeader={isLeader}
                  notify={notify}
                />
              )}
              {page === "dashboards" && (isLeader || openDashboard) && (
                <Suspense fallback={<Loading compact />}>
                  <DashboardsPage
                    key={company}
                    data={catalogData}
                    company={company}
                    demo={demo}
                    isLeader={isLeader}
                    user={user}
                    notify={notify}
                    dashboardId={openDashboard}
                    onOpen={(id) =>
                      navigate(
                        id
                          ? `${pageUrl("dashboards", companyPath)}/${id}`
                          : pageUrl("dashboards", companyPath),
                      )
                    }
                    internalUrl={(id) =>
                      `${window.location.origin}${pageUrl("dashboards", companyPath)}/${id}`
                    }
                  />
                </Suspense>
              )}
              {page === "storage" && isLeader && (
                <StoragePage
                  key={company}
                  demo={demo}
                  data={catalogData}
                  company={company}
                  notify={notify}
                />
              )}
              {page === "reports" && (
                <Suspense fallback={<Loading compact />}>
                  <Reports
                    avatarOf={(id) =>
                      data.members.find((m) => m.user_id === id)?.avatar_url
                    }
                    byClient={byClient}
                    byPerson={reportPeople}
                    personal={!isLeader}
                  />
                </Suspense>
              )}
              {page === "settings" && !isLeader && (
                <Empty
                  title="Área administrativa"
                  body="Esta área está disponível apenas para administradores e gestores."
                />
              )}
              {page === "settings" && isLeader && (
                <>
                  <div className="settings-grid">
                    <section className="panel" id="config-pessoas">
                      <div className="panel-heading">
                        <div>
                          <h2>Pessoas do espaço</h2>
                          <p>Perfis e vínculos ativos</p>
                        </div>
                        {isLeader && (
                          <Button
                            className="btn secondary"
                            aria-label="Convidar usuário"
                            onClick={() => openForm("user")}
                          >
                            <UserPlus size={17} /> Convidar usuário
                          </Button>
                        )}
                      </div>
                      <Paged
                        items={data.members}
                        pageSize={25}
                        noun="pessoas"
                        className=""
                      >
                        {(page) =>
                          page.map((m) => (
                            <div className="member-row" key={m.user_id}>
                              <span className="online-avatar">
                                <Avatar name={m.name} src={m.avatar_url} />
                                <PresenceDot
                                  state={presence.get(m.user_id)?.state}
                                />
                              </span>
                              <div className="member-info">
                                <strong>{m.name}</strong>
                                {m.email && (
                                  <span className="member-email">
                                    {m.email}
                                  </span>
                                )}
                              </div>
                              <span className="role-tag">
                                {m.role === "admin"
                                  ? "Administrador"
                                  : m.role === "manager"
                                    ? "Gestor"
                                    : "Colaborador"}
                              </span>
                              <span>{m.active ? "Ativo" : "Inativo"}</span>
                              {isLeader && (
                                <div className="member-actions">
                                  {(isAdmin || m.role !== "admin") && (
                                    <Button
                                      className="icon-btn"
                                      title="Editar usuário"
                                      aria-label={`Editar ${m.name}`}
                                      onClick={() => setEditMember(m)}
                                    >
                                      <Pencil size={15} />
                                    </Button>
                                  )}
                                  <Button
                                    className="icon-btn"
                                    title="Redefinir senha"
                                    aria-label={`Redefinir senha de ${m.name}`}
                                    onClick={() => setResetPasswordMember(m)}
                                  >
                                    <KeyRound size={15} />
                                  </Button>
                                  <Button
                                    className="icon-btn"
                                    title="Alterar e-mail"
                                    aria-label={`Alterar e-mail de ${m.name}`}
                                    onClick={() => setUpdateEmailMember(m)}
                                  >
                                    <Mail size={15} />
                                  </Button>
                                </div>
                              )}
                            </div>
                          ))
                        }
                      </Paged>
                      <div className="panel-footer">
                        <small>
                          {data.members.length}{" "}
                          {data.members.length === 1
                            ? "membro cadastrado"
                            : "membros cadastrados"}{" "}
                          · Convites enviados com link seguro de primeiro
                          acesso.
                        </small>
                      </div>
                    </section>
                    <section className="panel" id="config-produtos">
                      <div className="panel-heading">
                        <h2>Catálogo de produtos</h2>
                        {isLeader && (
                          <Button
                            className="btn secondary"

                            aria-label="Novo produto"
                            onClick={() => openForm("product")}
                          >
                            <Plus size={17} /> Novo produto
                          </Button>
                        )}
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
                    <section className="panel" id="config-equipes">
                      <div className="panel-heading">
                        <h2>Equipes</h2>
                        {isLeader && (
                          <Button
                            className="btn secondary"
                            aria-label="Nova equipe"
                            onClick={() => openForm("team")}
                          >
                            <Plus size={17} /> Nova equipe
                          </Button>
                        )}
                      </div>
                      {data.teams.map((t) => (
                        <div className="team-config" key={t.id}>
                          <div className="team-config-info">
                            <strong>{t.name}</strong>
                            <small>
                              <ShieldCheck size={12} />{" "}
                              {data.teamMembers
                                .filter(
                                  (tm) => tm.team_id === t.id && tm.supervisor,
                                )
                                .map(
                                  (tm) =>
                                    data.members.find(
                                      (m) => m.user_id === tm.user_id,
                                    )?.name,
                                )
                                .filter(Boolean)
                                .join(", ") || "Sem supervisor"}
                            </small>
                          </div>
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
                                  src={
                                    data.members.find(
                                      (m) => m.user_id === tm.user_id,
                                    )?.avatar_url
                                  }
                                  size="small"
                                />
                              ))}
                          </div>
                          {isLeader && (
                            <Button
                              className="icon-btn"
                              aria-label={`Editar equipe ${t.name}`}
                              title="Editar equipe"
                              onClick={() => openForm("team", { team: t.id })}
                            >
                              <Pencil size={15} />
                            </Button>
                          )}
                        </div>
                      ))}
                    </section>
                    <TaskTemplatesPanel
                      data={data}
                      company={company}
                      mutate={mutate}
                      notify={notify}
                    />
                    <SuggestionSettingsPanel
                      key={data.suggestionSettings?.[0]?.team_id ?? "none"}
                      data={data}
                      company={company}
                      mutate={mutate}
                      notify={notify}
                    />
                  </div>
                </>
              )}
            </>
          )}
          <footer className="app-footer">
            <span>
              Workspace <span>·</span> Gestão de trabalho
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
      {entityEdit && isLeader && (
        <EditEntityForm
          edit={entityEdit}
          data={data}
          busy={busy}
          mutate={mutate}
          onClose={() => setEntityEdit(null)}
        />
      )}
      {form === "team" ? (
        <TeamForm
          team={data.teams.find((t) => t.id === formPreset.team)}
          data={data}
          company={company}
          busy={busy}
          mutate={mutate}
          onClose={() => setForm(null)}
        />
      ) : form === "suggestion" ? (
        <SuggestionDialog
          demo={demo}
          data={data}
          company={company}
          isLeader={isLeader}
          busy={busy}
          mutate={mutate}
          notify={notify}
          onConfigure={() =>
            openNav({ page: "settings", hash: "config-sugestoes" })
          }
          onClose={() => setForm(null)}
        />
      ) : form === "task" ? (
        <TaskCreateForm
          initialContract={formPreset.contract}
          initialProject={formPreset.project}
          demo={demo}
          data={data}
          company={company}
          user={user}
          busy={busy}
          mutate={mutate}
          onClose={() => setForm(null)}
        />
      ) : (
        form && (
          <CreateForm
            kind={form}
            preset={formPreset}
            data={data}
            company={company}
            busy={busy}
            mutate={mutate}
            onClose={() => setForm(null)}
          />
        )
      )}
      {editMember && isLeader && (
        <MemberForm
          member={editMember}
          data={data}
          company={company}
          currentUser={user}
          callerIsAdmin={isAdmin}
          busy={busy}
          mutate={mutate}
          syncAccess={
            demo ? undefined : (id) => api.syncUserAccess(company, id)
          }
          onClose={() => setEditMember(null)}
        />
      )}
      {resetPasswordMember && (
        <ResetPasswordModal
          member={resetPasswordMember}
          busy={busy}
          onSubmit={async (mode, newPassword) => {
            await handleResetPassword(resetPasswordMember, mode, newPassword);
          }}
          onClose={() => setResetPasswordMember(null)}
        />
      )}
      {updateEmailMember && (
        <UpdateEmailModal
          member={updateEmailMember}
          busy={busy}
          onSubmit={async (newEmail) => {
            await handleUpdateEmail(updateEmailMember, newEmail);
          }}
          onClose={() => setUpdateEmailMember(null)}
        />
      )}
      {selected && !selectedTask && (detailLoading || detailError) && (
        <Modal
          title="Detalhes da tarefa"
          onClose={() => setSelected(null)}
          wide
        >
          {detailLoading ? (
            <Loading />
          ) : (
            <Empty title="Tarefa indisponível" body={detailError} />
          )}
        </Modal>
      )}
      {selectedTask && (
        <TaskDetail
          key={selectedTask.id}
          task={selectedTask}
          currentRunning={currentRunning}
          data={data}
          user={user}
          busy={busy}
          demo={demo}
          demoStore={demoStore.current}
          refresh={refresh + extrasTick}
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
/**
 * "Instalar app": the browser's install dialog where supported (Chrome,
 * Edge, Android), or the Share → Add to Home Screen steps on iPhone/iPad.
 * Hidden once installed or where installing isn't possible.
 */
function InstallApp({ notify }: { notify: (s: string) => void }) {
  const { mode, install } = useInstall();
  const [steps, setSteps] = useState(false);
  if (!mode) return null;
  return (
    <>
      <Button
        className="install-app"
        title="Instalar o Workspace como aplicativo"
        onClick={() =>
          mode === "ios"
            ? setSteps(true)
            : void install().then((ok) => ok && notify("Aplicativo instalado."))
        }
      >
        <MonitorDown size={16} />
        <span>Instalar app</span>
      </Button>
      {steps && (
        <Modal
          title="Instalar no iPhone ou iPad"
          onClose={() => setSteps(false)}
        >
          <ol className="install-steps">
            <li>
              Toque em <strong>Compartilhar</strong>{" "}
              <Share size={15} aria-label="(ícone de compartilhar)" /> na barra
              do Safari.
            </li>
            <li>
              Escolha <strong>Adicionar à Tela de Início</strong>.
            </li>
            <li>
              Confirme em <strong>Adicionar</strong>. O Workspace abre como um
              app, em tela cheia.
            </li>
          </ol>
        </Modal>
      )}
    </>
  );
}
/** The user's running timer, as the task list needs it to mark its task. */
type Playing = {
  entry: TimeEntry;
  hours: TimeEntry[];
  company: string;
  demo: boolean;
};
/** Live total time of the task being played (every session, not just this one). */
function TaskTotal({ playing }: { playing: Playing }) {
  const seconds = useTaskSeconds({
    company: playing.company,
    taskId: playing.entry.task_id,
    hours: playing.hours,
    running: playing.entry,
    demo: playing.demo,
  });
  return <>{durationWithSeconds(seconds)}</>;
}
/** Marks the task whose timer the user is running, with the task's total time. */
function PlayingBadge({ playing }: { playing: Playing }) {
  return (
    <span className="playing-badge" title="Seu cronômetro está nesta tarefa">
      <span className="playing-pulse" aria-hidden="true" />
      Em execução · <TaskTotal playing={playing} />
    </span>
  );
}
type TaskGroup = { key: string; label: string; hint: string; tasks: Task[] };
function TaskTable({
  tasks,
  groups,
  me,
  lookup,
  today,
  playing,
  onSelect,
}: {
  tasks: Task[];
  /** Sections (e.g. "Para você", "Suas equipes"); none renders one list. */
  groups?: TaskGroup[];
  /** The viewer: their own tasks and creations are marked "Você". */
  me?: string;
  lookup: NameLookup;
  today: string;
  /** The user's running timer, marked on its task. */
  playing?: Playing | null;
  onSelect: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setCollapsed((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const row = (t: Task) => {
    const n = namesFrom(lookup, t),
      creator = lookup.members.get(t.creator_id),
      isPlaying = playing?.entry.task_id === t.id,
      mineToDo = !!me && t.assignee_id === me,
      mineCreated = !!me && t.creator_id === me;
    return (
      <tr key={t.id} className={isPlaying ? "is-playing" : undefined}>
        <td>
          <Button className="task-title" onClick={() => onSelect(t.id)}>
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
              {isPlaying && playing && <PlayingBadge playing={playing} />}
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
          <span className="task-person" title={n.member?.name}>
            <Avatar
              name={n.member?.name ?? "?"}
              src={n.member?.avatar_url}
              size="small"
            />
            {mineToDo ? (
              <span className="you-tag">Você</span>
            ) : (
              <span className="task-person-name">
                {n.member?.name?.split(" ")[0]}
              </span>
            )}
          </span>
        </td>
        <td className="col-creator">
          <span className="task-person">
            <Avatar
              name={creator?.name ?? "?"}
              src={creator?.avatar_url}
              size="small"
            />
            {mineCreated ? (
              <span className="you-tag">Você</span>
            ) : (
              (creator?.name ?? "Usuário removido")
            )}
          </span>
        </td>
      </tr>
    );
  };
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
              <th className="col-creator">Criado por</th>
            </tr>
          </thead>
          {groups ? (
            groups.map((g) => {
              const closed = collapsed.has(g.key);
              return (
                <tbody key={g.key} className="task-group">
                  <tr className="task-group-head">
                    <th colSpan={5} scope="rowgroup">
                      <button
                        type="button"
                        aria-expanded={!closed}
                        onClick={() => toggle(g.key)}
                      >
                        <ChevronRight
                          size={15}
                          className={closed ? "" : "open"}
                          aria-hidden="true"
                        />
                        <strong>{g.label}</strong>
                        <span className="task-group-count">
                          {g.tasks.length}
                        </span>
                        <small>{g.hint}</small>
                      </button>
                    </th>
                  </tr>
                  {!closed && g.tasks.map(row)}
                </tbody>
              );
            })
          ) : (
            <tbody>{tasks.map(row)}</tbody>
          )}
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
const DEACTIVATED =
  "Seu acesso foi desativado. Fale com o administrador da sua empresa.";
function Login({
  onDemo,
  notify,
  notice = "",
}: {
  onDemo: () => void;
  notify: (s: string) => void;
  /** Why the person was signed out (e.g. their access was deactivated). */
  notice?: string;
}) {
  const [error, setError] = useState(notice),
    [busy, setBusy] = useState(false),
    [mode, setMode] = useState<"login" | "forgot" | "sent">("login"),
    [email, setEmail] = useState(""),
    [cooldown, setCooldown] = useState(0);
  // Supabase refuses a second recovery email within 60 s; the resend button
  // waits it out instead of failing.
  useEffect(() => {
    if (!cooldown) return;
    const id = setTimeout(() => setCooldown((v) => v - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);
  function switchMode(next: typeof mode) {
    setError("");
    setMode(next);
  }
  async function sendReset(e?: FormEvent<HTMLFormElement>) {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      await requestPasswordReset(email);
      setMode("sent");
      setCooldown(60);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  // The demo is no longer offered on the login page; local development can
  // still open it with /login?demo=1 (stripped from production builds).
  useEffect(() => {
    if (
      import.meta.env.DEV &&
      new URLSearchParams(window.location.search).has("demo")
    )
      onDemo();
  }, [onDemo]);
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
      if (error)
        throw error.code === "user_banned" || /banned/i.test(error.message)
          ? Error(DEACTIVATED)
          : error;
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
          <span className="brand-mark">W</span>
          <span>
            workspace<span className="brand-period">.</span>
          </span>
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
        {mode === "login" ? (
          <>
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
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
              {/* The link sits beside the label, not inside it: a button in a
                  <label> would take over its clicks. */}
              <div className="login-password">
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
                <button
                  type="button"
                  className="login-link login-forgot"
                  onClick={() => switchMode("forgot")}
                >
                  Esqueci minha senha
                </button>
              </div>
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
            <small>
              Acesso por convite. Entre em contato com seu administrador.
            </small>
          </>
        ) : mode === "forgot" ? (
          <>
            <h2>Esqueceu a senha?</h2>
            <p>
              Informe o e-mail do seu acesso. Enviaremos um link para você criar
              uma nova senha.
            </p>
            <form onSubmit={sendReset}>
              <label>
                E-mail
                <Input
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="voce@agencia.com.br"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  required
                />
              </label>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <Button className="btn primary" disabled={busy} loading={busy}>
                Enviar link de recuperação
                <ArrowRight size={17} />
              </Button>
            </form>
            <button
              type="button"
              className="login-link login-back"
              onClick={() => switchMode("login")}
            >
              <ArrowLeft size={15} /> Voltar para o login
            </button>
          </>
        ) : (
          <>
            <h2>Confira seu e-mail.</h2>
            <p role="status">
              Se houver um acesso com <strong>{email.trim()}</strong>, você
              receberá um link para criar uma nova senha. Se não chegar em
              alguns minutos, olhe também a caixa de spam.
            </p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <Button
              className="btn secondary"
              disabled={busy || cooldown > 0}
              loading={busy}
              onClick={() => void sendReset()}
            >
              {cooldown > 0 ? `Reenviar em ${cooldown}s` : "Reenviar link"}
            </Button>
            <button
              type="button"
              className="login-link login-back"
              onClick={() => switchMode("login")}
            >
              <ArrowLeft size={15} /> Voltar para o login
            </button>
          </>
        )}
        <div className="login-install">
          <InstallApp notify={notify} />
        </div>
      </div>
    </div>
  );
}

function SetPassword({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  // "Esqueci minha senha" links land on /?reset=1; invites use ?setup=1.
  const [recovery] = useState(() =>
    new URLSearchParams(window.location.search).has("reset"),
  );
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
        <h2>{recovery ? "Crie uma nova senha" : "Defina sua senha"}</h2>
        <p>
          {recovery
            ? "Escolha uma senha com pelo menos 12 caracteres."
            : "Conclua seu acesso ao espaço de trabalho."}
        </p>
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
