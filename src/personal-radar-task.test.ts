import { describe, expect, it } from "vitest";
import { sourceLabel, taskPreset } from "./PersonalRadarNextStep";
import type { PersonalItem, PersonalMention, TaskSuggestion } from "./personal-radar";
import { DESCRIPTION_PREFIX, type RichNode } from "./rich-text";

const item = {
  id: "it-1",
  kind: "request",
  title: "Ajustar jornada inicial",
  summary: "",
  group: { id: "g-1", title: "Clínica Sorriso | Make" },
  client: { id: "c-1", name: "Clínica Sorriso" },
  mentions: [{ message_id: "m-9", role: "client", speaker: "Carla", quote: "só a última", at: "2026-10-08T12:00:00Z" }],
  radar: { id: "ri-1", title: "Leads perdendo a paciência" },
  reply: {
    status: "done",
    evidence: [
      {
        title: "Reunião de 01/10",
        detail: "Ficou combinado encurtar a qualificação.",
        source: { ref: "S1", type: "meeting", id: "rec-1", title: "Alinhamento", date: null, client_id: "c-1", start: 754 },
      },
      { title: "Prompt do robô", detail: "Faz 6 perguntas antes de passar para o time." },
    ],
    actions: [],
    checks: [],
    version: 1,
    updated_at: "2026-10-08T12:00:00Z",
  },
} as unknown as PersonalItem;
const suggestion: TaskSuggestion = {
  title: "Ajustar jornada inicial da MAVI",
  description:
    "Contexto: a Carla disse que \"os leads perdem a paciência\" na qualificação.\nO que fazer:\n- Reduzir as perguntas para 3\n- Testar com um lead\nPronto quando: o robô passar o lead em até 3 perguntas.\nUma linha solta.",
  contract_id: "k-1",
  team_id: "t-1",
  due: "2026-10-10",
};
const mentions: PersonalMention[] = [
  { message_id: "m-1", role: "client", speaker: "Carla", quote: "Os leads perdem a paciência", at: "2026-10-07T13:05:00Z" },
  { message_id: "m-2", role: "team", speaker: "Gabi", quote: "Vou ver", at: "2026-10-07T13:10:00Z" },
];
const flat = (n: RichNode): string => (n.text ?? "") + (n.content ?? []).map(flat).join("");
const links = (n: RichNode): string[] => [
  ...(n.marks ?? []).filter((m) => m.type === "link").map((m) => String(m.attrs?.href)),
  ...(n.content ?? []).flatMap(links),
];

describe("Radar pessoal · a descrição da tarefa sugerida", () => {
  it("o texto da MAVI em seções e passos, e as fontes com os links", () => {
    (globalThis as { window?: unknown }).window = { location: { pathname: "/agencias/make/radar/pessoal" } };
    const p = taskPreset(item, suggestion, () => {}, mentions);
    delete (globalThis as { window?: unknown }).window;
    expect(p.team).toBe("t-1");
    expect(p.description?.startsWith(DESCRIPTION_PREFIX)).toBe(true);
    const doc = JSON.parse(p.description!.slice(DESCRIPTION_PREFIX.length)) as RichNode;
    const blocks = doc.content!;
    // Rótulos em negrito.
    expect(blocks[0].content?.[0]).toMatchObject({ text: "Contexto:", marks: [{ type: "bold" }] });
    expect(flat(blocks[1])).toBe("O que fazer:");
    expect(blocks[2].type).toBe("bulletList");
    expect(blocks[2].content?.map(flat)).toEqual(["Reduzir as perguntas para 3", "Testar com um lead"]);
    expect(flat(blocks[3])).toBe("Pronto quando: o robô passar o lead em até 3 perguntas.");
    expect(flat(blocks[4])).toBe("Uma linha solta.");
    // As fontes: todas as falas passadas (não só as da situação), a evidência e o Radar do cliente.
    const text = blocks.map(flat).join("\n");
    expect(text).toContain("Fontes");
    expect(text).toContain("Mensagens no grupo “Clínica Sorriso | Make”:");
    expect(text).toContain("Carla (cliente): “Os leads perdem a paciência”");
    expect(text).toContain("Gabi (time): “Vou ver”");
    expect(text).not.toContain("só a última");
    expect(text).toContain("Reunião de 01/10 — Ficou combinado encurtar a qualificação. · Gravação “Alinhamento” em 12:34");
    expect(text).toContain("Prompt do robô — Faz 6 perguntas antes de passar para o time.");
    const hrefs = blocks.flatMap(links);
    expect(hrefs).toContain("/agencias/make/drive?whatsapp=g-1&msg=m-1");
    expect(hrefs).toContain("/agencias/make/drive?gravacao=rec-1&t=754");
    expect(hrefs).toContain("/agencias/make/radar?item=ri-1");
  });

  it("sem descrição nem fontes, fica sem descrição; o rótulo de cada fonte", () => {
    const p = taskPreset({ ...item, mentions: [], reply: undefined, radar: undefined }, { title: "Algo" }, () => {}, []);
    expect(p.description).toBeUndefined();
    expect(sourceLabel({ ref: "S1", type: "meeting", id: "r", title: "Kickoff", date: null, client_id: null, start: 3725 })).toBe(
      "Gravação “Kickoff” em 1:02:05",
    );
    expect(sourceLabel({ ref: "S1", type: "file", id: "f", title: "Briefing.pdf", date: null, client_id: null, page: 3 })).toBe(
      "Arquivo “Briefing.pdf”, página 3",
    );
  });
});
