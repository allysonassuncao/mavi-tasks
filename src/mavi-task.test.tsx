import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ARTIFACT_LINE, DOCUMENT_MAX, artifactSummary, sanitizeArtifact, sanitizeCanvas, type TaskArtifact } from "./mavi-artifacts";
import { TaskCard, stale } from "./MaviTaskCard";

const card: TaskArtifact = {
  id: "task-card-1",
  ref: "T1",
  type: "task",
  task: "00000000-0000-4000-8000-0000000000f1",
  title: "Passagem de clientes",
  steps: 17,
  estimate: 6.8,
  cap: 10,
};

describe("tarefa longa na conversa", () => {
  it("o card da tarefa: formato fechado, referência T# e o resumo para o histórico", () => {
    expect(sanitizeArtifact(card)).toEqual(card);
    expect(sanitizeArtifact({ ...card, task: "nope" })).toBeNull();
    expect(sanitizeArtifact({ ...card, steps: 400, estimate: -1 })).toMatchObject({ steps: 40, estimate: 0 });
    expect(ARTIFACT_LINE.exec("[[T1]]")?.[1]).toBe("T1");
    expect(artifactSummary(card)).toMatch(/^plano de tarefa longa “Passagem de clientes” \(17 etapas;/);
  });

  it("o documento da tarefa cabe inteiro (bem mais que uma resposta)", () => {
    const markdown = `# Passagem\n\n${"x".repeat(150_000)}`;
    const doc = sanitizeCanvas({ kind: "document", title: "Passagem", markdown });
    expect(doc?.kind === "document" && doc.markdown.length).toBe(markdown.length);
    expect(DOCUMENT_MAX).toBeGreaterThanOrEqual(150_000);
  });

  it("antes de carregar, o card mostra o plano do anexo", () => {
    const html = renderToStaticMarkup(<TaskCard artifact={card} readOnly={false} notify={() => {}} />);
    expect(html).toContain("Tarefa longa");
    expect(html).toContain("Passagem de clientes");
    expect(html).toContain("Carregando o plano…");
    expect(html).toContain("US$ 6,80");
    expect(html).toContain("US$ 10,00");
  });

  it("pausada ou sem sinal da vez: a tela retoma", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    const at = (s: number) => new Date(now - s * 1000).toISOString();
    expect(stale({ status: "paused", lease_until: null, updated_at: at(1) }, now)).toBe(true);
    expect(stale({ status: "running", lease_until: at(-60), updated_at: at(1) }, now)).toBe(false);
    expect(stale({ status: "running", lease_until: at(60), updated_at: at(1) }, now)).toBe(true);
    // Entre uma fatia e outra (sem vez), só depois de um tempo.
    expect(stale({ status: "running", lease_until: null, updated_at: at(20) }, now)).toBe(false);
    expect(stale({ status: "running", lease_until: null, updated_at: at(200) }, now)).toBe(true);
    expect(stale({ status: "done", lease_until: null, updated_at: at(999) }, now)).toBe(false);
  });
});
