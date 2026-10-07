import { describe, expect, it, vi } from "vitest";
import { proposeDriveSave } from "./_ai-drive-save";
import type { PowerKit } from "./_ai-powers";
import type { ActionArtifact, AiArtifact, CanvasArtifact } from "../src/mavi-artifacts";

const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const k1 = "00000000-0000-4000-8000-0000000000c1";
const k2 = "00000000-0000-4000-8000-0000000000c2";
const folder = "00000000-0000-4000-8000-0000000000f1";

function kit() {
  const artifacts: AiArtifact[] = [
    { id: "d1", ref: "D1", type: "canvas", canvas: { kind: "document", title: "Proposta de outubro", markdown: "Texto longo o bastante." } } as CanvasArtifact,
    { id: "d2", ref: "D2", type: "canvas", canvas: { kind: "design", title: "One-pager", format: "a4", html: "<section class=\"page\">x</section>", pages: 1 } } as CanvasArtifact,
  ];
  const asked: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    const u = String(url);
    asked.push(u);
    if (u.includes("/contracts?"))
      return Response.json([
        { id: k1, name: null, archived: false, products: { name: "Tráfego pago" } },
        { id: k2, name: "Social Media", archived: false, products: { name: "Social" } },
      ]);
    if (u.includes("/drive_folders?"))
      return Response.json([
        { id: folder, name: "Propostas comerciais", contract_id: k1, system: null },
        { id: "00000000-0000-4000-8000-0000000000f9", name: "Marca", contract_id: null, system: "brand" },
      ]);
    return Response.json([]);
  });
  const k = {
    env: { supabaseUrl: "https://db", supabaseKey: "k" },
    ctx: { fetch: fetchImpl, auth: "Bearer t", company, clients: new Map([[client, "Clínica"]]), scope: { client } },
    artifacts,
    priorCanvas: new Map(),
    next: { V: 1, I: 1, A: 1, D: 3, Q: 1, T: 1, B: 1 },
    emit: () => {},
  } as unknown as PowerKit;
  return { k, artifacts, asked };
}

describe("save_to_drive", () => {
  it("acha o produto e a pasta pelo nome e propõe; a pessoa confirma na janela", async () => {
    const { k, artifacts } = kit();
    const out = await proposeDriveSave(k, { ref: "d1", format: "docx", product: "tráfego", folder: "propostas" });
    expect(out).toMatch(/^Proposta pronta \(A1\): salvar D1 em DOCX em Clínica › Tráfego pago › Propostas comerciais\./);
    expect((artifacts[2] as ActionArtifact).action).toEqual({
      kind: "drive_save",
      ref: "D1",
      format: "docx",
      file_name: "Proposta de outubro",
      client_id: client,
      client_name: "Clínica",
      contract_id: k1,
      contract_name: "Tráfego pago",
      folder_id: folder,
      folder_name: "Propostas comerciais",
    });
  });

  it("formato que não serve, documento que não existe e o que não achou", async () => {
    const { k, artifacts } = kit();
    expect(await proposeDriveSave(k, { ref: "D1", format: "xlsx" })).toMatch(/os formatos são: pdf, docx, html, md/);
    expect(await proposeDriveSave(k, { ref: "D2", format: "pptx" })).toMatch(/só para design em slides/);
    expect(await proposeDriveSave(k, { ref: "D9", format: "pdf" })).toMatch(/Não há D9/);
    const out = await proposeDriveSave(k, { ref: "D2", format: "pdf", folder: "Marca" });
    expect(out).toContain("o cliente tem mais de um produto");
    expect(out).toContain("não achei a pasta “Marca”");
    expect((artifacts.at(-1) as ActionArtifact).action).toMatchObject({ kind: "drive_save", ref: "D2", format: "pdf", client_id: client });
  });
});
