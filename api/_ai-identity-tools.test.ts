import { describe, expect, it, vi } from "vitest";
import { proposeIdentity } from "./_ai-identity-tools";
import { handleIdentityDraft } from "./_identity-draft";
import type { PowerKit } from "./_ai-powers";
import type { AiDeps, AiEnv } from "./_ai";
import type { ActionArtifact, AiArtifact } from "../src/mavi-artifacts";

const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const logo = "00000000-0000-4000-8000-0000000000aa";
const brand = {
  client,
  client_name: "Clínica",
  colors: [{ name: "Verde", hex: "#2F6B1E" }],
  fonts: [],
  notes: "Sem emoji.",
  files: [{ id: logo, name: "logo.svg", content_type: "image/svg+xml", size: 900 }],
};

function kit(rpcs: Record<string, unknown>) {
  const artifacts: AiArtifact[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    const name = String(url).split("/rpc/")[1] ?? "";
    return name in rpcs
      ? new Response(JSON.stringify(rpcs[name]), { status: 200 })
      : new Response(JSON.stringify({ message: "não existe" }), { status: 404 });
  });
  const k = {
    env: { supabaseUrl: "https://db", supabaseKey: "k" },
    ctx: { fetch: fetchImpl, auth: "Bearer t", company, clients: new Map([[client, "Clínica"]]), scope: { client } },
    artifacts,
    next: { V: 1, I: 1, A: 1, D: 1, Q: 1, T: 1, B: 1 },
    emit: () => {},
  } as unknown as PowerKit;
  return { k, artifacts };
}

describe("propose_identity", () => {
  it("guide_add: o card com a seção e os itens, na identidade que existe", async () => {
    const { k, artifacts } = kit({
      identity_of_client: { id: "00000000-0000-4000-8000-0000000000cc", scope: "client", client_id: client, name: "Guia da Clínica", tokens: {}, guide: "## Evite\n-", version: 2 },
    });
    const out = await proposeIdentity(k, { op: "guide_add", target: "cliente", section: "evite", lines: ["Emoji em proposta", " "], reason: "A pessoa pediu" });
    expect(out).toMatch(/^Proposta pronta \(A1\): adicionar 1 item em Evite/);
    expect((artifacts[0] as ActionArtifact).action).toEqual({
      kind: "identity",
      op: "guide_add",
      scope: "client",
      client_id: client,
      client_name: "Clínica",
      identity_id: "00000000-0000-4000-8000-0000000000cc",
      identity_name: "Guia da Clínica",
      section: "Evite",
      lines: ["Emoji em proposta"],
      reason: "A pessoa pediu",
    });
    expect((artifacts[0] as ActionArtifact).state).toBe("pending");
  });

  it("save: sem identidade, o tema nasce da Marca e o pedido vai por cima (o logo fica)", async () => {
    const { k, artifacts } = kit({ identity_of_client: null, ai_brand_kit: brand });
    await proposeIdentity(k, {
      op: "save",
      target: "cliente",
      name: "Marca da Clínica",
      style: { colors: { accent: "#C17C3A" }, cover: "split" },
      guide: "## Essência\nCuidado.",
      reason: "Do site e da Marca",
    });
    const a = (artifacts[0] as ActionArtifact).action as Extract<ActionArtifact["action"], { kind: "identity" }>;
    expect(a).toMatchObject({ op: "save", scope: "client", identity_name: "Marca da Clínica", guide: "## Essência\nCuidado." });
    expect(a.identity_id).toBeUndefined();
    expect(a.tokens).toMatchObject({ cover: "split", colors: { primary: "#2F6B1E", accent: "#C17C3A" }, logo: { light: logo } });
  });

  it("o que não dá volta como texto", async () => {
    const { k, artifacts } = kit({ identity_list: { company: null, client: null, gallery: [] } });
    expect(await proposeIdentity(k, { op: "guide_add", target: "galeria", lines: ["x"] })).toMatch(/use op save/);
    expect(await proposeIdentity(k, { op: "guide_add", target: "empresa", lines: [] })).toMatch(/Mande os itens/);
    expect(await proposeIdentity(k, { op: "save", target: "xyz" })).toMatch(/^target:/);
    expect(artifacts).toHaveLength(0);
  });
});

