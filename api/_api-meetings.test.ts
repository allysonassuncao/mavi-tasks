import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import {
  CHUNK,
  handleMeetingVideoImport,
  meetingPayload,
  meetingVideoAllowed,
  normalizeMeetingSummary,
  normalizeMeetingTranscript,
  privateAddress,
  seconds,
  videoType,
  videoUrlProblem,
  type MeetingVideoEnv,
} from "./_api-meetings";

describe("normalizeMeetingTranscript", () => {
  it("texto corrido com falantes e tempos; continuação na mesma fala", () => {
    const t = normalizeMeetingTranscript(
      "00:00:01 Ana Souza: Bom dia a todos.\nVamos começar.\n[00:00:10] Bruno: Ok!\nOs pontos são: prazo e verba.",
    );
    expect(t.speakers).toEqual(["Ana Souza", "Bruno"]);
    expect(t.segments).toEqual([
      [1, 10, 0, "Bom dia a todos. Vamos começar."],
      [10, 10, 1, "Ok! Os pontos são: prazo e verba."],
    ]);
  });

  it("texto sem falantes nem tempos: uma fala por linha", () => {
    const t = normalizeMeetingTranscript("Primeira linha.\nSegunda linha.");
    expect(t).toEqual({
      speakers: [],
      segments: [
        [null, null, null, "Primeira linha."],
        [null, null, null, "Segunda linha."],
      ],
    });
  });

  it("WebVTT do Zoom e SRT", () => {
    const vtt = normalizeMeetingTranscript(
      "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.500\nAna: Olá\ntudo bem?\n\n2\n00:00:05.000 --> 00:00:07.000\n<v Bruno>Tudo!</v>",
    );
    expect(vtt).toEqual({
      speakers: ["Ana", "Bruno"],
      segments: [
        [1, 4.5, 0, "Olá tudo bem?"],
        [5, 7, 1, "Tudo!"],
      ],
    });
    const srt = normalizeMeetingTranscript("1\n00:00:01,200 --> 00:00:02,000\nOi\n");
    expect(srt.segments).toEqual([[1.2, 2, null, "Oi"]]);
  });

  it("trechos com tempo (o formato da documentação)", () => {
    const t = normalizeMeetingTranscript([
      { start: 12, end: 15.5, speaker: "Ana", text: "Segundo" },
      { start: "00:00:02", end: "00:00:05", speaker: "Bruno", text: "Primeiro" },
    ]);
    expect(t.speakers).toEqual(["Ana", "Bruno"]);
    expect(t.segments).toEqual([
      [2, 5, 1, "Primeiro"],
      [12, 15.5, 0, "Segundo"],
    ]);
  });

  it("Deepgram: utterances e parágrafos; falante por número", () => {
    const utter = normalizeMeetingTranscript({
      results: { utterances: [{ start: 0.5, end: 2, speaker: 0, transcript: "Oi" }, { start: 2, end: 3, speaker: 1, transcript: "Olá" }] },
    });
    expect(utter).toEqual({ speakers: ["Falante 1", "Falante 2"], segments: [[0.5, 2, 0, "Oi"], [2, 3, 1, "Olá"]] });
    const para = normalizeMeetingTranscript(
      JSON.stringify({
        results: {
          channels: [
            { alternatives: [{ paragraphs: { paragraphs: [{ speaker: 0, sentences: [{ text: "Uma.", start: 1, end: 2 }, { text: "Duas.", start: 2, end: 3 }] }] } }] },
          ],
        },
      }),
    );
    expect(para.segments).toEqual([[1, 2, 0, "Uma."], [2, 3, 0, "Duas."]]);
  });

  it("AssemblyAI: tempos em milissegundos, falante por letra", () => {
    const t = normalizeMeetingTranscript({
      audio_duration: 10,
      utterances: [{ speaker: "A", start: 1500, end: 4000, text: "Oi" }],
    });
    expect(t).toEqual({ speakers: ["Falante A"], segments: [[1.5, 4, 0, "Oi"]] });
  });

  it("o formato das gravações e o do gravador da MAVI", () => {
    expect(
      normalizeMeetingTranscript({ speakers: ["Ana"], segments: [[1, 2, 0, "Oi"]] }),
    ).toEqual({ speakers: ["Ana"], segments: [[1, 2, 0, "Oi"]] });
    expect(
      normalizeMeetingTranscript([{ speaker: 0, speaker_name: "Ana", utterances: [{ start: 1, end: 2, transcript: "Oi" }] }]),
    ).toEqual({ speakers: ["Ana"], segments: [[1, 2, 0, "Oi"]] });
    expect(normalizeMeetingTranscript([{ Ana: "Oi" }])).toEqual({ speakers: ["Ana"], segments: [[null, null, 0, "Oi"]] });
  });

  it("um texto longo sem quebras vira vários trechos", () => {
    const t = normalizeMeetingTranscript("Frase de teste. ".repeat(500));
    expect(t.segments.length).toBeGreaterThan(4);
    expect(t.segments.every((s) => s[3].length <= 1500)).toBe(true);
  });

  it("seconds", () => {
    expect(seconds("01:02:03.5")).toBe(3723.5);
    expect(seconds("2:03")).toBe(123);
    expect(seconds(-1)).toBeNull();
    expect(seconds("abc")).toBeNull();
  });
});

