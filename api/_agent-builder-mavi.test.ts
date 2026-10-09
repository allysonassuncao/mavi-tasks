import { describe, expect, it } from "vitest";
import { draftText, parseBuilderReply } from "./_agent-builder-mavi";
import { checkFieldValue, fieldsGuide, hoursText } from "../src/agent-fields";

const reply = (o: unknown) => JSON.stringify(o);

describe("catálogo dos campos", () => {
  it("confere tipos e normaliza", () => {
    expect(checkFieldValue("persona.reply_size", "medium")).toEqual({ ok: true, value: "medium" });
    expect(checkFieldValue("persona.reply_size", "short")).toEqual({ ok: true, value: undefined }); // padrão
    expect(checkFieldValue("persona.reply_size", "gigante").ok).toBe(false);
    expect(checkFieldValue("buffer.seconds", 15)).toEqual({ ok: true, value: 15 });
    expect(checkFieldValue("buffer.seconds", 999).ok).toBe(false);
    expect(checkFieldValue("instructions.rules", ["- Uma", "Uma", " Duas "])).toEqual({ ok: true, value: ["Uma", "Duas"] });
    expect(checkFieldValue("knowledge.rerank", "sim").ok).toBe(false);
    expect(checkFieldValue("persona.idade", "x").ok).toBe(false);
  });

  it("horário da semana", () => {
    const ok = checkFieldValue("instructions.weekly_hours", { mon: { from: "09:00", to: "18:00" }, sun: null });
    expect(ok.ok).toBe(true);
    expect(checkFieldValue("instructions.weekly_hours", { mon: { from: "18:00", to: "09:00" } }).ok).toBe(false);
    expect(checkFieldValue("instructions.weekly_hours", { feriado: null }).ok).toBe(false);
    const week = { mon: { from: "09:00", to: "18:00" }, tue: { from: "09:00", to: "18:00" }, wed: { from: "09:00", to: "18:00" }, thu: { from: "09:00", to: "18:00" }, fri: { from: "09:00", to: "18:00" }, sat: { from: "09:00", to: "12:00" }, sun: null };
    expect(hoursText(week)).toBe("Segunda a sexta: 09:00 às 18:00 · Sábado: 09:00 às 12:00 · Domingo: fechado");
  });

  it("o guia para a MAVI cita todos os caminhos", () => {
    const g = fieldsGuide();
    expect(g).toContain("persona.tone");
    expect(g).toContain("instructions.weekly_hours");
    expect(g).toContain("model.model");
  });
});

describe("proposta da MAVI", () => {
  const draft = { persona: { name: "Clara", company: "Make", tone: "formal, educado e profissional" }, instructions: { goal: "Vender" } };

  it("campos válidos entram com o antes e o depois; inválidos e iguais ficam de fora", () => {
    const r = parseBuilderReply(
      reply({
        message: "Fiz uma proposta.",
        proposal: {
          summary: "Perfil",
          fields: [
            { path: "persona.tone", value: "descontraído, leve e próximo", why: "site" },
            { path: "persona.name", value: "Clara" }, // igual: some
            { path: "persona.emoji", value: "muitos" }, // opção inválida
            { path: "persona.cor", value: "azul" }, // campo desconhecido
            { path: "buffer.seconds", value: 15 },
          ],
        },
      }),
      draft,
      [],
    );
    expect(r.proposal?.fields.map((f) => [f.path, f.before, f.after])).toEqual([
      ["persona.tone", "Formal", "Descontraído"],
      ["buffer.seconds", "(padrão)", "Paciente (15 s)"],
    ]);
    expect(r.proposal?.skipped.length).toBe(2);
  });

  it("itens da base conferidos; arquivo só se foi anexado", () => {
    const r = parseBuilderReply(
      reply({
        message: "ok",
        proposal: {
          knowledge: [
            { kind: "faq", item: { question: "Aceita cartão?", answer: "Sim, em até 12x." } },
            { kind: "faq", item: { question: "Sem resposta" } },
            { kind: "product", item: { name: "Plano Pro", price: "R$ 997", attributes: { mensagens: "10 mil" } } },
            { kind: "document", item: { url: "http://inseguro.com" } },
            { kind: "file", item: { file: "tabela.pdf", title: "Tabela" } },
            { kind: "file", item: { file: "outro.pdf" } },
          ],
        },
      }),
      draft,
      ["tabela.pdf"],
    );
    expect(r.proposal?.knowledge.map((k) => k.kind)).toEqual(["faq", "product", "file"]);
    expect(r.proposal?.knowledge[2]).toMatchObject({ file: "tabela.pdf", item: { kind: "document", title: "Tabela" } });
    expect(r.proposal?.skipped).toHaveLength(3);
  });

  it("perguntas com opções; no máximo 3", () => {
    const r = parseBuilderReply(
      reply({ message: "Oi", questions: [1, 2, 3, 4].map((n) => ({ text: `P${n}`, options: ["a", "b"], multiple: n === 1 })) }),
      {},
      [],
    );
    expect(r.questions).toHaveLength(3);
    expect(r.questions[0]).toEqual({ text: "P1", options: ["a", "b"], multiple: true });
    expect(r.proposal).toBeNull();
  });

  it("sem JSON: o texto vira a mensagem", () => {
    expect(parseBuilderReply("Olá! Me conta do cliente.", {}, [])).toEqual({ message: "Olá! Me conta do cliente.", questions: [], proposal: null });
  });

  it("rascunho em palavras para a MAVI", () => {
    const t = draftText({ persona: { name: "Clara", reply_size: "medium" }, instructions: { rules: ["A", "B"] } });
    expect(t).toContain("persona.name (Nome do agente): Clara");
    expect(t).toContain("persona.reply_size (Tamanho das respostas): Médias");
    expect(t).toContain("instructions.rules (Regras que o agente segue): A · B");
    expect(draftText({})).toContain("vazio");
  });
});
