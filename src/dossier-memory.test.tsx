import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ClientDossier, type Dossier } from "./ClientDossier";
import { DossierCheckCard, MemoryChip } from "./MaviMemory";
import { sanitizeArtifact } from "./mavi-artifacts";
import { isNew } from "./dossier-memory";
import type { Snapshot } from "./types";

const now = new Date().toISOString();
const old = "2026-09-01T12:00:00Z";
const data = { members: [{ user_id: "u1", name: "Bruno Equipe" }, { user_id: "u2", name: "Gabi Gestora" }] } as unknown as Snapshot;
const proposal = {
  id: "p1",
  op: "add" as const,
  item_id: null,
  kind: "rule" as const,
  text: "Toda peça passa pela Joana.",
  previous: null,
  sources: [{ type: "meeting", title: "Alinhamento", date: "2026-10-01" }],
  seen_at: null,
  reasons: ["regra ou combinado"],
  note: null,
  status: "suggested",
  contest_reason: null,
  created_by: null,
  created_at: now,
  expires_at: "2026-10-21T12:00:00Z",
};
const dossier: Dossier = {
  version: 3,
  built_at: now,
  pending: false,
  failed: false,
  can_edit: false,
  can_confirm: true,
  items: [
    { id: "a", kind: "style", text: "Tom leve.", origin: "mavi", pinned: false, dismissed: false, sources: [], seen_at: null, updated_at: now, updated_by: null, created_at: now },
    { id: "b", kind: "avoids", text: "Sem vermelho.", origin: "mavi", pinned: false, dismissed: false, sources: [], seen_at: null, updated_at: old, updated_by: null, created_at: old },
  ],
  proposals: [proposal],
  contested: [{ ...proposal, id: "p2", op: "contest", status: "contested", contest_reason: "Agora é o Pedro", created_by: "u1" }],
};

describe("memória por cliente · telas", () => {
  it("o dossiê de quem trabalha com o cliente: para confirmar, novo e contestar (sem os contestados dos líderes)", () => {
    const html = renderToStaticMarkup(
      <ClientDossier company="c" client="k" clientName="ACME" data={data} notify={() => {}} initial={dossier} />,
    );
    expect(html).toContain("Para confirmar");
    expect(html).toContain("Toda peça passa pela Joana.");
    expect(html).toContain("Pede confirmação: regra ou combinado");
    expect(html).toContain("Está certo");
    expect(html).toContain("Não está");
    expect(html.match(/class="dossier-new"/g)?.length).toBe(1);
    expect(html.match(/aria-label="Está errado"/g)?.length).toBe(2);
    expect(html).not.toContain("Contestados");
  });

  it("para os líderes: os contestados, com quem contestou e por quê", () => {
    const html = renderToStaticMarkup(
      <ClientDossier company="c" client="k" clientName="ACME" data={data} notify={() => {}} initial={{ ...dossier, can_edit: true }} />,
    );
    expect(html).toContain("Contestados");
    expect(html).toContain("contestado por Bruno Equipe");
    expect(html).toContain("“Agora é o Pedro”");
    expect(html).toContain("Restaurar");
    expect(html).toContain("Descartar");
    expect(html).not.toContain('aria-label="Está errado"');
  });

  it("o cartão “Confere?” e o chip com o cliente", () => {
    const card = sanitizeArtifact({
      id: "abcd1234",
      ref: "B2",
      type: "dossier_check",
      proposal: "00000000-0000-4000-8000-0000000000b1",
      client: "ACME",
      op: "update",
      kind: "rule",
      text: "Aprovação com o Pedro.",
      previous: "Aprovação com a Bia.",
      reasons: ["regra ou combinado", 3],
      sources: [{ type: "meeting", title: "Alinhamento", date: "2026-10-01" }, "x"],
    });
    expect(card).toMatchObject({ type: "dossier_check", op: "update", reasons: ["regra ou combinado"] });
    expect(sanitizeArtifact({ id: "abcd1234", ref: "B2", type: "dossier_check", proposal: "x", kind: "rule", text: "a" })).toBeNull();
    if (card?.type !== "dossier_check") throw Error("cartão");
    const html = renderToStaticMarkup(<DossierCheckCard artifact={card} company="c" readOnly={false} notify={() => {}} />);
    expect(html).toContain("A MAVI notou sobre ACME: mudou?");
    expect(html).toContain("“Aprovação com o Pedro.”");
    expect(html).toContain("antes: “Aprovação com a Bia.”");
    expect(html).toContain("Pede confirmação: regra ou combinado · De: Alinhamento");
    const chip = renderToStaticMarkup(<MemoryChip company="c" ids={["a"]} clientIds={["b", "c"]} notify={() => {}} />);
    expect(chip).toContain("Memória · 3");
  });

  it("novo: só o da MAVI, por 7 dias", () => {
    const t = Date.parse("2026-10-07T12:00:00Z");
    expect(isNew({ origin: "mavi", created_at: "2026-10-02T12:00:00Z" }, t)).toBe(true);
    expect(isNew({ origin: "mavi", created_at: "2026-09-29T12:00:00Z" }, t)).toBe(false);
    expect(isNew({ origin: "person", created_at: "2026-10-06T12:00:00Z" }, t)).toBe(false);
  });
});