describe("normalizeMeetingSummary", () => {
  it("texto vira overview; listas aceitam textos; next_steps são action_items", () => {
    expect(normalizeMeetingSummary("Resumo.")).toEqual({ overview: "Resumo." });
    expect(
      normalizeMeetingSummary({
        title: " Kickoff ",
        overview: "Visão",
        notes: ["Escopo", { title: "Verba", description: "R$ 5 mil" }],
        next_steps: [{ owner: "Ana", description: "Enviar proposta", deadline: "sexta" }, "Marcar retorno"],
        keywords: ["SEO", 3],
        extra: "ignorado",
      }),
    ).toEqual({
      title: "Kickoff",
      overview: "Visão",
      notes: [{ title: "", description: "Escopo" }, { title: "Verba", description: "R$ 5 mil" }],
      action_items: [
        { owner: "Ana", description: "Enviar proposta", deadline: "sexta" },
        { owner: "", description: "Marcar retorno", deadline: "" },
      ],
      keywords: ["SEO"],
    });
    expect(normalizeMeetingSummary(null)).toEqual({});
  });
});

describe("meetingPayload", () => {
  it("participantes por e-mail ou nome; erros claros", () => {
    const ok = meetingPayload({
      recorded_at: "2026-10-07T14:00:00Z",
      attendees: ["ana@x.com", { name: "Bruno" }, { email: "c@x.com", name: "C" }],
      transcript: [{ start: 0, end: 30, text: "Oi" }],
    });
    expect(ok).toMatchObject({ ok: true, payload: { attendees: ["ana@x.com", "Bruno", "c@x.com"], duration_seconds: 30 } });
    expect(meetingPayload({ transcript: { foo: 1 } })).toMatchObject({ ok: false });
    expect(meetingPayload({ attendees: "ana" })).toMatchObject({ ok: false });
    expect(meetingPayload({ video_url: "http://x.com/a.mp4" })).toMatchObject({ ok: false });
  });
});

