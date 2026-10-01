import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskDock, TRAY_LIMIT, trayWith, type TaskTray, type TrayItem } from "./TaskTray";

const item = (n: number, extra: Partial<TrayItem> = {}): TrayItem => ({
  id: `t${n}`,
  title: `Tarefa ${n}`,
  status: "progress",
  at: n,
  ...extra,
});
const task = (n: number) => ({ id: `t${n}`, title: `Tarefa ${n}`, status: "review" as const });
const clean = () => false;

describe("rodapé de tarefas minimizadas", () => {
  it("entra no fim, sem mexer na ordem das outras", () => {
    const { next, evicted } = trayWith([item(1), item(2)], task(3), 10, clean);
    expect(next.map((i) => i.id)).toEqual(["t1", "t2", "t3"]);
    expect(next[2]).toMatchObject({ title: "Tarefa 3", status: "review", at: 10 });
    expect(evicted).toBeUndefined();
  });

  it("já estava: só marca a hora, no mesmo lugar", () => {
    const { next, evicted } = trayWith([item(1), item(2)], task(1), 10, clean);
    expect(next.map((i) => [i.id, i.at])).toEqual([
      ["t1", 10],
      ["t2", 2],
    ]);
    expect(evicted).toBeUndefined();
  });

  it(`cheio (${TRAY_LIMIT}): sai a mais antiga sem nada por enviar`, () => {
    const list = [item(1), item(2), item(3), item(4), item(5)];
    const { next, evicted } = trayWith(list, task(6), 10, (id) => id === "t1");
    expect(evicted?.id).toBe("t2");
    expect(next.map((i) => i.id)).toEqual(["t1", "t3", "t4", "t5", "t6"]);
  });

  it("cheio e todas com rascunho: sai a mais antiga (quem chama confirma)", () => {
    const list = [item(3), item(1), item(2), item(4), item(5)];
    const { next, evicted } = trayWith(list, task(6), 10, () => true);
    expect(evicted?.id).toBe("t1");
    expect(next).toHaveLength(TRAY_LIMIT);
  });
});

const fakeTray = (items: TrayItem[], unsaved: TaskTray["unsaved"] = {}) =>
  ({
    items,
    unsaved,
    isUnsaved: (id: string) =>
      !!unsaved[id]?.dirty || !!items.find((i) => i.id === id)?.draft,
  }) as unknown as TaskTray;

describe("TaskDock", () => {
  it("vazio: nada na tela", () => {
    expect(
      renderToStaticMarkup(<TaskDock tray={fakeTray([])} withFab onOpen={() => {}} />),
    ).toBe("");
  });

  it("uma aba por tarefa e a pílula com a mais recente e as outras", () => {
    const html = renderToStaticMarkup(
      <TaskDock
        tray={fakeTray([item(1), item(3, { draft: "x" }), item(2)], {
          t2: { dirty: true, recording: true },
        })}
        withFab
        onOpen={() => {}}
      />,
    );
    expect(html).toContain('class="task-dock with-fab"');
    expect(html.match(/class="task-dock-tab"/g)).toHaveLength(3);
    // A pílula: a minimizada por último (t3) e "+2".
    expect(html).toMatch(/task-dock-pill-open[^>]*aria-label="Abrir Tarefa 3"/);
    expect(html).toContain(">+2<");
    expect(html).toContain("Rascunho");
    expect(html).toContain("Gravando");
  });

  it("sem a bolinha da MAVI, ocupa o canto todo", () => {
    const html = renderToStaticMarkup(
      <TaskDock tray={fakeTray([item(1)])} withFab={false} onOpen={() => {}} />,
    );
    expect(html).toContain('class="task-dock"');
    expect(html).toContain('aria-label="Ver tarefa minimizada"');
  });
});
