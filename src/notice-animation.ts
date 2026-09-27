/**
 * Animação de um aviso do Mural (migration 20261108090000_notice_animation).
 *
 * A MAVI não escreve código: ela devolve um roteiro de cenas neste formato
 * fechado, e o player do SaaS (NoticeAnimation.tsx) anima com CSS e os
 * componentes do próprio app. O mesmo saneamento vale no servidor (antes de
 * gravar) e na tela (antes de tocar): só entram os campos e valores daqui;
 * texto é sempre texto.
 */

export const ANIMATION_MAX_SECONDS = 30;
export const MAX_SCENES = 10;
export const SCENE_MIN_SECONDS = 1.5;
export const SCENE_MAX_SECONDS = 8;
export const MAX_REFERENCES = 6;

export const LAYOUTS = [
  "title",
  "text",
  "steps",
  "stat",
  "screen",
  "mockup",
  "closing",
] as const;
export type SceneLayout = (typeof LAYOUTS)[number];
export const LAYOUT_LABELS: Record<SceneLayout, string> = {
  title: "Abertura",
  text: "Texto",
  steps: "Passo a passo",
  stat: "Número em destaque",
  screen: "Tela (print)",
  mockup: "Interface recriada",
  closing: "Encerramento",
};

export const ICONS = [
  "none",
  "bell",
  "calendar",
  "check",
  "sparkles",
  "megaphone",
  "users",
  "file",
  "clock",
  "alert",
  "rocket",
  "star",
  "gift",
  "lightbulb",
  "shield",
  "chart",
  "heart",
  "mouse",
] as const;
export type AnimIcon = (typeof ICONS)[number];

export const UI_KINDS = [
  "button",
  "menu",
  "card",
  "toggle",
  "input",
  "badge",
  "list",
] as const;
export type UiKind = (typeof UI_KINDS)[number];
export const TONES = ["green", "amber", "blue", "red", "gray"] as const;
export type Tone = (typeof TONES)[number];
export const TRANSITIONS = ["fade", "slide", "zoom"] as const;
export type Transition = (typeof TRANSITIONS)[number];

export type UiItem = {
  kind: UiKind;
  label: string;
  text?: string;
  items?: string[];
  /** Menu: o item ativo; toggle: ligado. */
  active?: number;
  on?: boolean;
  primary?: boolean;
  tone?: Tone;
};
/** Um retângulo ou ponto em % da tela (0 a 100). */
export type Box = { x: number; y: number; w: number; h: number };
export type Scene = {
  layout: SceneLayout;
  /** Segundos. */
  duration: number;
  heading?: string;
  text?: string;
  bullets?: string[];
  icon?: AnimIcon;
  stat?: { value: string; label: string };
  /** Tela: o id do anexo (imagem) usado como print. */
  image?: string;
  focus?: Box;
  cursor?: { x: number; y: number; click: boolean };
  callout?: string;
  /** Interface recriada: até 6 componentes; target é o que o cursor clica. */
  ui?: UiItem[];
  target?: number;
  transition: Transition;
};
export type AnimationSpec = {
  version: 1;
  theme: "light" | "dark";
  scenes: Scene[];
};

