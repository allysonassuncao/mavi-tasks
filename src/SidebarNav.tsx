import { useState, type MouseEvent, type ReactNode } from "react";
import {
  CalendarDays,
  ChartNoAxesCombined,
  CheckCheck,
  ChevronDown,
  Clock3,
  Database,
  FolderKanban,
  GraduationCap,
  HeartHandshake,
  HardDrive,
  LayoutDashboard,
  PanelsTopLeft,
  Megaphone,
  Package,
  Radar,
  BotMessageSquare,
  Rocket,
  Settings2,
  Sparkles,
  Thermometer,
  Trophy,
  BellRing,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { aiTab, settingsTab, type Page } from "./router";
import type { Product } from "./types";

/** A place in the app: a page, optionally with filters (query) or a section (hash). */
export type NavTarget = {
  page: Page;
  query?: Record<string, string>;
  hash?: string;
};
type Leaf = {
  key: string;
  label: string;
  to: NavTarget;
  dot?: string;
  count?: number;
};
type Item = Leaf & {
  icon: LucideIcon;
  count?: number;
  children?: (Leaf | { heading: string })[];
};
type Group = { label?: string; items: Item[] };

const OPEN_KEY = "mavi:sidebar-open";
function readOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}");
  } catch {
    return {};
  }
}
/** Products listed under Tarefas before "Ver todos". */
const PRODUCTS_SHOWN = 8;

/**
 * The main menu, grouped by what people do: the overview and the MAVI chat
 * on top, work (tasks, campaigns), files
 * and analyses, and administration (clients, products, projects, hours,
 * team and settings, storage). Collaborators, who have no administration,
 * find their clients, projects and hours under work. Tasks and settings
 * open submenus with shortcuts (views of the task list, sections of the
 * settings page); a submenu opens by itself when one of its places is
 * current, and remembers being opened or closed by hand.
 */
