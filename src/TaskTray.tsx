import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { ChevronUp, Maximize2, Mic, PenLine, X } from "lucide-react";
import { statuses, type Status, type Task } from "./types";

/**
 * Tarefas minimizadas: a tarefa sai da frente e fica no rodapé enquanto a
 * pessoa navega pelo sistema. Quem foi aberta nesta visita continua montada,
 * escondida (TaskDetail com `hidden`), então comentário em digitação, edição
 * aberta e áudio gravando seguem do jeito que estavam. A lista e o texto do
 * comentário em rascunho ficam guardados neste navegador (por empresa e
 * pessoa) e voltam ao recarregar a página.
 */
export const TRAY_LIMIT = 5;

export type TrayItem = {
  id: string;
  title: string;
  status: Status;
  /** Quando foi minimizada pela última vez (a pílula do celular mostra a mais recente). */
  at: number;
  /** O comentário em rascunho (rich text serializado). */
  draft?: string;
};

/** O que a tarefa aberta tem por enviar (TaskDetail avisa a cada mudança). */
export type TaskUnsaved = { dirty: boolean; recording: boolean };

const trayKey = (company: string, user: string) =>
  company && user ? `mavi:task-tray:${company}:${user}` : "";

function readTray(key: string): TrayItem[] {
  if (!key) return [];
  try {
    const list = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (i): i is TrayItem =>
          i &&
          typeof i.id === "string" &&
          typeof i.title === "string" &&
          i.status in statuses,
      )
      .slice(0, TRAY_LIMIT);
  } catch {
    return [];
  }
}

/** Um comentário que vale guardar (o editor dá "" quando não há texto, menção nem imagem). */
export function hasCommentText(value: string | undefined) {
  return !!value;
}

/**
 * O rodapé depois de pôr `task` nele: já estava, só muda a hora; cheio, sai
 * a mais antiga sem nada por enviar ou, se todas tiverem, a mais antiga
 * (`evicted`, que quem chama confirma com a pessoa quando tem algo por enviar).
 */
export function trayWith(
  list: TrayItem[],
  task: Pick<Task, "id" | "title" | "status">,
  now: number,
  isUnsaved: (id: string) => boolean,
): { next: TrayItem[]; evicted?: TrayItem } {
  if (list.some((i) => i.id === task.id))
    return { next: list.map((i) => (i.id === task.id ? { ...i, at: now } : i)) };
  const added = { id: task.id, title: task.title, status: task.status, at: now };
  if (list.length < TRAY_LIMIT) return { next: [...list, added] };
  const byAge = [...list].sort((a, b) => a.at - b.at);
  const evicted = byAge.find((i) => !isUnsaved(i.id)) ?? byAge[0];
  return { next: [...list.filter((i) => i.id !== evicted.id), added], evicted };
}

