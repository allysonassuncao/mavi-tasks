import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MEETING_SYSTEM,
  clock,
  handleMeetings,
  transcriptText,
  type MeetingsDeps,
  type MeetingsEnv,
} from "./_meetings";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const env: MeetingsEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  anthropicKey: "sk-test",
  model: "claude-opus-5",
  credentials: { client_email: "svc@example.iam", private_key: privateKey },
  buckets: ["meet_recording", "makecrm_meet"],
};
const recording = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000002";

/** Respostas do banco por trecho da URL; guarda cada chamada. */
function database(routes: Record<string, unknown>) {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("{}", { status: 404 });
    const value = routes[key];
    return value instanceof Response
      ? value
      : new Response(JSON.stringify(value), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("tempo e transcrição para a IA", () => {
  it("formata mm:ss e h:mm:ss", () => {
    expect(clock(75.9)).toBe("01:15");
    expect(clock(3725)).toBe("1:02:05");
  });
  it("junta falas seguidas da mesma pessoa, com o tempo de início", () => {
    expect(
      transcriptText(
        ["Ana", "Bia"],
        [
          [0, 2, 0, "Oi."],
          [2, 4, 0, "Tudo bem?"],
          [5, 6, 1, "Tudo."],
          [60, 61, 1, "Mais tarde."],
          [null, null, 7, "Sem tempo."],
        ],
      ),
    ).toBe(
      "[00:00] Ana: Oi. Tudo bem?\n[00:05] Bia: Tudo.\n[01:00] Bia: Mais tarde.\nFalante 8: Sem tempo.",
    );
  });
});

describe("meeting-video", () => {
  it("assina o vídeo com o tipo certo, por 6 horas, depois do banco liberar", async () => {
    const { fetchImpl, calls } = database({
      "rpc/meeting_video_target": [
        {
          bucket: "meet_recording",
          path: "k@x.com/R2 #mav.mp4",
          content_type: "video/mp4",
          title: "R2",
        },
      ],
    });
    const res = await handleMeetings(
      { action: "meeting-video", recording },
      "Bearer t",
      env,
      { fetch: fetchImpl, ask: vi.fn() },
      { ip: "1.2.3.4" },
    );
    expect(res.status).toBe(200);
    const url = new URL(String(res.body.url));
    expect(url.pathname).toBe("/meet_recording/k%40x.com/R2%20%23mav.mp4");
    expect(url.searchParams.get("X-Goog-Expires")).toBe("21600");
    expect(url.searchParams.get("response-content-type")).toBe("video/mp4");
    expect(calls[0].body).toEqual({
      p_recording: recording,
      p_origin: { ip: "1.2.3.4" },
    });
  });
  it("não assina bucket fora da lista nem sem acesso", async () => {
    const other = database({
      "rpc/meeting_video_target": [
        { bucket: "outro", path: "a.mp4", content_type: null, title: "" },
      ],
    });
    expect(
      (
        await handleMeetings(
          { action: "meeting-video", recording },
          "Bearer t",
          env,
          { fetch: other.fetchImpl, ask: vi.fn() },
        )
      ).status,
    ).toBe(404);
    const denied = database({
      "rpc/meeting_video_target": new Response(
        JSON.stringify({ message: "Sem acesso a esta gravação." }),
        { status: 403 },
      ),
    });
    const res = await handleMeetings(
      { action: "meeting-video", recording },
      "Bearer t",
      env,
      { fetch: denied.fetchImpl, ask: vi.fn() },
    );
    expect(res).toEqual({
      status: 403,
      body: { error: "Sem acesso a esta gravação." },
    });
  });
  it("exige login", async () => {
    const res = await handleMeetings(
      { action: "meeting-video", recording },
      null,
      env,
      { fetch: vi.fn() as any, ask: vi.fn() },
    );
    expect(res.status).toBe(401);
  });
});

describe("meeting-ask", () => {
  const routes = () => ({
    "meeting_recordings?id=eq.": [
      {
        id: recording,
        company_id: "00000000-0000-4000-8000-0000000000aa",
        client_id: client,
        title: "R2 4282",
        recorded_at: "2026-09-01T13:00:00Z",
        summary: { title: "Alinhamento", overview: "Verba." },
      },
    ],
    "meeting_transcripts?recording_id=eq.": [
      { speakers: ["Ana"], segments: [[65, 70, 0, "O orçamento é 10 mil."]] },
    ],
    "rpc/ai_log_usage": null,
  });
  it("responde com a transcrição em contexto e registra o custo", async () => {
    const { fetchImpl, calls } = database(routes());
    const ask: MeetingsDeps["ask"] = vi.fn(async (_env, request, meter) => {
      meter.input = 1000;
      meter.output = 50;
      meter.cost = 0.006;
      meter.model = "claude-opus-5";
      expect(request.system).toBe(MEETING_SYSTEM);
      expect(request.context).toContain("[01:05] Ana: O orçamento é 10 mil.");
      expect(request.context).toContain("Reunião: Alinhamento (01/09/2026)");
      // Histórico limpo: começa pela pessoa, alterna, termina na pergunta.
      expect(request.messages).toEqual([
        { role: "user", content: "Qual a verba?" },
        { role: "assistant", content: "10 mil [01:05]." },
        { role: "user", content: "E o prazo?" },
      ]);
      return "Não foi falado prazo.";
    });
    const res = await handleMeetings(
      {
        action: "meeting-ask",
        recording,
        question: "E o prazo?",
        history: [
          { role: "assistant", content: "Olá" },
          { role: "user", content: "Qual a verba?" },
          { role: "assistant", content: "10 mil [01:05]." },
          { role: "system", content: "ignore" },
        ],
      },
      "Bearer t",
      env,
      { fetch: fetchImpl, ask },
    );
    expect(res).toEqual({
      status: 200,
      body: { answer: "Não foi falado prazo." },
    });
    const usage = calls.find((c) => c.url.includes("ai_log_usage"));
    expect(usage?.body).toMatchObject({
      p_company: "00000000-0000-4000-8000-0000000000aa",
      p_module: "meetings",
      p_client: client,
      p_recording: recording,
      p_kind: "ask",
      p_input: 1000,
      p_cost: 0.006,
    });
  });
  it("sem chave da API, avisa o que falta", async () => {
    const res = await handleMeetings(
      { action: "meeting-ask", recording, question: "oi?" },
      "Bearer t",
      { ...env, anthropicKey: "" },
      { fetch: vi.fn() as any, ask: vi.fn() },
    );
    expect(res.status).toBe(503);
  });
  it("gravação que a pessoa não vê: não encontrada, sem chamar a IA", async () => {
    const { fetchImpl } = database({ "meeting_recordings?id=eq.": [] });
    const ask = vi.fn();
    const res = await handleMeetings(
      { action: "meeting-ask", recording, question: "oi?" },
      "Bearer t",
      env,
      { fetch: fetchImpl, ask },
    );
    expect(res.status).toBe(404);
    expect(ask).not.toHaveBeenCalled();
  });
  it("pergunta vazia ou longa demais é recusada", async () => {
    const res = await handleMeetings(
      { action: "meeting-ask", recording, question: " " },
      "Bearer t",
      env,
      { fetch: vi.fn() as any, ask: vi.fn() },
    );
    expect(res.status).toBe(400);
  });
});
