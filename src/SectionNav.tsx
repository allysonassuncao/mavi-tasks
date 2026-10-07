import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronsLeft, ChevronsRight, type LucideIcon } from "lucide-react";
import "./section-nav.css";

export type SectionNavItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Endereço da seção; por padrão, `#<id>`. */
  href?: string;
};

export type SectionNavGroup = {
  /** Título do grupo (opcional: um grupo sem título fica sem cabeçalho). */
  label?: string;
  items: SectionNavItem[];
};

function readCollapsed(key: string) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/**
 * Segundo menu lateral das páginas com várias seções (no lugar das abas):
 * uma coluna de altura toda, colada ao menu principal, com o nome da página
 * no topo e as seções agrupadas; a barra do topo e o conteúdo vêm depois.
 * Recolhe para só os ícones (lembrado por página neste navegador); no
 * celular vira uma faixa que rola de lado acima do conteúdo.
 */
export function SectionLayout({
  title,
  label,
  groups,
  current,
  storageKey,
  children,
}: {
  /** Título no topo da coluna (o nome da página). */
  title: string;
  /** Nome acessível do menu (ex.: "Seções do Painel da MAVI"). */
  label: string;
  groups: SectionNavGroup[];
  current: string;
  /** Chave para lembrar se o menu está recolhido. */
  storageKey: string;
  children: ReactNode;
}) {
  const key = `section-nav:${storageKey}`;
  const [collapsed, setCollapsed] = useState(() => readCollapsed(key));
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // Sem armazenamento, só não lembra.
    }
  };
  // Na faixa do celular, a seção aberta pode ficar fora da vista: rola até ela.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current;
    const active = el?.querySelector<HTMLElement>("a.active");
    if (!el || !active || el.scrollWidth <= el.clientWidth) return;
    const box = el.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    el.scrollLeft +=
      item.left - box.left - (box.width - item.width) / 2;
  }, [current]);
  const visible = groups.filter((g) => g.items.length > 0);
  const count = visible.reduce((n, g) => n + g.items.length, 0);
  if (count < 2) return <div className="section-layout-body">{children}</div>;
  return (
    <div className={`section-layout ${collapsed ? "collapsed" : ""}`}>
      <nav className="section-nav" aria-label={label}>
        <div className="section-nav-head" title={collapsed ? title : undefined}>
          <span className="section-nav-text">{title}</span>
        </div>
        <div className="section-nav-list" ref={list}>
          {visible.map((g, i) => (
            <div className="section-nav-group" key={g.label ?? i}>
              {g.label && (
                <span className="section-nav-heading">{g.label}</span>
              )}
              {g.items.map((item) => (
                <a
                  key={item.id}
                  href={item.href ?? `#${item.id}`}
                  className={current === item.id ? "active" : ""}
                  aria-current={current === item.id ? "page" : undefined}
                  title={collapsed ? item.label : undefined}
                >
                  <item.icon size={16} aria-hidden="true" />
                  <span className="section-nav-text">{item.label}</span>
                </a>
              ))}
            </div>
          ))}
        </div>
        <button
          type="button"
          className="section-nav-collapse"
          aria-expanded={!collapsed}
          title={collapsed ? "Expandir seções" : "Recolher seções"}
          onClick={toggle}
        >
          {collapsed ? (
            <ChevronsRight size={16} aria-hidden="true" />
          ) : (
            <ChevronsLeft size={16} aria-hidden="true" />
          )}
          <span className="section-nav-text">Recolher</span>
        </button>
      </nav>
      <div className="section-layout-body">{children}</div>
    </div>
  );
}
