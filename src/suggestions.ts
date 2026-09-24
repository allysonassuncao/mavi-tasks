import {
  parseDescription,
  richTextPlain,
  serializeDescription,
} from "./rich-text";
import type { Snapshot } from "./types";

export type SuggestionKind = "feature" | "bug";
export const suggestionKinds: Record<
  SuggestionKind,
  { label: string; prefix: string; hint: string }
> = {
  feature: {
    label: "Nova funcionalidade",
    prefix: "Funcionalidade",
    hint: "Uma ideia para o sistema fazer algo novo ou melhor.",
  },
  bug: {
    label: "Relatar bug",
    prefix: "Bug",
    hint: "Algo que não funciona como deveria.",
  },
};

/** The task's title: the kind and the description's first line. */
export function suggestionTitle(kind: SuggestionKind, description: string) {
  const { prefix, label } = suggestionKinds[kind];
  const first =
    richTextPlain(description)
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .find(Boolean) ?? "";
  const short = first.length > 90 ? `${first.slice(0, 89).trimEnd()}…` : first;
  return `${prefix}: ${short || label}`;
}

const browsers: [string, RegExp][] = [
  ["Edge", /Edg\/(\d+)/],
  ["Firefox", /Firefox\/(\d+)/],
  ["Chrome", /Chrome\/(\d+)/],
  ["Safari", /Version\/(\d+).*Safari/],
];
const systems: [string, RegExp][] = [
  ["iOS", /iPhone|iPad/],
  ["Android", /Android/],
  ["macOS", /Mac OS X/],
  ["Windows", /Windows/],
  ["Linux", /Linux/],
];

/** "Chrome 140 · macOS", enough to reproduce a bug. */
export function browserLabel(ua: string) {
  let browser = "Navegador desconhecido";
  for (const [name, pattern] of browsers) {
    const version = ua.match(pattern)?.[1];
    if (version) {
      browser = `${name} ${version}`;
      break;
    }
  }
  const system = systems.find(([, pattern]) => pattern.test(ua))?.[0];
  return system ? `${browser} · ${system}` : browser;
}

/** The description plus where it was sent from (page, screen, browser). */
export function withContext(
  description: string,
  where: { path: string; width: number; height: number; userAgent: string },
) {
  const doc = parseDescription(description);
  return serializeDescription({
    ...doc,
    content: [
      ...(doc.content ?? []),
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Enviado de: ", marks: [{ type: "bold" }] },
          {
            type: "text",
            text: `${where.path} · tela ${where.width}×${where.height} · ${browserLabel(where.userAgent)}`,
          },
        ],
      },
    ],
  });
}

/** Active members of the P&D team, by name (the form's "Responsável"). */
export function suggestionAssignees(data: Snapshot) {
  const settings = data.suggestionSettings?.[0];
  if (!settings) return [];
  const ids = new Set(
    data.teamMembers
      .filter((tm) => tm.team_id === settings.team_id)
      .map((tm) => tm.user_id),
  );
  return data.members
    .filter((m) => m.active && ids.has(m.user_id))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

/** A first guess for the P&D team when setting suggestions up. */
export function guessResearchTeam(data: Snapshot) {
  return data.teams.find((t) =>
    /\bp\s*&\s*d\b|pesquisa|desenvolvimento|produto/i.test(t.name),
  )?.id;
}
