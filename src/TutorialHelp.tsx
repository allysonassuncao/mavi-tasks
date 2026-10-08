import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ArrowRight, CircleHelp, Compass, GraduationCap, Play } from "lucide-react";
import { Skeleton } from "./ui";
import { navigate, pageUrl, type Page } from "./router";
import {
  TUTORIAL_PARAM,
  demoTutorials,
  moduleLabel,
  serverTutorials,
  tutorialModuleOf,
  type TutorialRow,
} from "./tutorials";
import { demoTours, playTour, serverTours, type TourRow } from "./tours";
import type { Snapshot } from "./types";
import "./tutorials.css";
import "./tours.css";

const SHOWN = 6;

/**
 * O "?" do topo: os tutoriais da tela aberta (pelo módulo dela), com
 * atalho para todos. Só busca ao abrir (sem consultas periódicas).
 */
export function TutorialHelp({
  page,
  company,
  companyPath,
  data,
  user,
  demo,
}: {
  page: Page | null;
  company: string;
  /** The company's part of the address (/agencias/<slug>). */
  companyPath: string;
  data: Snapshot;
  user: string;
  demo: boolean;
}) {
  const api = useMemo(
    () => (demo ? demoTutorials(data, user) : serverTutorials),
    [demo], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const toursApi = useMemo(
    () => (demo ? demoTours(user) : serverTours),
    [demo, user],
  );
  const module = tutorialModuleOf(page);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TutorialRow[] | null>(null);
  const [tours, setTours] = useState<TourRow[]>([]);
  const [error, setError] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !company) return;
    let alive = true;
    setRows(null);
    setError(false);
    api
      .list(company, {
        scope: "library",
        query: "",
        module: module ?? "",
        category: "",
        tags: [],
        limit: SHOWN,
        offset: 0,
      })
      .then((list) => alive && setRows(list))
      .catch(() => alive && setError(true));
    // Os onboardings que passam por esta tela (ou começam nela).
    setTours([]);
    toursApi
      .list(company, "library", module, page)
      .then((list) => alive && setTours(list.slice(0, 4)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, api, toursApi, company, module, page]);

  // Fecha ao clicar fora, com Esc e ao trocar de tela.
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  useEffect(() => setOpen(false), [page]);

  const base = pageUrl("tutorials", companyPath);
  const go = (e: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    setOpen(false);
    navigate(href);
  };
  const total = rows?.[0]?.total ?? 0;
  const allOfModule = module ? `${base}?modulo=${module}` : base;

  return (
    <div className="tutorial-help" ref={box}>
      <button
        type="button"
        className="inbox-toggle"
        title={module ? `Tutoriais de ${moduleLabel(module)}` : "Tutoriais"}
        aria-label="Ajuda: tutoriais desta tela"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <CircleHelp size={17} />
      </button>
      {open && (
        <div className="tutorial-help-panel" role="dialog" aria-label="Tutoriais">
          <div className="tutorial-help-head">
            <GraduationCap size={16} aria-hidden="true" />
            <strong>
              {module ? `Tutoriais de ${moduleLabel(module)}` : "Tutoriais"}
            </strong>
          </div>
          {error ? (
            <p className="tutorial-help-empty">
              Não foi possível carregar os tutoriais.
            </p>
          ) : rows === null ? (
            <div className="tutorial-help-loading" role="status" aria-label="Carregando tutoriais">
              <Skeleton className="skeleton-inline" />
              <Skeleton className="skeleton-inline" />
            </div>
          ) : rows.length ? (
            <ul className="tutorial-help-list">
              {rows.map((r) => {
                const href = `${base}?${TUTORIAL_PARAM}=${r.id}&de=ajuda`;
                return (
                  <li key={r.id}>
                    <a href={href} onClick={(e) => go(e, href)}>
                      <strong>{r.title}</strong>
                      {r.summary && <small>{r.summary}</small>}
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="tutorial-help-empty">
              {module
                ? "Ainda não há tutorial sobre esta tela."
                : "Ainda não há tutoriais publicados."}
            </p>
          )}
          {tours.length > 0 && (
            <div className="tutorial-help-tours">
              <div className="tutorial-help-tours-head">
                <Compass size={13} aria-hidden="true" /> Onboarding desta tela
              </div>
              {tours.map((t) => {
                const paused = t.my_status !== "completed" && (t.my_step ?? 0) > 0;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      playTour(t.id, paused ? (t.my_step ?? 0) : 0);
                    }}
                  >
                    <Play size={14} aria-hidden="true" />
                    <span>
                      <strong>{t.title}</strong>
                      <small>
                        {t.my_status === "completed"
                          ? "Concluído · fazer de novo"
                          : paused
                            ? `Continuar do passo ${(t.my_step ?? 0) + 1} de ${t.step_count}`
                            : `${t.step_count} ${t.step_count === 1 ? "passo" : "passos"}`}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="tutorial-help-foot">
            {module && total > SHOWN && (
              <a href={allOfModule} onClick={(e) => go(e, allOfModule)}>
                Ver os {total} de {moduleLabel(module)}
              </a>
            )}
            <a href={base} onClick={(e) => go(e, base)}>
              Todos os tutoriais <ArrowRight size={14} />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
