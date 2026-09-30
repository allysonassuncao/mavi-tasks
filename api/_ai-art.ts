import crypto from "node:crypto";
import { callRpc, signGcsUrl } from "./_drive.js";
import type { ToolOutput, ToolSpec } from "./_ai-llm.js";
import { add, type PowerKit } from "./_ai-powers.js";
import { renderArt, type ArtAsset, type RenderInput } from "./_art-render.js";
import { appOrigin } from "./_origin.js";
import type { ImageArtifact, ImageSize } from "../src/mavi-artifacts.js";

/**
 * MAVI · arte por código (migração 20261223090000_mavi_art_brand).
 *
 * Em vez de pedir à IA de imagem que desenhe o texto e o logo (sai genérico
 * e com letras erradas), a MAVI monta a arte como uma página HTML e CSS no
 * tamanho do post, com a marca do cliente (Drive › cliente › Marca), e o
 * servidor desenha num navegador. A arte volta como imagem para ela conferir
 * e corrigir antes de mostrar — como um designer olhando o que fez.
 *
 * - brand_kit: as cores, fontes, logos e regras do cliente;
 * - render_art: desenha (PNG no GCS, anexo I#) e devolve a prévia para a
 *   MAVI ver, com o que a conferência automática achou;
 * - read_art: o HTML de uma arte desta conversa, para ajustar.
 */

const FORMATS = {
  feed: [1080, 1350],
  square: [1080, 1080],
  story: [1080, 1920],
  landscape: [1200, 628],
  banner: [1920, 1080],
} as const;
type Format = keyof typeof FORMATS;

