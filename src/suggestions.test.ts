import { describe, it, expect } from "vitest";
import {
  browserLabel,
  guessResearchTeam,
  suggestionAssignees,
  suggestionTitle,
  withContext,
} from "./suggestions";
import { richTextPlain, serializeDescription } from "./rich-text";
import { screenshotName } from "./screenshot";
import type { Snapshot } from "./types";

const rich = (...lines: string[]) =>
  serializeDescription({
    type: "doc",
    content: lines.map((text) => ({
      type: "paragraph",
      content: text ? [{ type: "text", text }] : [],
    })),
  });

describe("Sugestões", () => {
  it("título vem do tipo e da primeira linha da descrição", () => {
    expect(
      suggestionTitle("bug", rich("", "  Relatório   não abre ", "Detalhes")),
    ).toBe("Bug: Relatório não abre");
    expect(suggestionTitle("feature", rich("Exportar em PDF"))).toBe(
      "Funcionalidade: Exportar em PDF",
    );
  });

  it("título longo é encurtado; sem texto usa o tipo", () => {
    const title = suggestionTitle("bug", rich("a".repeat(200)));
    expect(title.length).toBe("Bug: ".length + 90);
    expect(title.endsWith("…")).toBe(true);
    expect(suggestionTitle("feature", "")).toBe(
      "Funcionalidade: Nova funcionalidade",
    );
  });

  it("descrição leva a página, a tela e o navegador", () => {
    const text = richTextPlain(
      withContext(rich("Botão some"), {
        path: "/tarefas",
        width: 1440,
        height: 900,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      }),
    );
    expect(text).toBe(
      "Botão some\nEnviado de: /tarefas · tela 1440×900 · Chrome 140 · macOS",
    );
  });

  it("reconhece os navegadores comuns", () => {
    expect(
      browserLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0",
      ),
    ).toBe("Edge 140 · Windows");
    expect(
      browserLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari 18 · iOS");
    expect(
      browserLabel("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Firefox/130.0"),
    ).toBe("Firefox 130 · Linux");
  });

  it("responsáveis são os membros ativos da equipe de P&D", () => {
    const data = {
      members: [
        { user_id: "z", name: "Zeca", active: true },
        { user_id: "a", name: "Ana", active: true },
        { user_id: "i", name: "Inativo", active: false },
        { user_id: "o", name: "Outra equipe", active: true },
      ],
      teams: [
        { id: "t1", name: "Comercial" },
        { id: "pd", name: "P&D" },
      ],
      teamMembers: [
        { team_id: "pd", user_id: "z" },
        { team_id: "pd", user_id: "a" },
        { team_id: "pd", user_id: "i" },
        { team_id: "t1", user_id: "o" },
      ],
      suggestionSettings: [{ team_id: "pd", contract_id: "c" }],
    } as unknown as Snapshot;
    expect(suggestionAssignees(data).map((m) => m.name)).toEqual([
      "Ana",
      "Zeca",
    ]);
    expect(guessResearchTeam(data)).toBe("pd");
    expect(
      suggestionAssignees({ ...data, suggestionSettings: [] } as Snapshot),
    ).toEqual([]);
  });

  it("nome da captura de tela traz data e hora", () => {
    expect(screenshotName(new Date(2026, 8, 24, 14, 5, 30))).toBe(
      "captura-2026-09-24-14h05m30s.png",
    );
  });
});
