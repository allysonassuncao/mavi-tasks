import { describe, expect, it, vi } from "vitest";
import type { LlmAdapter } from "./_ai-llm";
import { newMeter } from "./_social-leads";
import {
  agentCheckMessage,
  checkWithAgents,
  inKnowledge,
  knowledgeBlock,
  knowledgeQuery,
  parseAgentChecks,
  type AgentKnowledge,
} from "./_agent-knowledge";

const main: AgentKnowledge = {
  id: "00000000-0000-4000-8000-0000000000b1",
  workflow: "Clínica Sorriso - Atendimento",
  node: "AI Agent",
  product: "MAVI",
  role: "main",
  active: true,
  full: true,
  chars: 120,
  text: "Você é a Bia, da Clínica Sorriso.\n\nHorário: segunda a sexta, das 8h às 18h. Limpeza custa R$ 150.",
};
const big: AgentKnowledge = {
  id: "00000000-0000-4000-8000-0000000000b2",
  workflow: "Clínica Sorriso - Agenda",
  node: "Agendador",
  role: "subflow",
  full: false,
  chars: 90000,
  pieces: ["Você agenda consultas.", "Nunca marque aos domingos."],
};

describe("a base do Agente Conversacional", () => {
  it("numera os prompts, diz quando são só trechos e confere o trecho sem acento nem caixa", () => {
    const { text, refs } = knowledgeBlock([main, big]);
    expect(text).toMatch(/\[K1\] fluxo "Clínica Sorriso - Atendimento" › nó "AI Agent" · produto MAVI/);
    expect(text).toMatch(/\[K2\] .*subfluxo · só os trechos ligados ao caso de um prompt de 90000 caracteres/);
    expect(text).toMatch(/Você agenda consultas\.\n\(…\)\nNunca marque aos domingos\./);
    expect(refs.get("K2")).toBe(big);
    expect(inKnowledge(main, "HORARIO: segunda a sexta")).toBe(true);
    expect(inKnowledge(main, "Horário: sábado")).toBe(false);
    expect(inKnowledge(main, "Bia")).toBe(false); // curto demais para valer
  });

  it("a busca dos trechos usa o que os casos falam", () => {
    expect(
      knowledgeQuery([{ kind: "dúvida", title: "Preço da limpeza", summary: "Quer saber o valor", quotes: ["quanto custa?"] }]),
    ).toBe("Preço da limpeza Quer saber o valor quanto custa?");
  });

  it("a mensagem traz a base e os casos com as falas", () => {
    const { text } = agentCheckMessage("Clínica Sorriso", [
      { kind: "solicitação", title: "Novo horário de sábado", summary: "", quotes: ["agora abrimos sábado de manhã"] },
    ], [main]);
    expect(text).toMatch(/^Cliente: Clínica Sorriso\./);
    expect(text).toMatch(/1\. \[solicitação\] Novo horário de sábado\n {3}fala: "agora abrimos sábado de manhã"/);
  });

  it("só fica o que a base sustenta: trecho de fora sai, 'já tem' sem trecho sai, sugestão só com trecho certo", () => {
    const { refs } = knowledgeBlock([main, big]);
    const checks = parseAgentChecks(
      JSON.stringify({
        cases: [
          {
            case: 1,
            status: "conflict",
            note: "O robô ainda fala do preço antigo.",
            evidence: [{ ref: "K1", excerpt: "Limpeza custa R$ 150." }, { ref: "K1", excerpt: "Limpeza grátis" }],
            suggestion: { ref: "K1", before: "Limpeza custa R$ 150.", after: "Limpeza custa R$ 180.", why: "Preço novo" },
            done: true,
          },
          { case: 2, status: "covered", note: "Já tem.", evidence: [{ ref: "K1", excerpt: "não existe na base" }] },
          {
            case: 3,
            status: "missing",
            note: "Falta o sábado.",
            evidence: [],
            suggestion: { ref: "K1", before: "trecho inventado", after: "Sábado das 8h às 12h.", why: "" },
          },
          {
            case: 4,
            status: "missing",
            note: "Falta o sábado.",
            suggestion: { ref: "K2", before: "", after: "Aos sábados, das 8h às 12h.", why: "Novo horário" },
          },
          { case: 5, status: "covered", evidence: [{ ref: "K2", excerpt: "Nunca marque aos domingos." }], done: true },
          { case: 9, status: "covered" },
          { case: 1, status: "unrelated" },
        ],
      }),
      refs,
      5,
    );
    expect(checks.get(0)).toEqual({
      status: "conflict",
      note: "O robô ainda fala do preço antigo.",
      evidence: [{ prompt_id: main.id, workflow: main.workflow, node: "AI Agent", excerpt: "Limpeza custa R$ 150." }],
      suggestion: {
        prompt_id: main.id,
        workflow: main.workflow,
        node: "AI Agent",
        before: "Limpeza custa R$ 150.",
        after: "Limpeza custa R$ 180.",
        why: "Preço novo",
      },
      // "done" só quando o robô já tem.
      done: false,
    });
    expect(checks.has(1)).toBe(false);
    expect(checks.get(2)?.suggestion).toBeNull();
    expect(checks.get(3)?.suggestion).toMatchObject({ prompt_id: big.id, before: "", after: "Aos sábados, das 8h às 12h." });
    expect(checks.get(4)).toMatchObject({ status: "covered", done: true });
    expect(checks.size).toBe(4);
    expect(parseAgentChecks("sem json", refs, 1).size).toBe(0);
  });

  it("confere em lotes de 12 e soma o custo", async () => {
    const llm: LlmAdapter = vi.fn(async (req) => {
      const meter = newMeter("claude-haiku-4-5");
      meter.input = 100;
      meter.cost = 0.001;
      const n = (req.messages[0].content.match(/^\d+\. /gm) ?? []).length;
      return {
        text: JSON.stringify({ cases: Array.from({ length: n }, (_, i) => ({ case: i + 1, status: "unrelated", note: "x" })) }),
        meter,
        rounds: 1,
      };
    });
    const cases = Array.from({ length: 14 }, (_, i) => ({ kind: "dúvida", title: `Caso ${i}`, summary: "", quotes: [] }));
    const run = await checkWithAgents(llm, "Clínica", cases, [main]);
    expect(llm).toHaveBeenCalledTimes(2);
    expect(run.checks.size).toBe(14);
    expect(run.checks.get(13)?.status).toBe("unrelated");
    expect(run.meter).toMatchObject({ input: 200, cost: 0.002 });
  });
});
