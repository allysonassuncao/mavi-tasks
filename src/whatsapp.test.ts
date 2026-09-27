import { describe, expect, it, vi } from "vitest";
import { ago, filterGroups, groupFilter, type WhatsappGroup } from "./whatsapp";

const group = (over: Partial<WhatsappGroup>): WhatsappGroup => ({
  id: "g",
  jid: "1@g.us",
  title: "",
  client_id: null,
  product_ids: [],
  linked_by: "auto",
  ignored: false,
  last_message_at: null,
  synced_until: null,
  synced_at: null,
  sync_error: null,
  message_count: 0,
  ...over,
});

describe("grupos do Whatsapp", () => {
  const groups = [
    group({ id: "a", title: "2745 - Facilita & Make", client_id: "c1" }),
    group({ id: "b", title: "CS | CX - Relacionamento", jid: "120363@g.us" }),
    group({ id: "c", title: "Squad 1", ignored: true, client_id: "c1" }),
  ];
  const names: Record<string, string> = { c1: "Aurora Studio" };

  it("cada grupo está numa aba só", () => {
    expect(groups.map(groupFilter)).toEqual(["linked", "unlinked", "ignored"]);
  });
  it("busca por título, cliente (sem acento) e JID", () => {
    const find = (f: Parameters<typeof filterGroups>[1], q: string) =>
      filterGroups(groups, f, q, (id) => names[id]).map((g) => g.id);
    expect(find("linked", "")).toEqual(["a"]);
    expect(find("linked", "aurora")).toEqual(["a"]);
    expect(find("linked", "FACILITA")).toEqual(["a"]);
    expect(find("unlinked", "relacionamento")).toEqual(["b"]);
    expect(find("unlinked", "120363")).toEqual(["b"]);
    expect(find("ignored", "aurora")).toEqual(["c"]);
    expect(find("linked", "nada")).toEqual([]);
  });
  it("tempo desde a última leitura", () => {
    const now = Date.UTC(2026, 8, 26, 12);
    const at = (ms: number) => new Date(now - ms).toISOString();
    expect(ago(null, now)).toBe("");
    expect(ago(at(20_000), now)).toBe("agora");
    expect(ago(at(20 * 60_000), now)).toBe("há 20 min");
    expect(ago(at(3 * 3600_000), now)).toBe("há 3 h");
    expect(ago(at(26 * 3600_000), now)).toBe("há 1 dia");
    expect(ago(at(5 * 86400_000), now)).toBe("há 5 dias");
  });
});

// ------------------------------------------------------------ pasta no Drive
import {
  dayLabel,
  formatPhone,
  formatWhatsapp,
  linksIn,
  messagePreview,
  messagesTask,
  fallbackTitle,
  reactionsOf,
  senderLabel,
  taskContract,
  timeLabel,
  visibleMessages,
  type WhatsappMessage,
} from "./whatsapp";
import type { Snapshot } from "./types";

const msg = (over: Partial<WhatsappMessage>): WhatsappMessage => ({
  id: "m",
  group_id: "g1",
  wa_id: "w",
  sent_at: "2026-09-26T15:00:00.000Z",
  sender: "1@lid",
  sender_phone: "5511986060266",
  sender_name: "Kamilli",
  from_me: false,
  kind: "text",
  body: "",
  quoted_wa_id: null,
  reaction_to: null,
  edited: false,
  extra: {},
  media_mime: null,
  media_name: null,
  media_bytes: null,
  media_seconds: null,
  media_status: "none",
  content_text: null,
  content_status: "none",
  ...over,
});

describe("formatação do WhatsApp", () => {
  it("negrito, itálico, riscado, mono e links", () => {
    expect(
      formatWhatsapp(
        "Olá *time*, veja _isso_ ~não~ ```x = 1``` em https://make.com.br/a?b=1.",
      ),
    ).toEqual([
      { text: "Olá " },
      { text: "time", bold: true },
      { text: ", veja " },
      { text: "isso", italic: true },
      { text: " " },
      { text: "não", strike: true },
      { text: " " },
      { text: "x = 1", mono: true },
      { text: " em " },
      { text: "https://make.com.br/a?b=1", href: "https://make.com.br/a?b=1" },
      { text: "." },
    ]);
  });
  it("asterisco solto e nomes com sublinhado ficam como texto", () => {
    expect(formatWhatsapp("2 * 3 = 6")).toEqual([{ text: "2 * 3 = 6" }]);
    expect(formatWhatsapp("arquivo_final_v2.pdf")).toEqual([
      { text: "arquivo_final_v2.pdf" },
    ]);
  });
  it("links de um texto", () => {
    expect(linksIn("veja (https://a.com/x) e http://b.com.")).toEqual([
      "https://a.com/x",
      "http://b.com",
    ]);
  });
});

