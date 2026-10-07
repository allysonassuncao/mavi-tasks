import type { ToolSpec } from "./_ai-llm.js";
import { add, type PowerKit } from "./_ai-powers.js";
import { resolveClient } from "./_ai-render.js";
import type { ActionArtifact, CanvasArtifact } from "../src/mavi-artifacts.js";
import { DRIVE_SAVE_FORMATS, sanitizeAction } from "../src/mavi-artifacts.js";

/**
 * MAVI · salvar no Drive (Fase 4 das identidades visuais): a MAVI acha o
 * lugar (cliente › produto › pasta, pelos nomes) e propõe salvar um
 * documento desta conversa num formato; a pessoa confirma na janela do
 * Drive, que abre já no lugar, e o arquivo entra como qualquer envio.
 *
 * Importa _ai-powers (add) e _ai-powers o importa: nada daqui é lido por
 * _ai-powers ao carregar (scripts/test-api-imports.mjs confere).
 */

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const near = (a: string, b: string) => fold(a) === fold(b) || fold(a).includes(fold(b));

export const DRIVE_SAVE_TOOL: ToolSpec = {
  name: "save_to_drive",
  description:
    "Propõe salvar no Drive um documento, apresentação, design ou planilha desta conversa (D#), num formato: pdf, docx (Word, só documento), pptx (PowerPoint: apresentação, ou design em slides), html, md (só documento), xlsx ou csv (planilha). Você diz o cliente e, se souber, o produto e a pasta pelo nome; a pessoa confirma na janela do Drive (pode trocar o lugar).",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "O documento (ex.: D1)." },
      format: { type: "string", enum: [...DRIVE_SAVE_FORMATS] },
      client: { type: "string", description: "O cliente (id ou nome). Sem ele, o da conversa." },
      product: { type: "string", description: "Opcional: o produto do cliente (nome), quando há mais de um." },
      folder: { type: "string", description: "Opcional: a pasta (nome), ex.: Propostas." },
      file_name: { type: "string", description: "O nome do arquivo, sem a extensão." },
    },
    required: ["ref", "format"],
    additionalProperties: false,
  },
};

export const DRIVE_SAVE_RULES = `- Salvar no Drive (save_to_drive): quando a pessoa pedir para guardar, salvar ou mandar para a pasta do cliente um documento desta conversa, proponha com o formato pedido (sem pedido: PDF para documentos e design, PowerPoint para apresentações, Excel para planilhas) e o lugar (cliente, produto e pasta pelo nome). A pessoa confirma; nunca diga que já salvou.`;

const ALLOWED: Record<string, string[]> = {
  document: ["pdf", "docx", "html", "md"],
  slides: ["pdf", "pptx", "html"],
  design: ["pdf", "html", "pptx"],
  sheet: ["xlsx", "csv"],
};

async function rest<T>(kit: PowerKit, path: string): Promise<T[]> {
  const res = await kit.ctx.fetch(`${kit.env.supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: kit.env.supabaseKey, Authorization: kit.ctx.auth },
  });
  return res.ok ? ((await res.json()) as T[]) : [];
}

export async function proposeDriveSave(kit: PowerKit, raw: unknown) {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const ref = str(input.ref).toUpperCase();
  const canvas =
    [...kit.artifacts].reverse().find((a): a is CanvasArtifact => a.type === "canvas" && a.ref === ref) ?? kit.priorCanvas.get(ref);
  if (!canvas) return `Não há ${ref || "esse documento"} nesta conversa.`;
  const c = canvas.canvas;
  const format = str(input.format).toLowerCase();
  const allowed = ALLOWED[c.kind] ?? [];
  if (c.kind === "design" && format === "pptx" && c.format !== "slides" && c.format !== "square")
    return "PowerPoint só para design em slides ou quadrado: use pdf ou html.";
  if (!allowed.includes(format)) return `Para ${c.kind === "sheet" ? "planilha" : c.kind === "slides" ? "apresentação" : "este documento"}, os formatos são: ${allowed.join(", ")}.`;
  const picked = resolveClient(kit, input.client);
  if (picked && typeof picked !== "string") return picked.error;
  const out: Record<string, unknown> = {
    kind: "drive_save",
    ref,
    format,
    file_name: str(input.file_name).slice(0, 150) || c.title,
  };
  const notes: string[] = [];
  if (picked) {
    out.client_id = picked;
    out.client_name = kit.ctx.clients.get(picked) ?? "";
    const contracts = (
      await rest<{ id: string; name: string | null; archived: boolean; products: { name: string } | null }>(
        kit,
        `contracts?select=id,name,archived,products(name)&company_id=eq.${kit.ctx.company}&client_id=eq.${picked}`,
      )
    ).filter((k) => !k.archived);
    const label = (k: (typeof contracts)[number]) => k.name || k.products?.name || "Produto";
    const want = str(input.product);
    const contract = want ? contracts.find((k) => near(label(k), want) || near(k.products?.name ?? "", want)) : contracts.length === 1 ? contracts[0] : undefined;
    if (want && !contract) notes.push(`não achei o produto “${want}” (a janela abre no cliente)`);
    if (!want && contracts.length > 1) notes.push("o cliente tem mais de um produto: a pessoa escolhe na janela");
    if (contract) {
      out.contract_id = contract.id;
      out.contract_name = label(contract);
    }
    const folderName = str(input.folder);
    if (folderName) {
      const folders = await rest<{ id: string; name: string; contract_id: string | null; system: string | null }>(
        kit,
        `drive_folders?select=id,name,contract_id,system&company_id=eq.${kit.ctx.company}&client_id=eq.${picked}&limit=500`,
      );
      const options = folders.filter((f) => !f.system && (!contract || f.contract_id === contract.id));
      const folder = options.find((f) => fold(f.name) === fold(folderName)) ?? options.find((f) => near(f.name, folderName));
      if (folder) {
        out.folder_id = folder.id;
        out.folder_name = folder.name;
        if (!contract && folder.contract_id) out.contract_id = folder.contract_id;
      } else notes.push(`não achei a pasta “${folderName}” (a pessoa pode criar ou escolher outra na janela)`);
    }
  } else notes.push("sem cliente: a janela abre na raiz do Drive");
  const action = sanitizeAction(out);
  if (!action) return "Não deu para montar a proposta.";
  const a = add<ActionArtifact>(kit, "A", { type: "action", action, state: "pending" });
  return `Proposta pronta (${a.ref}): salvar ${ref} em ${format.toUpperCase()}${out.client_name ? ` em ${[out.client_name, out.contract_name, out.folder_name].filter(Boolean).join(" › ")}` : ""}.${notes.length ? ` Observações: ${notes.join("; ")}.` : ""} A pessoa confirma na janela do Drive: escreva [[${a.ref}]] sozinho numa linha; não diga que já salvou.`;
}
