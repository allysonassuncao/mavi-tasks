import { callRpc } from "./_drive.js";
import type { ToolSpec } from "./_ai-llm.js";
import { add, type PowerKit } from "./_ai-powers.js";
import { resolveClient } from "./_ai-render.js";
import { IDENTITY_PARAMS } from "./_ai-identity.js";
import { siteStyle, siteStyleText } from "./_site-style.js";
import type { ActionArtifact } from "../src/mavi-artifacts.js";
import { sanitizeAction } from "../src/mavi-artifacts.js";
import {
  BUILTIN_LOOKS,
  GUIDE_SECTIONS,
  builtinLook,
  sanitizeTokens,
  tokensFromBrand,
  type BrandInput,
  type IdentityRow,
  type IdentityScope,
  type IdentityTokens,
} from "../src/visual-identity.js";

/**
 * MAVI · o Guia da marca vivo (Fase 3 das identidades visuais):
 * - site_style: as cores, fontes e o tom de um site (para criar uma
 *   identidade a partir dele);
 * - propose_identity: propõe salvar uma identidade inteira (tema e guia) ou
 *   pôr itens numa seção do Guia da marca — a pessoa confirma no card.
 *
 * Este módulo importa _ai-powers (add) e _ai-powers o importa: nada daqui é
 * lido por _ai-powers ao carregar (só dentro das funções), senão a ordem de
 * carga derruba a /api/drive (scripts/test-api-imports.mjs confere).
 */

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SITE_STYLE_TOOL: ToolSpec = {
  name: "site_style",
  description:
    "Lê o estilo de um site: as cores que o CSS mais usa (com as variáveis de tema, como --primary), a cor do navegador, as fontes, o logo provável e um trecho do texto (para o tom de voz). Use para criar ou ajustar uma identidade visual a partir do site do cliente ou de uma referência.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "O endereço do site (ex.: https://www.cliente.com.br)." } },
    required: ["url"],
    additionalProperties: false,
  },
};

export const PROPOSE_IDENTITY_TOOL: ToolSpec = {
  name: "propose_identity",
  description:
    "Propõe mudar uma identidade visual; a pessoa confirma no card (nada é gravado antes). op \"guide_add\": põe itens numa seção do Guia da marca (o que a pessoa corrigiu ou ensinou). op \"save\": salva uma identidade inteira — o tema (style) e o Guia da marca em Markdown — nova ou como versão nova da que existe (da Marca do cliente, de um site, de uma imagem ou de uma descrição).",
  parameters: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["guide_add", "save"] },
      target: {
        type: "string",
        description: '"cliente" (a do cliente da conversa ou de client), "empresa", "galeria" (um estilo novo; só com save) ou o id de uma identidade.',
      },
      client: { type: "string", description: "O cliente (id ou nome), se não for o da conversa." },
      section: { type: "string", enum: [...GUIDE_SECTIONS], description: "guide_add: a seção do guia." },
      lines: {
        type: "array",
        items: { type: "string" },
        description: "guide_add: de 1 a 8 itens curtos e objetivos (uma regra por item, ex.: \"Nunca usar verde-limão nos títulos\").",
      },
      name: { type: "string", description: "save: o nome da identidade (ex.: \"Marca da Clínica Bem Estar\")." },
      description: { type: "string", description: "save: quando usar (uma frase)." },
      base: { type: "string", description: "save: um estilo pronto como ponto de partida (ex.: builtin:editorial)." },
      style: IDENTITY_PARAMS.style,
      guide: {
        type: "string",
        description: `save: o Guia da marca inteiro em Markdown, com as seções ${GUIDE_SECTIONS.map((s) => `"## ${s}"`).join(", ")}. Só o que veio do material (Marca, site, reuniões, o que a pessoa disse); onde faltar, deixe a seção curta. Sem o guia, fica o atual.`,
      },
      reason: { type: "string", description: "Por que mudar (uma frase: o que a pessoa disse ou de onde veio)." },
    },
    required: ["op", "target", "reason"],
    additionalProperties: false,
  },
};

export const GUIDE_RULES = `- Guia da marca vivo (propose_identity): quando a pessoa corrigir ou ensinar algo de estilo, tom ou marca de um cliente (ex.: "não use esse verde", "capa sempre escura", "o cliente não gosta de emoji", "ele aprovou essa versão"), faça o que ela pediu e proponha registrar no Guia da marca com op guide_add — Faça, Evite, Tom de voz, Visual, Exemplos aprovados ou Aprendizados —, um item curto por regra. Não proponha o que já está no guia.
- Criar ou refazer uma identidade: junte o material (brand_kit para a Marca do Drive, site_style para o site, as imagens que a pessoa mandou, o que ela descreveu) e proponha com op save: o tema em style (cores com bom contraste; as fontes da Marca pelo nome da família, ou do Google Fonts) e o guia em Markdown. Se a conversa é de um cliente sem Guia da marca e você vai fazer um documento para ele, ofereça criar um (uma vez por conversa).
- Nunca diga que salvou ou atualizou: a pessoa confirma no card.`;