// ------------------------------------------------------------ schema
const s = { type: "string" };
const n = { type: "number" };
const b = { type: "boolean" };
const strings = { type: "array", items: s };
const obj = (properties: Record<string, unknown>, description?: string) => ({
  type: "object",
  ...(description ? { description } : {}),
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
/**
 * O JSON Schema da resposta (saída estruturada). Todos os campos são
 * obrigatórios; "vazio" vale como ausente ("" nos textos, [] nas listas,
 * w = 0 no destaque, show = false no cursor, -1 no alvo).
 */
export const ANIMATION_SCHEMA = obj({
  theme: { type: "string", enum: ["light", "dark"] },
  scenes: {
    type: "array",
    description: `De 2 a ${MAX_SCENES} cenas; a soma das durações até ${ANIMATION_MAX_SECONDS} segundos.`,
    items: obj({
      layout: { type: "string", enum: [...LAYOUTS] },
      duration: {
        ...n,
        description: `Segundos, de ${SCENE_MIN_SECONDS} a ${SCENE_MAX_SECONDS}.`,
      },
      heading: s,
      text: s,
      bullets: strings,
      icon: { type: "string", enum: [...ICONS] },
      stat: obj({ value: s, label: s }),
      image: {
        ...s,
        description:
          "Tela: o id de uma das imagens de referência; senão vazio.",
      },
      focus: obj(
        { x: n, y: n, w: n, h: n },
        "Tela: a área a destacar, em % da imagem (w = 0: sem destaque).",
      ),
      cursor: obj(
        { show: b, x: n, y: n, click: b },
        "Tela ou interface: onde o cursor vai (em % da tela) e se clica.",
      ),
      callout: s,
      ui: {
        type: "array",
        description:
          "Interface recriada: até 6 componentes do sistema, de cima para baixo.",
        items: obj({
          kind: { type: "string", enum: [...UI_KINDS] },
          label: s,
          text: s,
          items: strings,
          active: n,
          on: b,
          primary: b,
          tone: { type: "string", enum: [...TONES] },
        }),
      },
      target: {
        ...n,
        description:
          "Interface: o índice do componente que o cursor clica (-1: nenhum).",
      },
      transition: { type: "string", enum: [...TRANSITIONS] },
    }),
  },
});

// ------------------------------------------------------------ saneamento
const clip = (v: unknown, max: number) =>
  typeof v === "string"
    ? v
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
        .trim()
        .slice(0, max)
    : "";
const num = (v: unknown, min: number, max: number, fallback: number) => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : fallback;
};
const oneOf = <T extends string>(
  list: readonly T[],
  v: unknown,
  fallback: T,
): T => (list.includes(v as T) ? (v as T) : fallback);
const texts = (v: unknown, count: number, max: number) =>
  Array.isArray(v)
    ? v
        .map((x) => clip(x, max))
        .filter(Boolean)
        .slice(0, count)
    : [];

export class AnimationError extends Error {}

/**
 * O roteiro conferido: só o que o player sabe tocar, com as durações
 * ajustadas para caber em 30 segundos. `images` são os anexos que podem
 * aparecer como tela (os outros ids somem da cena).
 */
export function sanitizeSpec(
  raw: unknown,
  images: ReadonlySet<string>,
): AnimationSpec {
  const r = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(r.scenes) ? r.scenes.slice(0, MAX_SCENES) : [];
  const scenes: Scene[] = [];
  for (const item of list) {
    const x = (item ?? {}) as Record<string, unknown>;
    let layout = oneOf(LAYOUTS, x.layout, "text");
    const scene: Scene = {
      layout,
      duration: num(x.duration, SCENE_MIN_SECONDS, SCENE_MAX_SECONDS, 3),
      transition: oneOf(TRANSITIONS, x.transition, "fade"),
    };
    const heading = clip(x.heading, 90);
    const text = clip(x.text, 240);
    const bullets = texts(x.bullets, 5, 90);
    const icon = oneOf(ICONS, x.icon, "none");
    if (heading) scene.heading = heading;
    if (text) scene.text = text;
    if (bullets.length) scene.bullets = bullets;
    if (icon !== "none") scene.icon = icon;
    const st = (x.stat ?? {}) as Record<string, unknown>;
    if (layout === "stat" && clip(st.value, 16))
      scene.stat = { value: clip(st.value, 16), label: clip(st.label, 60) };
    const image = clip(x.image, 60);
    if (layout === "screen") {
      if (!images.has(image))
        layout = scene.layout = heading || text ? "text" : "title";
      else scene.image = image;
    }
    const f = (x.focus ?? {}) as Record<string, unknown>;
    if (scene.image && num(f.w, 0, 100, 0) > 0 && num(f.h, 0, 100, 0) > 0)
      scene.focus = {
        x: num(f.x, 0, 100, 0),
        y: num(f.y, 0, 100, 0),
        w: num(f.w, 1, 100, 10),
        h: num(f.h, 1, 100, 10),
      };
    const c = (x.cursor ?? {}) as Record<string, unknown>;
    if (
      (layout === "screen" || layout === "mockup") &&
      c.show !== false &&
      (c.show === true || "x" in c)
    )
      scene.cursor = {
        x: num(c.x, 0, 100, 50),
        y: num(c.y, 0, 100, 50),
        click: c.click === true,
      };
    const callout = clip(x.callout, 80);
    if (callout && (layout === "screen" || layout === "mockup"))
      scene.callout = callout;
    if (layout === "mockup") {
      const ui = (Array.isArray(x.ui) ? x.ui : [])
        .slice(0, 6)
        .map((u) => {
          const y = (u ?? {}) as Record<string, unknown>;
          const item: UiItem = {
            kind: oneOf(UI_KINDS, y.kind, "card"),
            label: clip(y.label, 60),
          };
          const t = clip(y.text, 120);
          const items = texts(y.items, 6, 40);
          if (t) item.text = t;
          if (items.length) item.items = items;
          if (item.kind === "menu")
            item.active = Math.round(num(y.active, -1, items.length - 1, -1));
          if (item.kind === "toggle") item.on = y.on === true;
          if (item.kind === "button") item.primary = y.primary === true;
          if (item.kind === "badge") item.tone = oneOf(TONES, y.tone, "green");
          return item;
        })
        .filter((u) => u.label || u.items?.length);
      if (!ui.length) scene.layout = "text";
      else {
        scene.ui = ui;
        const target = Math.round(num(x.target, -1, ui.length - 1, -1));
        if (target >= 0) scene.target = target;
      }
    }
    if (
      !scene.heading &&
      !scene.text &&
      !scene.bullets &&
      !scene.stat &&
      !scene.image &&
      !scene.ui
    )
      continue;
    scenes.push(scene);
  }
  if (!scenes.length) throw new AnimationError("A animação veio sem cenas.");
  // Cabe em 30 segundos: as cenas encolhem juntas, sem passar do mínimo.
  const total = scenes.reduce((t, x) => t + x.duration, 0);
  if (total > ANIMATION_MAX_SECONDS) {
    const k = ANIMATION_MAX_SECONDS / total;
    for (const x of scenes)
      x.duration = Math.max(
        SCENE_MIN_SECONDS,
        Math.floor(x.duration * k * 10) / 10,
      );
    while (scenes.reduce((t, x) => t + x.duration, 0) > ANIMATION_MAX_SECONDS)
      scenes.pop();
  }
  for (const x of scenes) x.duration = Math.round(x.duration * 10) / 10;
  return { version: 1, theme: r.theme === "dark" ? "dark" : "light", scenes };
}

export const totalSeconds = (spec: Pick<AnimationSpec, "scenes">) =>
  Math.round(spec.scenes.reduce((t, x) => t + x.duration, 0) * 10) / 10;

/** Os anexos que uma animação mostra (para pedir os links de uma vez). */
export const specImages = (spec: AnimationSpec | null | undefined) => [
  ...new Set((spec?.scenes ?? []).flatMap((x) => (x.image ? [x.image] : []))),
];

// ------------------------------------------------------------ custo
/**
 * Quanto custa gerar, antes de gerar: instruções e roteiro (~4 mil tokens),
 * cada imagem (~1,6 mil), a base de conhecimento (~2,5 mil), a versão
 * anterior num ajuste (~2,5 mil); a resposta com o raciocínio (~6 mil).
 */
export function estimateCost(
  price: { input: number; output: number } | null | undefined,
  opts: { images: number; knowledge: boolean; adjusting: boolean },
) {
  if (!price) return null;
  const input =
    4000 +
    1600 * opts.images +
    (opts.knowledge ? 2500 : 0) +
    (opts.adjusting ? 2500 : 0);
  const output = 6000;
  return (input * price.input + output * price.output) / 1e6;
}
