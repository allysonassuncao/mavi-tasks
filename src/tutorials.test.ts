import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_PREFIX,
  headingAnchors,
  parseDescription,
  richTextClipboard,
  sanitizeDescription,
  serializeDescription,
  videoEmbedUrl,
  videoFromUrl,
} from "./rich-text";
import {
  addTag,
  audienceSummary,
  contentOf,
  demoTutorials,
  emptyTutorial,
  readingMinutes,
  tutorialModuleOf,
  videoIds,
  videoUrlCache,
  type TutorialDetail,
  type TutorialsApi,
} from "./tutorials";
import type { Snapshot } from "./types";

const MEDIA = "11111111-2222-4333-8444-555555555555";
const doc = (...content: unknown[]) =>
  DESCRIPTION_PREFIX + JSON.stringify({ type: "doc", content });
const h = (text: string, level = 2) => ({
  type: "heading",
  attrs: { level },
  content: [{ type: "text", text }],
});
const p = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

describe("vídeos no texto", () => {
  it("reconhece os links de YouTube, Loom e Vimeo", () => {
    expect(videoFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10")).toEqual({
      provider: "youtube",
      videoId: "dQw4w9WgXcQ",
    });
    expect(videoFromUrl("https://youtu.be/dQw4w9WgXcQ")?.videoId).toBe("dQw4w9WgXcQ");
    expect(videoFromUrl("https://youtube.com/shorts/dQw4w9WgXcQ")?.videoId).toBe(
      "dQw4w9WgXcQ",
    );
    expect(
      videoFromUrl("https://www.loom.com/share/0123456789abcdef0123456789abcdef?sid=1"),
    ).toEqual({ provider: "loom", videoId: "0123456789abcdef0123456789abcdef" });
    expect(videoFromUrl("https://vimeo.com/123456789")).toEqual({
      provider: "vimeo",
      videoId: "123456789",
    });
    expect(videoFromUrl("https://player.vimeo.com/video/123456789")?.videoId).toBe(
      "123456789",
    );
  });

  it("recusa o que não é um vídeo conhecido", () => {
    expect(videoFromUrl("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(videoFromUrl("javascript:alert(1)")).toBeNull();
    expect(videoFromUrl("https://www.youtube.com/watch?v=curto")).toBeNull();
    expect(videoFromUrl("não é link")).toBeNull();
  });

  it("monta o endereço do player só com um id válido", () => {
    expect(videoEmbedUrl("youtube", "dQw4w9WgXcQ")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0",
    );
    expect(videoEmbedUrl("vimeo", "1\"><script>")).toBeNull();
  });

  it("guarda só o id do vídeo, nunca um endereço livre", () => {
    const clean = sanitizeDescription({
      type: "doc",
      content: [
        { type: "tutorialVideo", attrs: { mediaId: MEDIA, label: "Passo 1", src: "x" } },
        { type: "tutorialVideo", attrs: { provider: "youtube", videoId: "dQw4w9WgXcQ" } },
        { type: "tutorialVideo", attrs: { provider: "evil", videoId: "1" } },
        { type: "tutorialVideo", attrs: { mediaId: "../../etc" } },
      ],
    });
    expect(clean.content).toEqual([
      { type: "tutorialVideo", attrs: { mediaId: MEDIA, label: "Passo 1" } },
      {
        type: "tutorialVideo",
        attrs: { provider: "youtube", videoId: "dQw4w9WgXcQ", label: "" },
      },
    ]);
    // Um texto só com vídeo não é vazio.
    expect(
      serializeDescription({ type: "doc", content: [clean.content![0]] }),
    ).not.toBe("");
    expect(videoIds(serializeDescription(clean))).toEqual([MEDIA]);
  });
});

describe("seções", () => {
  it("guarda títulos de nível 2 e 3 só com texto", () => {
    const clean = sanitizeDescription({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "A" }] },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "B" }, { type: "inlineImage", attrs: { imageId: MEDIA } }],
        },
      ],
    });
    expect(clean.content).toEqual([
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "A", marks: [] }] },
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "B", marks: [] }] },
    ]);
  });

  it("dá âncoras únicas, sem acento, e ignora títulos vazios", () => {
    const value = doc(
      h("Criar a tarefa"),
      p("texto"),
      h("Passo à passo", 3),
      { type: "heading", attrs: { level: 2 }, content: [] },
      h("Criar a tarefa"),
    );
    expect(headingAnchors(value)).toEqual([
      { id: "criar-a-tarefa", level: 2, text: "Criar a tarefa" },
      { id: "passo-a-passo", level: 3, text: "Passo à passo" },
      { id: "criar-a-tarefa-2", level: 2, text: "Criar a tarefa" },
    ]);
    expect(headingAnchors(parseDescription("texto antigo"))).toEqual([]);
  });

  it("copia títulos e vídeos para a área de transferência", () => {
    const { text, html } = richTextClipboard(
      doc(h("Entrega"), { type: "tutorialVideo", attrs: { provider: "vimeo", videoId: "123456789", label: "Demo" } }),
    );
    expect(html).toContain("<h2>Entrega</h2>");
    expect(text).toContain("[Vídeo: Demo] https://player.vimeo.com/video/123456789");
  });
});