export function SidebarNav({
  page,
  params,
  isLeader,
  isAdmin = false,
  allowed,
  taskCount,
  caseCount,
  skillCount,
  noticeCount,
  personalRadarCount,
  tutorialCount,
  csAccess = false,
  products,
  href,
  onNavigate,
}: {
  page: Page;
  /** The current URL's filters (escopo, atrasadas, produto…). */
  params: URLSearchParams;
  isLeader: boolean;
  /** Administrators also configure the AI providers. */
  isAdmin?: boolean;
  /** Pages the person may open. */
  allowed: (page: Page) => boolean;
  taskCount?: number;
  /** Leaders: cases and edits waiting for their approval. */
  caseCount?: number;
  /** Leaders: MAVI skills waiting for their approval. */
  skillCount?: number;
  /** Avisos do Mural no ar que a pessoa ainda não viu. */
  noticeCount?: number;
  /** Radar › Pessoal: as situações em aberto da pessoa. */
  personalRadarCount?: number;
  /** Tutoriais: as trilhas obrigatórias que a pessoa ainda não concluiu. */
  tutorialCount?: number;
  /** Customer Success: líderes e quem está num squad (cs_ai_access). */
  csAccess?: boolean;
  products: Pick<Product, "id" | "name" | "color">[];
  href: (to: NavTarget) => string;
  onNavigate: (to: NavTarget) => void;
}) {
  const [open, setOpen] = useState(readOpen);
  function toggle(key: string, next: boolean) {
    const value = { ...open, [key]: next };
    setOpen(value);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(value));
    } catch {
      // Remembering open submenus is a convenience; ignore blocked storage.
    }
  }

  const tasks = (query: Record<string, string> = {}): NavTarget => ({
    page: "tasks",
    query,
  });
  // Where leaders manage the portfolio and hours; collaborators use them as
  // part of their work.
  const portfolio: Item[] = [
    { key: "clients", label: "Clientes", icon: Users, to: { page: "clients" } },
    {
      key: "products",
      label: "Produtos",
      icon: Package,
      to: { page: "products" },
    },
    {
      key: "projects",
      label: "Projetos",
      icon: FolderKanban,
      to: { page: "projects" },
    },
    {
      key: "hours",
      label: "Controle de horas",
      icon: Clock3,
      to: { page: "hours" },
    },
  ];
  const groups: Group[] = [
    {
      items: [
        {
          key: "overview",
          label: "Visão geral",
          icon: LayoutDashboard,
          to: { page: "overview" },
        },
        {
          key: "mavi",
          label: "MAVI",
          icon: Sparkles,
          to: { page: "mavi" },
          count: skillCount,
          children: [
            { key: "mavi-chat", label: "Conversas", to: { page: "mavi" } },
            { key: "mavi-skills", label: "Skills", to: { page: "skills" } },
            { key: "mavi-connections", label: "Conexões", to: { page: "connections" } },
            { key: "mavi-identities", label: "Identidades", to: { page: "identities" } },
          ],
        },
        {
          key: "notices",
          label: "Mural",
          icon: BellRing,
          to: { page: "notices" },
          count: noticeCount,
        },
      ],
    },
    {
      label: "Trabalho",
      items: [
        {
          key: "tasks",
          label: "Tarefas",
          icon: CheckCheck,
          to: tasks(),
          count: taskCount,
          children: [
            // "Tarefas" reopens the last filters; a shortcut, its own.
            {
              key: "tasks-mine",
              label: "Para você",
              to: tasks({ escopo: "mine" }),
            },
            {
              key: "tasks-created",
              label: "Criadas por você",
              to: tasks({ escopo: "created" }),
            },
            {
              key: "tasks-participating",
              label: "Participando",
              to: tasks({ escopo: "participating" }),
            },
            {
              key: "tasks-late",
              label: "Atrasadas",
              to: tasks({ atrasadas: "1" }),
            },
            {
              key: "tasks-search",
              label: "Busca avançada",
              to: { page: "search" },
            },
            ...(products.length
              ? [
                  { heading: "Por produto" },
                  ...products.slice(0, PRODUCTS_SHOWN).map((p) => ({
                    key: `tasks-product-${p.id}`,
                    label: p.name,
                    dot: p.color,
                    to: tasks({ produto: p.id }),
                  })),
                  ...(products.length > PRODUCTS_SHOWN && isLeader
                    ? [
                        {
                          key: "tasks-products-all",
                          label: `Ver todos os ${products.length} produtos`,
                          to: { page: "products" } as NavTarget,
                        },
                      ]
                    : []),
                ]
              : []),
          ],
        },
        {
          key: "agenda",
          label: "Agenda",
          icon: CalendarDays,
          to: { page: "agenda" },
        },
        {
          key: "campaigns",
          label: "Campanhas",
          icon: Megaphone,
          to: { page: "campaigns" },
        },
        {
          key: "finance",
          label: "Financeiro",
          icon: Wallet,
          // Opens the first of its modules the person has.
          to: {
            page:
              allowed("financeMedia") || !allowed("financeMakeAdsRq")
                ? "financeMedia"
                : "financeMakeAdsRq",
          },
          children: [
            { key: "finance-media", label: "Mídia", to: { page: "financeMedia" } },
            { key: "finance-make-ads-rq", label: "Make Ads RQ", to: { page: "financeMakeAdsRq" } },
          ],
        },
        {
          key: "onboarding",
          label: "Planejamento",
          icon: Rocket,
          // Opens the first of its modules the person has.
          to: {
            page:
              allowed("onboarding") || !allowed("socialMedia")
                ? "onboarding"
                : "socialMedia",
          },
          children: [
            {
              key: "onboarding-social-leads",
              label: "Social Leads",
              to: { page: "onboarding" },
            },
            {
              key: "onboarding-social-media",
              label: "Social Media",
              to: { page: "socialMedia" },
            },
          ],
        },
        {
          key: "cases",
          label: "Cases de Sucesso",
          icon: Trophy,
          to: { page: "cases" },
          count: caseCount,
        },
        {
          key: "temperature",
          label: "Termômetro",
          icon: Thermometer,
          to: { page: "temperature" },
        },
        {
          key: "radar",
          label: "Radar",
          icon: Radar,
          // Opens the first of its modules the person has.
          to: { page: allowed("radar") || !allowed("personalRadar") ? "radar" : "personalRadar" },
          // As situações em aberto do Radar pessoal, também no item principal.
          count: personalRadarCount,
          children: [
            { key: "radar-client", label: "Do cliente", to: { page: "radar" } },
            { key: "radar-personal", label: "Pessoal", to: { page: "personalRadar" }, count: personalRadarCount },
          ],
        },
        {
          key: "agents",
          label: "Agente Conversacional",
          icon: BotMessageSquare,
          to: { page: "agents" },
        },
        ...(isLeader ? [] : portfolio),
      ],
    },
    {
      label: "Arquivos e análises",
      items: [
        {
          key: "drive",
          label: "Drive",
          icon: HardDrive,
          to: { page: "drive" },
        },
        {
          key: "reports",
          label: "Relatórios",
          icon: ChartNoAxesCombined,
          to: { page: "reports" },
        },
        {
          key: "dashboards",
          label: "Dashboards",
          icon: PanelsTopLeft,
          to: { page: "dashboards" },
        },
        ...(csAccess
          ? [
              {
                key: "customerSuccess",
                label: "Customer Success",
                icon: HeartHandshake,
                to: { page: "customerSuccess" as const },
              },
            ]
          : []),
      ],
    },
    {
      label: "Ajuda",
      items: [
        {
          key: "tutorials",
          label: "Tutoriais",
          icon: GraduationCap,
          to: { page: "tutorials" },
          count: tutorialCount,
        },
      ],
    },
    {
      label: "Administração",
      items: [
        ...(isLeader ? portfolio : []),
        {
          key: "settings",
          label: "Equipe e configurações",
          icon: Settings2,
          to: { page: "settings" },
          children: [
            {
              key: "settings-people",
              label: "Pessoas",
              to: { page: "settings", hash: "config-pessoas" },
            },
            {
              key: "settings-teams",
              label: "Equipes",
              to: { page: "settings", hash: "config-equipes" },
            },
            {
              key: "settings-squads",
              label: "Squads",
              to: { page: "settings", hash: "config-squads" },
            },
            {
              key: "settings-cs",
              label: "Customer Success",
              to: { page: "settings", hash: "config-cs" },
            },
            {
              key: "settings-templates",
              label: "Templates de tarefa",
              to: { page: "settings", hash: "config-templates" },
            },
            {
              key: "settings-due",
              label: "Prazos e jornada",
              to: { page: "settings", hash: "config-prazos" },
            },
            {
              key: "settings-suggestions",
              label: "Sugestões",
              to: { page: "settings", hash: "config-sugestoes" },
            },
          ],
        },
        {
          key: "storage",
          label: "Armazenamento",
          icon: Database,
          to: { page: "storage" },
        },
        {
          key: "aiUsage",
          label: "Painel da MAVI",
          icon: Sparkles,
          to: { page: "aiUsage" },
          // Gestores veem tudo menos Provedores e modelos (as API Keys).
          children: [
            {
              key: "ai-usage",
              label: "Consumo e limites",
              to: { page: "aiUsage", hash: "consumo" },
            },
            {
              key: "ai-copilot",
              label: "Copiloto",
              to: { page: "aiUsage", hash: "copiloto" },
            },
            {
              key: "ai-learning",
              label: "Aprendizado da MAVI",
              to: { page: "aiUsage", hash: "aprendizado" },
            },
            {
              key: "ai-temperature",
              label: "Termômetro",
              to: { page: "aiUsage", hash: "termometro" },
            },
            {
              key: "ai-radar",
              label: "Radar",
              to: { page: "aiUsage", hash: "radar" },
            },
            {
              key: "ai-powers",
              label: "Poderes",
              to: { page: "aiUsage", hash: "poderes" },
            },
            ...(isAdmin
              ? [
                  {
                    key: "ai-providers",
                    label: "Provedores e modelos",
                    to: { page: "aiUsage" as const, hash: "provedores" },
                  },
                ]
              : []),
            {
              key: "ai-routes",
              label: "Quem usa qual modelo",
              to: { page: "aiUsage" as const, hash: "regras" },
            },
            {
              key: "ai-router",
              label: "Roteamento",
              to: { page: "aiUsage" as const, hash: "roteamento" },
            },
            {
              key: "ai-eval-set",
              label: "Avaliação",
              to: { page: "aiUsage" as const, hash: "avaliacao" },
            },
            {
              key: "ai-whatsapp",
              label: "Grupos do Whatsapp",
              to: { page: "aiUsage" as const, hash: "whatsapp" },
            },
            ...(isAdmin
              ? [
                  {
                    key: "ai-job-alerts",
                    label: "Avisos de falhas",
                    to: { page: "aiUsage" as const, hash: "avisos" },
                  },
                ]
              : []),
          ],
        },
      ],
    },
  ];

  // Filters that tell the task list's views apart.
  const FILTERS = ["escopo", "atrasadas", "produto"];
  const current = (to: NavTarget) => {
    if (to.page !== page) return false;
    if (to.hash) {
      if (typeof window === "undefined") return false;
      const hash = window.location.hash.slice(1);
      // Without a hash, the settings page opens on its first tab.
      return (
        (page === "settings"
          ? settingsTab(hash)
          : page === "aiUsage"
            ? aiTab(hash)
            : hash) === to.hash
      );
    }
    if (to.page !== "tasks") return true;
    // No scope is the same list as "Para você".
    const value = (key: string, v: string | null | undefined) =>
      key === "escopo" ? v || "mine" : (v ?? "");
    return FILTERS.every(
      (key) => value(key, params.get(key)) === value(key, to.query?.[key]),
    );
  };
  const inside = (item: Item) =>
    page === item.to.page ||
    (item.key === "tasks" && page === "search") ||
    (item.key === "onboarding" && page === "socialMedia") ||
    (item.key === "mavi" && (page === "skills" || page === "connections"));

  const link = (to: NavTarget, content: ReactNode, props: object = {}) => (
    <a
      href={href(to)}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
          return;
        e.preventDefault();
        onNavigate(to);
      }}
      {...props}
    >
      {content}
    </a>
  );

  return (
    <nav className="sidebar-nav" aria-label="Navegação principal">
      {groups.map((group, gi) => {
        const items = group.items.filter((i) => allowed(i.to.page));
        if (!items.length) return null;
        return (
          <div className="nav-group" key={group.label ?? gi}>
            {group.label && (
              <span className="nav-label">{group.label.toUpperCase()}</span>
            )}
            {items.map((item) => {
              const children = item.children?.filter(
                (c) => "heading" in c || allowed(c.to.page),
              );
              const expanded =
                !!children?.length && (open[item.key] ?? inside(item));
              const active = inside(item);
              const submenu = `submenu-${item.key}`;
              return (
                <div
                  className={`nav-item${expanded ? " expanded" : ""}`}
                  key={item.key}
                >
                  <div className="nav-row">
                    {link(
                      item.to,
                      <>
                        <item.icon size={19} />
                        <span>{item.label}</span>
                        {!!item.count && (
                          // O texto escuro, também no item ativo (que fica verde).
                          <span className="nav-count" style={{ color: "#263334" }}>
                            {item.count}
                          </span>
                        )}
                        {/* Recolhido, o número dos filhos aparece no item (ex.: Radar › Pessoal). */}
                        {!item.count && !expanded && !!children?.some((c) => !("heading" in c) && c.count) && (
                          <span className="nav-count">
                            {children!.reduce((n, c) => n + (("heading" in c) ? 0 : (c.count ?? 0)), 0)}
                          </span>
                        )}
                      </>,
                      {
                        className: active ? "active" : "",
                        "aria-current":
                          active && !expanded ? "page" : undefined,
                        title: item.label,
                      },
                    )}
                    {!!children?.length && (
                      <button
                        type="button"
                        className="nav-toggle"
                        aria-expanded={expanded}
                        aria-controls={submenu}
                        aria-label={`${expanded ? "Recolher" : "Expandir"} ${item.label}`}
                        onClick={() => toggle(item.key, !expanded)}
                      >
                        <ChevronDown size={15} />
                      </button>
                    )}
                  </div>
                  {expanded && (
                    <ul className="nav-sub" id={submenu}>
                      {children!.map((c) =>
                        "heading" in c ? (
                          <li className="nav-sub-heading" key={c.heading}>
                            {c.heading}
                          </li>
                        ) : (
                          <li key={c.key}>
                            {link(
                              c.to,
                              <>
                                {c.dot && (
                                  <span
                                    className="product-dot"
                                    style={{ background: c.dot }}
                                  />
                                )}
                                <span>{c.label}</span>
                                {!!c.count && (
                                  // O texto escuro, também no subitem ativo (que é verde).
                                  <span className="nav-count" style={{ color: "#263334", flexShrink: 0 }}>
                                    {c.count}
                                  </span>
                                )}
                              </>,
                              {
                                className: current(c.to) ? "active" : "",
                                "aria-current": current(c.to)
                                  ? "page"
                                  : undefined,
                              },
                            )}
                          </li>
                        ),
                      )}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
