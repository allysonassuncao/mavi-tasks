import { describe, it, expect } from "vitest";
import { buildNameLookup, canSubmitTask, taskMatchesSearch } from "./domain";
import { taskSearchFilter } from "./api";
import {
  DESCRIPTION_PREFIX,
  parseDescription,
  richTextPlain,
  serializeDescription,
  transitionComment,
} from "./rich-text";
import { demoSnapshot } from "./demo";
import { DemoStore } from "./demo-store";
import type { Status } from "./types";

describe("Envio para validação", () => {
  it("só é permitido em tarefas abertas ou em andamento", () => {
    const allowed = (
      ["open", "progress", "returned", "rejected", "review", "done"] as Status[]
    ).filter((status) => canSubmitTask({ status }));
    expect(allowed).toEqual(["open", "progress"]);
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
  it("no modo demonstração, reprovar gera status e comentário", () => {
    const store = new DemoStore();
    const task = store.data.tasks.find((t) => t.status === "review")!;
    store.mutate("transition_task", {
      p_task: task.id,
      p_version: task.version,
      p_action: "reject",
      p_note: note,
    });
    expect(store.data.tasks.find((t) => t.id === task.id)!.status).toBe(
      "rejected",
    );
    expect(richTextPlain(store.comments[0].body)).toContain("Faltou o logo");
  });
});
