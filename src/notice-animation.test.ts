import { describe, expect, it } from "vitest";
import {
  ANIMATION_MAX_SECONDS,
  estimateCost,
  sanitizeSpec,
  specImages,
  totalSeconds,
} from "./notice-animation";

const shot = "00000000-0000-4000-8000-000000000001";
const empty = {
  heading: "",
  text: "",
  bullets: [],
  icon: "none",
  stat: { value: "", label: "" },
  image: "",
  focus: { x: 0, y: 0, w: 0, h: 0 },
  cursor: { show: false, x: 0, y: 0, click: false },
  callout: "",
  ui: [],
  target: -1,
  transition: "fade",
};

describe("Roteiro da animação", () => {
  it("guarda só o que o player toca e trata vazio como ausente", () => {
    const spec = sanitizeSpec(
      {
        theme: "light",
        scenes: [
          {
            ...empty,
            layout: "title",
            duration: 3,
            heading: "Chegou o Mural",
            icon: "megaphone",
          },
          {
            ...empty,
            layout: "screen",
            duration: 5,
            heading: "Clique aqui",
            image: shot,
            focus: { x: 10, y: 20, w: 30, h: 8 },
            cursor: { show: true, x: 25, y: 24, click: true },
            callout: "Novo aviso",
          },
          {
            ...empty,
            layout: "steps",
            duration: 4,
            bullets: ["Escreva", "", "Publique"],
            hack: "<script>",
          },
        ],
      },
      new Set([shot]),
    );
    expect(spec.scenes).toHaveLength(3);
    expect(spec.scenes[0]).toEqual({
      layout: "title",
      duration: 3,
      heading: "Chegou o Mural",
      icon: "megaphone",
      transition: "fade",
    });
    expect(spec.scenes[1].focus).toEqual({ x: 10, y: 20, w: 30, h: 8 });
    expect(spec.scenes[1].cursor).toEqual({ x: 25, y: 24, click: true });
    expect(spec.scenes[2].bullets).toEqual(["Escreva", "Publique"]);
    expect("hack" in spec.scenes[2]).toBe(false);
    expect(specImages(spec)).toEqual([shot]);
  });

  it("tela sem um print do aviso vira texto; interface sem componentes também", () => {
    const spec = sanitizeSpec(
      {
        scenes: [
          {
            ...empty,
            layout: "screen",
            duration: 4,
            heading: "Tela",
            image: "outro-id",
          },
          { ...empty, layout: "mockup", duration: 4, heading: "Sem nada" },
          { ...empty, layout: "text", duration: 3 },
        ],
      },
      new Set([shot]),
    );
    expect(spec.scenes.map((s) => s.layout)).toEqual(["text", "text"]);
    expect(spec.scenes[0].image).toBeUndefined();
  });

  it("interface recriada: componentes conhecidos, alvo válido e cursor", () => {
    const [scene] = sanitizeSpec(
      {
        scenes: [
          {
            ...empty,
            layout: "mockup",
            duration: 5,
            ui: [
              {
                kind: "menu",
                label: "",
                text: "",
                items: ["Visão geral", "Mural"],
                active: 1,
                on: false,
                primary: false,
                tone: "green",
              },
              {
                kind: "button",
                label: "Novo aviso",
                text: "",
                items: [],
                active: 0,
                on: false,
                primary: true,
                tone: "green",
              },
              {
                kind: "iframe",
                label: "x",
                text: "",
                items: [],
                active: 0,
                on: false,
                primary: false,
                tone: "green",
              },
            ],
            target: 1,
            cursor: { show: true, x: 60, y: 30, click: true },
          },
        ],
      },
      new Set(),
    ).scenes;
    expect(scene.ui?.map((u) => u.kind)).toEqual(["menu", "button", "card"]);
    expect(scene.ui?.[0].active).toBe(1);
    expect(scene.ui?.[1].primary).toBe(true);
    expect(scene.target).toBe(1);
  });

  it("cabe em 30 segundos e recusa um roteiro sem cenas", () => {
    const spec = sanitizeSpec(
      {
        scenes: Array.from({ length: 10 }, (_, i) => ({
          ...empty,
          layout: "text",
          duration: 8,
          heading: `Cena ${i}`,
        })),
      },
      new Set(),
    );
    expect(totalSeconds(spec)).toBeLessThanOrEqual(ANIMATION_MAX_SECONDS);
    expect(spec.scenes.every((s) => s.duration >= 1.5)).toBe(true);
    expect(() => sanitizeSpec({ scenes: [] }, new Set())).toThrow(/sem cenas/);
    expect(() =>
      sanitizeSpec({ scenes: [{ layout: "text" }] }, new Set()),
    ).toThrow();
  });

  it("estima o custo antes de gerar", () => {
    expect(
      estimateCost(null, { images: 0, knowledge: false, adjusting: false }),
    ).toBeNull();
    const base = estimateCost(
      { input: 2, output: 10 },
      { images: 0, knowledge: false, adjusting: false },
    )!;
    expect(base).toBeCloseTo((4000 * 2 + 6000 * 10) / 1e6);
    const more = estimateCost(
      { input: 2, output: 10 },
      { images: 2, knowledge: true, adjusting: true },
    )!;
    expect(more).toBeGreaterThan(base);
  });
});
