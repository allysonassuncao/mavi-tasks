import { callRpc } from "./_drive.js";
import type { ToolOutput, ToolSpec } from "./_ai-llm.js";
import { add, type PowerKit } from "./_ai-powers.js";
import { localRenderer, resolveClient } from "./_ai-art.js";
import { IDENTITY_PARAMS, keepAllowed, lookForCanvas, renderAssets, renderRemote } from "./_ai-identity.js";
import type { CanvasArtifact, ImageArtifact } from "../src/mavi-artifacts.js";
import { sanitizeCanvas } from "../src/mavi-artifacts.js";
import {
  DESIGN_FORMATS,
  DESIGN_FORMAT_KEYS,
  DESIGN_PAGES_MAX,
  cleanDesignHtml,
  countPages,
  designPage,
  designTokens,
  type DesignFormat,
} from "../src/mavi-design.js";
import { logoFor, type Look } from "../src/visual-identity.js";

/**
 * MAVI · design livre (Fase 2 das identidades visuais): a MAVI escreve as
 * páginas em HTML e CSS, o Chromium desenha e devolve as prévias com a
 * conferência automática, para ela corrigir antes de mostrar — como nas
 * artes (render_art), mas com várias páginas e saída em PDF, .html e
 * PowerPoint (as páginas como imagens).
 */

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export const DESIGN_TOOL: ToolSpec = {
  name: "design_document",
  description:
    "Monta um documento ou apresentação com design livre: você escreve as páginas em HTML e CSS e recebe as prévias de volta (com o que a conferência automática achou) para corrigir antes de mostrar. A pessoa baixa em PDF, .html e, nos slides, PowerPoint com cada página como imagem. Use quando o pedido precisa de um layout próprio (proposta comercial caprichada, one-pager, e-book, relatório visual, catálogo, apresentação especial, 'mais bonito', 'no estilo do site'); para algo que a pessoa vai editar no Word ou no PowerPoint, use create_document ou create_presentation. Devolve a referência (ex.: D1).",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      format: {
        type: "string",
        enum: DESIGN_FORMAT_KEYS,
        description: "a4 (A4 em pé, 794×1123 px, padrão), a4_landscape (1123×794), slides (16:9, 1280×720) ou square (1080×1080).",
      },
      html: {
        type: "string",
        description:
          'As páginas: cada uma é um <section class="page"> (já tem o tamanho exato do formato, overflow escondido); para texto longo que continua nas páginas seguintes, <section class="page flow">. Estilos num <style>. Com identidade, use as variáveis do tema: var(--bg), var(--surface), var(--ink), var(--muted), var(--primary), var(--on-primary), var(--accent), var(--font-head), var(--font-body); o logo é logo:light (fundo claro) ou logo:dark (fundo escuro), ex.: <img src="logo:light">. Arquivos da Marca do cliente: marca:<nome do arquivo>. Imagens desta conversa: img:I2. Google Fonts por @import ou <link>. Sem scripts e sem links da internet.',
      },
      revises: { type: "string", description: "Opcional: a referência que esta versão ajusta (ex.: D1). Leia antes com read_canvas." },
      ...IDENTITY_PARAMS,
    },
    required: ["title", "html"],
    additionalProperties: false,
  },
};

export const DESIGN_RULES = `- Design livre (design_document): pense como designer editorial antes de escrever o HTML — grade com margens generosas (ex.: 64px no A4, 80px nos slides), hierarquia clara (um destaque por página), no máximo 2 fontes, as cores da identidade, contraste bom, números grandes, respiro. Cada página cabe no tamanho dela: corte texto ou divida em mais páginas (ou use class="page flow" para texto corrido). Posicione com flex e grid. Fotos e ilustrações: gere antes com generate_image (sem texto) e use como img:I2; logo só pelo arquivo (logo:light, logo:dark, marca:<arquivo>), nunca desenhado. Confira as prévias e o relatório que voltam e corrija com revises até ficar limpo (no máximo 3 versões). Na resposta, só [[D#]] e um resumo curto.`;

function findCanvas(kit: PowerKit, ref: string): CanvasArtifact | undefined {
  const r = ref.toUpperCase();
  return (
    [...kit.artifacts].reverse().find((a): a is CanvasArtifact => a.type === "canvas" && a.ref === r) ??
    kit.priorCanvas.get(r)
  );
}
const imagePath = (kit: PowerKit, ref: string) =>
  kit.artifacts.find((a): a is ImageArtifact => a.type === "image" && a.ref === ref)?.path ?? kit.priorImages.get(ref);

/** As páginas que viram prévia para a MAVI: todas até 6; acima, a primeira, a última e as do meio. */
export function previewPages(total: number, max = 6) {
  if (total <= max) return Array.from({ length: total }, (_, i) => i);
  const step = (total - 1) / (max - 1);
  return [...new Set(Array.from({ length: max }, (_, i) => Math.round(i * step)))];
}