describe("Gerar com a MAVI (ai-identity-draft)", () => {
  it("lê a Marca e o guia atual, pede ao modelo e devolve o rascunho sem gravar", async () => {
    const calls: string[] = [];
    let asked = "";
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push(u.split("/rest/v1/")[1] ?? u);
      if (u.includes("/memberships?")) return Response.json([{ hidden_pages: [], active: true }]);
      const name = u.split("/rpc/")[1] ?? "";
      if (name === "ai_check_limits") return Response.json({ blocked: false, message: null });
      if (name === "ai_brand_kit") return Response.json(brand);
      if (name === "identity_of_client")
        return Response.json({ id: "00000000-0000-4000-8000-0000000000cc", scope: "client", name: "Guia antigo", version: 3, tokens: { logo: { light: logo } }, guide: "## Aprendizados\n- (01/10/2026) Capa escura" });
      if (name === "ai_log_usage") return Response.json(null);
      void init;
      return Response.json({ message: "não existe" }, { status: 404 });
    });
    const llm = vi.fn(async (r: { messages: { content: string }[] }) => {
      asked = r.messages[0].content;
      return {
        text: '```json\n{"name":"Marca da Clínica","description":"Tudo da clínica","style":{"colors":{"primary":"#2F6B1E","bg":"#FFFFFF"},"heading":{"family":"Lora","weight":700}},"guide":"## Essência\\nCuidado.\\n\\n## Aprendizados\\n- (01/10/2026) Capa escura","notes":["Confirme o tom"]}\n```',
        meter: { model: "claude-x", input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
        rounds: 1,
      };
    });
    const token = `x.${Buffer.from(JSON.stringify({ sub: "00000000-0000-4000-8000-000000000010" })).toString("base64url")}.y`;
    const env = { supabaseUrl: "https://db", supabaseKey: "k", anthropicKey: "sk", model: "claude-x" } as unknown as AiEnv;
    const deps = { fetch: fetchImpl, llm } as unknown as AiDeps;
    const r = await handleIdentityDraft({ company, scope: "client", client, notes: "público jovem" }, `Bearer ${token}`, env, deps);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      name: "Marca da Clínica",
      tokens: { colors: { primary: "#2F6B1E" }, heading: { family: "Lora", source: "google" }, logo: { light: logo } },
      notes: ["Confirme o tom"],
    });
    expect(String(r.body.guide)).toContain("Capa escura");
    expect(asked).toContain("Regras de uso: Sem emoji.");
    expect(asked).toContain("Guia atual:\n## Aprendizados");
    expect(asked).toContain("Pedido da pessoa: público jovem");
    expect(calls.some((c) => c.startsWith("rpc/identity_save"))).toBe(false);
    expect(calls).toContain("rpc/ai_log_usage");
  });
});

describe("histórico com a versão editada", () => {
  it("duas mensagens seguidas da pessoa se juntam; a edição vai com a pergunta", async () => {
    const { conversation } = await import("./_ai");
    const turns = conversation("E agora?", [
      { role: "user", content: "Faça a proposta" },
      { role: "assistant", content: "Pronto: [[D1]]" },
      { role: "user", content: "Editei o D1 direto no canvas e salvei como D2." },
    ]);
    expect(turns).toEqual([
      { role: "user", content: "Faça a proposta" },
      { role: "assistant", content: "Pronto: [[D1]]" },
      { role: "user", content: "Editei o D1 direto no canvas e salvei como D2.\n\nE agora?" },
    ]);
    const middle = conversation("Mais um ajuste", [
      { role: "user", content: "Faça" },
      { role: "assistant", content: "[[D1]]" },
      { role: "user", content: "Editei o D1 (D2)." },
      { role: "user", content: "Deixa mais curto" },
      { role: "assistant", content: "[[D3]]" },
    ]);
    expect(middle[2]).toEqual({ role: "user", content: "Editei o D1 (D2).\n\nDeixa mais curto" });
    expect(middle).toHaveLength(5);
  });
});
