import {
  DESCRIPTION_PREFIX,
  parseDescription,
  serializeDescription,
  type RichNode,
} from "./rich-text";

/**
 * A MAVI escreve o tutorial (api/_tutorial-writer.ts): o texto aberto vai
 * como linhas simples, com cada imagem ou vídeo trocado por [[MIDIA n]], e
 * a resposta volta em blocos que viram o texto rico do editor. Uma mídia que
 * a MAVI não recolocou entra no fim: nada se perde.
 */
export type WriterMode = "idea" | "video" | "improve";
export type WriterBlock =
  | { type: "heading"; level: 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "steps" | "list"; items: string[] }
  | { type: "media"; n: number };
export type WriterDraft = {
  title: string;
  summary: string;
  blocks: WriterBlock[];
  notes: string;
  references?: number;
  model?: string;
};

const inlineText = (n: RichNode): string =>
  n.type === "text"
    ? n.marks?.some((m) => m.type === "bold")
      ? `**${n.text ?? ""}**`
      : (n.text ?? "")
    : n.type === "hardBreak"
      ? " "
      : n.type === "mention"
        ? `@${n.attrs?.label ?? ""}`
        : (n.content ?? []).map(inlineText).join("");
const hasMedia = (n: RichNode): boolean =>
  n.type === "inlineImage" || n.type === "tutorialVideo" || !!n.content?.some(hasMedia);

/** O texto aberto como a MAVI lê, e as mídias na ordem dos [[MIDIA n]]. */
export function writerOutline(body: string): { text: string; media: RichNode[] } {
  const media: RichNode[] = [];
  const lines: string[] = [];
  for (const node of parseDescription(body).content ?? []) {
    if (hasMedia(node)) {
      media.push(node);
      const label = node.type === "tutorialVideo" ? node.attrs?.label : "";
      lines.push(`[[MIDIA ${media.length}]]${node.type === "tutorialVideo" ? ` (vídeo${label ? `: ${label}` : ""})` : " (imagem)"}`);
      continue;
    }
    if (node.type === "heading") {
      const t = inlineText(node).trim();
      if (t) lines.push(`${node.attrs?.level === 3 ? "###" : "##"} ${t}`);
    } else if (node.type === "bulletList" || node.type === "orderedList") {
      (node.content ?? []).forEach((item, i) => {
        const t = inlineText(item).trim();
        if (t) lines.push(`${node.type === "orderedList" ? `${i + 1}.` : "-"} ${t}`);
      });
    } else {
      const t = inlineText(node).trim();
      if (t) lines.push(t);
    }
  }
  return { text: lines.join("\n"), media };
}

/** "Clique em **Salvar**" com o negrito como marca. */
export function inlineNodes(text: string): RichNode[] {
  const out: RichNode[] = [];
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  for (const p of parts) {
    if (!p) continue;
    const bold = /^\*\*[^*]+\*\*$/.test(p);
    const t = bold ? p.slice(2, -2) : p.replace(/\*\*/g, "");
    if (t) out.push(bold ? { type: "text", text: t, marks: [{ type: "bold" }] } : { type: "text", text: t });
  }
  return out;
}

const paragraph = (text: string): RichNode => ({ type: "paragraph", content: inlineNodes(text) });
const listOf = (type: "bulletList" | "orderedList", items: string[]): RichNode => ({
  type,
  content: items.map((i) => ({ type: "listItem", content: [paragraph(i)] })),
});

/** Os blocos da MAVI como o texto rico do editor (as mídias no lugar, as que sobraram no fim). */
export function draftBody(blocks: WriterBlock[], media: RichNode[]): string {
  const used = new Set<number>();
  const content: RichNode[] = [];
  for (const b of blocks) {
    if (b.type === "heading")
      content.push({ type: "heading", attrs: { level: b.level }, content: inlineNodes(b.text) });
    else if (b.type === "paragraph") content.push(paragraph(b.text));
    else if (b.type === "steps") content.push(listOf("orderedList", b.items));
    else if (b.type === "list") content.push(listOf("bulletList", b.items));
    else if (b.type === "media" && media[b.n - 1] && !used.has(b.n)) {
      used.add(b.n);
      content.push(media[b.n - 1]);
    }
  }
  media.forEach((m, i) => {
    if (!used.has(i + 1)) content.push(m);
  });
  return serializeDescription({ type: "doc", content: content.length ? content : [{ type: "paragraph" }] });
}

/** Os vídeos do tutorial com transcrição (os enviados e os de link). */
export function transcribedVideos(
  body: string,
  media: { id: string; name: string; transcript?: string | null }[],
): { key: string; label: string; transcript: string }[] {
  const out: { key: string; label: string; transcript: string }[] = [];
  const seen = new Set<string>();
  const walk = (n: RichNode) => {
    if (n.type === "tutorialVideo") {
      const id = n.attrs?.mediaId;
      if (id) {
        const m = media.find((x) => x.id === id);
        if (m?.transcript?.trim() && !seen.has(id)) {
          seen.add(id);
          out.push({ key: id, label: n.attrs?.label || m.name, transcript: m.transcript });
        }
      } else if (n.attrs?.transcript?.trim()) {
        const key = `${n.attrs.provider}:${n.attrs.videoId}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ key, label: n.attrs.label || "Vídeo de link", transcript: n.attrs.transcript });
        }
      }
    }
    n.content?.forEach(walk);
  };
  if (body.startsWith(DESCRIPTION_PREFIX)) walk(parseDescription(body));
  // Enviados que ainda não estão no texto também servem.
  for (const m of media)
    if (m.transcript?.trim() && !seen.has(m.id)) {
      seen.add(m.id);
      out.push({ key: m.id, label: m.name, transcript: m.transcript });
    }
  return out;
}
