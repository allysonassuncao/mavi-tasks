import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  artifactSummary,
  sanitizeArtifact,
  sanitizeArtifacts,
  sanitizeVisual,
} from "./mavi-artifacts";
import { visualCsv } from "./MaviArtifacts";
import { AnswerText, hidePartial } from "./AiChat";
import {
  FEATURES,
  isImageModel,
  isNonChatModel,
  pickRoute,
  serverModel,
  type AiRoute,
} from "./ai-providers";
import { aiTab } from "./router";

const company = "00000000-0000-4000-8000-000000000001";
const uuid = "00000000-0000-4000-8000-000000000002";

describe("visualizações da MAVI (formato fechado)", () => {
  it("gráfico: uma série por categoria, números de verdade, rosca com uma série", () => {
    const v = sanitizeVisual({
      kind: "chart",
      chart: "donut",
      title: "  Gasto por cliente ",
      unit: "money",
      categories: ["A", "B", "C"],
      series: [
        { name: "Gasto", values: [100, "250.5", "x"] },
        { name: "Outra", values: [1, 2, 3] },
      ],
      script: "alert(1)",
    });
    expect(v).toEqual({
      kind: "chart",
      chart: "donut",
      title: "Gasto por cliente",
      unit: "money",
      categories: ["A", "B", "C"],
      series: [{ name: "Gasto", values: [100, 250.5, null] }],
    });
    expect(
      sanitizeVisual({ kind: "chart", categories: ["A"], series: [{ values: [null] }] }),
    ).toBeNull();
    expect(sanitizeVisual({ kind: "html", html: "<script>" })).toBeNull();
    // Tipo desconhecido de gráfico vira colunas; unidade desconhecida, número.
    expect(
      sanitizeVisual({ kind: "chart", chart: "3d", unit: "kg", categories: ["A"], series: [{ values: [1] }] }),
    ).toMatchObject({ chart: "bar", unit: "number" });
  });

  it("tabela, indicadores e linha do tempo", () => {
    expect(
      sanitizeVisual({
        kind: "table",
        title: "Tarefas",
        columns: [{ label: "Tarefa" }, { label: "Horas", unit: "hours" }, "Status"],
        rows: [["Post", "2.5", "Em andamento", "extra"], "linha ruim"],
      }),
    ).toEqual({
      kind: "table",
      title: "Tarefas",
      columns: [{ label: "Tarefa" }, { label: "Horas", unit: "hours" }, { label: "Status" }],
      rows: [["Post", 2.5, "Em andamento"]],
    });
    expect(
      sanitizeVisual({
        kind: "kpis",
        items: [
          { label: "CPL", value: "12.3", unit: "money", delta: -8.26, good: "down" },
          { label: "Status", value: "Bom" },
          { label: "" },
        ],
      }),
    ).toEqual({
      kind: "kpis",
      items: [
        { label: "CPL", value: 12.3, unit: "money", delta: -8.3, good: "down" },
        { label: "Status", value: "Bom" },
      ],
    });
    expect(
      sanitizeVisual({
        kind: "timeline",
        title: "Reuniões",
        items: [{ date: "2026-09-01", title: "Kickoff", detail: "" }, { title: "sem data" }],
      }),
    ).toEqual({ kind: "timeline", title: "Reuniões", items: [{ date: "2026-09-01", title: "Kickoff" }] });
  });

  it("anexos gravados: só os válidos; imagem só com caminho da MAVI", () => {
    const image = {
      id: "abcd-1234",
      ref: "I1",
      type: "image",
      path: `ai-images/${company}/${uuid}.png`,
      prompt: "um gato",
      size: "wide",
      url: "javascript:alert(1)",
    };
    expect(sanitizeArtifact(image)).toEqual({
      id: "abcd-1234",
      ref: "I1",
      type: "image",
      path: image.path,
      prompt: "um gato",
      size: "square",
    });
    expect(sanitizeArtifact({ ...image, path: "drive/segredo.png" })).toBeNull();
    expect(sanitizeArtifact({ ...image, ref: "X1" })).toBeNull();
    const action = sanitizeArtifact({
      id: "action-1",
      ref: "A1",
      type: "action",
      state: "weird",
      action: { kind: "comment_task", task_id: uuid, task_title: "Relatório", text: "Ok, aprovado" },
    });
    expect(action).toMatchObject({ state: "pending", action: { kind: "comment_task" } });
    expect(artifactSummary(action!)).toBe(
      "ação: comentar na tarefa “Relatório” — aguardando a confirmação da pessoa",
    );
    expect(
      sanitizeArtifacts([
        action,
        { id: "x", ref: "V1", type: "visual" },
        { id: "task-1", ref: "A2", type: "action", action: { kind: "create_task", title: "T", client_id: uuid } },
      ]),
    ).toHaveLength(1);
  });

  it("os dados em CSV para o Excel em português", () => {
    expect(
      visualCsv({
        kind: "chart",
        chart: "bar",
        title: "x",
        unit: "number",
        categories: ["Jan; fev", "Mar"],
        series: [{ name: "Leads", values: [1.5, null] }],
      }),
    ).toBe(';Leads\n"Jan; fev";1,5\nMar;');
  });
});

describe("a resposta com anexos", () => {
  it("no módulo, a linha [[V1]] desenha o anexo; na bolinha, vira um aviso", () => {
    const text = "Resumo [[V1]] abaixo:\n[[V1]]\nFim.";
    const page = renderToStaticMarkup(
      <AnswerText text={text} renderArtifact={(ref) => <b>anexo {ref}</b>} />,
    );
    expect(page).toContain('<div class="answer-artifact"><b>anexo V1</b></div>');
    expect(page).toContain("<p><span>Resumo abaixo:</span></p>");
    const bubble = renderToStaticMarkup(<AnswerText text={text} />);
    expect(bubble).toContain("abra esta conversa no módulo MAVI");
    expect(bubble).not.toContain("[[V1]]");
  });

  it("enquanto digita, a referência pela metade não aparece", () => {
    expect(hidePartial("Veja:\n[[V")).toBe("Veja:\n");
    expect(hidePartial("Veja:\n[[V1]")).toBe("Veja:\n");
    expect(hidePartial("Veja:\n[[V1]]")).toBe("Veja:\n[[V1]]");
    expect(hidePartial("Fonte [S1")).toBe("Fonte ");
  });
});

describe("imagens em Quem usa qual modelo", () => {
  it("uma funcionalidade própria, só com modelos de imagem, sem herdar a empresa", () => {
    const f = FEATURES.find((x) => x.id === "image_generation")!;
    expect(f).toMatchObject({ images: true, conversation: false, env: "IMAGE_MODEL" });
    expect(serverModel("image_generation", {})).toBe("gpt-image-1");
    expect(serverModel("image_generation", { IMAGE_MODEL: "dall-e-3" })).toBe("dall-e-3");
    expect(isImageModel("gpt-image-1") && isImageModel("imagen-4.0-generate-001")).toBe(true);
    expect(isImageModel("claude-opus-5-5")).toBe(false);
    expect(isNonChatModel("gpt-image-1")).toBe(true);
    const routes: AiRoute[] = [
      { id: "r1", type: "company", scope_id: null, provider_id: "p1", model: "claude-opus-5-5" },
    ];
    expect(pickRoute(routes, { feature: "image_generation" }, new Set(["p1"]))).toBeNull();
    expect(pickRoute(routes, { feature: "notice_writer" }, new Set(["p1"]))?.id).toBe("r1");
  });

  it("o Painel da MAVI tem a aba Poderes", () => {
    expect(aiTab("poderes")).toBe("poderes");
  });
});
