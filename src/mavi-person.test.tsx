import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MaviPersonProfile } from "./MaviPersonProfile";
import { TRAIT_KINDS, type PersonProfile } from "./mavi-person";
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
