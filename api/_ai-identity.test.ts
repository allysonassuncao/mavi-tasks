import { describe, expect, it, vi } from "vitest";
import { canvasPdf, lookForCanvas, runIdentityTool } from "./_ai-identity";
import type { PowerKit } from "./_ai-powers";
import type { CanvasArtifact } from "../src/mavi-artifacts";

const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const logo = "00000000-0000-4000-8000-0000000000aa";
const font = "00000000-0000-4000-8000-0000000000bb";

/** Um kit com o banco simulado: cada RPC devolve o que o teste mandar. */
function kit(rpcs: Record<string, unknown>, scopeClient: string | undefined = client) {
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const name = String(url).split("/rpc/")[1] ?? "";
    calls.push({ name, body: JSON.parse(String(init?.body ?? "{}")) });
    if (!(name in rpcs)) return new Response(JSON.stringify({ message: "não existe" }), { status: 404 });
    return new Response(JSON.stringify(rpcs[name]), { status: 200 });
  });
  const k = {
    env: { supabaseUrl: "https://db", supabaseKey: "k" },
    ctx: {
      fetch: fetchImpl,
      auth: "Bearer t",
      company,
      clients: new Map([[client, "MakeCRM"]]),
      scope: { client: scopeClient },
    },
  } as unknown as PowerKit;
  return { k, calls };
}
const brand = {
  client,
  client_name: "MakeCRM",
  colors: [
    { name: "Navy", hex: "#001119" },
    { name: "Laranja", hex: "#FF8900" },
  ],
  fonts: [{ file: font, family: "Tomato Grotesk", weight: 700, style: "normal", role: "Títulos" }],
  files: [
    { id: logo, name: "logo-colorido.svg" },
    { id: font, name: "Tomato.otf" },
  ],
};

describe("identidade no documento", () => {
  it("estilo pronto, estilo novo e o tema antigo das apresentações", async () => {
    const { k } = kit({});
    const ready = await lookForCanvas(k, { identity: "builtin:corporativo" });
    expect(ready).toMatchObject({ id: "builtin:corporativo", name: "Corporativo", source: "builtin" });
    expect(await lookForCanvas(k, { identity: "Editorial" })).toMatchObject({ id: "builtin:editorial" });
    const custom = await lookForCanvas(k, {
      style: { name: "Noite", colors: { bg: "#0b1020", primary: "22d3ee" }, heading: { family: "Space Grotesk", weight: 700 } },
    });
    expect(custom).toMatchObject({ source: "custom", name: "Noite", mode: "dark", colors: { bg: "#0B1020", primary: "#22D3EE" } });
    expect((custom as { heading: unknown }).heading).toEqual({ family: "Space Grotesk", weight: 700, source: "google" });
    expect(await lookForCanvas(k, { theme: "escuro" })).toMatchObject({ id: "builtin:escuro" });
    expect(await lookForCanvas(k, {})).toBeNull();
    // Num ajuste sem identidade, fica a da versão anterior.
    const before = { canvas: { kind: "document", title: "x", markdown: "y", look: ready } } as unknown as CanvasArtifact;
    expect(await lookForCanvas(k, {}, before)).toBe(ready);
  });

  it("a do cliente: o Guia da marca salvo, ou o tema tirado da Marca do Drive", async () => {
    const saved = kit({
      identity_of_client: { id: "00000000-0000-4000-8000-0000000000cc", scope: "client", client_id: client, name: "Guia MakeCRM", tokens: { colors: { primary: "#001119" } } },
    });
    expect(await lookForCanvas(saved.k, { identity: "cliente" })).toMatchObject({ name: "Guia MakeCRM", source: "client", client });
    const fromBrand = kit({ identity_of_client: null, ai_brand_kit: brand });
    const look = await lookForCanvas(fromBrand.k, { identity: "cliente" });
    expect(look).toMatchObject({
      name: "Marca de MakeCRM",
      source: "client",
      cover: "primary",
      colors: { primary: "#FF8900", ink: "#001119" },
      heading: { family: "Tomato Grotesk", source: "brand" },
      logo: { light: logo },
    });
    const empty = kit({ identity_of_client: null, ai_brand_kit: { ...brand, colors: [], fonts: [], files: [] } });
    expect(await lookForCanvas(empty.k, { identity: "cliente" })).toMatch(/não tem identidade nem Marca/);
    const noClient = kit({}, "");
    expect(await lookForCanvas(noClient.k, { identity: "cliente" })).toMatch(/Diga de qual cliente/);
    const company_ = kit({ identity_list: { company: null, client: null, gallery: [] } });
    expect(await lookForCanvas(company_.k, { identity: "empresa" })).toMatch(/não tem identidade cadastrada/);
  });

  it("a lista para a MAVI: cliente, empresa, galeria e prontos; com id, o Guia", async () => {
    const { k } = kit({
      identity_list: {
        company: { id: "00000000-0000-4000-8000-0000000000dd", scope: "company", name: "Make Vendas", description: "", tokens: {}, guide_chars: 0 },
        client: null,
        gallery: [{ id: "00000000-0000-4000-8000-0000000000ee", scope: "gallery", name: "Tech", description: "SaaS", tokens: {}, guide_chars: 1200 }],
      },
      ai_brand_kit: brand,
      identity_get: { id: "00000000-0000-4000-8000-0000000000ee", scope: "gallery", name: "Tech", description: "SaaS", tokens: { colors: { ink: "#EEEEEE", bg: "#FFFFFF" } }, guide: "## Tom\nCurto.", version: 3 },
    });
    const list = String(await runIdentityTool(k, {}));
    expect(list).toContain('sem identidade salva, mas com Marca no Drive (2 cores, 1 fontes, 1 imagens/logos). Use identity "cliente"');
    expect(list).toContain("Da empresa: “Make Vendas”");
    expect(list).toContain("“Tech” (id 00000000-0000-4000-8000-0000000000ee) — SaaS");
    expect(list).toContain("Guia da marca: 1.200 caracteres");
    expect(list).toContain("builtin:corporativo “Corporativo”");
    const one = String(await runIdentityTool(k, { id: "00000000-0000-4000-8000-0000000000ee" }));
    expect(one).toContain("<guia_da_marca>\n## Tom\nCurto.\n</guia_da_marca>");
    expect(one).toContain("Texto sobre fundo com pouco contraste");
  });
});

describe("PDF do canvas", () => {
  it("confere a empresa e as credenciais antes de desenhar", async () => {
    const f = vi.fn();
    expect((await canvasPdf({ supabaseUrl: "x", supabaseKey: "k" }, f, "Bearer t", { company: "x" })).status).toBe(400);
    expect((await canvasPdf({ supabaseUrl: "x", supabaseKey: "k" }, f, "Bearer t", { company, html: "<p>oi</p>".repeat(5) })).status).toBe(500);
    expect(f).not.toHaveBeenCalled();
  });
});
