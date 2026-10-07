import { describe, expect, it } from "vitest";
import {
  actorName,
  describeEntry,
  modelsDiff,
  type LogNames,
  type SettingsLogEntry,
} from "./ai-settings-log";

const names: LogNames = {
  person: (id) => ({ u1: "Ana Admin", u2: "Gabi Gestora" })[id],
  team: (id) => ({ t1: "Tráfego" })[id],
  feature: (id) => ({ assistant: "Assistente (bolinha)" })[id],
  scope: (area, id) => (area === "client" && id === "c1" ? "ACME" : undefined),
  kind: (k) => ({ anthropic: "Claude", openai: "OpenAI" })[k],
  effort: (e) => ({ high: "Alto", max: "Máximo" })[e],
};
const entry = (e: Partial<SettingsLogEntry>): SettingsLogEntry => ({
  id: 1,
  at: "2026-10-02T12:00:00Z",
  actor: "u1",
  area: "feature",
  subject: "assistant",
  subject_label: "",
  field: "model",
  action: "changed",
  old: null,
  new: null,
  cause: null,
  ...e,
});

describe("histórico de Quem usa qual modelo", () => {
  it("troca de modelo, com o padrão de cada seção quando não há regra", () => {
    expect(
      describeEntry(
        entry({
          old: {
            provider_id: "p1",
            provider: "Claude",
            model: "claude-a",
            model_label: "Sonnet",
          },
          new: { provider_id: "p2", provider: "OpenAI", model: "gpt-a" },
        }),
        names,
      ),
    ).toMatchObject({
      where: "Por funcionalidade › Assistente (bolinha)",
      field: "Provedor e modelo",
      from: "Claude · Sonnet",
      to: "OpenAI · gpt-a",
    });
    expect(
      describeEntry(
        entry({
          area: "company",
          subject: "",
          action: "removed",
          old: { provider_id: "p1", model: "m" },
        }),
        names,
      ),
    ).toMatchObject({
      where: "Padrão da empresa › Empresa toda",
      from: "Provedor removido · m",
      to: "Padrão do servidor",
    });
    expect(
      describeEntry(
        entry({
          area: "client",
          subject: "c1",
          subject_label: "ACME antigo",
          action: "created",
          new: { provider_id: "p", provider: "X", model: "m" },
        }),
        names,
      ),
    ).toMatchObject({
      where: "Clientes › ACME",
      from: "Sem regra (vale a mais geral)",
    });
    // Cliente apagado: o nome da hora.
    expect(
      describeEntry(
        entry({ area: "client", subject: "c9", subject_label: "Velho" }),
        names,
      ).where,
    ).toBe("Clientes › Velho");
  });

  it("esforço, ligado/desligado, chave e a causa do que muda sozinho", () => {
    expect(
      describeEntry(
        entry({
          field: "effort",
          old: { effort: "high" },
          new: null,
          action: "removed",
        }),
        names,
      ),
    ).toMatchObject({ field: "Esforço", from: "Alto", to: "Automático" });
    expect(
      describeEntry(
        entry({
          area: "provider",
          subject: "p1",
          subject_label: "Claude",
          field: "active",
          old: true,
          new: false,
        }),
        names,
      ),
    ).toMatchObject({
      where: "Provedores e modelos › Claude",
      from: "Ligado",
      to: "Desligado",
    });
    const key = describeEntry(
      entry({
        area: "provider",
        field: "key",
        old: { key_hint: "aaaa" },
        new: { key_hint: "bbbb" },
      }),
      names,
    );
    expect(key.text).toContain("termina em bbbb");
    expect(
      describeEntry(
        entry({
          area: "user",
          subject: "u9",
          subject_label: "Bruno",
          action: "removed",
          cause: { type: "provider_deleted", label: "Claude" },
        }),
        names,
      ).cause,
    ).toBe("Automático: o provedor Claude foi excluído");
    const baseline = describeEntry(
      entry({
        action: "created",
        new: { provider_id: "p", provider: "X", model: "m" },
        cause: { type: "baseline" },
      }),
      names,
    );
    expect(baseline.cause).toMatch(/já existia/);
    expect(baseline.from).toBeUndefined();
    expect(baseline.to).toBe("X · m");
  });

  it("modelos do provedor: o que entrou, saiu e mudou de preço", () => {
    expect(
      modelsDiff(
        [
          { id: "a", input: 1, output: 5 },
          { id: "b", input: 1, output: 5 },
        ],
        [
          { id: "a", label: "A", input: 2, output: 6 },
          { id: "c", input: 3, output: 9, cached: 0.3 },
        ],
      ),
    ).toBe(
      "Entrou: c (3/9 (cache 0.3)); Saiu: b; Preço de A: 1/5 → 2/6; Nome de a: — → A.",
    );
  });

  it("animações: pessoas e equipes por nome; vazio é todos os líderes", () => {
    expect(
      describeEntry(
        entry({
          area: "animation",
          subject: "p1|m",
          subject_label: "Claude · m",
          field: "access",
          old: { user_ids: [], team_ids: [] },
          new: { user_ids: ["u2"], team_ids: ["t1"] },
        }),
        names,
      ),
    ).toMatchObject({
      where: "Animações do Mural › Claude · m",
      from: "Todos os líderes · qualquer equipe",
      to: "Gabi Gestora · Tráfego",
    });
    expect(
      describeEntry(
        entry({
          area: "animation",
          subject: "",
          field: "knowledge",
          old: true,
          new: false,
        }),
        names,
      ),
    ).toMatchObject({
      where: "Animações do Mural › Base de conhecimento",
      from: "Sim",
      to: "Não",
    });
  });

  it("quem alterou: o sistema ou a pessoa removida", () => {
    expect(actorName(entry({ actor: null }), names)).toBe("Sistema");
    expect(actorName(entry({ actor: "u1" }), names)).toBe("Ana Admin");
    expect(actorName(entry({ actor: "u9" }), names)).toBe("Pessoa removida");
  });
});

