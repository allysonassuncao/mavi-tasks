import { describe, expect, it } from "vitest";
import {
  addNiche,
  groupMedia,
  linkInfo,
  mediaKind,
  nicheSuggestions,
  normalizeUrl,
  textInfo,
} from "./cases";

describe("Cases de Sucesso: organização do material", () => {
  it("completa o endereço digitado sem https e recusa o que não é link", () => {
    expect(normalizeUrl("instagram.com/clinica")).toBe(
      "https://instagram.com/clinica",
    );
    expect(normalizeUrl("https://site.com.br/lp")).toBe(
      "https://site.com.br/lp",
    );
    expect(normalizeUrl("javascript:alert(1)")).toBe("");
    expect(normalizeUrl("não é link")).toBe("");
    expect(normalizeUrl("  ")).toBe("");
  });

  it("reconhece o tipo do link e mostra o @ dos perfis", () => {
    expect(
      linkInfo({ url: "https://www.instagram.com/clinicasorriso/", label: "" }),
    ).toEqual({
      kind: "instagram",
      title: "Instagram",
      short: "@clinicasorriso",
    });
    expect(
      linkInfo({ url: "https://youtu.be/abc", label: "Depoimento" }).title,
    ).toBe("Depoimento");
    expect(linkInfo({ url: "https://youtu.be/abc", label: "" }).kind).toBe(
      "youtube",
    );
    expect(
      linkInfo({ url: "https://clinica.com.br/lp-implantes", label: "" }).title,
    ).toBe("Landing page");
    expect(
      linkInfo({ url: "https://clinica.com.br", label: "" }),
    ).toMatchObject({
      kind: "site",
      title: "Site",
      short: "clinica.com.br",
    });
  });

  it("telefone, WhatsApp e e-mail viram botões", () => {
    expect(textInfo({ label: "E-mail", value: "dono@clinica.com.br" })).toEqual(
      {
        kind: "email",
        href: "mailto:dono@clinica.com.br",
      },
    );
    expect(textInfo({ label: "Celular", value: "(11) 99876-5432" })).toEqual({
      kind: "whatsapp",
      href: "https://wa.me/5511998765432",
    });
    expect(textInfo({ label: "Telefone", value: "(11) 3456-7890" })).toEqual({
      kind: "phone",
      href: "tel:+551134567890",
    });
    expect(textInfo({ label: "WhatsApp", value: "11 3456-7890" }).kind).toBe(
      "whatsapp",
    );
    expect(textInfo({ label: "Obs.", value: "Indicado pelo Marcos" })).toEqual({
      kind: "text",
    });
  });

  it("nicho repetido não entra e a grafia existente vence", () => {
    const known = ["Odontologia", "Estética"];
    expect(addNiche([], "  odontologia ", known)).toEqual(["Odontologia"]);
    expect(addNiche(["Odontologia"], "ODONTOLOGIA", known)).toEqual([
      "Odontologia",
    ]);
    expect(addNiche([], "Pet   shop", known)).toEqual(["Pet shop"]);
    expect(addNiche([], "estetica", known)).toEqual(["Estética"]);
  });

  it("sugere nichos pelo começo, depois pelo meio, sem os já escolhidos", () => {
    const known = [
      { niche: "Estética", cases: 5 },
      { niche: "Clínica estética", cases: 2 },
      { niche: "Odontologia", cases: 3 },
    ];
    expect(nicheSuggestions(known, "est", []).map((n) => n.niche)).toEqual([
      "Estética",
      "Clínica estética",
    ]);
    expect(
      nicheSuggestions(known, "est", ["estetica"]).map((n) => n.niche),
    ).toEqual(["Clínica estética"]);
    expect(nicheSuggestions(known, "", [], 2)).toHaveLength(2);
  });

  it("fotos e vídeos vão para a galeria; o resto vira lista de arquivos", () => {
    const media = [
      { name: "proposta.pdf", content_type: "application/pdf" },
      { name: "antes.jpg", content_type: "image/jpeg" },
      { name: "logo.svg", content_type: "image/svg+xml" },
      { name: "depoimento.mp4", content_type: "video/mp4" },
    ];
    const { visual, files } = groupMedia(media);
    expect(visual.map((m) => m.name)).toEqual(["antes.jpg", "depoimento.mp4"]);
    expect(files.map((m) => m.name)).toEqual(["proposta.pdf", "logo.svg"]);
    expect(
      mediaKind({
        name: "apresentacao.pptx",
        content_type: "application/octet-stream",
      }),
    ).toBe("doc");
  });
});
