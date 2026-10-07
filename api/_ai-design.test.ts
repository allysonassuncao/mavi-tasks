import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { previewPages, runDesignTool } from "./_ai-design";
import type { PowerKit } from "./_ai-powers";
import type { AiArtifact, CanvasArtifact } from "../src/mavi-artifacts";

const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";
const logo = "00000000-0000-4000-8000-0000000000aa";
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function kit(rpcs: Record<string, unknown> = {}) {
  const artifacts: AiArtifact[] = [];
  const shots: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    const name = String(url).split("/rpc/")[1] ?? "";
    if (!(name in rpcs)) return new Response(JSON.stringify({ message: "não existe" }), { status: 404 });
    return new Response(JSON.stringify(rpcs[name]), { status: 200 });
  });
  const k = {
    env: {
      supabaseUrl: "https://db",
      supabaseKey: "k",
      credentials: { client_email: "svc@example.iam", private_key: privateKey },
      bucket: "b",
      renderPages: async (input: Record<string, unknown>) => {
        shots.push(input);
        return { pages: 3, report: ["Página 2: o conteúdo passa da altura da página e foi cortado."], images: [{ page: 0, data: "AAAA" }, { page: 2, data: "BBBB" }] };
      },
    },
    ctx: { fetch: fetchImpl, auth: "Bearer t", company, clients: new Map([[client, "MakeCRM"]]), scope: { client } },
    artifacts,
    priorImages: new Map([["I1", `ai-images/${company}/00000000-0000-4000-8000-0000000000f1.png`]]),
    priorCanvas: new Map<string, CanvasArtifact>(),
    next: { V: 1, I: 2, A: 1, D: 1, Q: 1, T: 1, B: 1 },
    emit: () => {},
    imageCost: { usd: 0, model: "", provider: null },
  } as unknown as PowerKit;
  return { k, artifacts, shots };
}
const pages = (n: number, extra = "") => Array.from({ length: n }, (_, i) => `<section class="page">Página ${i + 1}${extra}</section>`).join("");

describe("design livre", () => {
  it("prévias: todas até 6; acima, espalhadas com a primeira e a última", () => {
    expect(previewPages(4)).toEqual([0, 1, 2, 3]);
    expect(previewPages(20)).toEqual([0, 4, 8, 11, 15, 19]);
  });

  it("desenha, devolve as prévias para a MAVI e guarda o canvas com a identidade e o logo", async () => {
    const { k, artifacts, shots } = kit({
      identity_file_targets: [{ id: logo, path: "drive/logo.svg" }],
    });
    const out = await runDesignTool(k, {
      title: "Proposta",
      format: "a4",
      identity: "builtin:tech",
      html: `<style>.c{color:var(--primary)}</style>${pages(2)}<section class="page"><img src="img:I1"><script>x()</script></section>`,
    });
    expect(typeof out).toBe("object");
    const o = out as { text: string; images: { data: string }[] };
    expect(o.text).toMatch(/^Design D1 pronto \(3 páginas, A4 em pé, identidade “Tech noturno”\)/);
    expect(o.text).toContain("Página 2: o conteúdo passa");
    expect(o.images.map((i) => i.data)).toEqual(["AAAA", "BBBB"]);
    expect(shots[0]).toMatchObject({ width: 794, height: 1123, type: "jpeg", pick: [0, 1, 2] });
    expect(String(shots[0].html)).toContain("--primary:#22D3EE");
    expect((shots[0].assets as { token: string }[]).map((a) => a.token)).toEqual(["img:I1"]);
    const d = artifacts[0] as CanvasArtifact;
    expect(d.canvas).toMatchObject({ kind: "design", format: "a4", pages: 3, look: { id: "builtin:tech" } });
    expect((d.canvas as { html: string }).html).not.toContain("script");
  });

  it("o que falta volta como texto, sem desenhar", async () => {
    const { k, shots } = kit();
    expect(await runDesignTool(k, { title: "x", html: "<div>uma página sem section nenhuma aqui</div>" })).toMatch(/Nenhuma página/);
    expect(await runDesignTool(k, { title: "x", html: `${pages(1)}<section class="page"><img src="img:I7"></section>` })).toMatch(/Não achei I7/);
    expect(await runDesignTool(k, { title: "x", html: `<section class="page"><img src="marca:logo.svg"></section>` })).toMatch(/não tem “logo.svg”/);
    expect(await runDesignTool(k, { title: "x", html: pages(41) })).toMatch(/máximo é 40/);
    expect(shots).toHaveLength(0);
  });

  it("logo:light usa o logo da identidade; um ajuste mantém o formato e marca a versão", async () => {
    const { k, artifacts } = kit({
      identity_of_client: { id: "00000000-0000-4000-8000-0000000000cc", scope: "client", client_id: client, name: "Guia MakeCRM", tokens: { logo: { light: logo } } },
      identity_file_targets: [{ id: logo, path: "drive/logo.svg" }],
    });
    await runDesignTool(k, { title: "Deck", format: "slides", identity: "cliente", html: `<section class="page"><img src="logo:light"></section>` });
    const first = artifacts[0] as CanvasArtifact;
    expect((first.canvas as { html: string }).html).toContain(`src="file:${logo}"`);
    await runDesignTool(k, { title: "Deck v2", revises: "D1", html: `<section class="page">Nova</section>` });
    const second = artifacts[1] as CanvasArtifact;
    expect(second).toMatchObject({ revision_of: "D1", canvas: { format: "slides", look: { name: "Guia MakeCRM" } } });
  });
});
