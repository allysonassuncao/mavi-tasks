import { describe, expect, it } from "vitest";
import { cssStyle, siteStyle, topColors } from "./_site-style";

describe("estilo de um site", () => {
  it("as cores das variáveis de tema primeiro, as parecidas juntas, sem fontes de ícone", () => {
    const { colors, fonts } = cssStyle(`:root{--primary:#ff6e28;--text:#222}
a{color:#ff6e28}b{color:#FF6F29}.x{background:#fff;border:1px solid #eee}.y{color:rgba(0,0,0,.1)}
body{font-family:"Biennale",Arial,sans-serif}i{font-family:"Font Awesome 5 Free"}
@font-face{font-family:"Biennale";src:url(x.woff2)}`);
    const top = topColors(colors);
    expect(top[0]).toMatchObject({ hex: "#FF6E28", vars: ["--primary"] });
    expect(top[0].count).toBeGreaterThanOrEqual(6); // 4 da variável + 2 usos (o parecido somado)
    expect(top.map((c) => c.hex)).not.toContain("#000000"); // quase transparente não conta
    expect([...fonts.keys()]).toEqual(["Biennale"]);
  });

  it("lê a página e as folhas próprias (não as de bibliotecas), respeitando o robots.txt", async () => {
    const pages: Record<string, string> = {
      "https://cliente.com.br/robots.txt": "User-agent: *\nDisallow: /privado",
      "https://cliente.com.br/": `<html><head><title>Clínica</title><meta name="theme-color" content="#2F6B1E"><link rel="stylesheet" href="/css/site.css"><link rel="stylesheet" href="https://cdn.x.com/bootstrap.min.css"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lora:wght@400;700&family=DM+Sans"></head><body><img class="logo" src="/img/logo.png"><h1>Cuidado de verdade</h1><p>Atendimento humano.</p></body></html>`,
      "https://cliente.com.br/css/site.css": ":root{--brand:#2F6B1E}h1{color:#2F6B1E;font-family:Lora}",
    };
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(String(url));
      const body = pages[String(url)];
      return new Response(body ?? "", { status: body === undefined ? 404 : 200, headers: { "content-type": String(url).endsWith(".css") ? "text/css" : "text/html" } });
    }) as typeof fetch;
    const deps = { fetch: fetchImpl, lookup: async () => [{ address: "93.184.216.34" }] };
    const s = await siteStyle("cliente.com.br", deps);
    expect(s.themeColor).toBe("#2F6B1E");
    expect(s.colors[0]).toMatchObject({ hex: "#2F6B1E", vars: ["--brand"] });
    expect(s.googleFonts).toEqual(["Lora", "DM Sans"]);
    expect(s.logo).toBe("https://cliente.com.br/img/logo.png");
    expect(s.text).toContain("Atendimento humano");
    expect(asked.some((u) => u.includes("bootstrap"))).toBe(false);
    await expect(siteStyle("https://cliente.com.br/privado/x", deps)).rejects.toThrow(/robots/);
  });
});
