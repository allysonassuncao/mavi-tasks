import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  TOUR_EVENT,
  currentScreen,
  demoTours,
  serverTours,
  tourContentOf,
  type TourCommand,
  type TourStep,
} from "./tours";
import type { EditorStart } from "./TourEditor";
import type { Snapshot } from "./types";

const TourPlayer = lazy(() => import("./TourPlayer").then((m) => ({ default: m.TourPlayer })));
const TourEditor = lazy(() => import("./TourEditor"));

type Session =
  | { mode: "play"; id: string; step: number; test: boolean; title: string; steps: TourStep[] }
  | { mode: "edit"; id: string; start: EditorStart };
type Saved = { mode: "play"; id: string; step: number } | { mode: "edit"; id: string };

/** Below this width the screens change shape: tours are for the computer. */
const MIN_WIDTH = 760;

/**
 * Onboarding above every page: plays a tour or opens the floating editor
 * when asked (window event "mavi:tour", see playTour/editTour). The session
 * stays in this tab's storage, so a reload — or a screen that reloads —
 * picks it up where it was.
 */
export function TourLayer({
  company,
  companyPath,
  user,
  isLeader,
  demo,
  data,
  notify,
}: {
  company: string;
  companyPath: string;
  user: string;
  isLeader: boolean;
  demo: boolean;
  data: Snapshot;
  notify: (message: string) => void;
}) {
  const api = useMemo(
    () => (demo ? demoTours(user, data.members.find((m) => m.user_id === user)?.name) : serverTours),
    [demo, user], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const key = `mavi:tour:${company}`;
  const [session, setSession] = useState<Session | null>(null);

  const remember = useCallback(
    (s: Saved | null) => {
      try {
        if (s) sessionStorage.setItem(key, JSON.stringify(s));
        else sessionStorage.removeItem(key);
      } catch {
        // Sem armazenamento: a sessão vale até recarregar.
      }
    },
    [key],
  );
  const end = useCallback(() => {
    remember(null);
    setSession(null);
  }, [remember]);

  const open = useCallback(
    async (cmd: TourCommand, resumed = false) => {
      if (window.innerWidth < MIN_WIDTH) {
        if (!resumed) notify("Os onboardings funcionam no computador. Abra o sistema numa tela maior.");
        return;
      }
      try {
        const d = await api.detail(cmd.id);
        if (!d) {
          remember(null);
          if (!resumed) notify("Este onboarding não está disponível para você.");
          return;
        }
        if (cmd.action === "edit") {
          if (!d.can_edit || !isLeader) {
            remember(null);
            return notify("Só um administrador ou o gestor que criou pode editar este onboarding.");
          }
          remember({ mode: "edit", id: d.id });
          setSession({
            mode: "edit",
            id: d.id,
            start: {
              id: d.id,
              content: tourContentOf(d),
              revision: d.revision,
              status: d.status,
              hasDraft: !!d.draft,
              misses: d.misses ?? [],
            },
          });
          return;
        }
        if (!d.steps.length) {
          remember(null);
          return notify("Este onboarding ainda não tem passos.");
        }
        // Um rascunho (só quem edita o vê) toca como teste: não conta progresso.
        const test = d.status !== "published";
        const step = Math.max(0, Math.min(cmd.from ?? 0, d.steps.length - 1));
        if (!test && !resumed)
          void api
            .progress(d.id, step ? "step" : "start", step, d.steps[step].id)
            .catch(() => {});
        remember({ mode: "play", id: d.id, step });
        setSession({ mode: "play", id: d.id, step, test, title: d.title, steps: d.steps });
      } catch (e) {
        if (!resumed) notify((e as Error).message || "Não foi possível abrir o onboarding.");
      }
    },
    [api, isLeader, notify, remember],
  );

  // Commands from any screen.
  useEffect(() => {
    const on = (e: Event) => {
      const cmd = (e as CustomEvent<TourCommand>).detail;
      if (cmd?.id) void open(cmd);
    };
    window.addEventListener(TOUR_EVENT, on);
    return () => window.removeEventListener(TOUR_EVENT, on);
  }, [open]);

  // The session of this tab (after a reload).
  useEffect(() => {
    setSession(null);
    if (!company) return;
    let saved: Saved | null = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(key) ?? "null") as Saved | null;
    } catch {
      saved = null;
    }
    if (!saved?.id) return;
    void open(
      saved.mode === "edit" ? { action: "edit", id: saved.id } : { action: "play", id: saved.id, from: saved.step },
      true,
    );
  }, [company]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!session) return null;
  if (session.mode === "edit")
    return (
      <Suspense fallback={null}>
        <TourEditor
          key={session.id}
          start={session.start}
          api={api}
          company={company}
          companyPath={companyPath}
          data={data}
          demo={demo}
          notify={notify}
          onSaved={(start) => setSession((s) => (s?.mode === "edit" && s.id === start.id ? { ...s, start } : s))}
          onExit={() => {
            end();
            notify("Editor fechado. O onboarding fica salvo em Tutoriais › Onboarding.");
          }}
        />
      </Suspense>
    );
  const { id, steps, test } = session;
  return (
    <Suspense fallback={null}>
      <TourPlayer
        key={id}
        title={session.title}
        steps={steps}
        start={session.step}
        companyPath={companyPath}
        test={test}
        onStep={(i, s) => {
          remember({ mode: "play", id, step: i });
          if (!test) void api.progress(id, "step", i, s.id).catch(() => {});
        }}
        onMiss={(s) => void api.miss(id, s.id, currentScreen()).catch(() => {})}
        onFinish={() => {
          end();
          if (!test) void api.progress(id, "complete", steps.length - 1, steps[steps.length - 1].id).catch(() => {});
          notify(test ? "Fim do teste." : "Onboarding concluído. Bom trabalho!");
        }}
        onClose={(i, s) => {
          end();
          if (!test && s) void api.progress(id, "dismiss", i, s.id).catch(() => {});
          if (!test) notify("Onboarding pausado. Continue quando quiser pelo “?” ou em Tutoriais › Onboarding.");
        }}
      />
    </Suspense>
  );
}