describe("conversa", () => {
  it("reações: a última de cada pessoa, e a vazia tira", () => {
    const list = [
      msg({ id: "1", wa_id: "A", body: "oi" }),
      msg({
        id: "2",
        kind: "reaction",
        reaction_to: "A",
        body: "👍",
        sender: "x",
        sender_name: "Ana",
        sent_at: "2026-09-26T15:01:00Z",
      }),
      msg({
        id: "3",
        kind: "reaction",
        reaction_to: "A",
        body: "❤️",
        sender: "x",
        sender_name: "Ana",
        sent_at: "2026-09-26T15:02:00Z",
      }),
      msg({
        id: "4",
        kind: "reaction",
        reaction_to: "A",
        body: "❤️",
        sender: "y",
        sender_name: "Bia",
        sent_at: "2026-09-26T15:02:00Z",
      }),
      msg({
        id: "5",
        kind: "reaction",
        reaction_to: "A",
        body: "😂",
        sender: "z",
        sender_name: "Caio",
        sent_at: "2026-09-26T15:01:00Z",
      }),
      msg({
        id: "6",
        kind: "reaction",
        reaction_to: "A",
        body: "",
        sender: "z",
        sender_name: "Caio",
        sent_at: "2026-09-26T15:03:00Z",
      }),
      msg({ id: "7", kind: "album", body: "Album: 2 images" }),
    ];
    expect(reactionsOf(list).get("A")).toEqual([
      { emoji: "❤️", names: ["Ana", "Bia"] },
    ]);
    expect(visibleMessages(list).map((m) => m.id)).toEqual(["1"]);
  });
  it("quem mandou: nome, telefone ou o número da agência", () => {
    expect(formatPhone("5511986060266")).toBe("+55 11 98606-0266");
    expect(formatPhone("14155550100")).toBe("+14155550100");
    expect(senderLabel(msg({ sender_name: "" }))).toBe("+55 11 98606-0266");
    expect(senderLabel(msg({ sender_name: "", from_me: true }))).toBe(
      "Número da agência",
    );
  });
  it("datas no horário de Brasília", () => {
    const now = Date.parse("2026-09-26T15:00:00Z");
    expect(dayLabel("2026-09-26T04:00:00Z", now)).toBe("Hoje");
    // 02:00 UTC do dia 26 ainda é dia 25 em Brasília.
    expect(dayLabel("2026-09-26T02:00:00Z", now)).toBe("Ontem");
    expect(dayLabel("2026-09-20T15:00:00Z", now)).toBe(
      "20 de setembro de 2026",
    );
    expect(timeLabel("2026-09-26T15:05:00Z")).toBe("12:05");
  });
  it("resumo de cada tipo", () => {
    expect(messagePreview(msg({ body: "  oi  " }))).toBe("oi");
    expect(messagePreview(msg({ body: "*Atenção*: _hoje_" }))).toBe(
      "Atenção: hoje",
    );
    expect(
      messagePreview(
        msg({ kind: "document", media_name: "Proposta.pdf", body: "segue" }),
      ),
    ).toBe("Proposta.pdf · segue");
    expect(messagePreview(msg({ kind: "audio" }))).toBe("Áudio");
    expect(messagePreview(msg({ kind: "image", body: "arte" }))).toBe(
      "Imagem: arte",
    );
  });
});

describe("tarefa a partir de mensagens", () => {
  it("prefere o contrato do produto do grupo que a pessoa pode usar", () => {
    const data = {
      contracts: [
        { id: "k1", client_id: "c1", product_id: "social", archived: false },
        { id: "k2", client_id: "c1", product_id: "ads", archived: false },
        { id: "k3", client_id: "c1", product_id: "seo", archived: true },
        { id: "k4", client_id: "c2", product_id: "ads", archived: false },
      ],
    } as unknown as Snapshot;
    const all = () => true;
    expect(taskContract(data, "c1", ["ads"], all)).toBe("k2");
    expect(taskContract(data, "c1", [], all)).toBe("k1");
    expect(taskContract(data, "c1", ["ads"], (k) => k !== "k2")).toBe("k1");
    expect(
      taskContract(data, "c1", ["seo"], (k) => k === "k3"),
    ).toBeUndefined();
  });
  it("título da primeira mensagem, as mensagens em ordem e o link", () => {
    vi.stubGlobal("window", {
      location: {
        pathname: "/agencias/make/drive",
        origin: "https://app.test",
      },
    });
    const task = messagesTask(
      [
        msg({
          id: "b",
          body: "Pode ser amanhã às 10h",
          sent_at: "2026-09-26T15:10:00Z",
          sender_name: "Rauzer",
        }),
        msg({
          id: "a",
          body: "Precisamos   trocar o criativo\nda campanha",
          sent_at: "2026-09-26T15:00:00Z",
        }),
      ],
      { group: "g1", groupTitle: "2745 - Facilita", clientName: "2745" },
    );
    expect(task.title).toBe("Precisamos trocar o criativo da campanha");
    const doc = JSON.stringify(task.description);
    expect(doc.indexOf("Kamilli")).toBeLessThan(doc.indexOf("Rauzer"));
    expect(doc).toContain("2745 - Facilita (cliente 2745)");
    expect(doc).toContain("whatsapp=g1");
    expect(doc).toContain("msg=a");
  });
});

