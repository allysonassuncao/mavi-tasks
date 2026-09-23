import { describe, it, expect } from "vitest";
import {
  buildNameLookup,
  statusDurations,
  suggestedAssignee,
  taskMatchesSearch,
} from "./domain";
import { taskSearchFilter } from "./api";
import {
  DESCRIPTION_PREFIX,
  mentionedIds,
  parseDescription,
  richTextPlain,
  serializeDescription,
  transitionComment,
} from "./rich-text";
import { demoSnapshot } from "./demo";
import { DemoStore } from "./demo-store";
import type { Status } from "./types";

describe("Responsável sugerido ao mudar o status", () => {
  const data = demoSnapshot();
  const task = {
    ...data.tasks.find((t) => !t.project_id || t.project_id)!,
    project_id: null,
    status: "progress" as Status,
    creator_id: "user-julia",
    assignee_id: "user-lucas",
  };
  it("delegação e falta de informação voltam ao criador", () => {
    expect(suggestedAssignee(data, task, "open")).toBe("user-julia");
    expect(suggestedAssignee(data, task, "returned")).toBe("user-julia");
  });
  it("validação vai para quem valida", () => {
    expect(suggestedAssignee(data, task, "review")).toBe("user-julia");
  });
  it("alteração volta para quem executou", () => {
    const inReview = {
      ...task,
      status: "review" as Status,
      assignee_id: "user-julia",
    };
    const events = [
      {
        id: "e1",
        task_id: task.id,
        actor_id: "user-lucas",
        action: "move",
        detail: {
          from: "progress",
          to: "review",
          assignee_from: "user-lucas",
          assignee_to: "user-julia",
        },
        created_at: "2026-09-20T10:00:00Z",
      },
    ];
    expect(suggestedAssignee(data, inReview, "rejected", events)).toBe(
      "user-lucas",
    );
  });
  it("manter o status mantém o responsável", () => {
    expect(suggestedAssignee(data, task, "progress")).toBe("user-lucas");
  });
});

describe("Tempo em cada status", () => {
  it("soma o histórico e conta o status atual desde a entrada", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 8, 20, h)).toISOString();
    const move = (h: number, from: Status, to: Status) => ({
      id: `m${h}`,
      task_id: "t",
      actor_id: "u",
      action: "move",
      detail: { from, to },
      created_at: at(h),
    });
    const created = {
      ...move(0, "open", "open"),
      action: "created",
      detail: {},
    };
    const spent = statusDurations(
      { status: "progress", created_at: at(0), status_changed_at: at(6) },
      [
        created,
        move(1, "open", "progress"),
        move(3, "progress", "review"),
        move(6, "review", "progress"),
      ],
      Date.parse(at(8)),
    );
    const h = 3600000;
    expect(spent).toEqual({ open: 1 * h, progress: 4 * h, review: 3 * h });
  });
});

describe("Busca de tarefas", () => {
  const data = demoSnapshot();
  const lookup = buildNameLookup(data);
  const task = data.tasks.find((t) => t.project_id)!;
  const client = lookup.clients.get(
    lookup.contracts.get(task.contract_id)!.client_id,
  )!;
  const project = lookup.projects.get(task.project_id!)!;
  it("encontra pelo título, cliente ou projeto, sem diferenciar acentos", () => {
    expect(taskMatchesSearch(lookup, task, task.title.slice(0, 5))).toBe(true);
    expect(taskMatchesSearch(lookup, task, client.name.toUpperCase())).toBe(
      true,
    );
    expect(taskMatchesSearch(lookup, task, project.name)).toBe(true);
    expect(taskMatchesSearch(lookup, task, "zzz-nada-disso")).toBe(false);
  });
  it("monta o filtro do servidor com ids de clientes e projetos", () => {
    const filter = taskSearchFilter(project.name, data);
    expect(filter).toContain(`project_id.in.(`);
    expect(filter).toContain(project.id);
  });
  it("não deixa o texto digitado quebrar a sintaxe do filtro", () => {
    expect(taskSearchFilter('a,b)"%_', data)).toBe(
      'title.ilike."%a,b)\\"\\\\%\\\\_%"',
    );
  });
});

describe("Motivos de devolução e validação", () => {
  const note = serializeDescription({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Faltou o logo" }] },
    ],
  });
  it("mede o texto visível do editor", () => {
    expect(richTextPlain(note)).toBe("Faltou o logo");
    expect(richTextPlain("")).toBe("");
  });
  it("vira comentário com o rótulo da ação", () => {
    const body = transitionComment("Devolvida ao criador", note);
    expect(body.startsWith(DESCRIPTION_PREFIX)).toBe(true);
    expect(richTextPlain(body)).toBe("Devolvida ao criador\nFaltou o logo");
    expect(parseDescription(body).content?.[0].content?.[0].marks).toEqual([
      { type: "bold" },
    ]);
  });
  it("no modo demonstração, pedir alteração muda status, responsável e comenta", () => {
    const store = new DemoStore();
    const task = store.data.tasks.find((t) => t.status === "review")!;
    store.mutate("transition_task", {
      p_task: task.id,
      p_version: task.version,
      p_action: "move",
      p_note: note,
      p_status: "rejected",
      p_assignee: "user-lucas",
    });
    const moved = store.data.tasks.find((t) => t.id === task.id)!;
    expect(moved.status).toBe("rejected");
    expect(moved.assignee_id).toBe("user-lucas");
    expect(richTextPlain(store.comments[0].body)).toContain("Alteração");
    expect(richTextPlain(store.comments[0].body)).toContain("Faltou o logo");
  });
  it("no modo demonstração, alteração sem texto é recusada", () => {
    const store = new DemoStore();
    const task = store.data.tasks.find((t) => t.status === "review")!;
    expect(() =>
      store.mutate("transition_task", {
        p_task: task.id,
        p_version: task.version,
        p_action: "move",
        p_note: "",
        p_status: "rejected",
      }),
    ).toThrow();
  });
});

describe("Menções com @", () => {
  const body = serializeDescription({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Pode revisar, " },
          { type: "mention", attrs: { id: "user-lucas", label: "Lucas" } },
          { type: "text", text: "?" },
        ],
      },
    ],
  });
  it("guarda a menção no texto e lê como @Nome", () => {
    expect(mentionedIds(body)).toEqual(["user-lucas"]);
    expect(richTextPlain(body)).toBe("Pode revisar, @Lucas?");
  });
  it("no modo demonstração, quem é mencionado vira participante e é notificado", () => {
    const store = new DemoStore();
    const task = store.data.tasks.find(
      (t) => t.assignee_id !== "user-lucas" && t.creator_id !== "user-lucas",
    )!;
    store.mutate("add_comment", { p_task: task.id, p_body: body });
    const updated = store.data.tasks.find((t) => t.id === task.id)!;
    expect(updated.participant_ids).toContain("user-lucas");
    const inbox = store.inbox("user-lucas");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].task_id).toBe(task.id);
    expect(inbox[0].excerpt).toContain("@Lucas");
  });
  it("mencionar a si mesmo não notifica", () => {
    const store = new DemoStore();
    const before = store.inbox("user-allyson").length;
    const self = body.replace("user-lucas", "user-allyson");
    store.mutate("add_comment", {
      p_task: store.data.tasks[0].id,
      p_body: self,
    });
    expect(store.inbox("user-allyson")).toHaveLength(before);
  });
});