/** Troca logo:… e marca:… pelos arquivos (file:<id>), ou diz o que faltou. */
async function bindFiles(
  kit: PowerKit,
  html: string,
  look: Look | null,
  client: string | null,
): Promise<{ html: string } | { error: string }> {
  let out = html.replace(/logo:(light|dark)\b/g, (_, which: string) => {
    const id = look ? (which === "dark" ? (look.logo.dark ?? look.logo.light) : (look.logo.light ?? look.logo.dark)) ?? logoFor(look, look.colors.bg) : null;
    return id ? `file:${id}` : "";
  });
  const names = [...new Set([...out.matchAll(/marca:([^"')\s]+[^"')]*?)(?=["')])/g)].map((m) => m[1]))];
  if (!names.length) return { html: out };
  if (!client) return { error: "Diga de qual cliente é a marca (client) para usar os arquivos marca:…." };
  const r = await callRpc<{ id: string; name: string }[]>(kit.env, kit.ctx.fetch, kit.ctx.auth, "brand_asset_targets", {
    p_company: kit.ctx.company,
    p_client: client,
  });
  const byName = new Map((r.ok && Array.isArray(r.data) ? r.data : []).map((f) => [f.name, f.id]));
  const missing = names.filter((n) => !byName.has(n));
  if (missing.length)
    return { error: `A marca deste cliente não tem ${missing.map((n) => `“${n}”`).join(", ")}. Veja os nomes com brand_kit.` };
  for (const n of names) out = out.split(`marca:${n}`).join(`file:${byName.get(n)}`);
  return { html: out };
}

export async function runDesignTool(kit: PowerKit, raw: unknown): Promise<ToolOutput> {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const { ctx, env } = kit;
  const title = str(input.title).slice(0, 120) || "Documento";
  const previous = str(input.revises) ? findCanvas(kit, str(input.revises)) : undefined;
  const before = previous?.canvas.kind === "design" ? previous.canvas : undefined;
  const format: DesignFormat = (DESIGN_FORMAT_KEYS as string[]).includes(str(input.format))
    ? (str(input.format) as DesignFormat)
    : (before?.format ?? "a4");
  const look = await lookForCanvas(kit, input, previous);
  if (typeof look === "string") return look;
  const html = typeof input.html === "string" ? input.html : "";
  if (html.trim().length < 30) return "Mande as páginas em HTML (cada uma num <section class=\"page\">).";
  const picked = resolveClient(kit, input.client);
  if (picked && typeof picked !== "string") return picked.error;
  const bound = await bindFiles(kit, html, look, look?.client ?? picked ?? null);
  if ("error" in bound) return bound.error;
  const clean = cleanDesignHtml(bound.html);
  const pages = countPages(clean);
  if (!pages) return 'Nenhuma página: cada página precisa ser um <section class="page">…</section>.';
  if (pages > DESIGN_PAGES_MAX) return `São ${pages} páginas: o máximo é ${DESIGN_PAGES_MAX}. Divida em dois documentos.`;
  const tokens = designTokens(clean);
  const missing = tokens.images.filter((r) => !imagePath(kit, r));
  if (missing.length) return `Não achei ${missing.join(", ")} nesta conversa: gere antes com generate_image ou use as que já apareceram.`;
  const assets = await renderAssets(
    env,
    ctx.fetch,
    ctx.auth,
    ctx.company,
    tokens.files,
    Object.fromEntries(tokens.images.map((r) => [r, imagePath(kit, r)])),
    true,
  );
  if (!Array.isArray(assets)) throw new Error(assets.error);
  const page = keepAllowed(designPage(clean, format, look), assets);
  const f = DESIGN_FORMATS[format];
  const pick = previewPages(pages);
  // Prévias leves: ~640 px de largura.
  const scale = Math.min(1, 640 / f.width);
  const shot = { html: page, assets, width: f.width, height: f.height, scale, type: "jpeg" as const, pick };
  let result: { pages: number; report: string[]; images: { page: number; data: string }[] };
  if (env.renderPages) result = await env.renderPages(shot);
  else if (!process.env.VERCEL) {
    const { renderPages } = await localRenderer();
    const r = await renderPages(shot, ctx.fetch);
    result = { pages: r.pages, report: r.report, images: r.images.map((i) => ({ page: i.page, data: i.data.toString("base64") })) };
  } else result = await renderRemote(ctx.fetch, ctx.auth, { mode: "pages", ...shot });
  const canvas = sanitizeCanvas({ kind: "design", title, format, html: clean, ...(look ? { look } : {}) });
  if (!canvas) return "Não deu para criar: confira as páginas (<section class=\"page\">).";
  const a = add<CanvasArtifact>(kit, "D", {
    type: "canvas",
    canvas,
    ...(previous ? { revision_of: previous.ref } : {}),
  });
  const seen = result.images.map((i) => i.page + 1);
  const check = result.report.length
    ? `A conferência automática achou:\n${result.report.map((r) => `- ${r}`).join("\n")}`
    : "A conferência automática não achou problema; confira mesmo assim nas prévias: alinhamento, hierarquia, contraste, espaço vazio, texto pequeno demais.";
  return {
    text: `Design ${a.ref} pronto (${pages} ${pages === 1 ? "página" : "páginas"}, ${f.label}${look ? `, identidade “${look.name}”` : ""}); você vê abaixo as páginas ${seen.join(", ")}. ${check}\nPara corrigir, mande o HTML inteiro de novo com design_document e revises: "${a.ref}". Na resposta, só a versão final: [[${a.ref}]] sozinho numa linha e um resumo curto.`,
    images: result.images.map((i) => ({ mediaType: "image/jpeg" as const, data: i.data })),
  };
}

export function summarizeDesignStep(output: string) {
  const found = output.match(/^- /gm)?.length ?? 0;
  return /^Design D\d+ pronto/.test(output)
    ? found
      ? `pronto · ${found} ${found === 1 ? "ponto" : "pontos"} para conferir`
      : "pronto"
    : "não deu";
}
