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

describe("memória · Fase 3", () => {
  it("o cartão “Isso ainda vale?” e o “Ainda vale?” do histórico", async () => {
    const { MemoryReviewCard } = await import("./MaviMemory");
    const card = sanitizeArtifact({
      id: "abcd1234",
      ref: "B3",
      type: "memory_review",
      item: "00000000-0000-4000-8000-0000000000a7",
      kind: "context",
      text: "Fecha o mês do 5022.",
      valid_until: "2026-10-01T12:00:00Z",
    });
    expect(card).toMatchObject({ type: "memory_review", kind: "context" });
    expect(sanitizeArtifact({ id: "abcd1234", ref: "B3", type: "memory_review", item: "x", kind: "context", text: "a" })).toBeNull();
    if (card?.type !== "memory_review") throw Error("cartão");
    const html = renderToStaticMarkup(<MemoryReviewCard artifact={card} company="c" readOnly={false} notify={() => {}} />);
    expect(html).toContain("Isso ainda vale?");
    expect(html).toContain("Venceu em 01/10");
    const review = sanitizeArtifact({
      id: "abcd1235",
      ref: "B4",
      type: "dossier_check",
      proposal: "00000000-0000-4000-8000-0000000000b2",
      client: "ACME",
      op: "review",
      kind: "history",
      text: "Reclamou do atraso em março.",
      reasons: ["histórico antigo: ainda vale?"],
      sources: [],
    });
    if (review?.type !== "dossier_check") throw Error("cartão");
    expect(renderToStaticMarkup(<DossierCheckCard artifact={review} company="c" readOnly={false} notify={() => {}} />)).toContain(
      "A MAVI notou sobre ACME: ainda vale?",
    );
  });

  it("o painel: com e sem memória, autonomia, contestados e configuração", async () => {
    const { MemoryReport } = await import("./MaviMemoryPanel");
    const html = renderToStaticMarkup(
      <MemoryReport
        company="c"
        data={data}
        notify={() => {}}
        initial={{
          days: 30,
          answers: {
            with: { answers: 40, up: 9, down: 1, judged: 10, judged_ok: 9 },
            without: { answers: 60, up: 6, down: 4, judged: 10, judged_ok: 7 },
          },
          person: { noted: 5, undone: 1, learned: 8, expired: 2, people: 6 },
          proposals: { confirmed: 18, refused: 2, auto: 4, suggested: 3 },
          applied: 12,
          autonomy: [
            { kind: "style", decided: 20, confirmed: 19, window: 20, rate: 0.95, contests: 0, auto: true },
            { kind: "rule", decided: 4, confirmed: 2, window: 20, rate: 0.5, contests: 1, auto: false },
          ],
          contested: [
            { id: "p", client: "4282", client_id: "k", kind: "rule", text: "Aprovação com a Bia.", reason: "Agora é o Pedro", status: "contested", origin: "mavi", by: "u1", at: now },
          ],
          cost: { dossier: 0.5, dossier_check: 0.02, profile: 0.1 },
          settings: {
            dossier_autonomy: true,
            autonomy_window: 20,
            autonomy_rate: 0.9,
            contest_limit: 3,
            history_days: 120,
            summary_leaders: false,
            updated_by: null,
            updated_at: null,
          },
        }}
      />,
    );
    expect(html).toContain("👍 com memória");
    expect(html).toContain("90%");
    expect(html).toContain("sem memória: 60%");
    expect(html).toContain("12 item(ns) entraram direto");
    expect(html).toContain("90% confirmadas");
    expect(html).toContain("4</strong> entraram sozinhas");
    expect(html).toContain("Entra direto");
    expect(html).toContain("Pede confirmação");
    expect(html).toContain("Aprovação com a Bia.");
    expect(html).toContain("Bruno Equipe");
    expect(html).toContain("US$ 0,62");
    expect(html).toContain("leitura dos dossiês (a rotina que mantém o dossiê de cada cliente): US$ 0,50");
    expect(html).toContain("Ligada: o tipo que a MAVI vem acertando entra direto");
    expect(html).toContain("<legend>Revisão semanal</legend>");
  });

  it("o custo: 2 casas; abaixo de 1 centavo, até 4", async () => {
    const { money } = await import("./MaviMemoryPanel");
    expect(money(20.5297)).toBe("US$ 20,53");
    expect(money(0.0008)).toBe("US$ 0,0008");
    expect(money(0)).toBe("US$ 0,00");
  });
});
