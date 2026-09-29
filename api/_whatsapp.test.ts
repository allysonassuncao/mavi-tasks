import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { seal } from "./_google";
import {
  handleWhatsapp,
  mediaPath,
  normalizeMessage,
  parseDraft,
  runWhatsappSync,
  type WhatsappEnv,
} from "./_whatsapp";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 1024,
});
const env: WhatsappEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  bucket: "drive-bucket",
  credentials: {
    client_email: "svc@example.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  },
  uazapiUrl: "https://uaz.example.com",
  uazapiToken: "instance-token",
  workerSecret: "w".repeat(40),
  workerBudgetMs: 80_000,
  mediaMaxBytes: 1000,
  openaiKey: "sk-test",
  transcribeModel: "gpt-4o-mini-transcribe",
  transcribeUsdPerMinute: 0.003,
};
const HOUR = 3600_000;
const NOW = Date.UTC(2026, 8, 26, 12);

const raw = (id: string, t: number, extra: Record<string, unknown> = {}) => ({
  id: `5511986540334:${id}`,
  messageid: id,
  chatid: "1@g.us",
  messageTimestamp: t,
  messageType: "Conversation",
  sender: "184@lid",
  sender_pn: "5511986060266@s.whatsapp.net",
  senderName: "Kamilli",
  fromMe: false,
  text: `texto ${id}`,
  content: { text: `texto ${id}` },
  quoted: "",
  reaction: "",
  edited: "",
  ...extra,
});

describe("normalizeMessage", () => {
  it("texto, com quem mandou e o telefone", () => {
    expect(normalizeMessage(raw("A1", NOW))).toMatchObject({
      wa_id: "A1",
      source_id: "5511986540334:A1",
      sent_at: new Date(NOW).toISOString(),
      sender_phone: "5511986060266",
      sender_name: "Kamilli",
      kind: "text",
      body: "texto A1",
      media_mime: null,
    });
  });
  it("áudio e documento guardam o que a mídia é", () => {
    const audio = normalizeMessage(
      raw("A2", NOW, {
        messageType: "AudioMessage",
        text: "",
        content: {
          PTT: true,
          mimetype: "audio/ogg; codecs=opus",
          seconds: 23,
          fileLength: 58856,
        },
      }),
    );
    expect(audio).toMatchObject({
      kind: "audio",
      body: "",
      media_mime: "audio/ogg; codecs=opus",
      media_seconds: 23,
      media_bytes: 58856,
      media_name: null,
    });
    const doc = normalizeMessage(
      raw("A3", NOW, {
        messageType: "DocumentMessage",
        text: "",
        content: JSON.stringify({
          caption: "Segue a proposta",
          fileName: "Proposta.pdf",
          mimetype: "application/pdf",
          fileLength: "1200",
        }),
      }),
    );
    expect(doc).toMatchObject({
      kind: "document",
      body: "Segue a proposta",
      media_name: "Proposta.pdf",
      media_bytes: 1200,
    });
  });
  it("reação aponta para a mensagem; resposta, para a citada", () => {
    expect(
      normalizeMessage(
        raw("A4", NOW, {
          messageType: "ReactionMessage",
          text: "❤️",
          reaction: "A1",
        }),
      ),
    ).toMatchObject({ kind: "reaction", body: "❤️", reaction_to: "A1" });
    expect(
      normalizeMessage(
        raw("A5", NOW, {
          messageType: "ExtendedTextMessage",
          content: { contextInfo: { stanzaID: "A1" } },
        }),
      ),
    ).toMatchObject({ quoted_wa_id: "A1", reaction_to: null });
  });
  it("mensagem que não abriu fica registrada sem o texto de erro", () => {
    expect(
      normalizeMessage(
        raw("A6", NOW, {
          messageType: "error",
          text: "[Undecryptable] [media] [view_once] Não foi possível…",
        }),
      ),
    ).toMatchObject({
      kind: "unavailable",
      body: "",
      extra: { view_once: true },
    });
  });
  it("enquete e localização", () => {
    expect(
      normalizeMessage(
        raw("P1", NOW, {
          messageType: "PollCreationMessageV3",
          text: "",
          content: {
            name: "Qual dia?",
            options: [{ optionName: "Seg" }, { optionName: "Ter" }],
          },
        }),
      ),
    ).toMatchObject({
      kind: "poll",
      body: "Qual dia?",
      extra: { options: ["Seg", "Ter"] },
    });
    expect(
      normalizeMessage(
        raw("L1", NOW, {
          messageType: "LocationMessage",
          text: "",
          content: {
            name: "Loja",
            address: "Rua A",
            degreesLatitude: -23.5,
            degreesLongitude: -46.6,
          },
        }),
      ),
    ).toMatchObject({
      kind: "location",
      body: "Loja · Rua A",
      extra: { lat: -23.5, lng: -46.6 },
    });
  });
  it("controle do WhatsApp e tipos vazios não entram; segundos viram ms", () => {
    expect(
      normalizeMessage(raw("X1", NOW, { messageType: "ProtocolMessage" })),
    ).toBeNull();
    expect(
      normalizeMessage(
        raw("X2", NOW, { messageType: "Esquisita", text: "", content: {} }),
      ),
    ).toBeNull();
    expect(
      normalizeMessage(raw("X3", NOW, { messageType: "Esquisita" }))?.kind,
    ).toBe("other");
    expect(normalizeMessage(raw("X4", NOW / 1000))?.sent_at).toBe(
      new Date(NOW).toISOString(),
    );
    expect(normalizeMessage(raw("", NOW, { id: "" }))).toBeNull();
  });
});