describe("tarefa inteligente a partir de mensagens", () => {
  const ctx = {
    group: "g1",
    groupTitle: "2745 - Facilita & Make",
    clientName: "2745",
  };
  const picked = [
    msg({
      id: "a",
      body: "Bom dia pessoal! Podemos trocar o *criativo* da campanha de outubro até sexta?",
      sent_at: "2026-09-26T13:00:00Z",
      sender_name: "Rauzer",
    }),
    msg({
      id: "b",
      kind: "audio",
      media_seconds: 23,
      content_text: "E aumentar a verba para 5 mil",
      sent_at: "2026-09-26T13:05:00Z",
      sender_name: "Rauzer",
    }),
  ];
  const nodes = (description: string) =>
    JSON.parse(description.replace(/^mavi:richtext:v1:/, "")).content as any[];
  const textOf = (n: any): string =>
    n.text ??
    (n.content ?? []).map(textOf).join(n.type === "bulletList" ? "\n" : "");
  it("com a MAVI: resumo, o que fazer, detalhes, mensagens com link e prazo", () => {
    vi.stubGlobal("window", {
      location: {
        pathname: "/agencias/make/drive",
        origin: "https://app.test",
      },
    });
    const task = messagesTask(picked, ctx, {
      title: "Trocar o criativo da campanha de outubro",
      summary: "Rauzer pediu novo criativo e mais verba.",
      actions: ["Criar 3 opções", "Ajustar a verba"],
      details: ["Prazo: sexta"],
      due: "2026-10-02",
    });
    expect(task.title).toBe("Trocar o criativo da campanha de outubro");
    expect(task.due).toBe("2026-10-02");
    const doc = nodes(task.description);
    expect(doc.map(textOf)).toEqual([
      "Resumo",
      "Rauzer pediu novo criativo e mais verba.",
      "O que fazer",
      "Criar 3 opções\nAjustar a verba",
      "Detalhes",
      "Prazo: sexta",
      "Mensagens do grupo",
      "Clique no horário para abrir a conversa naquela mensagem.",
      "26/09/26, 10:00 · Rauzer: Bom dia pessoal! Podemos trocar o criativo da campanha de outubro até sexta?\n26/09/26, 10:05 · Rauzer: Áudio (0:23): “E aumentar a verba para 5 mil”",
      "Grupo: 2745 - Facilita & Make (cliente 2745) · abrir a conversa",
    ]);
    const firstItem = doc[8].content[0].content[0].content[0];
    expect(firstItem.marks).toEqual([
      {
        type: "link",
        attrs: { href: "/agencias/make/drive?whatsapp=g1&msg=a" },
      },
    ]);
    const open = doc[9].content.at(-1);
    expect(open.marks[0].attrs.href).toBe(
      "/agencias/make/drive?whatsapp=g1&msg=a",
    );
  });
  it("sem a MAVI: contexto em uma frase e título limpo", () => {
    vi.stubGlobal("window", {
      location: {
        pathname: "/agencias/make/drive",
        origin: "https://app.test",
      },
    });
    const task = messagesTask(picked, ctx, null);
    expect(task.title).toBe(
      "Podemos trocar o criativo da campanha de outubro até sexta?",
    );
    expect(task).not.toHaveProperty("due");
    expect(textOf(nodes(task.description)[0])).toBe(
      "Pedido feito no grupo do cliente 2745 por Rauzer, em 26/09/26, 10:00. Leia as mensagens abaixo e abra a conversa para ver o contexto.",
    );
  });
  it("título de reserva: sem saudação, sem link, cortado na palavra", () => {
    expect(
      fallbackTitle([
        msg({ body: "Oi, bom dia! https://x.com" }),
        msg({ id: "z", body: "Oi" }),
      ]),
    ).toBe("Ver mensagem de Kamilli no grupo");
    expect(
      fallbackTitle([
        msg({ body: "olá time, " + "revisar a landing page nova ".repeat(5) }),
      ]),
    ).toBe(
      "Revisar a landing page nova revisar a landing page nova revisar a landing page…",
    );
    expect(
      fallbackTitle([
        msg({ kind: "audio", content_text: "precisamos aprovar a arte hoje" }),
      ]),
    ).toBe("Precisamos aprovar a arte hoje");
    expect(fallbackTitle([msg({ kind: "image" })])).toBe(
      "Ver imagem de Kamilli no grupo",
    );
  });
});
