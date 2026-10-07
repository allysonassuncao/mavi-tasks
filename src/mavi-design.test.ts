import { describe, expect, it } from "vitest";
import { cleanDesignHtml, countPages, designPage, designTokens } from "./mavi-design";
import { sanitizeCanvas } from "./mavi-artifacts";
import { builtinLook } from "./visual-identity";

const file = "00000000-0000-4000-8000-0000000000aa";

describe("design livre: limpeza", () => {
  it("tira scripts, eventos, formulários e endereços de fora; mantém desenho e referências", () => {
    const html = cleanDesignHtml(`<style>@import url('https://fonts.googleapis.com/css2?family=Inter');@import url(https://evil.com/x.css);.a{background:url(https://evil.com/bg.png)}.b{background:url(img:I2)}</style>
<section class="page" onclick="steal()"><script>alert(1)</script><iframe src="https://x"></iframe>
<img src="file:${file}"><img src="https://evil.com/p.png" onerror="alert(2)"><img src="img:I3">
<a href="javascript:alert(3)">x</a><a href="https://make.com.br">site</a><form action="/x"><input name="senha"></form>
<link rel="stylesheet" href="https://evil.com/a.css"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins"><meta http-equiv="refresh" content="0;url=https://x"></section>`);
    for (const bad of ["<script", "alert(1)", "onclick", "onerror", "<iframe", "evil.com", "javascript:", "<form", "<input", "http-equiv"])
      expect(html, bad).not.toContain(bad);
    for (const ok of [`src="file:${file}"`, 'src="img:I3"', "url(img:I2)", 'href="https://make.com.br"', "fonts.googleapis.com/css2?family=Poppins", "fonts.googleapis.com/css2?family=Inter"])
      expect(html, ok).toContain(ok);
    expect(countPages(html)).toBe(1);
    expect(designTokens(html)).toEqual({ files: [file], images: ["I2", "I3"] });
  });

  it("a página inteira: tamanho do formato, tema, e as referências trocadas quando há link", () => {
    const look = builtinLook("tech")!;
    const page = designPage(`<style>.x{color:red}</style><section class="page"><img src="file:${file}"></section><section class="page flow">texto</section>`, "slides", look);
    expect(page).toContain("@page{size:1280px 720px;margin:0}");
    expect(page).toContain(".page{position:relative;width:1280px;height:720px");
    expect(page).toContain("--primary:#22D3EE");
    expect(page).toContain("fonts.googleapis.com/css2?family=Space+Grotesk");
    expect(page.indexOf(".x{color:red}")).toBeGreaterThan(page.indexOf("@page"));
    expect(page).toContain(`src="file:${file}"`);
    const linked = designPage(`<section class="page"><img src="file:${file}"><img src="img:I9"></section>`, "a4", null, (t) => (t.startsWith("file:") ? "https://gcs/logo.png" : null));
    expect(linked).toContain('src="https://gcs/logo.png"');
    expect(linked).toContain('src=""');
    expect(linked).toContain("@page{size:A4;margin:0}");
  });

  it("o canvas guarda o design limpo e conta as páginas", () => {
    const c = sanitizeCanvas({ kind: "design", title: "Proposta", format: "inventado", html: '<section class="page">A</section><section class="page">B<script>x</script></section>' });
    expect(c).toMatchObject({ kind: "design", format: "a4", pages: 2 });
    expect((c as { html: string }).html).not.toContain("script");
    expect(sanitizeCanvas({ kind: "design", title: "x", html: "<div>sem página nenhuma aqui dentro</div>" })).toBeNull();
  });
});