describe("mediaPath", () => {
  it("por empresa, grupo e mês, com a extensão do tipo ou do nome", () => {
    const item = {
      id: "m1",
      group_jid: "5511986540379-1602856322@g.us",
      sent_at: "2026-09-26T12:00:00Z",
      media_name: null,
    };
    expect(mediaPath("c1", item, "audio/mpeg")).toBe(
      "whatsapp/c1/5511986540379-1602856322/2026/09/m1.mp3",
    );
    expect(
      mediaPath(
        "c1",
        { ...item, media_name: "Planilha.XLSX" },
        "application/vnd.ms-excel",
      ),
    ).toBe("whatsapp/c1/5511986540379-1602856322/2026/09/m1.xlsx");
    expect(mediaPath("c1", item, "application/x-desconhecido")).toBe(
      "whatsapp/c1/5511986540379-1602856322/2026/09/m1",
    );
  });
});

// ------------------------------------------------------------ worker
type Call = { url: string; method: string; body: any };
function world(opts: {
  sweepDue?: boolean;
  groups?: { id: string; jid: string; since: string }[];
  pages?: Record<string, any[][]>;
  media?: any[];
  content?: any[];
  gcsBody?: Uint8Array;
  transcript?: string;
  fileBytes?: number;
  contentLength?: number;
  clock?: () => number;
  /** A regra "Transcrição dos áudios dos grupos" (nulo: o servidor). */
  transcribeRoute?: unknown;
}) {
  const calls: Call[] = [];
  let groupsClaimed = false;
  let mediaClaimed = false;
  let contentClaimed = false;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = String(input);
    const body =
      typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ url, method: init.method ?? "GET", body });
    const rpc = url.match(/\/rest\/v1\/rpc\/(\w+)$/)?.[1];
    if (rpc) {
      expect(body.p_secret).toBe(env.workerSecret);
      if (rpc === "whatsapp_worker_state")
        return json({
          company: "c1",
          sweep_due: opts.sweepDue ?? false,
          backfill_days: 8,
        });
      if (rpc === "whatsapp_sweep") return json(body.p_groups?.length ?? 0);
      if (rpc === "whatsapp_claim_groups") {
        const out = groupsClaimed ? [] : (opts.groups ?? []);
        groupsClaimed = true;
        return json(out);
      }
      if (rpc === "whatsapp_store_messages")
        return json(body.p_messages.length);
      if (rpc === "whatsapp_claim_media") {
        const out = mediaClaimed ? [] : (opts.media ?? []);
        mediaClaimed = true;
        return json(out);
      }
      if (rpc === "whatsapp_store_media") return json(null);
      if (rpc === "whatsapp_claim_content") {
        const out = contentClaimed ? [] : (opts.content ?? []);
        contentClaimed = true;
        return json(out);
      }
      if (rpc === "whatsapp_store_content" || rpc === "whatsapp_log_usage")
        return json(null);
      if (rpc === "whatsapp_transcribe_route")
        return json(opts.transcribeRoute ?? null);
      throw new Error(`rpc inesperada ${rpc}`);
    }
    if (url === "https://uaz.example.com/chat/find") {
      expect(init.headers.token).toBe("instance-token");
      const all = [
        {
          wa_chatid: "1@g.us",
          wa_name: "2745 - Facilita",
          wa_lastMsgTimestamp: NOW,
        },
        {
          wa_chatid: "5511@s.whatsapp.net",
          wa_name: "Pessoa",
          wa_lastMsgTimestamp: NOW,
        },
        { wa_chatid: "2@g.us", name: "CS", wa_lastMsgTimestamp: NOW - HOUR },
      ];
      const page = all.slice(body.offset, body.offset + 2);
      return json({
        chats: page,
        pagination: { totalRecords: all.length, limit: 2, offset: body.offset },
      });
    }
    if (url === "https://uaz.example.com/message/find") {
      const pages = opts.pages?.[body.chatid] ?? [];
      const index = body.offset / 200;
      const messages = pages[index] ?? [];
      return json({
        messages,
        hasMore: index < pages.length - 1,
        nextOffset: body.offset + messages.length,
      });
    }
    if (url === "https://uaz.example.com/message/download")
      return json({
        fileURL: `https://cdn.example.com/${body.id}`,
        mimetype: "audio/mpeg",
      });
    if (url.startsWith("https://cdn.example.com/")) {
      const headers: Record<string, string> = { "content-type": "audio/mpeg" };
      if (opts.contentLength)
        headers["content-length"] = String(opts.contentLength);
      return new Response(new Uint8Array(opts.fileBytes ?? 10), { headers });
    }
    if (
      url === "https://api.openai.com/v1/audio/transcriptions" ||
      url === "https://api.groq.com/openai/v1/audio/transcriptions"
    )
      return json({ text: opts.transcript ?? "" });
    if (
      url.startsWith("https://storage.googleapis.com/") &&
      (init.method ?? "GET") === "GET"
    )
      return new Response(opts.gcsBody ?? new Uint8Array(32000));
    if (url.startsWith("https://storage.googleapis.com/"))
      return new Response("", { status: 200 });
    throw new Error(`fetch inesperado ${url}`);
  }) as typeof fetch;
  return { calls, deps: { fetch: fetchImpl, now: opts.clock ?? (() => NOW) } };
}
const rpcCalls = (calls: Call[], name: string) =>
  calls.filter((c) => c.url.endsWith(`/rpc/${name}`)).map((c) => c.body);