describe("histórico do Roteamento", () => {
  const withProviders: LogNames = { ...names, provider: (id) => ({ p1: "OpenAI da agência" })[id] };
  it("modo, nível, telas, provedores (com o Servidor) e o Automático em palavras", () => {
    expect(
      describeEntry(entry({ area: "router", subject: "", field: "mode", old: { mode: "shadow" }, new: { mode: "active" } }), withProviders),
    ).toMatchObject({ where: "Roteamento › Empresa toda", field: "Modo do roteador", from: "Sombra", to: "Ativo" });
    expect(
      describeEntry(
        entry({ area: "router", subject: "", field: "surface_levels", old: { surface_levels: {} }, new: { surface_levels: { copilot: "maxima" } } }),
        withProviders,
      ),
    ).toMatchObject({ from: "Todas as telas com o da empresa", to: "Copiloto: Máxima qualidade" });
    expect(
      describeEntry(
        entry({
          area: "router",
          subject: "",
          field: "providers",
          old: { providers: null },
          new: { providers: ["00000000-0000-0000-0000-000000000000", "p1", "p9"] },
        }),
        withProviders,
      ),
    ).toMatchObject({ from: "Todos", to: "Servidor, OpenAI da agência, Provedor removido" });
    expect(
      describeEntry(entry({ area: "client", subject: "c1", field: "sigiloso", action: "created", new: { sigiloso: true } }), withProviders),
    ).toMatchObject({ where: "Clientes › ACME", field: "Sigiloso", from: undefined, to: "Sim" });
    expect(
      describeEntry(entry({ field: "auto", old: { auto: false }, new: { auto: true } }), withProviders),
    ).toMatchObject({ field: "Automático (o roteador escolhe)", from: "Não", to: "Sim" });
    expect(
      describeEntry(entry({ area: "user", subject: "u2", field: "level", action: "removed", old: { level: "economico" } }), withProviders),
    ).toMatchObject({ from: "Econômico", to: "O da tela ou da empresa" });
    expect(
      describeEntry(entry({ area: "router", subject: "", field: "judge_sample", old: { judge_sample: 0.1 }, new: { judge_sample: 0.25 } }), withProviders),
    ).toMatchObject({ field: "Amostra para a autoavaliação", from: "10%", to: "25%" });
    expect(
      describeEntry(entry({ area: "router", subject: "", field: "eval_daily_cap", old: { eval_daily_cap: 0.5 }, new: { eval_daily_cap: 2 } }), withProviders),
    ).toMatchObject({ field: "Teto por dia dos testes", from: "US$ 0,5", to: "US$ 2" });
    expect(
      describeEntry(entry({ area: "router", subject: "", field: "gate_min", old: { gate_min: 0.8 }, new: { gate_min: 0.85 } }), withProviders),
    ).toMatchObject({ field: "Nota mínima para aprovar", from: "80%", to: "85%" });
  });
});
