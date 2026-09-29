import { describe, expect, it, vi } from "vitest";
import { decode, focusText, pageForMavi, readHtml, robotsAllows, scrapePage } from "./_ai-scrape";

const lookup = async (host: string) => [{ address: host.startsWith("interno") ? "10.0.0.8" : "93.184.216.34" }];
const html = `<!doctype html><html><head>
<title>Planos &amp; Preços | Concorrente</title>
<meta name="description" content="Veja os planos da Concorrente">
<script type="application/ld+json">{"@type":"Product","name":"Plano Pro","offers":{"price":"199.90","priceCurrency":"BRL"}}</script>
<script>window.tracking = 1</script><style>.x{color:red}</style>
</head><body>
<nav><a href="/">Início</a><a href="/blog">Blog</a></nav>
<main>
<h1>Nossos planos</h1>
<p>Escolha o plano ideal &mdash; sem fidelidade.</p>
<ul><li>Suporte 24h</li><li>Relatórios</li></ul>
<table><tr><th>Plano</th><th>Preço</th></tr><tr><td>Básico</td><td>R$ 99</td></tr><tr><td>Pro</td><td>R$ 199,90</td></tr></table>
<a href="/contato">Fale conosco</a>
</main>
<footer>© 2026 Concorrente</footer>
</body></html>`;

describe("leitura de páginas: o conteúdo", () => {
  it("título, descrição, texto principal, tabelas, dados estruturados e links", () => {
    const p = readHtml(html, "https://concorrente.com.br/planos");
    expect(p.title).toBe("Planos & Preços | Concorrente");
    expect(p.description).toBe("Veja os planos da Concorrente");
    expect(p.text).toContain("# Nossos planos");
    expect(p.text).toContain("Escolha o plano ideal — sem fidelidade.");
    expect(p.text).toContain("- Suporte 24h");
    // Menu, rodapé, scripts e estilos ficam de fora.
    expect(p.text).not.toMatch(/Início|tracking|color:red|© 2026/);
    expect(p.tables[0]).toBe("| Plano | Preço |\n| --- | --- |\n| Básico | R$ 99 |\n| Pro | R$ 199,90 |");
    expect(JSON.parse(p.data[0])).toMatchObject({ name: "Plano Pro", offers: { price: "199.90" } });
    expect(p.links).toEqual([{ text: "Fale conosco", url: "https://concorrente.com.br/contato" }]);
    expect(decode("&#x1F600; &#233; &aacute; &foo;")).toBe("😀 é á &foo;");
  });

  it("página montada por JavaScript avisa; página longa traz o foco primeiro", () => {
    const spa = readHtml(`<html><body><div id="root"></div>${"<script></script>".repeat(8)}</body></html>`, "https://x.com");
    expect(spa.note).toContain("JavaScript");
    const long = [...Array(40)].map((_, i) => (i === 30 ? "Preço do plano Pro: R$ 199" : `Parágrafo ${i} ${"x".repeat(400)}`)).join("\n\n");
    const cut = focusText(long, "preço", 3000);
    expect(cut.length).toBeLessThan(3200);
    expect(cut).toContain("Preço do plano Pro: R$ 199");
    expect(cut).toContain("Parágrafo 0");
    expect(cut).toContain("vieram os trechos sobre");
  });

  it("robots.txt: o grupo da MAVI ou o '*', a regra mais longa vale", () => {
    const robots = "User-agent: *\nDisallow: /admin\nAllow: /admin/publico\nDisallow: /*.pdf$\n\nUser-agent: Googlebot\nDisallow: /";
    expect(robotsAllows(robots, "/planos")).toBe(true);
    expect(robotsAllows(robots, "/admin/usuarios")).toBe(false);
    expect(robotsAllows(robots, "/admin/publico/x")).toBe(true);
    expect(robotsAllows(robots, "/files/a.pdf")).toBe(false);
    expect(robotsAllows("User-agent: MAVI-Bot\nDisallow: /\n\nUser-agent: *\nAllow: /", "/x")).toBe(false);
    expect(robotsAllows("", "/qualquer")).toBe(true);
  });
});

describe("leitura de páginas: a busca", () => {
  const world = (routes: Record<string, () => Response>) => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      return routes[url] ? routes[url]() : new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  };
  const page = (body: string, type = "text/html; charset=utf-8") =>
    new Response(body, { status: 200, headers: { "content-type": type } });

  it("lê a página seguindo o redirecionamento e respeita o robots.txt", async () => {
    const { fetchImpl, calls } = world({
      "https://concorrente.com.br/robots.txt": () => page("User-agent: *\nDisallow: /privado", "text/plain"),
      "https://concorrente.com.br/planos": () =>
        new Response(null, { status: 301, headers: { location: "/planos-2026" } }),
      "https://concorrente.com.br/planos-2026": () => page(html),
    });
    const robots = new Map<string, string>();
    const p = await scrapePage("https://concorrente.com.br/planos", { fetch: fetchImpl, lookup }, robots, { focus: "preço" });
    expect(p.url).toBe("https://concorrente.com.br/planos-2026");
    expect(p.title).toBe("Planos & Preços | Concorrente");
    expect(pageForMavi(p, "S3", false)).toMatch(/^\[S3\] Planos & Preços \| Concorrente\nEndereço: https:\/\/concorrente\.com\.br\/planos-2026/);
    await expect(
      scrapePage("https://concorrente.com.br/privado/x", { fetch: fetchImpl, lookup }, robots),
    ).rejects.toThrow("robots.txt");
    // O robots.txt do site é buscado uma vez por resposta.
    expect(calls.filter((c) => c.endsWith("/robots.txt"))).toHaveLength(1);
  });

  it("nada de rede interna, nem por redirecionamento; erros claros", async () => {
    const { fetchImpl } = world({
      "https://site.com/robots.txt": () => new Response("", { status: 404 }),
      "https://site.com/vai": () => new Response(null, { status: 302, headers: { location: "https://interno.site.com/admin" } }),
      "https://site.com/login": () => new Response("", { status: 403 }),
      "https://site.com/foto.png": () => page("x", "image/png"),
      "https://site.com/api": () => page('{"ok":true}', "application/json"),
    });
    const deps = { fetch: fetchImpl, lookup };
    const robots = new Map<string, string>();
    await expect(scrapePage("http://site.com/x", deps, robots)).rejects.toThrow("https://");
    await expect(scrapePage("https://interno.site.com/", deps, robots)).rejects.toThrow("rede interna");
    await expect(scrapePage("https://site.com/vai", deps, robots)).rejects.toThrow("rede interna");
    await expect(scrapePage("https://site.com/login", deps, robots)).rejects.toThrow("pede login");
    await expect(scrapePage("https://site.com/nada", deps, robots)).rejects.toThrow("não existe");
    await expect(scrapePage("https://site.com/foto.png", deps, robots)).rejects.toThrow("tipo de arquivo");
    expect((await scrapePage("https://site.com/api", deps, robots)).text).toBe('{"ok":true}');
  });
});
