import { describe, expect, it } from "vitest";
import { thumbKind } from "./drive-thumbs";
import { fileTone } from "./DriveThumb";

describe("miniaturas do Drive", () => {
  it("segue a regra do banco: imagens e PDFs até 25 MB, vídeos de qualquer tamanho", () => {
    const mb = 1024 * 1024;
    expect(thumbKind({ content_type: "image/png", size_bytes: 3 * mb })).toBe(
      "image",
    );
    expect(
      thumbKind({ content_type: "application/pdf", size_bytes: 25 * mb }),
    ).toBe("pdf");
    expect(
      thumbKind({ content_type: "image/jpeg", size_bytes: 25 * mb + 1 }),
    ).toBeNull();
    expect(thumbKind({ content_type: "video/mp4", size_bytes: 400 * mb })).toBe(
      "video",
    );
    expect(
      thumbKind({ content_type: "application/zip", size_bytes: 10 }),
    ).toBeNull();
  });
  it("cor e ícone pelo tipo, como no Google Drive", () => {
    expect(fileTone("application/octet-stream", "Relatório.PDF")).toBe("pdf");
    expect(fileTone("", "leads.xlsx")).toBe("sheet");
    expect(fileTone("", "deck.pptx")).toBe("slides");
    expect(fileTone("application/msword", "a.doc")).toBe("doc");
    expect(fileTone("", "fotos.zip")).toBe("archive");
    expect(fileTone("", "sem-extensao")).toBe("other");
  });
});