describe("runWhatsappSync", () => {
  it("varredura: só grupos, com título e última mensagem", async () => {
    const w = world({ sweepDue: true });
    const stats = await runWhatsappSync(env, w.deps);
    expect(rpcCalls(w.calls, "whatsapp_sweep")[0].p_groups).toEqual([
      { jid: "1@g.us", title: "2745 - Facilita", last_message_at: NOW },
      { jid: "2@g.us", title: "CS", last_message_at: NOW - HOUR },
    ]);
    expect(stats.swept).toBe(2);
    expect(w.calls.filter((c) => c.url.endsWith("/chat/find"))).toHaveLength(2);
  });

  it("sem varredura vencida, não lista os grupos", async () => {
    const w = world({});
    await runWhatsappSync(env, w.deps);
    expect(w.calls.some((c) => c.url.endsWith("/chat/find"))).toBe(false);
  });

  it("lê de trás para frente até o ponto de leitura e avança o cursor", async () => {
    const since = new Date(NOW - 5 * HOUR).toISOString();
    const page1 = Array.from({ length: 200 }, (_, i) =>
      raw(`N${i}`, NOW - i * 1000),
    );
    const page2 = [
      raw("OLD1", NOW - 4 * HOUR),
      raw("OLD2", NOW - 6 * HOUR),
      raw("OLD3", NOW - 7 * HOUR),
    ];
    const page3 = [raw("NUNCA", NOW - 8 * HOUR)];
    const w = world({
      groups: [{ id: "g1", jid: "1@g.us", since }],
      pages: { "1@g.us": [page1, page2, page3] },
    });
    const stats = await runWhatsappSync(env, w.deps);
    const finds = w.calls.filter((c) => c.url.endsWith("/message/find"));
    expect(finds.map((c) => c.body.offset)).toEqual([0, 200]);
    const [store] = rpcCalls(w.calls, "whatsapp_store_messages");
    expect(store.p_group).toBe("g1");
    expect(store.p_messages.map((m: any) => m.wa_id)).not.toContain("OLD2");
    expect(store.p_messages).toHaveLength(201);
    expect(store.p_until).toBe(new Date(NOW).toISOString());
    expect(store.p_error).toBeNull();
    expect(stats.messages).toBe(201);
  });

  it("grupo sem mensagem nova fica em dia até o ponto de leitura", async () => {
    const since = new Date(NOW - HOUR).toISOString();
    const w = world({
      groups: [{ id: "g1", jid: "1@g.us", since }],
      pages: { "1@g.us": [[raw("OLD", NOW - 3 * HOUR)]] },
    });
    await runWhatsappSync(env, w.deps);
    const [store] = rpcCalls(w.calls, "whatsapp_store_messages");
    expect(store.p_messages).toEqual([]);
    expect(store.p_until).toBe(since);
  });

  it("sem tempo, guarda o que leu sem avançar o cursor", async () => {
    let t = NOW;
    const page = Array.from({ length: 200 }, (_, i) =>
      raw(`N${i}`, NOW - i * 1000),
    );
    const w = world({
      groups: [
        {
          id: "g1",
          jid: "1@g.us",
          since: new Date(NOW - 9 * HOUR).toISOString(),
        },
      ],
      pages: { "1@g.us": [page, page, page] },
      // Cada leitura "gasta" 40 s.
      clock: () => t,
    });
    const originalFetch = w.deps.fetch;
    w.deps.fetch = (async (input: any, init: any) => {
      if (String(input).endsWith("/message/find")) t += 40_000;
      return originalFetch(input, init);
    }) as typeof fetch;
    await runWhatsappSync(env, w.deps);
    const stores = rpcCalls(w.calls, "whatsapp_store_messages");
    expect(stores.at(-1).p_until).toBeNull();
    expect(stores.flatMap((s) => s.p_messages).length).toBeGreaterThan(0);
  });

  it("erro da Uazapi fica registrado no grupo", async () => {
    const w = world({
      groups: [{ id: "g1", jid: "1@g.us", since: new Date(NOW).toISOString() }],
    });
    const originalFetch = w.deps.fetch;
    w.deps.fetch = (async (input: any, init: any) =>
      String(input).endsWith("/message/find")
        ? new Response("fora do ar", { status: 503 })
        : originalFetch(input, init)) as typeof fetch;
    const stats = await runWhatsappSync(env, w.deps);
    const [store] = rpcCalls(w.calls, "whatsapp_store_messages");
    expect(store.p_until).toBeNull();
    expect(store.p_error).toMatch(/Uazapi \/message\/find \(503\)/);
    expect(stats.errors[0]).toMatch(/^1@g\.us:/);
  });

  it("copia a mídia para o GCS e avisa o banco", async () => {
    const w = world({
      media: [
        {
          id: "m1",
          source_id: "5511986540334:A2",
          group_jid: "1@g.us",
          kind: "audio",
          media_mime: "audio/ogg",
          media_name: null,
          media_bytes: 10,
          sent_at: "2026-09-26T12:00:00Z",
        },
      ],
    });
    await runWhatsappSync(env, w.deps);
    const download = w.calls.find((c) => c.url.endsWith("/message/download"))!;
    expect(download.body).toEqual({
      id: "5511986540334:A2",
      return_link: true,
      generate_mp3: true,
    });
    const put = w.calls.find((c) =>
      c.url.startsWith("https://storage.googleapis.com/"),
    )!;
    expect(put.method).toBe("PUT");
    expect(put.url).toContain("/drive-bucket/whatsapp/c1/1/2026/09/m1.mp3");
    expect(rpcCalls(w.calls, "whatsapp_store_media")).toEqual([
      {
        p_secret: env.workerSecret,
        p_message: "m1",
        p_status: "stored",
        p_bucket: "drive-bucket",
        p_path: "whatsapp/c1/1/2026/09/m1.mp3",
        p_mime: "audio/mpeg",
        p_bytes: 10,
      },
    ]);
  });

  it("mídia grande demais não é baixada; falha volta para a fila", async () => {
    const big = {
      id: "m2",
      source_id: "s2",
      group_jid: "1@g.us",
      kind: "video",
      media_mime: "video/mp4",
      media_name: null,
      media_bytes: 5000,
      sent_at: "2026-09-26T12:00:00Z",
    };
    const w = world({ media: [big] });
    await runWhatsappSync(env, w.deps);
    expect(w.calls.some((c) => c.url.endsWith("/message/download"))).toBe(
      false,
    );
    expect(rpcCalls(w.calls, "whatsapp_store_media")[0].p_status).toBe(
      "too_large",
    );

    const w2 = world({
      media: [{ ...big, media_bytes: null }],
      contentLength: 5000,
    });
    await runWhatsappSync(env, w2.deps);
    expect(rpcCalls(w2.calls, "whatsapp_store_media")[0]).toMatchObject({
      p_status: "too_large",
      p_error: "5000 bytes",
    });

    const w3 = world({ media: [{ ...big, media_bytes: null }] });
    const originalFetch = w3.deps.fetch;
    w3.deps.fetch = (async (input: any, init: any) =>
      String(input).startsWith("https://storage.googleapis.com/")
        ? new Response("", { status: 403 })
        : originalFetch(input, init)) as typeof fetch;
    await runWhatsappSync(env, w3.deps);
    expect(rpcCalls(w3.calls, "whatsapp_store_media")[0]).toMatchObject({
      p_status: "failed",
      p_error: "Envio ao GCS falhou (403).",
    });
  });
});