// ------------------------------------------------------------ site
export async function runSiteStyle(kit: PowerKit, raw: unknown) {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const url = str(input.url);
  if (!url) return "Mande o endereço do site.";
  try {
    return siteStyleText(await siteStyle(url, { fetch: kit.ctx.fetch }));
  } catch (e) {
    return `Não deu para ler o site: ${(e as Error).message}`;
  }
}

// ------------------------------------------------------------ proposta
type Full = IdentityRow & { guide: string };
async function rpc<T>(kit: PowerKit, name: string, args: Record<string, unknown>) {
  const r = await callRpc<T>(kit.env, kit.ctx.fetch, kit.ctx.auth, name, args);
  return r.ok ? r.data : null;
}

export async function proposeIdentity(kit: PowerKit, raw: unknown) {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const op = input.op === "save" ? "save" : "guide_add";
  const target = str(input.target).toLowerCase();
  let scope: IdentityScope;
  let client: string | null = null;
  let current: Full | null = null;
  if (UUID.test(target)) {
    current = await rpc<Full | null>(kit, "identity_get", { p_id: target });
    if (!current) return "Identidade não encontrada (ou sem acesso).";
    scope = current.scope;
    client = current.client_id;
  } else if (/^(cliente|client|marca)/.test(target)) {
    const picked = resolveClient(kit, input.client);
    if (!picked) return "Diga de qual cliente (client).";
    if (typeof picked !== "string") return picked.error;
    scope = "client";
    client = picked;
    current = await rpc<Full | null>(kit, "identity_of_client", { p_company: kit.ctx.company, p_client: client });
  } else if (/^(empresa|company|agencia)/.test(target)) {
    scope = "company";
    const list = await rpc<{ company: IdentityRow | null } | null>(kit, "identity_list", { p_company: kit.ctx.company, p_client: null });
    current = list?.company ? await rpc<Full | null>(kit, "identity_get", { p_id: list.company.id }) : null;
  } else if (/^(galeria|gallery)/.test(target)) {
    if (op !== "save") return "Para a galeria, use op save (um estilo novo) ou o id do estilo.";
    scope = "gallery";
  } else return 'target: "cliente", "empresa", "galeria" ou o id de uma identidade.';
  const clientName = client ? (kit.ctx.clients.get(client) ?? "") : "";
  const reason = str(input.reason).slice(0, 300);

  let proposal: Record<string, unknown>;
  if (op === "guide_add") {
    const lines = (Array.isArray(input.lines) ? input.lines : []).map(str).filter(Boolean).slice(0, 8);
    const section = GUIDE_SECTIONS.find((s) => s.toLowerCase() === str(input.section).toLowerCase()) ?? "Aprendizados";
    if (!lines.length) return "Mande os itens (lines) para pôr no guia.";
    proposal = {
      kind: "identity",
      op,
      scope,
      ...(client ? { client_id: client, client_name: clientName } : {}),
      ...(current ? { identity_id: current.id } : {}),
      identity_name: current?.name ?? (clientName ? `Marca de ${clientName}` : "Identidade da empresa"),
      section,
      lines,
      reason,
    };
  } else {
    // O tema: o pedido por cima da base (a atual, a da Marca, ou um pronto).
    let base: IdentityTokens = current ? sanitizeTokens(current.tokens) : BUILTIN_LOOKS.claro.tokens;
    if (!current && client) {
      const brand = await rpc<BrandInput | null>(kit, "ai_brand_kit", { p_company: kit.ctx.company, p_client: client });
      if (brand && (brand.colors.length || brand.fonts.length || brand.files.length)) base = tokensFromBrand(brand);
    }
    const ready = str(input.base) ? builtinLook(str(input.base)) : null;
    if (ready) base = { ...ready, faces: base.faces, logo: base.logo };
    const style = input.style && typeof input.style === "object" ? (input.style as Record<string, unknown>) : {};
    const tokens = sanitizeTokens(style, base);
    const name =
      str(input.name).slice(0, 80) || str(style.name).slice(0, 80) || current?.name || (clientName ? `Marca de ${clientName}` : "Estilo novo");
    proposal = {
      kind: "identity",
      op,
      scope,
      ...(client ? { client_id: client, client_name: clientName } : {}),
      ...(current ? { identity_id: current.id } : {}),
      identity_name: name,
      description: str(input.description).slice(0, 300) || current?.description || "",
      tokens,
      guide: typeof input.guide === "string" && input.guide.trim() ? input.guide.trim().slice(0, 30_000) : (current?.guide ?? ""),
      reason,
    };
  }
  const action = sanitizeAction(proposal);
  if (!action) return "Não deu para montar a proposta: confira os campos.";
  const a = add<ActionArtifact>(kit, "A", { type: "action", action, state: "pending" });
  return `Proposta pronta (${a.ref}): ${
    op === "save" ? `salvar a identidade “${proposal.identity_name}”` : `adicionar ${(proposal.lines as string[]).length} ${(proposal.lines as string[]).length === 1 ? "item" : "itens"} em ${proposal.section}`
  }. A pessoa confirma no card: escreva [[${a.ref}]] sozinho numa linha e diga em uma frase o que vai mudar; não diga que já foi salvo.`;
}
