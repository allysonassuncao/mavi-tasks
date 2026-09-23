import { calendarDays, monthRange } from "./schedule";
import { EditEntityForm, type EntityEdit } from "./EditEntityForm";
import { taskIdFromPath, taskUrl } from "./router";
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
  CheckCheck,
  Users,
  FolderKanban,
  Clock3,
  ChartNoAxesCombined,
  HardDrive,
  Bell,
  BellOff,
  BellRing,
  Settings2,
  Search,
  Plus,
  ArrowUpRight,
  ChevronRight,
  ChevronLeft,
  ChevronsUpDown,
  ChevronsLeft,
  ChevronsRight,
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
  taskMatchesSearch,
  upsertById,
  initials,
  type NameLookup,
} from "./domain";
import { useNow } from "./useClock";
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
import { ProfilePage } from "./ProfilePage";
import { MemberForm } from "./MemberForm";
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

const navigation = [
  { id: "overview", label: "Visão geral", icon: LayoutDashboard },
  { id: "tasks", label: "Tarefas", icon: CheckCheck },
  { id: "clients", label: "Clientes", icon: Users },
  { id: "products", label: "Produtos", icon: Package },
  { id: "projects", label: "Projetos", icon: FolderKanban },
  { id: "hours", label: "Controle de horas", icon: Clock3 },
  { id: "reports", label: "Relatórios", icon: ChartNoAxesCombined },
  { id: "drive", label: "Drive", icon: HardDrive },
] as const;
// Mutations that return the affected row (see the RPCs in
// supabase/migrations/20260921120000_performance_optimizations.sql) patch
// local state directly instead of forcing a full snapshot refetch — the task
// list and dashboards no longer flash a loading state for a one-row change.
const TASK_ROW_MUTATIONS = new Set(["transition_task", "update_task"]);
const TIMER_ROW_MUTATIONS = new Set(["start_timer", "stop_timer"]);
const SELF_HANDLED_MUTATIONS = new Set(["add_comment"]);
// Collaborators see these modules scoped to them: clients/projects they serve
// (read-only, plus creating tasks) and only their own hours and reports.
const MEMBER_PAGES: readonly Page[] = [
  "tasks",
  "clients",
  "projects",
  "hours",
  "reports",
  "drive",
  "profile",
];
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
  const demoStore = useRef(new DemoStore());
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
    [mine, setMine] = useUrlState<boolean>("minhas", false),
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
    [reportRefresh, setReportRefresh] = useState(0);
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
  const today = dateKey(new Date(), currentCompany?.timezone);
  const [periodValue, setPeriod] = useUrlState<string>("periodo", "");
  const [currentRunning, setCurrentRunning] = useState<
    import("./types").TimeEntry | null
  >(null);
  const activeTimer = currentRunning;
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
  }, [demo, session, user, refresh]);
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
            (!isLeader && t.assignee_id !== user && t.creator_id !== user)
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
  }, [selected, company, demo, session, refresh, isLeader, user]);
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
    if (!isLeader && page && !MEMBER_PAGES.includes(page)) {
      navigate(pageUrl("tasks", companyPath), true);
    }
  }, [authReady, member, isLeader, page, companyPath, isLogin]);
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
        : demoData.tasks.filter(
            (t) => t.assignee_id === user || t.creator_id === user,
          );
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
          mine: page === "tasks" ? mine : false,
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
    mine,
    user,
    offset,
    late,
    clientFilter,
    projectFilter,
    refresh,
    isLeader,
    page === "tasks",
    page === "tasks" ? view : "list",
    page === "tasks" ? scheduleMonth : "",
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
  const live = useRef({ user, openTask: setSelected });
  live.current = { user, openTask: setSelected };
  // Realtime subscription: automatically detects changes from other users/tabs and updates cache & state
  useEffect(() => {
    if (!company || demo || !session) return;
    const unsubscribe = api.subscribeToCompanyChanges(company, {
      onTaskChange: (task, eventType) => {
        const me = live.current.user;
        if (
          eventType === "INSERT" &&
          task.assignee_id === me &&
          task.creator_id !== me
        ) {
          notify(`Nova tarefa para você: ${task.title}`);
          showNotification("Nova tarefa para você", {
            body: `${task.title} · prazo ${dateLabel(task.due_date)}`,
            tag: task.id,
            onClick: () => live.current.openTask(task.id),
          });
        }
        if (eventType === "INSERT") {
          setData((d) =>
            d.tasks.some((t) => t.id === task.id)
              ? d
              : { ...d, tasks: [task, ...d.tasks] },
          );
        } else if (eventType === "UPDATE") {
          setData((d) => ({
            ...d,
            tasks: d.tasks.map((t) => (t.id === task.id ? task : t)),
          }));
          setDetailTask((t) => (t && t.id === task.id ? task : t));
        } else if (eventType === "DELETE") {
          setData((d) => ({
            ...d,
            tasks: d.tasks.filter((t) => t.id !== task.id),
          }));
          setDetailTask((t) => (t && t.id === task.id ? null : t));
        }
        setReportRefresh((v) => v + 1);
      },
      onLookupChange: () => {
        api
          .companyLookups(company, true)
          .then((lookups) => {
            setData((d) => ({ ...d, ...lookups }));
          })
          .catch(() => {});
      },
      onHoursChange: (entry, eventType) => {
        if (eventType !== "DELETE") {
          setData((d) => ({ ...d, hours: upsertById(d.hours, entry) }));
        } else {
          setData((d) => ({
            ...d,
            hours: d.hours.filter((h) => h.id !== entry.id),
          }));
        }
        setReportRefresh((v) => v + 1);
      },
      onTaskExtrasChange: (taskId) => {
        if (selected === taskId) {
          setRefresh((v) => v + 1);
        }
      },
    });
    return unsubscribe;
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
        api.patchCachedTask(company, updated);
        api.invalidateTaskExtras(updated.id);
        setReportRefresh((v) => v + 1);
      } else if (TIMER_ROW_MUTATIONS.has(name) && result) {
        const entry = result as TimeEntry;
        setCurrentRunning(entry.ended_at ? null : entry);
        setData((d) => ({ ...d, hours: upsertById(d.hours, entry) }));
        api.patchCachedHours(company, entry);
      } else if (name === "add_comment" && args.p_task) {
        api.invalidateTaskExtras(args.p_task as string);
      } else if (!SELF_HANDLED_MUTATIONS.has(name)) {
        if (name === "create_task" && result) {
          const newTask = await api.taskById(company, result as string, true);
          if (newTask) {
            api.addCachedTask(company, newTask);
            setData((d) => ({
              ...d,
              tasks: [newTask, ...d.tasks.filter((t) => t.id !== newTask.id)],
            }));
          }
          setReportRefresh((v) => v + 1);
        } else if (
          name.startsWith("create_client") ||
          name.startsWith("update_client") ||
          name.startsWith("create_product") ||
          name.startsWith("update_product") ||
          name.startsWith("create_contract") ||
          name.startsWith("update_contract") ||
          name.startsWith("create_project") ||
          name.startsWith("update_project") ||
          name.startsWith("create_team") ||
          name.startsWith("update_team") ||
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
  async function logout() {
    api.clearAllCaches();
    if (demo) {
      setDemo(false);
      setData(emptySnapshot);
      navigate("/login", true);
      return;
    }
    try {
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
  const filtered = useMemo(
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
          (!mine || t.assignee_id === user) &&
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
      mine,
      user,
      late,
      today,
      product,
    ],
  );
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
        <span className="nav-label">PRINCIPAL</span>
        <nav aria-label="Navegação principal">
          {navigation
            .filter((item) => isLeader || MEMBER_PAGES.includes(item.id))
            .map((item) => (
              <a
                key={item.id}
                href={pageUrl(item.id, companyPath)}
                aria-current={page === item.id ? "page" : undefined}
                className={page === item.id ? "active" : ""}
                title={item.label}
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
          {data.products
            .filter(
              (p) =>
                isLeader ||
                data.tasks.some((t) => {
                  const contract = data.contracts.find(
                    (c) => c.id === t.contract_id,
                  );
                  return contract?.product_id === p.id;
                }),
            )
            .map((p) => (
              <Button
                key={p.id}
                title={p.name}
                onClick={() => {
                  go("tasks");
                  setProduct(p.id);
                }}
              >
                <span className="product-dot" style={{ background: p.color }} />
                <span className="sidebar-text">{p.name}</span>
                <ChevronRight size={13} />
              </Button>
            ))}
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
          {isLeader && (
            <a
              className={
                page === "settings" ? "settings-link active" : "settings-link"
              }
              href={pageUrl("settings", companyPath)}
              aria-current={page === "settings" ? "page" : undefined}
              title="Equipe e configurações"
              onClick={(event) => followLink(event, "settings")}
            >
              <Settings2 size={18} />{" "}
              <span className="sidebar-text">Equipe e configurações</span>
            </a>
          )}
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
                : (navigation.find((n) => n.id === page)?.label ??
                  "Configurações")}
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
                <LiveDuration entry={activeTimer} />
              </Button>
            )}
            {notifications !== "unsupported" && (
              <Button
                className={`notify-toggle ${notifications}`}
                disabled={notifications === "denied"}
                aria-pressed={notifications === "on"}
                title={
                  {
                    default:
                      "Receber um aviso quando uma tarefa for criada para você",
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
            <span className="online-label">
              <span /> {demo ? "Demonstração" : "Conectado"}
            </span>
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
                      "Cada cliente com os produtos que contratou e os projetos de cada um.",
                    products:
                      "O catálogo do que a agência vende. Adicione cada produto aos clientes que o contrataram.",
                    contracts:
                      "Serviços ativos de cada cliente. Cada serviço pode ter projetos e tarefas avulsas.",
                    projects:
                      "Campanhas e entregas com começo e fim, organizadas por cliente.",
                    hours: "Seu tempo, registrado com clareza.",
                    drive:
                      "Arquivos da equipe, privados ou compartilhados por link.",
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
              {!isLeader && page && !MEMBER_PAGES.includes(page) && (
                <Empty
                  title="Acesso restrito"
                  body="Esta área é exclusiva de administradores e gestores. Redirecionando..."
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
                      lookup={nameLookup}
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
                      lookup={nameLookup}
                      today={today}
                      onSelect={setSelected}
                    />
                  ) : view === "board" ? (
                    <div className="board">
                      {Object.entries(statuses)
                        .filter(([key]) => key !== "done" || status === "done")
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
                                const n = namesFrom(nameLookup, t);
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
                    <div className="pagination">
                      <span>
                        {demo ? filtered.length : count} tarefas ·{" "}
                        {demo ? "demonstração" : `página ${offset + 1}`}
                      </span>
                      <div>
                        <Button
                          className="icon-btn"
                          disabled={loading || offset === 0 || demo}
                          aria-label="Página anterior"
                          onClick={() => setOffset((v) => v - 1)}
                        >
                          <ChevronLeft size={18} />
                        </Button>
                        <Button
                          className="icon-btn"
                          disabled={
                            loading || demo || (offset + 1) * 50 >= count
                          }
                          aria-label="Próxima página"
                          onClick={() => setOffset((v) => v + 1)}
                        >
                          <ChevronRight size={18} />
                        </Button>
                      </div>
                    </div>
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
                      const contracts = data.contracts.filter(
                        (c) => c.product_id === p.id && !c.archived,
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
                                {contracts.map((k) => (
                                  <span key={k.id}>
                                    {
                                      data.clients.find(
                                        (c) => c.id === k.client_id,
                                      )?.name
                                    }
                                  </span>
                                ))}
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
                    <section className="panel">
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
                      {data.members.map((m) => (
                        <div className="member-row" key={m.user_id}>
                          <Avatar name={m.name} src={m.avatar_url} />
                          <div className="member-info">
                            <strong>{m.name}</strong>
                            {m.email && (
                              <span className="member-email">{m.email}</span>
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
                      ))}
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
                    <section className="panel">
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
                    <section className="panel">
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
  lookup,
  today,
  onSelect,
}: {
  tasks: Task[];
  lookup: NameLookup;
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
              const n = namesFrom(lookup, t);
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
                    <Avatar
                      name={n.member?.name ?? "?"}
                      src={n.member?.avatar_url}
                      size="small"
                    />
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
    [busy, setBusy] = useState(false);
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
