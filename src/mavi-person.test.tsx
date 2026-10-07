import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MaviPersonProfile, logLine } from "./MaviPersonProfile";
import { MemoryCard, MemoryChip } from "./MaviMemory";
import { sanitizeArtifact } from "./mavi-artifacts";
import { TRAIT_KINDS, sourcesLabel, validityLabel, type PersonProfile } from "./mavi-person";
import type { Snapshot } from "./types";

const now = "2026-09-30T15:00:00Z";
const profile: PersonProfile = {
  user: "u1",
  self: true,
  built_at: now,
  pending: false,
  items: [
    { id: "a", kind: "preference", text: "Responda listas de clientes em tabela.", origin: "mavi", pinned: false, dismissed: false, updated_at: now, updated_by: null },
    { id: "b", kind: "preference", text: "Seja direta.", origin: "person", pinned: true, dismissed: false, updated_at: now, updated_by: "u1" },
    { id: "c", kind: "context", text: "Cuida do Squad Primogênito.", origin: "leader", pinned: true, dismissed: false, updated_at: now, updated_by: "u2" },
    { id: "d", kind: "frustration", text: "Removido.", origin: "mavi", pinned: false, dismissed: true, updated_at: now, updated_by: "u1" },
  ],
  facts: { role: "member", teams: ["Squad Primogênito"], clients: [{ id: "k", name: "5022", n: 12 }] },
  history: {
    up: 14,
    down: 3,
    reasons: { incomplete: 2 },
    recent: [{ vote: "down", reason: "incomplete", comment: "Me mande o que pedi", question: "Faça a passagem", at: now }],
  },
};
const data = { members: [{ user_id: "u1", name: "Ana Equipe" }, { user_id: "u2", name: "Gil Gestor" }] } as unknown as Snapshot;

describe("o que a MAVI sabe sobre a pessoa", () => {
  it("os três grupos, quem escreveu, o que o sistema sabe e o histórico", () => {
    const html = renderToStaticMarkup(<MaviPersonProfile company="c" user={null} data={data} notify={() => {}} initial={profile} />);
    expect(html).toContain("O que a MAVI sabe sobre você");
    for (const k of TRAIT_KINDS) expect(html).toContain(k.label);
    expect(html).toContain("Aprendido pela MAVI");
    expect(html).toContain("Escrito por você");
    expect(html).toContain("Escrito por Gil Gestor (gestão)");
    expect(html).toContain("Equipes: Squad Primogênito.");
    expect(html).toContain("Clientes que você mais consulta com a MAVI (90 dias): 5022.");
    expect(html).toContain("Não terminou o pedido (2)");
    expect(html).toContain("“Faça a passagem” · Não terminou o pedido — Me mande o que pedi");
    // O removido fica escondido (com o botão para ver).
    expect(html).not.toContain(">Removido.<");
    expect(html).toContain("Ver os 1 removidos");
    // Só o da MAVI tem fixar.
    expect(html.match(/aria-label="Fixar"/g)?.length).toBe(1);
  });

  it("para um líder, o nome da pessoa", () => {
    const html = renderToStaticMarkup(
      <MaviPersonProfile company="c" user="u1" data={data} notify={() => {}} initial={{ ...profile, self: false }} />,
    );
    expect(html).toContain("O que a MAVI sabe sobre Ana Equipe");
    expect(html).toContain("Escrito por Ana Equipe");
  });
});

describe("memória por pessoa · Fase 1", () => {
  it("situação com validade, vencida apagada, de onde veio e o histórico", () => {
    const html = renderToStaticMarkup(
      <MaviPersonProfile
        company="c"
        user={null}
        data={data}
        notify={() => {}}
        initial={{
          ...profile,
          valid_days: 60,
          items: [
            ...profile.items,
            {
              id: "e",
              kind: "context",
              text: "Fecha o mês do 5022.",
              origin: "person",
              pinned: true,
              dismissed: false,
              updated_at: now,
              updated_by: "u1",
              durability: "situation",
              valid_until: "2026-12-05T12:00:00Z",
              expired: false,
              sources: [{ type: "chat", said: "estou fechando o mês do 5022" }],
            },
            {
              id: "f",
              kind: "context",
              text: "Monta o trimestral.",
              origin: "mavi",
              pinned: false,
              dismissed: false,
              updated_at: now,
              updated_by: null,
              durability: "situation",
              valid_until: "2026-09-01T12:00:00Z",
              expired: true,
              sources: [{ type: "feedback", id: 1 }, { type: "feedback", id: 2 }, { type: "question", message: 3 }],
            },
          ],
          log: [{ action: "edit", kind: "preference", before: "Seja breve.", after: "Seja direta.", actor: "person", by: "u1", at: now }],
        }}
      />,
    );
    expect(html).toContain("Anotado pela MAVI na conversa");
    expect(html).toContain("Situação · vale até 05/12");
    expect(html).toContain("Situação vencida");
    expect(html).toContain("(a MAVI não usa mais)");
    expect(html).toContain('class="expired"');
    expect(html).toContain("De: 2 avaliações, 1 pergunta");
    expect(html.match(/aria-label="Renovar"/g)?.length).toBe(2);
    expect(html).toContain("Ver o histórico de mudanças");
  });

  it("os rótulos", () => {
    expect(validityLabel({ durability: "stable" })).toBe("");
    expect(sourcesLabel({ sources: [{ type: "chat" }, { type: "check", message: 1 }] })).toBe("De: dito na conversa, 1 reclamação");
    const name = (id: string | null) => (id === "u2" ? "Gil Gestor" : "alguém");
    expect(logLine({ action: "edit", kind: "preference", before: "A.", after: "B.", actor: "person", by: "u1", at: now }, true, name)).toBe(
      "Você corrigiu “B.” (era “A.”)",
    );
    expect(logLine({ action: "add", kind: "context", before: null, after: "C.", actor: "mavi", by: "u1", at: now }, true, name)).toBe(
      "A MAVI adicionou “C.”",
    );
    expect(logLine({ action: "dismiss", kind: "context", before: "D.", after: "D.", actor: "leader", by: "u2", at: now }, false, name)).toBe(
      "Gil Gestor removeu “D.”",
    );
  });

  it("o cartão “Anotei” e o chip da memória usada", () => {
    const card = sanitizeArtifact({
      id: "abcd1234",
      ref: "B1",
      type: "memory",
      op: "replace",
      item: "00000000-0000-4000-8000-0000000000a9",
      kind: "preference",
      text: "Responda em tabela.",
      durability: "situation",
      previous: "Responda em tópicos.",
      previous_id: "00000000-0000-4000-8000-0000000000a1",
    });
    expect(card).toMatchObject({ type: "memory", op: "replace", previous_id: "00000000-0000-4000-8000-0000000000a1" });
    expect(sanitizeArtifact({ id: "abcd1234", ref: "B1", type: "memory", item: "x", kind: "preference", text: "a" })).toBeNull();
    if (card?.type !== "memory") throw Error("cartão");
    const html = renderToStaticMarkup(<MemoryCard artifact={card} company="c" readOnly={false} notify={() => {}} />);
    expect(html).toContain("Corrigi na sua memória");
    expect(html).toContain("“Responda em tabela.”");
    expect(html).toContain("antes: “Responda em tópicos.”");
    expect(html).toContain("Passageiro: vale 60 dias.");
    const chip = renderToStaticMarkup(<MemoryChip company="c" ids={["a", "b"]} notify={() => {}} />);
    expect(chip).toContain("Memória · 2");
  });
});