describe("tutoriais", () => {
  const data = {
    companies: [{ id: "c1", name: "Make" }],
    members: [
      { company_id: "c1", user_id: "admin", name: "Ana", role: "admin", active: true },
      { company_id: "c1", user_id: "gest", name: "Gabi", role: "manager", active: true },
      { company_id: "c1", user_id: "colab", name: "Bruno", role: "member", active: true },
    ],
    teams: [{ id: "t1", company_id: "c1", name: "Tráfego" }],
    teamMembers: [{ company_id: "c1", team_id: "t1", user_id: "colab" }],
  } as unknown as Snapshot;

  it("acha o módulo da tela aberta", () => {
    expect(tutorialModuleOf("search")).toBe("tasks");
    expect(tutorialModuleOf("skills")).toBe("assistant");
    expect(tutorialModuleOf("campaigns")).toBe("campaigns");
    expect(tutorialModuleOf("settings")).toBe("settings");
    expect(tutorialModuleOf("tutorials")).toBeNull();
    expect(tutorialModuleOf("person")).toBeNull();
  });

  it("junta tags iguais sem acento na grafia conhecida", () => {
    expect(addTag(["Tarefas"], " tarefas ", [])).toEqual(["Tarefas"]);
    expect(addTag([], "midia  paga", ["Mídia paga"])).toEqual(["Mídia paga"]);
    expect(addTag([], "  ", [])).toEqual([]);
  });

  it("resume o público", () => {
    expect(audienceSummary(emptyTutorial(), data)).toBe("Todos");
    expect(audienceSummary({ ...emptyTutorial(), aud_exclude: ["colab"] }, data)).toBe(
      "Todos, menos 1 pessoa",
    );
    expect(
      audienceSummary(
        { ...emptyTutorial(), aud_all: false, aud_roles: ["manager"], aud_teams: ["t1"] },
        data,
      ),
    ).toBe("Gestores, Tráfego");
  });

  it("conta os minutos de leitura", () => {
    expect(readingMinutes("")).toBe(1);
    expect(readingMinutes(doc(p(Array(1000).fill("palavra").join(" "))))).toBe(5);
  });

  it("abre para edição o rascunho guardado, se houver", () => {
    const detail = {
      title: "No ar",
      summary: "",
      body: "",
      modules: [],
      category: "",
      tags: [],
      audience: { ...emptyTutorial(), aud_all: false, aud_roles: ["admin"] },
      draft: null,
    } as unknown as TutorialDetail;
    expect(contentOf(detail).aud_roles).toEqual(["admin"]);
    expect(
      contentOf({ ...detail, draft: { content: { ...emptyTutorial(), title: "Novo" }, saved_at: "", saved_by_name: "" } })
        .title,
    ).toBe("Novo");
  });

  it("pede os links dos vídeos de uma vez e reaproveita", async () => {
    const calls: string[][] = [];
    const api = {
      mediaUrls: async (ids: string[]) => {
        calls.push(ids);
        return Object.fromEntries(ids.map((id) => [id, `https://x/${id}`]));
      },
    } as unknown as TutorialsApi;
    const urls = videoUrlCache(api);
    const [a, b] = await Promise.all([urls(["1"]), urls(["2", "1"])]);
    expect(a).toEqual({ 1: "https://x/1" });
    expect(b).toEqual({ 2: "https://x/2", 1: "https://x/1" });
    expect(calls).toEqual([["1", "2"]]);
    await urls(["1"]);
    expect(calls).toHaveLength(1);
  });

  it("na demonstração: rascunho escondido, alteração guardada e público", async () => {
    const asAdmin = demoTutorials(data, "admin");
    const asMember = demoTutorials(data, "colab");
    const q = { scope: "library" as const, query: "", module: "", category: "", tags: [], limit: 30, offset: 0 };
    const before = (await asMember.list("c1", q)).length;
    const r = await asAdmin.save("c1", null, { ...emptyTutorial(), title: "Guia novo" }, false);
    expect(r.mode).toBe("created");
    expect((await asMember.list("c1", q)).length).toBe(before);
    await asAdmin.save("c1", r.id, { ...emptyTutorial(), title: "Guia novo", aud_all: false, aud_teams: ["t1"] }, true);
    expect((await asMember.list("c1", { ...q, query: "guia novo" })).map((x) => x.title)).toEqual([
      "Guia novo",
    ]);
    const d = await asAdmin.save("c1", r.id, { ...emptyTutorial(), title: "Guia renomeado", aud_all: false, aud_teams: ["t1"] }, false);
    expect(d.mode).toBe("draft");
    expect((await asMember.detail(r.id))?.title).toBe("Guia novo");
    await expect(asMember.save("c1", null, { ...emptyTutorial(), title: "x".repeat(5) }, true)).rejects.toThrow(
      /administradores e gestores/,
    );
    await asAdmin.remove(r.id);
    expect(await asAdmin.detail(r.id)).toBeNull();
  });
});