describe("handleWhatsapp", () => {
  it("o worker só entra com o segredo e com a Uazapi configurada", async () => {
    const w = world({});
    expect(
      (await handleWhatsapp({ action: "whatsapp-sync" }, null, env, w.deps))
        .status,
    ).toBe(401);
    expect(
      (
        await handleWhatsapp(
          { action: "whatsapp-sync" },
          "Bearer errado",
          env,
          w.deps,
        )
      ).status,
    ).toBe(401);
    const noUaz = await handleWhatsapp(
      { action: "whatsapp-sync" },
      `Bearer ${env.workerSecret}`,
      { ...env, uazapiToken: "" },
      w.deps,
    );
    expect(noUaz.status).toBe(500);
    const ok = await handleWhatsapp(
      { action: "whatsapp-sync" },
      `Bearer ${env.workerSecret}`,
      env,
      w.deps,
    );
    expect(ok.status).toBe(200);
    expect(
      (await handleWhatsapp({ action: "whatsapp-outra" }, null, env, w.deps))
        .status,
    ).toBe(400);
  });
});

describe("whatsapp-media", () => {
  const ID = "00000000-0000-4000-8000-000000000001";
  const ID2 = "00000000-0000-4000-8000-000000000002";
  function media(rows: any[]) {
    const calls: Call[] = [];
    const fetchImpl = (async (input: any, init: any = {}) => {
      calls.push({
        url: String(input),
        method: init.method ?? "GET",
        body: JSON.parse(init.body),
        headers: init.headers,
      } as any);
      return new Response(JSON.stringify(rows), { status: 200 });
    }) as typeof fetch;
    return { calls, deps: { fetch: fetchImpl } };
  }
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    bucket: "drive-bucket",
    path: `whatsapp/c1/1/2026/09/${id}.pdf`,
    content_type: "application/pdf",
    name: "Proposta Ção.pdf",
    kind: "document",
    ...over,
  });

  it("assina como a pessoa, só o bucket das mídias", async () => {
    const m = media([row(ID), row(ID2, { bucket: "outro" })]);
    const r = await handleWhatsapp(
      { action: "whatsapp-media", ids: [ID, ID2] },
      "Bearer user-token",
      env,
      m.deps,
      { ip: "1.2.3.4" },
    );
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.urls)).toEqual([ID]);
    expect(r.body.urls[ID]).toContain("/drive-bucket/whatsapp/c1/1/2026/09/");
    expect(r.body.urls[ID]).toContain("response-content-disposition=inline");
    const call = m.calls[0] as any;
    expect(call.url).toBe(
      "https://db.example.com/rest/v1/rpc/whatsapp_media_targets",
    );
    expect(call.headers.Authorization).toBe("Bearer user-token");
    expect(call.body).toEqual({
      p_ids: [ID, ID2],
      p_download: false,
      p_origin: { ip: "1.2.3.4" },
    });
  });
  it("baixar: uma mídia, como anexo com o nome", async () => {
    const m = media([row(ID)]);
    const r = await handleWhatsapp(
      { action: "whatsapp-media", ids: [ID], download: true },
      "Bearer u",
      env,
      m.deps,
    );
    expect((m.calls[0] as any).body.p_download).toBe(true);
    expect(decodeURIComponent(r.body.urls[ID])).toContain(
      'attachment; filename="Proposta __o.pdf"',
    );
  });
  it("pedido inválido ou sem conta", async () => {
    const m = media([]);
    expect(
      (
        await handleWhatsapp(
          { action: "whatsapp-media", ids: [ID] },
          null,
          env,
          m.deps,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleWhatsapp(
          { action: "whatsapp-media", ids: ["x"] },
          "Bearer u",
          env,
          m.deps,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleWhatsapp(
          { action: "whatsapp-media", ids: [] },
          "Bearer u",
          env,
          m.deps,
        )
      ).status,
    ).toBe(400);
    const many = Array.from(
      { length: 101 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect(
      (
        await handleWhatsapp(
          { action: "whatsapp-media", ids: many },
          "Bearer u",
          env,
          m.deps,
        )
      ).status,
    ).toBe(400);
    expect(m.calls).toHaveLength(0);
  });
});

describe("miniatura", () => {
  it("imagem e vídeo guardam a miniatura pequena; grande demais, não", () => {
    const image = normalizeMessage(
      raw("I1", NOW, {
        messageType: "ImageMessage",
        text: "",
        content: { JPEGThumbnail: "abc", mimetype: "image/jpeg" },
      }),
    );
    expect(image?.extra.thumb).toBe("abc");
    const big = normalizeMessage(
      raw("I2", NOW, {
        messageType: "ImageMessage",
        text: "",
        content: { JPEGThumbnail: "x".repeat(20_000) },
      }),
    );
    expect(big?.extra.thumb).toBeUndefined();
    const doc = normalizeMessage(
      raw("D1", NOW, {
        messageType: "DocumentMessage",
        content: { JPEGThumbnail: "abc" },
      }),
    );
    expect(doc?.extra.thumb).toBeUndefined();
  });
});

describe("leitura das mídias para a MAVI", () => {
  const audio = {
    id: "a1",
    kind: "audio",
    content_kind: "audio",
    bucket: "drive-bucket",
    path: "whatsapp/c1/1/2026/09/a1.mp3",
    media_mime: "audio/mpeg",
    media_name: null,
    media_bytes: 32000,
    media_seconds: 40,
    client_id: "cl1",
  };
  it("transcreve o áudio em português e registra o custo por cliente", async () => {
    const w = world({
      content: [audio],
      transcript: "  Precisamos aumentar a verba  ",
    });
    const stats = await runWhatsappSync(env, w.deps);
    expect(stats.contents).toBe(1);
    const call = w.calls.find((c) => c.url.endsWith("/audio/transcriptions"))!;
    expect(call.method).toBe("POST");
    const form = call.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(form.get("language")).toBe("pt");
    expect((form.get("file") as File).name).toBe("a1.mp3");
    expect(rpcCalls(w.calls, "whatsapp_store_content")).toEqual([
      {
        p_secret: env.workerSecret,
        p_message: "a1",
        p_status: "done",
        p_text: "Precisamos aumentar a verba",
        p_error: null,
      },
    ]);
    // 40 s a US$ 0,003 por minuto.
    expect(rpcCalls(w.calls, "whatsapp_log_usage")[0]).toMatchObject({
      p_model: "gpt-4o-mini-transcribe",
      p_items: [{ client: "cl1", cost: 0.002 }],
    });
  });
  it("com a regra do Painel da MAVI, transcreve pelo provedor escolhido", async () => {
    const providerKey = crypto.randomBytes(32);
    const w = world({
      content: [audio],
      transcript: "Subir a verba",
      transcribeRoute: {
        scope: "feature",
        provider_id: "p-groq",
        provider: "Groq",
        kind: "groq",
        base_url: null,
        key_cipher: seal(providerKey, "gsk-da-agencia"),
        model: "whisper-large-v3-turbo",
        price: null,
      },
    });
    const stats = await runWhatsappSync({ ...env, providerKey, openaiKey: "" }, w.deps);
    expect(stats.errors).toEqual([]);
    const call = w.calls.find((c) => c.url.endsWith("/audio/transcriptions"))!;
    expect(call.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect((call.body as FormData).get("model")).toBe("whisper-large-v3-turbo");
    // Uma consulta por rodada, não uma por áudio.
    expect(rpcCalls(w.calls, "whatsapp_transcribe_route")).toHaveLength(1);
    expect(rpcCalls(w.calls, "whatsapp_log_usage")[0]).toMatchObject({
      p_model: "whisper-large-v3-turbo",
    });
  });
  it("áudio sem fala fica vazio; sem chave da OpenAI, erro (volta para a fila)", async () => {
    const w = world({ content: [audio], transcript: "" });
    await runWhatsappSync(env, w.deps);
    expect(rpcCalls(w.calls, "whatsapp_store_content")[0].p_status).toBe(
      "empty",
    );
    const w2 = world({ content: [audio] });
    await runWhatsappSync({ ...env, openaiKey: "" }, w2.deps);
    expect(rpcCalls(w2.calls, "whatsapp_store_content")[0]).toMatchObject({
      p_status: "error",
      p_error: "Transcrição não configurada: falta OPENAI_API_KEY na Vercel.",
    });
    expect(rpcCalls(w2.calls, "whatsapp_log_usage")).toHaveLength(0);
  });
  it("documento: o texto extraído vai para o banco, sem custo", async () => {
    const doc = {
      ...audio,
      id: "d1",
      kind: "document",
      content_kind: "text",
      path: "whatsapp/c1/1/2026/09/d1.txt",
      media_mime: "text/plain",
      media_name: "briefing.txt",
    };
    const w = world({
      content: [doc],
      gcsBody: new TextEncoder().encode("Briefing da campanha de outubro"),
    });
    await runWhatsappSync(env, w.deps);
    expect(w.calls.some((c) => c.url.includes("openai"))).toBe(false);
    const [stored] = rpcCalls(w.calls, "whatsapp_store_content");
    expect(stored.p_status).toBe("done");
    expect(stored.p_text).toContain("Briefing da campanha de outubro");
    expect(rpcCalls(w.calls, "whatsapp_log_usage")).toHaveLength(0);
  });
  it("mídia de outro bucket não é lida", async () => {
    const w = world({ content: [{ ...audio, bucket: "outro" }] });
    await runWhatsappSync(env, w.deps);
    expect(
      w.calls.some((c) => c.url.startsWith("https://storage.googleapis.com/")),
    ).toBe(false);
    expect(rpcCalls(w.calls, "whatsapp_store_content")[0].p_status).toBe(
      "skipped",
    );
  });
});

describe("tarefa a partir de mensagens (MAVI)", () => {
  const G = "00000000-0000-4000-8000-00000000000a";
  const C = "00000000-0000-4000-8000-00000000000c";
  const M1 = "00000000-0000-4000-8000-000000000011";
  const M2 = "00000000-0000-4000-8000-000000000012";
  const row = (id: string, t: string, over: Record<string, unknown> = {}) => ({
    id,
    group_id: G,
    company_id: "co",
    sent_at: t,
    sender_name: "Rauzer",
    sender_phone: "553182916886",
    from_me: false,
    kind: "text",
    body: "",
    media_name: null,
    media_seconds: null,
    content_text: null,
    quoted_wa_id: null,
    wa_id: id,
    ...over,
  });
  function server(
    answer: string,
    picked = [
      row(M1, "2026-09-26T13:00:00Z", {
        body: "Podemos trocar o criativo da campanha de outubro até sexta?",
      }),
      row(M2, "2026-09-26T13:05:00Z", {
        kind: "audio",
        content_text: "E aumentar a verba para 5 mil",
      }),
    ],
    route: unknown = null,
  ) {
    const calls: { url: string; auth?: string; body?: any }[] = [];
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), { status: 200 });
    const fetchImpl = (async (input: any, init: any = {}) => {
      const url = String(input);
      calls.push({
        url,
        auth: init.headers?.Authorization,
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      if (url.includes("whatsapp_messages?") && url.includes("id=in."))
        return json(picked);
      if (url.includes("whatsapp_messages?") && url.includes("sent_at=lt."))
        return json([
          row("b1", "2026-09-26T12:50:00Z", {
            body: "Oi pessoal, tudo certo com a campanha?",
            from_me: true,
            sender_name: "Kamilli",
          }),
        ]);
      if (url.includes("whatsapp_messages?")) return json([]);
      if (url.includes("whatsapp_groups?"))
        return json([
          {
            title: "4282 - Loja & Make (Make Ads)",
            client_id: C,
            product_ids: ["p1"],
          },
        ]);
      if (url.includes("clients?")) return json([{ name: "4282" }]);
      if (url.includes("products?")) return json([{ name: "Make Ads" }]);
      if (url.endsWith("rpc/ai_log_usage")) return json(null);
      if (url.endsWith("rpc/ai_resolve_route")) return json(route);
      throw new Error(`fetch inesperado ${url}`);
    }) as typeof fetch;
    const requests: any[] = [];
    const envs: any[] = [];
    const ask = vi.fn(async (used: any, request: any, meter: any) => {
      envs.push(used);
      requests.push(request);
      meter.input = 900;
      meter.output = 200;
      meter.cost = 0.01;
      return answer;
    });
    return {
      calls,
      requests,
      envs,
      deps: { fetch: fetchImpl, ask, now: () => NOW },
    };
  }
  const draftEnv = {
    ...env,
    anthropicKey: "sk-ant",
    taskModel: "claude-opus-5-5",
  };

  it("a MAVI lê as mensagens escolhidas e o contexto e devolve o rascunho", async () => {
    const s = server(
      'Aqui está:\n```json\n{"title": "Trocar o criativo da campanha de outubro", "summary": "Rauzer pediu para trocar o criativo e aumentar a verba.", "actions": ["Criar 3 opções de criativo", "Ajustar a verba para R$ 5 mil"], "details": ["Prazo: sexta"], "due": "2026-10-02"}\n```',
    );
    const r = await handleWhatsapp(
      { action: "whatsapp-task-draft", messages: [M1, M2] },
      "Bearer user",
      draftEnv,
      s.deps,
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      title: "Trocar o criativo da campanha de outubro",
      summary: "Rauzer pediu para trocar o criativo e aumentar a verba.",
      actions: ["Criar 3 opções de criativo", "Ajustar a verba para R$ 5 mil"],
      details: ["Prazo: sexta"],
      due: "2026-10-02",
    });
    // Tudo lido como a pessoa.
    expect(
      s.calls
        .filter((c) => c.url.includes("/rest/v1/"))
        .every((c) => c.auth === "Bearer user"),
    ).toBe(true);
    const context: string = s.requests[0].context;
    expect(context).toContain(
      'Grupo de WhatsApp: "4282 - Loja & Make (Make Ads)"',
    );
    expect(context).toContain("Cliente: 4282 · produtos: Make Ads");
    expect(context).toContain(
      "   26/09/2026, 09:50 · Kamilli (número da agência): Oi pessoal",
    );
    expect(context).toContain(
      ">> 26/09/2026, 10:00 · Rauzer: Podemos trocar o criativo",
    );
    expect(context).toContain(
      ">> 26/09/2026, 10:05 · Rauzer: [áudio] E aumentar a verba para 5 mil",
    );
    expect(context.indexOf("Kamilli")).toBeLessThan(context.indexOf("Podemos"));
    const usage = s.calls.find((c) => c.url.endsWith("rpc/ai_log_usage"))!;
    expect(usage.body).toMatchObject({
      p_module: "whatsapp",
      p_kind: "task",
      p_client: C,
      p_input: 900,
      p_cost: 0.01,
    });
  });

  it("com provedor escolhido no Painel da MAVI, responde por ele (mesmo sem a chave da Vercel)", async () => {
    const providerKey = crypto.randomBytes(32);
    const s = server(
      '{"title": "Trocar o criativo", "summary": "x", "actions": ["y"], "details": [], "due": null}',
      undefined,
      {
        scope: "feature",
        provider_id: "00000000-0000-4000-8000-0000000000bb",
        provider: "Gemini",
        kind: "google",
        base_url: null,
        key_cipher: seal(providerKey, "chave-gemini"),
        model: "gemini-x",
        price: { id: "gemini-x", input: 1, output: 2 },
      },
    );
    const r = await handleWhatsapp(
      { action: "whatsapp-task-draft", messages: [M1, M2] },
      "Bearer user",
      { ...draftEnv, anthropicKey: "", providerKey },
      s.deps,
    );
    expect(r.status).toBe(200);
    expect(s.envs[0].provider).toMatchObject({
      kind: "google",
      apiKey: "chave-gemini",
      model: "gemini-x",
    });
    const resolve = s.calls.find((c) => c.url.endsWith("rpc/ai_resolve_route"))!;
    expect(resolve.body).toMatchObject({ p_feature: "whatsapp_task" });
    const usage = s.calls.find((c) => c.url.endsWith("rpc/ai_log_usage"))!;
    expect(usage.body).toMatchObject({
      p_provider: "00000000-0000-4000-8000-0000000000bb",
    });
  });

  it("rascunho sem título, mensagens de grupos diferentes ou sem configuração", async () => {
    const bad = server('{"summary": "x"}');
    expect(
      (
        await handleWhatsapp(
          { action: "whatsapp-task-draft", messages: [M1, M2] },
          "Bearer u",
          draftEnv,
          bad.deps,
        )
      ).status,
    ).toBe(502);
    const mixed = server("{}", [
      row(M1, "2026-09-26T13:00:00Z"),
      { ...row(M2, "2026-09-26T13:05:00Z"), group_id: "outro" },
    ]);
    expect(
      (
        await handleWhatsapp(
          { action: "whatsapp-task-draft", messages: [M1, M2] },
          "Bearer u",
          draftEnv,
          mixed.deps,
        )
      ).status,
    ).toBe(404);
    expect(mixed.requests).toHaveLength(0);
    const s = server("{}");
    expect(
      (
        await handleWhatsapp(
          { action: "whatsapp-task-draft", messages: [M1, M2] },
          "Bearer u",
          { ...draftEnv, anthropicKey: "" },
          s.deps,
        )
      ).status,
    ).toBe(503);
    expect(s.requests).toHaveLength(0);
    expect(
      (
        await handleWhatsapp(
          { action: "whatsapp-task-draft", messages: ["x"] },
          "Bearer u",
          draftEnv,
          s.deps,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleWhatsapp(
          { action: "whatsapp-task-draft", messages: [M1] },
          null,
          draftEnv,
          s.deps,
        )
      ).status,
    ).toBe(401);
  });

  it("valida e limpa o JSON", () => {
    expect(
      parseDraft(
        '{"title": "  Revisar   o site ", "actions": ["a", 3, ""], "due": "sexta"}',
      ),
    ).toEqual({
      title: "Revisar o site",
      summary: "",
      actions: ["a"],
      details: [],
      due: null,
    });
    expect(parseDraft("sem json")).toBeNull();
  });
});
