import { useState, type MouseEvent, type ReactNode } from "react";
import {
  CalendarDays,
  ChartNoAxesCombined,
  CheckCheck,
  ChevronDown,
  Clock3,
  Database,
  FolderKanban,
  HardDrive,
  LayoutDashboard,
  PanelsTopLeft,
  Megaphone,
  Package,
  Settings2,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Page } from "./router";
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
 * The main menu, grouped by what people do: work (tasks, campaigns), files
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
  allowed,
  taskCount,
  products,
  href,
  onNavigate,
}: {
  page: Page;
  /** The current URL's filters (escopo, atrasadas, produto…). */
  params: URLSearchParams;
  isLeader: boolean;
  /** Pages the person may open. */
  allowed: (page: Page) => boolean;
  taskCount?: number;
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
            { key: "tasks-all", label: "Todas", to: tasks() },
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
              key: "settings-products",
              label: "Catálogo de produtos",
              to: { page: "settings", hash: "config-produtos" },
            },
            {
              key: "settings-templates",
              label: "Templates de tarefa",
              to: { page: "settings", hash: "config-templates" },
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
      ],
    },
  ];

  // Filters that tell the task list's views apart.
  const FILTERS = ["escopo", "atrasadas", "produto"];
  const current = (to: NavTarget) => {
    if (to.page !== page) return false;
    if (to.hash)
      return (
        typeof window !== "undefined" && window.location.hash === `#${to.hash}`
      );
    if (to.page !== "tasks") return true;
    return FILTERS.every(
      (key) => (params.get(key) ?? "") === (to.query?.[key] ?? ""),
    );
  };
  const inside = (item: Item) =>
    page === item.to.page || (item.key === "tasks" && page === "search");

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
                          <span className="nav-count">{item.count}</span>
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