export const ART_TOOLS: ToolSpec[] = [
  {
    name: "brand_kit",
    description:
      "Lê a marca de um cliente cadastrada no Drive (Drive › cliente › Marca): cores com os códigos, fontes (família, peso e para que serve cada uma), logos e imagens (com o nome para usar na arte) e as regras de uso. Use antes de montar qualquer arte de um cliente.",
    parameters: {
      type: "object",
      properties: {
        client: {
          type: "string",
          description: "O cliente: o id (de find_clients) ou o nome. Sem ele, o cliente da conversa.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "render_art",
    description:
      "Monta uma arte (post, carrossel, card, capa, story, banner, anúncio, convite) como uma página HTML e CSS no tamanho exato e devolve a imagem pronta (PNG) — você vê a arte e o que a conferência automática achou, para corrigir antes de mostrar. Use para toda arte com texto, marca ou layout: o texto, as fontes e o logo saem exatos. Para foto ou ilustração sem texto (um fundo, um objeto), gere com generate_image ou com a conexão de imagens e use na arte como img:I2. Devolve a referência (ex.: I3).",
    parameters: {
      type: "object",
      properties: {
        html: {
          type: "string",
          description:
            "A página inteira (HTML com <style>). O corpo já tem o tamanho da arte. Arquivos da marca: marca:<nome do arquivo> (ex.: <img src=\"marca:logo.svg\">); imagens desta conversa: img:I2 (ex.: background-image:url('img:I2')). As fontes da marca já vêm com @font-face: use pelo nome (font-family: 'Tomato Grotesk'). Google Fonts pode por @import. Sem scripts e sem links da internet.",
        },
        format: {
          type: "string",
          enum: Object.keys(FORMATS),
          description: "feed (1080×1350, padrão), square (1080×1080), story (1080×1920), landscape (1200×628) ou banner (1920×1080).",
        },
        width: { type: "integer", description: "Opcional: largura em pixels (200 a 2400), no lugar do formato." },
        height: { type: "integer", description: "Opcional: altura em pixels (200 a 2400), no lugar do formato." },
        client: {
          type: "string",
          description: "O cliente cuja marca a arte usa (id ou nome). Sem ele, o cliente da conversa.",
        },
        name: { type: "string", description: "Um nome curto da arte (ex.: 'Black Friday · feed')." },
        revises: { type: "string", description: "Opcional: a arte que esta versão corrige (ex.: I3)." },
      },
      required: ["html"],
      additionalProperties: false,
    },
  },
  {
    name: "read_art",
    description:
      "Lê o HTML de uma arte desta conversa (feita com render_art), para ajustar: mande depois a versão inteira com render_art e revises.",
    parameters: {
      type: "object",
      properties: { ref: { type: "string", description: "A referência da arte (ex.: I3)." } },
      required: ["ref"],
      additionalProperties: false,
    },
  },
];

/** Como fazer arte (entra nas instruções quando o poder de imagens está ligado). */
export const ART_RULES = `- Artes com texto, marca ou layout (post, carrossel, card, capa, story, banner, anúncio): monte com render_art, não com generate_image — a IA de imagem erra letras e inventa logos. Antes, leia a marca do cliente com brand_kit. Se faltar o logo, as fontes ou as cores, pergunte com ask_user (a pessoa pode subir em Drive › cliente › Marca) ou siga com o que tiver, dizendo o que faltou; nunca desenhe um logo com texto ou CSS no lugar do arquivo.
- Pense como designer antes de escrever o HTML: hierarquia (um destaque grande, apoio curto), grade com margens seguras (ex.: 80px nas laterais), no máximo 2 fontes, as cores da marca, contraste bom, texto grande o bastante para celular, nada encostando nas bordas. Posicione com flex ou grid, não com posições soltas que se sobrepõem.
- Fotos e ilustrações entram como imagem: gere com generate_image (ou a conexão de imagens), sem texto na imagem, e use no HTML como img:I2.
- Confira a imagem que render_art devolve e o relatório: texto cortado, sobreposto ou fora da arte, fonte que não carregou, desalinhamento, espaço vazio, contraste. Corrija e mande de novo (revises) até ficar limpo — no máximo 3 versões. Na resposta, mostre só a versão final ([[I#]]) e diga em poucas linhas o que tem nela e o que faltou da marca.`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

type BrandKit = {
  client: string;
  client_name: string;
  folder: string | null;
  colors: { name: string; hex: string }[];
  fonts: { file: string; family: string; weight: number; style: string; role: string }[];
  notes: string;
  files: { id: string; name: string; content_type: string; size: number }[];
};
type Target = { id: string; name: string; content_type: string; path: string; size: number };

/** O cliente pedido (id ou nome) entre os que a pessoa vê; sem pedido, o da conversa. */
export function resolveClient(kit: PowerKit, raw: unknown): string | { error: string } | null {
  const v = str(raw);
  const clients = kit.ctx.clients;
  if (!v) return kit.ctx.scope.client ?? null;
  if (UUID.test(v)) return clients.has(v) ? v : { error: "Cliente não encontrado (ou sem acesso)." };
  const want = fold(v);
  const all = [...clients.entries()];
  const exact = all.filter(([, name]) => fold(name) === want);
  const found = exact.length ? exact : all.filter(([, name]) => fold(name).includes(want));
  if (found.length === 1) return found[0][0];
  if (!found.length) return { error: `Não achei o cliente “${v}”. Confira com find_clients.` };
  return {
    error: `Há mais de um cliente com “${v}”: ${found
      .slice(0, 6)
      .map(([id, name]) => `${name} (${id})`)
      .join(", ")}. Mande o id.`,
  };
}

async function brandOf(kit: PowerKit, client: string) {
  const { ctx } = kit;
  const r = await callRpc<BrandKit | null>(kit.env, ctx.fetch, ctx.auth, "ai_brand_kit", {
    p_company: ctx.company,
    p_client: client,
  });
  // Antes da migração 20261223090000 não há marca.
  if (!r.ok) return r.status === 404 ? null : Promise.reject(new Error(r.error));
  return r.data;
}

const fileKind = (name: string) =>
  /\.(ttf|otf|woff2?)$/i.test(name) ? "fonte" : /\.pdf$/i.test(name) ? "PDF" : "imagem";

async function brandKit(kit: PowerKit, input: Record<string, unknown>) {
  const client = resolveClient(kit, input.client);
  if (!client) return "Diga de qual cliente é a marca (o id de find_clients ou o nome).";
  if (typeof client !== "string") return client.error;
  const b = await brandOf(kit, client);
  if (!b) return "A marca não está disponível (sem acesso a este cliente ou o sistema ainda não tem a área de marca).";
  const lines = [`Marca do cliente ${b.client_name}:`];
  lines.push(
    b.colors.length
      ? `Cores: ${b.colors.map((c) => `${c.name || "sem nome"} ${c.hex}`).join(", ")}.`
      : "Cores: nenhuma cadastrada.",
  );
  const byId = new Map(b.files.map((f) => [f.id, f]));
  lines.push(
    b.fonts.length
      ? `Fontes (já carregadas na arte; use font-family pelo nome): ${b.fonts
          .map(
            (f) =>
              `“${f.family}” ${f.weight}${f.style === "italic" ? " itálico" : ""}${f.role ? ` — ${f.role}` : ""} (${byId.get(f.file)?.name ?? "arquivo"})`,
          )
          .join("; ")}.`
      : "Fontes: nenhuma cadastrada (use uma do Google Fonts parecida com a marca e diga isso).",
  );
  const images = b.files.filter((f) => fileKind(f.name) === "imagem");
  lines.push(
    images.length
      ? `Logos e imagens (use no HTML como marca:<nome>): ${images.map((f) => `marca:${f.name}`).join(", ")}.`
      : "Logos e imagens: nenhum arquivo (não desenhe o logo; peça o arquivo).",
  );
  const pdfs = b.files.filter((f) => fileKind(f.name) === "PDF");
  if (pdfs.length)
    lines.push(`Manuais em PDF na pasta (busque o texto com search_knowledge): ${pdfs.map((f) => f.name).join(", ")}.`);
  const untyped = b.files.filter(
    (f) => fileKind(f.name) === "fonte" && !b.fonts.some((x) => x.file === f.id),
  );
  if (untyped.length)
    lines.push(`Fontes na pasta sem família cadastrada (não entram na arte): ${untyped.map((f) => f.name).join(", ")}.`);
  lines.push(b.notes.trim() ? `Regras de uso:\n${b.notes.trim()}` : "Regras de uso: nenhuma.");
  if (!b.colors.length && !b.fonts.length && !b.files.length)
    lines.push(
      "A marca está vazia: pergunte à pessoa (ask_user) as cores e o estilo, ou peça para subir logo e fontes em Drive › cliente › Marca.",
    );
  return lines.join("\n");
}

function findArt(kit: PowerKit, ref: string): ImageArtifact | undefined {
  const r = ref.toUpperCase();
  return (
    [...kit.artifacts]
      .reverse()
      .find((a): a is ImageArtifact => a.type === "image" && a.ref === r) ?? kit.priorArts?.get(r)
  );
}

function readArt(kit: PowerKit, input: Record<string, unknown>) {
  const ref = str(input.ref).toUpperCase();
  const a = findArt(kit, ref);
  if (!a) return `Não achei a arte ${ref} nesta conversa.`;
  if (!a.html) return `${ref} não foi feita com render_art: não há HTML para ajustar (para editar a imagem, use generate_image com edit_ref).`;
  return `HTML da arte ${ref} (${a.width}×${a.height}${a.client ? `, marca do cliente ${kit.ctx.clients.get(a.client) ?? a.client}` : ""}):\n<html_arte>\n${a.html}\n</html_arte>\nPara ajustar, mande a versão inteira com render_art e revises: "${ref}".`;
}

const aspect = (w: number, h: number): ImageSize =>
  w / h > 1.15 ? "landscape" : h / w > 1.15 ? "portrait" : "square";
const cssString = (s: string) => s.replace(/["\\\n]/g, "");

/** Onde desenhar: aqui mesmo (computador) ou a função /api/render-art (Vercel). */
async function draw(
  kit: PowerKit,
  input: RenderInput,
  put: string,
): Promise<{ preview: string; report: string[] }> {
  const { ctx } = kit;
  if (kit.env.renderArt) return kit.env.renderArt(input, put);
  if (!process.env.VERCEL) {
    const r = await renderArt(input, ctx.fetch);
    const saved = await ctx.fetch(put, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array(r.png),
      signal: AbortSignal.timeout(60_000),
    });
    if (!saved.ok) throw new Error(`Não foi possível guardar a arte (${saved.status}).`);
    return { preview: r.preview.toString("base64"), report: r.report };
  }
  // Na produção, o endereço do app; nas prévias, o da própria implantação.
  const origin =
    process.env.ART_RENDER_ORIGIN?.replace(/\/+$/, "") ||
    (process.env.VERCEL_ENV === "production" || !process.env.VERCEL_URL
      ? appOrigin()
      : `https://${process.env.VERCEL_URL}`);
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const res = await ctx.fetch(`${origin}/api/render-art`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: ctx.auth,
      ...(bypass ? { "x-vercel-protection-bypass": bypass } : {}),
    },
    body: JSON.stringify({ ...input, put: { url: put } }),
    signal: AbortSignal.timeout(85_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    preview?: string;
    report?: string[];
    error?: string;
  };
  if (!res.ok || !body.preview)
    throw new Error(body.error ?? `O desenho da arte falhou (${res.status}).`);
  return { preview: body.preview, report: Array.isArray(body.report) ? body.report : [] };
}

async function renderArtTool(kit: PowerKit, input: Record<string, unknown>): Promise<ToolOutput> {
  const { ctx, env } = kit;
  if (!env.credentials || !env.bucket)
    throw new Error("Credenciais do GCS não configuradas para guardar a arte.");
  const html = typeof input.html === "string" ? input.html : "";
  if (html.trim().length < 20) return "Mande o HTML da arte.";
  const format: Format = str(input.format) in FORMATS ? (str(input.format) as Format) : "feed";
  const w = Number(input.width);
  const h = Number(input.height);
  const [width, height] =
    Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 ? [w, h] : FORMATS[format];
  const revises = str(input.revises).toUpperCase();
  const previous = revises ? findArt(kit, revises) : undefined;
  const picked = resolveClient(kit, input.client ?? previous?.client);
  if (picked && typeof picked !== "string") return picked.error;
  const client = picked;
  const sign = (path: string) =>
    signGcsUrl(env.credentials!, env.bucket!, path, "GET", { expiresInSeconds: 900 });

  // Os arquivos da marca e as fontes dela (com @font-face prontos).
  const assets: ArtAsset[] = [];
  let fontFaces = "";
  if (client) {
    const [targets, brand] = await Promise.all([
      callRpc<Target[]>(env, ctx.fetch, ctx.auth, "brand_asset_targets", {
        p_company: ctx.company,
        p_client: client,
      }).then((r) => (r.ok && Array.isArray(r.data) ? r.data : [])),
      brandOf(kit, client).catch(() => null),
    ]);
    const byId = new Map(targets.map((t) => [t.id, t]));
    for (const t of targets) assets.push({ token: `marca:${t.name}`, url: sign(t.path) });
    fontFaces = (brand?.fonts ?? [])
      .filter((f) => byId.has(f.file))
      .map(
        (f) =>
          `@font-face{font-family:"${cssString(f.family)}";src:url("marca:${byId.get(f.file)!.name}");font-weight:${f.weight};font-style:${f.style === "italic" ? "italic" : "normal"};font-display:block}`,
      )
      .join("\n");
  }
  // As imagens desta conversa que a página usa (img:I2).
  const refs = [...new Set([...html.matchAll(/img:(I\d{1,2})\b/gi)].map((m) => m[1].toUpperCase()))];
  const missing: string[] = [];
  for (const ref of refs) {
    const path =
      kit.artifacts.find((a): a is ImageArtifact => a.type === "image" && a.ref === ref)?.path ??
      kit.priorImages.get(ref);
    if (path) assets.push({ token: `img:${ref}`, url: sign(path) });
    else missing.push(ref);
  }
  if (missing.length) return `Não achei ${missing.join(", ")} nesta conversa. Use as imagens que já apareceram (img:I1…).`;
  const unknown = [...html.matchAll(/marca:([^"')\s]+[^"')]*?)(?=["')])/g)]
    .map((m) => m[1])
    .filter((name) => !assets.some((a) => a.token === `marca:${name}`));
  if (unknown.length)
    return client
      ? `A marca deste cliente não tem ${[...new Set(unknown)].map((n) => `“${n}”`).join(", ")}. Veja os nomes com brand_kit.`
      : "Diga de qual cliente é a marca (client) para usar os arquivos marca:….";

  const page = fontFaces ? `<style>\n${fontFaces}\n</style>\n${html}` : html;
  const path = `ai-images/${ctx.company}/${crypto.randomUUID()}.png`;
  const put = signGcsUrl(env.credentials, env.bucket, path, "PUT", { contentType: "image/png" });
  const { preview, report } = await draw(kit, { html: page, width, height, assets }, put);
  const name = str(input.name).slice(0, 120) || previous?.prompt || `Arte ${width}×${height}`;
  const a = add<ImageArtifact>(kit, "I", {
    type: "image",
    path,
    prompt: name,
    size: aspect(width, height),
    model: "arte por código",
    art: true,
    width,
    height,
    html: html.slice(0, 200_000),
    ...(client ? { client } : {}),
    ...(previous ? { edited_from: previous.ref } : {}),
    url: signGcsUrl(env.credentials, env.bucket, path, "GET", { expiresInSeconds: 3600 }),
  });
  const check = report.length
    ? `A conferência automática achou:\n${report.map((r) => `- ${r}`).join("\n")}`
    : "A conferência automática não achou problema; confira mesmo assim na imagem: alinhamento, hierarquia, contraste, espaço vazio e se o texto é o pedido.";
  return {
    text: `Arte ${a.ref} pronta (${width}×${height}); você a vê abaixo. ${check}\nSe precisar corrigir, mande o HTML inteiro de novo com render_art e revises: "${a.ref}". Na resposta, só a versão final: [[${a.ref}]] sozinho numa linha.`,
    images: [{ mediaType: "image/jpeg", data: preview }],
  };
}

export async function runArtTool(kit: PowerKit, name: string, raw: unknown): Promise<ToolOutput> {
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (name === "brand_kit") return brandKit(kit, input);
  if (name === "read_art") return readArt(kit, input);
  if (name === "render_art") return renderArtTool(kit, input);
  return `Ferramenta desconhecida: ${name}.`;
}

export function summarizeArtStep(name: string, output: string) {
  if (name === "brand_kit") return /^Marca do cliente/.test(output) ? (/A marca está vazia/.test(output) ? "marca vazia" : "marca lida") : "não deu";
  if (name === "read_art") return /^HTML da arte/.test(output) ? "lida" : "não deu";
  const found = output.match(/^- /gm)?.length ?? 0;
  return /^Arte I\d+ pronta/.test(output) ? (found ? `pronta · ${found} ${found === 1 ? "ponto" : "pontos"} para conferir` : "pronta") : "não deu";
}
