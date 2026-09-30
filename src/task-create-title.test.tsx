import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DemoStore } from "./demo-store";
import { TaskCreateForm } from "./TaskCreateForm";

describe("Nova tarefa sem o campo de título", () => {
  it("não pede o título e avisa que a MAVI cria ao salvar", () => {
    const store = new DemoStore();
    const company = store.data.companies[0].id;
    const user = store.data.members.find((m) => m.company_id === company && m.role === "admin")!.user_id;
    const html = renderToStaticMarkup(
      <TaskCreateForm
        demo
        data={store.data}
        company={company}
        user={user}
        busy={false}
        mutate={async () => ""}
        onClose={() => {}}
      />,
    );
    expect(html).not.toContain("Nome da tarefa");
    expect(html).not.toContain("O que precisa ser feito?");
    expect(html).toContain("A MAVI cria o título ao salvar");
    expect(html).toContain("Criar tarefa");
  });
});