export function useTaskTray(company: string, user: string) {
  const key = trayKey(company, user);
  const [state, setState] = useState(() => ({ key, items: readTray(key) }));
  // Trocou a empresa (ou a pessoa): a bandeja é a dela.
  const items = state.key === key ? state.items : readTray(key);
  useEffect(() => {
    if (state.key !== key) setState({ key, items: readTray(key) });
  }, [key, state.key]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Guardar sempre na chave de quem está com a bandeja agora.
  const keyRef = useRef(key);
  keyRef.current = key;
  // O texto do comentário chega a cada tecla: fica aqui e vai para o
  // navegador depois de uma pausa, sem redesenhar a página.
  const comments = useRef(new Map<string, string>());
  const [unsaved, setUnsaved] = useState<Record<string, TaskUnsaved>>({});
  const unsavedRef = useRef(unsaved);
  unsavedRef.current = unsaved;

  const persist = useCallback(() => {
    const key = keyRef.current;
    if (!key) return;
    try {
      const list = itemsRef.current.map((i) => {
        const draft = comments.current.get(i.id) ?? i.draft;
        return { ...i, draft: hasCommentText(draft) ? draft : undefined };
      });
      if (list.length) localStorage.setItem(key, JSON.stringify(list));
      else localStorage.removeItem(key);
    } catch {
      // Armazenamento bloqueado: a bandeja só não sobrevive ao recarregar.
    }
  }, []);
  useEffect(() => {
    if (state.key === key) persist();
  }, [state, key, persist]);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const flush = () => {
      clearTimeout(saveTimer.current);
      persist();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [persist]);

  const update = useCallback(
    (fn: (list: TrayItem[]) => TrayItem[]) => {
      const next = fn(itemsRef.current);
      if (next === itemsRef.current) return;
      itemsRef.current = next;
      setState({ key, items: next });
    },
    [key],
  );

  /** Tem algo por enviar: aberta nesta visita, ou o rascunho guardado. */
  const isUnsaved = useCallback((id: string) => {
    const u = unsavedRef.current[id];
    if (u) return u.dirty || u.recording;
    const draft =
      comments.current.get(id) ??
      itemsRef.current.find((i) => i.id === id)?.draft;
    return hasCommentText(draft);
  }, []);

  /** A tarefa saiu sem enviar (fechou, ou saiu do rodapé cheio): esquece o que tinha. */
  const forget = useCallback((id: string) => {
    comments.current.delete(id);
    setUnsaved((u) => {
      if (!(id in u)) return u;
      const next = { ...u };
      delete next[id];
      return next;
    });
  }, []);

  /**
   * Põe a tarefa no rodapé (ou só marca a hora, se já estiver). Cheia, sai a
   * mais antiga sem nada por enviar; se todas tiverem, a mais antiga depois
   * de a pessoa confirmar. `false`: a pessoa preferiu não tirar nenhuma.
   */
  const add = useCallback(
    (task: Pick<Task, "id" | "title" | "status">) => {
      const { next, evicted } = trayWith(
        itemsRef.current,
        task,
        Date.now(),
        isUnsaved,
      );
      if (
        evicted &&
        isUnsaved(evicted.id) &&
        !window.confirm(
          `O rodapé comporta até ${TRAY_LIMIT} tarefas. "${evicted.title}" tem algo não enviado (comentário, edição ou áudio) e vai sair do rodapé, descartando isso. Continuar?`,
        )
      )
        return false;
      // Sai de vez (desmonta): sem isto, o que tinha por enviar a manteria aberta.
      if (evicted) forget(evicted.id);
      update(() => next);
      return true;
    },
    [update, isUnsaved, forget],
  );

  const remove = useCallback(
    (id: string) => {
      forget(id);
      update((l) => (l.some((i) => i.id === id) ? l.filter((i) => i.id !== id) : l));
    },
    [update, forget],
  );

  const report = useCallback((id: string, next: TaskUnsaved) => {
    setUnsaved((u) =>
      u[id]?.dirty === next.dirty && u[id]?.recording === next.recording
        ? u
        : { ...u, [id]: next },
    );
  }, []);

  const setComment = useCallback(
    (id: string, value: string) => {
      comments.current.set(id, value);
      if (!itemsRef.current.some((i) => i.id === id)) return;
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(persist, 600);
    },
    [persist],
  );

  /** Título e status em dia com o que o app já sabe da tarefa. */
  const sync = useCallback(
    (lookup: (id: string) => Task | undefined) => {
      update((l) => {
        let changed = false;
        const next = l.map((i) => {
          const t = lookup(i.id);
          if (!t || (t.title === i.title && t.status === i.status)) return i;
          changed = true;
          return { ...i, title: t.title, status: t.status };
        });
        return changed ? next : l;
      });
    },
    [update],
  );

  // Pelas refs: quem chama pode estar com uma versão antiga do hook (o
  // clique numa notificação do navegador, por exemplo).
  const has = useCallback(
    (id: string) => itemsRef.current.some((i) => i.id === id),
    [],
  );
  const draftOf = useCallback(
    (id: string) =>
      comments.current.get(id) ??
      itemsRef.current.find((i) => i.id === id)?.draft,
    [],
  );

  return {
    items,
    unsaved,
    has,
    draftOf,
    isUnsaved,
    add,
    remove,
    forget,
    report,
    setComment,
    sync,
  };
}

export type TaskTray = ReturnType<typeof useTaskTray>;

/**
 * O rodapé. No computador, uma aba por tarefa ao lado da bolinha da MAVI; no
 * celular, uma pílula com a mais recente e a lista das outras por baixo.
 */
export function TaskDock({
  tray,
  withFab,
  onOpen,
}: {
  tray: TaskTray;
  /** A bolinha da MAVI está na tela: o rodapé deixa o lugar dela. */
  withFab: boolean;
  onOpen: (id: string) => void;
}) {
  const [listOpen, setListOpen] = useState(false);
  const items = tray.items;
  useEffect(() => {
    if (!items.length) setListOpen(false);
  }, [items.length]);
  useEffect(() => {
    if (!listOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setListOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listOpen]);
  if (!items.length) return null;
  const latest = items.reduce((a, b) => (b.at > a.at ? b : a));
  const others = items.length - 1;

  function close(item: TrayItem) {
    if (
      tray.isUnsaved(item.id) &&
      !window.confirm(
        `"${item.title}" tem algo não enviado (comentário, edição ou áudio). Fechar e descartar?`,
      )
    )
      return false;
    tray.remove(item.id);
    return true;
  }
  function open(id: string) {
    setListOpen(false);
    onOpen(id);
  }
  // Nas abas do computador, só o ícone: o título precisa do espaço.
  const marks = (item: TrayItem, compact = false) => {
    const u = tray.unsaved[item.id];
    if (u?.recording)
      return (
        <span
          className={`task-dock-mark recording${compact ? " compact" : ""}`}
          title="Gravando áudio"
          aria-label="Gravando áudio"
        >
          <Mic size={12} /> {!compact && "Gravando"}
        </span>
      );
    return tray.isUnsaved(item.id) ? (
      <span
        className={`task-dock-mark${compact ? " compact" : ""}`}
        title="Tem algo não enviado"
        aria-label="Rascunho"
      >
        {compact ? <PenLine size={12} /> : "Rascunho"}
      </span>
    ) : null;
  };

  return (
    <div
      className={`task-dock${withFab ? " with-fab" : ""}`}
      role="region"
      aria-label="Tarefas minimizadas"
    >
      <ul className="task-dock-tabs">
        {items.map((item) => (
          <li key={item.id} className="task-dock-tab">
            <button
              type="button"
              className="task-dock-open"
              onClick={() => open(item.id)}
              title={`${item.title} — ${statuses[item.status].label}. Clique para abrir.`}
            >
              <i style={{ background: statuses[item.status].color }} />
              <span className="task-dock-title">{item.title}</span>
              {marks(item, true)}
              <Maximize2 size={14} className="task-dock-max" />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Fechar ${item.title}`}
              title="Fechar"
              onClick={() => close(item)}
            >
              <X size={15} />
            </button>
          </li>
        ))}
      </ul>
      <Pill
        item={latest}
        others={others}
        marks={marks(latest)}
        onOpen={() => open(latest.id)}
        onList={() => setListOpen(true)}
        onSwipe={() => close(latest)}
      />
      {listOpen && (
        <>
          <div
            className="task-dock-backdrop"
            onClick={() => setListOpen(false)}
          />
          <section className="task-dock-sheet" aria-label="Tarefas minimizadas">
            <header>
              <h3>Tarefas minimizadas</h3>
              <button
                type="button"
                className="icon-btn"
                aria-label="Fechar a lista"
                onClick={() => setListOpen(false)}
              >
                <X size={18} />
              </button>
            </header>
            <ul>
              {[...items]
                .sort((a, b) => b.at - a.at)
                .map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="task-dock-row"
                      onClick={() => open(item.id)}
                    >
                      <i style={{ background: statuses[item.status].color }} />
                      <span>
                        <strong>{item.title}</strong>
                        <small>
                          {statuses[item.status].label}
                          {marks(item)}
                        </small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Fechar ${item.title}`}
                      onClick={() => close(item)}
                    >
                      <X size={16} />
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

/** A pílula do celular: toque abre, arrastar para o lado fecha. */
function Pill({
  item,
  others,
  marks,
  onOpen,
  onList,
  onSwipe,
}: {
  item: TrayItem;
  others: number;
  marks: ReactNode;
  onOpen: () => void;
  onList: () => void;
  onSwipe: () => boolean;
}) {
  const [dx, setDx] = useState(0);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // O clique que vem depois de arrastar não abre a tarefa.
  const dragged = useRef(false);
  function down(e: PointerEvent<HTMLButtonElement>) {
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  }
  function move(e: PointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (!d) return;
    const x = e.clientX - d.x;
    if (!d.moved && Math.abs(x) > 8 && Math.abs(x) > Math.abs(e.clientY - d.y)) {
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (d.moved) setDx(x);
  }
  function up() {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    dragged.current = true;
    // Solta longe: fecha (se a pessoa confirmar); perto, volta ao lugar.
    if (Math.abs(dx) > 96 && onSwipe()) return;
    setDx(0);
  }
  useEffect(() => setDx(0), [item.id]);
  return (
    <div
      className="task-dock-pill"
      style={
        dx
          ? {
              transform: `translateX(${dx}px)`,
              opacity: Math.max(0.3, 1 - Math.abs(dx) / 240),
              transition: "none",
            }
          : undefined
      }
    >
      <button
        type="button"
        className="task-dock-pill-open"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => {
          drag.current = null;
          setDx(0);
        }}
        onClick={() => {
          if (dragged.current) dragged.current = false;
          else onOpen();
        }}
        aria-label={`Abrir ${item.title}`}
      >
        <i style={{ background: statuses[item.status].color }} />
        <span>
          <strong>{item.title}</strong>
          <small>
            {statuses[item.status].label}
            {marks}
          </small>
        </span>
      </button>
      <button
        type="button"
        className="task-dock-pill-more"
        onClick={onList}
        aria-label={
          others ? `Ver as ${others + 1} tarefas minimizadas` : "Ver tarefa minimizada"
        }
      >
        {others ? `+${others}` : <ChevronUp size={18} />}
      </button>
    </div>
  );
}
