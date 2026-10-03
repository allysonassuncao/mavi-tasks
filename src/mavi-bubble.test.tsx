import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BubbleThread } from "./MaviChatPage";
import type { ChatEntry } from "./AiChat";

const company = "00000000-0000-4000-8000-000000000001";
const props = {
  company,
  client: "",
  readOnly: false,
  greeting: "Como posso ajudar, Ana?",
  intro: "Pergunte sobre qualquer cliente.",
  placeholder: "Pergunte qualquer coisa à MAVI",
  suggestions: ["O que está atrasado?"],
  onNew: () => {},
  onRun: () => {},
  onAnswer: () => {},
  onReload: () => {},
  onNewTask: () => {},
  onComment: () => Promise.resolve(),
  taskHref: (task: string) => `/tarefas/${task}`,
  notify: () => {},
};

describe("a conversa da bolinha (a mesma do módulo MAVI)", () => {
  it("vazia: a saudação, a caixa e as sugestões", () => {
    const html = renderToStaticMarkup(<BubbleThread {...props} conversation={null} initial={[]} />);
    expect(html).toContain("mavi-thread empty");
    expect(html).toContain("Como posso ajudar, Ana?");
    expect(html).toContain("mavi-composer");
    expect(html).toContain("O que está atrasado?");
  });

  it("desenha os passos da skill e as visualizações no lugar da resposta", () => {
    const initial: ChatEntry[] = [
      { role: "user", content: "Faz o relatório do mês?" },
      {
        id: 7,
        role: "assistant",
        content: "Aqui está o relatório.\n\n[[V1]]",
        steps: [{ id: "s0", label: "Usando a skill “Relatório mensal”", state: "done" }],
        artifacts: [
          {
            id: "visual-1",
            ref: "V1",
            type: "visual",
            visual: {
              kind: "kpis",
              title: "Resumo",
              items: [{ label: "Leads", value: 42, unit: "number" }],
            },
          },
        ],
      },
    ];
    const html = renderToStaticMarkup(
      <BubbleThread {...props} conversation="00000000-0000-4000-8000-0000000000c1" initial={initial} />,
    );
    expect(html).toContain("Usando a skill “Relatório mensal”");
    expect(html).toContain("Leads");
    // A linha [[V1]] vira a visualização (não o aviso de "abra no módulo").
    expect(html).not.toContain("[[V1]]");
    expect(html).toContain("mavi-dock");
  });
});