describe("links do vídeo", () => {
  it("só endereços públicos, https e porta padrão", () => {
    expect(videoUrlProblem("https://zoom.us/rec/a.mp4")).toBeNull();
    for (const bad of [
      "http://zoom.us/a.mp4",
      "https://localhost/a.mp4",
      "https://10.0.0.2/a.mp4",
      "https://[::1]/a.mp4",
      "https://x.com:8443/a.mp4",
      "https://u:p@x.com/a.mp4",
      "nada",
    ])
      expect(videoUrlProblem(bad)).not.toBeNull();
    expect(privateAddress("169.254.169.254")).toBe(true);
    expect(privateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(privateAddress("8.8.8.8")).toBe(false);
  });

  it("tipo pelo cabeçalho ou, se genérico, pela extensão", () => {
    expect(videoType("video/mp4; codecs=x", "https://a.com/v")).toBe("video/mp4");
    expect(videoType("application/octet-stream", "https://a.com/v.webm?x=1")).toBe("video/webm");
    expect(videoType("text/html", "https://a.com/v.mp4")).toBeNull();
  });
});

describe("handleMeetingVideoImport", () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
  const env: MeetingVideoEnv = {
    supabaseUrl: "https://db.example.com",
    supabaseKey: "publishable",
    bucket: "drive",
    credentials: { client_email: "svc@x.iam", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string },
    workerSecret: "segredo",
    maxBytes: 100 * 1024 * 1024,
    budgetMs: 200_000,
  };
  const JOB = { recording_id: "r1", company_id: "c1", url: "https://files.example.com/a.mp4", attempts: 1 };

  function world(video: Response | (() => Response)) {
    const saved: Record<string, unknown>[] = [];
    const puts: string[] = [];
    let claimed = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/rpc/meeting_video_claim")) {
        const out = claimed ? [] : [JOB];
        claimed = true;
        return new Response(JSON.stringify(out));
      }
      if (url.endsWith("/rpc/meeting_video_save")) {
        saved.push(JSON.parse(String(init?.body)));
        return new Response("null");
      }
      if (url.startsWith("https://files.example.com"))
        return typeof video === "function" ? video() : video;
      if (url.startsWith("https://storage.googleapis.com/drive/") && init?.method === "POST")
        return new Response(null, { status: 201, headers: { location: "https://upload.example.com/s" } });
      if (url === "https://upload.example.com/s" && init?.method === "PUT") {
        const range = (init.headers as Record<string, string>)["Content-Range"];
        puts.push(range);
        return new Response(null, { status: range.endsWith("/*") ? 308 : 200 });
      }
      if (url === "https://upload.example.com/s" && init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`inesperado: ${url}`);
    });
    const deps = { fetch: fetchMock as unknown as typeof fetch, lookup: async () => ["93.184.216.34"] };
    return { saved, puts, deps, fetchMock };
  }

  it("envia em partes e guarda na gravação", async () => {
    const bytes = new Uint8Array(CHUNK + 10);
    const w = world(new Response(bytes, { headers: { "content-type": "video/mp4" } }));
    const r = await handleMeetingVideoImport(env, w.deps);
    expect(r.body).toEqual({ stored: 1, failed: 0 });
    expect(w.puts).toEqual([`bytes 0-${CHUNK - 1}/*`, `bytes ${CHUNK}-${CHUNK + 9}/${CHUNK + 10}`]);
    expect(w.saved[0]).toMatchObject({
      p_secret: "segredo",
      p_recording: "r1",
      p_bucket: "drive",
      p_path: "meetings/c1/r1.mp4",
      p_type: "video/mp4",
      p_bytes: CHUNK + 10,
    });
  });

  it("página em vez de vídeo: falha sem nova tentativa", async () => {
    const w = world(new Response("<html>", { headers: { "content-type": "text/html" } }));
    await handleMeetingVideoImport(env, w.deps);
    expect(w.saved[0]).toMatchObject({ p_path: null, p_retry: false });
    expect(String(w.saved[0].p_error)).toMatch(/link direto/);
  });

  it("servidor fora do ar: volta para a fila", async () => {
    const w = world(new Response("", { status: 503 }));
    await handleMeetingVideoImport(env, w.deps);
    expect(w.saved[0]).toMatchObject({ p_retry: true });
  });

  it("redirecionamento para a rede interna é recusado", async () => {
    const w = world(new Response(null, { status: 302, headers: { location: "https://127.0.0.1/x.mp4" } }));
    await handleMeetingVideoImport(env, w.deps);
    expect(w.saved[0]).toMatchObject({ p_retry: false });
  });

  it("grande demais: para no meio e apaga o envio", async () => {
    const small = { ...env, maxBytes: CHUNK };
    const w = world(new Response(new Uint8Array(CHUNK + 1), { headers: { "content-type": "video/mp4" } }));
    await handleMeetingVideoImport(small, w.deps);
    expect(w.saved[0]).toMatchObject({ p_retry: false });
    expect(w.fetchMock.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === "DELETE")).toBe(true);
  });

  it("só com o segredo", () => {
    expect(meetingVideoAllowed("Bearer segredo", env)).toBe(true);
    expect(meetingVideoAllowed("Bearer outro", env)).toBe(false);
    expect(meetingVideoAllowed(null, { ...env, workerSecret: "" })).toBe(false);
  });
});
