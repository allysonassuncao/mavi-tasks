import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  artifactSummary,
  htmlToMarkdown,
  sanitizeArtifact,
  sanitizeCanvas,
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
import { SearchCard, searchCardUrl } from "./MaviSearchCard";
import { readPrepared, searchLinkQuery } from "./task-search-mavi";

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

describe("o botão da Busca avançada (find_tasks)", () => {
  const query = searchLinkQuery({
    request: "logo da Clínica",
    prepared: { terms: ["logo", "logotipo"], topic: "logotipo da marca", summary: "Na conversa." },
    filters: { client: uuid, status: "done", priority: true, fields: ["title", "comments"] },
  });
  it("o link leva termo, termos, assunto e filtros; lido de volta igual", () => {
    const q = new URLSearchParams(query);
    expect(q.get("termo")).toBe("logo da Clínica");
    expect(q.get("cli")).toBe(uuid);
    expect(q.get("situacao")).toBe("done");
    expect(q.get("prioritarias")).toBe("1");
    expect(q.get("em")).toBe("title,comments");
    expect(readPrepared(q.get("mavi"))).toEqual({
      terms: ["logo", "logotipo"],
      topic: "logotipo da marca",
      summary: "Na conversa.",
    });
    expect(readPrepared("{quebrado")).toBeNull();
    expect(readPrepared(JSON.stringify({ t: [], a: "" }))).toBeNull();
  });
  it("o cartão é saneado, conta como anexo B e abre a Busca da agência aberta", () => {
    const card = sanitizeArtifact({ id: "abcd1", ref: "B1", type: "search", query, request: "logo", total: 12 });
    expect(card).toMatchObject({ type: "search", ref: "B1", total: 12 });
    expect(sanitizeArtifact({ id: "abcd1", ref: "B1", type: "search", query: "sem=termo", total: 1 })).toBeNull();
    expect(artifactSummary(card!)).toBe("botão da Busca avançada com “logo” (12 tarefas)");
    expect(searchCardUrl(query, "/agencias/make-agency/mavi")).toBe(`/agencias/make-agency/tarefas/busca?${query}`);
    // Na bolinha, a linha [[B1]] some (o botão aparece abaixo da resposta).
    const bubble = renderToStaticMarkup(<AnswerText text={"Achei estas.\n[[B1]]"} below={["B1"]} />);
    expect(bubble).not.toContain("B1");
    expect(bubble).not.toContain("módulo MAVI");
  });
  it("o cartão diz quantas achou e o pedido", () => {
    const g = globalThis as unknown as { window?: unknown };
    const had = g.window;
    g.window = { location: { pathname: "/agencias/make-agency/mavi" } };
    try {
      const html = renderToStaticMarkup(
        <SearchCard artifact={{ id: "abcd1", ref: "B1", type: "search", query, request: "logo", total: 12 }} />,
      );
      expect(html).toContain("Ver na Busca avançada");
      expect(html).toContain("12 tarefas encontradas · “logo”");
      expect(html).toContain('href="/agencias/make-agency/tarefas/busca?');
    } finally {
      g.window = had;
    }
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

describe("Whatsapp › Perguntar ao histórico em Quem usa qual modelo", () => {
  it("funcionalidade de conversa: vale a regra por cliente e, sem regra, o padrão da empresa", () => {
    const f = FEATURES.find((x) => x.id === "whatsapp_history")!;
    expect(f).toMatchObject({ group: "WhatsApp", conversation: true, env: "AI_MODEL" });
    expect(serverModel("whatsapp_history", { AI_MODEL: "claude-fable-5-1" })).toBe("claude-fable-5-1");
    const routes: AiRoute[] = [
      { id: "r1", type: "company", scope_id: null, provider_id: "p1", model: "claude-opus-5-5" },
      { id: "r2", type: "client", scope_id: "c1", provider_id: "p1", model: "gpt-x" },
    ];
    const active = new Set(["p1"]);
    expect(pickRoute(routes, { feature: "whatsapp_history", client: "c1" }, active)?.id).toBe("r2");
    expect(pickRoute(routes, { feature: "whatsapp_history" }, active)?.id).toBe("r1");
  });
});

describe("HTML que a MAVI escreve no documento", () => {
  it("vira Markdown: cor e destaque viram negrito, o resto fica só o texto", () => {
    expect(htmlToMarkdown('## <span style="color:#C99A2E">Parcial</span> — 01/10 a 07/10')).toBe(
      "## **Parcial** — 01/10 a 07/10",
    );
    expect(htmlToMarkdown("<b>Meta</b> e <em>prazo</em>, <span>sem cor</span>&nbsp;ok")).toBe("**Meta** e *prazo*, sem cor ok");
    expect(htmlToMarkdown('<font color="red"><b>Atenção</b></font>')).toBe("Atenção");
    expect(htmlToMarkdown('veja <a href="https://make.com.br/x">o site</a>')).toBe("veja [o site](https://make.com.br/x)");
    expect(htmlToMarkdown("linha 1<br>linha 2")).toBe("linha 1\nlinha 2");
    expect(htmlToMarkdown("| a<br/>b | c |")).toBe("| a · b | c |");
  });

  it("deixa o que não é tag e os blocos de código", () => {
    const md = "Prazo <5 dias e a<b mas x>y\n```html\n<span>código</span>\n```";
    expect(htmlToMarkdown(md)).toBe(md);
  });

  it("limpa o documento e os slides ao gravar e ao ler", () => {
    const doc = sanitizeCanvas({
      kind: "document",
      title: "Relatório <b>semanal</b>",
      markdown: '# Relatório\n\n## <span style="color:#C99A2E">Parcial</span> — 01/10 a 07/10\n\nTexto.',
    });
    expect(doc).toMatchObject({ title: "Relatório **semanal**" });
    expect(doc?.kind === "document" && doc.markdown).toContain("## **Parcial** — 01/10 a 07/10");
    const slides = sanitizeCanvas({
      kind: "slides",
      title: "Deck",
      slides: [{ layout: "bullets", title: '<span style="color:red">Resultado</span>', bullets: ["um<br>dois"] }],
    });
    expect(slides?.kind === "slides" && slides.slides[0]).toMatchObject({ title: "**Resultado**", bullets: ["um dois"] });
  });
});
