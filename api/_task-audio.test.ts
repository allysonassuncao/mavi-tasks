import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  SUMMARY_MIN_CHARS,
  handleTaskAudio,
  summaryPoints,
  type TaskAudioEnv,
} from "./_task-audio";
import type { Meter } from "./_social-leads";
import { seal } from "./_google";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const id = "00000000-0000-4000-8000-000000000001";
const company = "00000000-0000-4000-8000-000000000009";
const env: TaskAudioEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "publishable",
  credentials: { client_email: "svc@example.iam", private_key: privateKey },
  bucket: "public-bucket",
  openaiKey: "sk-test",
  transcribeModel: "gpt-4o-mini-transcribe",
  transcribeUsdPerMinute: 0.006,
  anthropicKey: "sk-ant",
  model: "claude-test",
};
const audio = (over: Record<string, unknown> = {}) => ({
  id,
  company_id: company,
  task_id: null,
  comment_id: null,
  purpose: "description",
  path: `${company}/audio/${id}`,
  mime: "audio/webm",
  duration_seconds: 30,
  status: "transcribing",
  transcript: null,
  summary: null,
  error: null,
  ...over,
});
const long = "Precisamos subir a campanha de outubro com três criativos. ".repeat(8).trim();

/**
 * A fake of the database, the GCS and OpenAI: records the RPCs and answers
 * like the real functions would.
 */
function world({
  started = audio(),
  file = new Response(new Uint8Array([1, 2, 3])),
  transcript = long,
  transcribeRoute = null,
}: {
  started?: ReturnType<typeof audio>;
  file?: Response;
  transcript?: string;
  /** A regra "Transcrição dos áudios das tarefas" (nulo: o servidor). */
  transcribeRoute?: unknown;
} = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let row = { ...started };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://db.example.com/rest/v1/rpc/")) {
      const name = url.split("/").pop()!;
      const args = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ name, args });
      const json = (v: unknown) => new Response(JSON.stringify(v));
      if (name === "start_task_audio_work")
        return json({ skip: false, audio: row, client: "cli", contract: "con", project: null, task_title: "Campanha" });
      if (name === "ai_check_limits") return json({ blocked: false });
      if (name === "ai_resolve_route")
        return json(args.p_feature === "task_audio_transcribe" ? transcribeRoute : null);
      if (name === "ai_log_usage") return json(null);
      if (name === "edit_task_audio") {
        row = { ...row, transcript: args.p_transcript, summary: null, status: "summarizing" };
        return json(row);
      }
      if (name === "save_task_audio_work") {
        if (args.p_error)
          row = { ...row, error: args.p_error, status: row.transcript ? "ready" : "failed" };
        else if (args.p_transcript != null)
          row = {
            ...row,
            transcript: args.p_transcript || null,
            status: !args.p_transcript ? "empty" : row.purpose === "description" ? "summarizing" : "ready",
          };
        else row = { ...row, summary: args.p_summary || null, status: "ready" };
        return json(row);
      }
      return json(null);
    }
    if (url.startsWith("https://storage.googleapis.com/")) return file;
    if (
      url === "https://api.openai.com/v1/audio/transcriptions" ||
      url === "https://api.mistral.ai/v1/audio/transcriptions"
    )
      return new Response(JSON.stringify({ text: transcript }));
    throw new Error(`unexpected ${url}`);
  });
  const ask = vi.fn(async (_env: unknown, _request: unknown, meter: Meter) => {
    meter.input += 400;
    meter.output += 60;
    meter.cost += 0.002;
    return "Resumo:\n- Subir a campanha de outubro\n2. **Três** criativos";
  });
  return { calls, fetch: fetchMock as unknown as typeof fetch, ask, row: () => row };
}

describe("handleTaskAudio", () => {
  it("exige login e um áudio válido", async () => {
    const w = world();
    expect((await handleTaskAudio({ op: "work", audio: id }, null, env, w)).status).toBe(401);
    expect((await handleTaskAudio({ op: "work", audio: "x" }, "Bearer t", env, w)).status).toBe(400);
    expect(w.calls).toEqual([]);
  });

  it("transcreve, resume e registra o consumo", async () => {
    const w = world();
    const res = await handleTaskAudio(
      { op: "work", audio: id, contract: "00000000-0000-4000-8000-0000000000aa" },
      "Bearer user",
      env,
      w,
    );
    expect(res.status).toBe(200);
    expect(res.body.audio).toMatchObject({
      status: "ready",
      transcript: long,
      summary: "- Subir a campanha de outubro\n- Três criativos",
    });
    const names = w.calls.map((c) => c.name);
    expect(names[0]).toBe("start_task_audio_work");
    expect(w.calls[0].args).toEqual({
      p_audio: id,
      p_contract: "00000000-0000-4000-8000-0000000000aa",
    });
    const usage = w.calls.filter((c) => c.name === "ai_log_usage").map((c) => c.args);
    expect(usage.map((u) => u.p_kind)).toEqual(["audio_transcription", "audio_summary"]);
    // 30 s do gpt-4o-mini-transcribe, a US$ 0,003 por minuto.
    expect(usage[0].p_cost).toBe(0.0015);
    expect(usage[0]).toMatchObject({ p_module: "tasks", p_client: "cli" });
    const request = w.ask.mock.calls[0][1] as { messages: { content: string }[] };
    expect(request.messages[0].content).toContain(long.trim());
  });

  it("com a regra do Painel da MAVI, transcreve pelo provedor escolhido", async () => {
    const providerKey = crypto.randomBytes(32);
    const w = world({
      transcribeRoute: {
        scope: "feature",
        provider_id: "p-mistral",
        provider: "Mistral",
        kind: "mistral",
        base_url: null,
        key_cipher: seal(providerKey, "mk-agencia"),
        model: "voxtral-mini-latest",
        price: null,
      },
    });
    const res = await handleTaskAudio(
      { op: "work", audio: id },
      "Bearer user",
      { ...env, providerKey, openaiKey: "" },
      w,
    );
    expect(res.body.audio).toMatchObject({ status: "ready", transcript: long });
    const call = (w.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([u]) =>
      String(u).endsWith("/audio/transcriptions"),
    )!;
    expect(call[0]).toBe("https://api.mistral.ai/v1/audio/transcriptions");
    expect((call[1].body as FormData).get("model")).toBe("voxtral-mini-latest");
    expect(call[1].headers.Authorization).toBe("Bearer mk-agencia");
    const usage = w.calls.find((c) => c.name === "ai_log_usage")!.args;
    expect(usage).toMatchObject({
      p_kind: "audio_transcription",
      p_model: "voxtral-mini-latest",
      p_provider: "p-mistral",
      // 30 s a US$ 0,001 por minuto.
      p_cost: 0.0005,
    });
  });

  it("comentário: só transcreve", async () => {
    const w = world({ started: audio({ purpose: "comment" }) });
    const res = await handleTaskAudio({ op: "work", audio: id }, "Bearer user", env, w);
    expect(res.body.audio).toMatchObject({ status: "ready", summary: null });
    expect(w.ask).not.toHaveBeenCalled();
  });

  it("fala curta: a transcrição já basta, sem chamar a MAVI", async () => {
    const w = world({ transcript: "Pode subir amanhã." });
    expect("Pode subir amanhã.".length).toBeLessThan(SUMMARY_MIN_CHARS);
    const res = await handleTaskAudio({ op: "work", audio: id }, "Bearer user", env, w);
    expect(res.body.audio).toMatchObject({ status: "ready", summary: null, error: null });
    expect(w.ask).not.toHaveBeenCalled();
  });

  it("o arquivo não chegou: o áudio falha com uma explicação", async () => {
    const w = world({ file: new Response("", { status: 404 }) });
    const res = await handleTaskAudio({ op: "work", audio: id }, "Bearer user", env, w);
    expect(res.body.audio).toMatchObject({ status: "failed" });
    expect(String((res.body.audio as { error: string }).error)).toMatch(/Grave de novo/);
  });

  it("o resumo falhou: a transcrição continua valendo", async () => {
    const w = world();
    w.ask.mockRejectedValueOnce(new Error("sobrecarregado"));
    const res = await handleTaskAudio({ op: "work", audio: id }, "Bearer user", env, w);
    expect(res.body.audio).toMatchObject({ status: "ready", transcript: long, summary: null });
    expect(String((res.body.audio as { error: string }).error)).toMatch(/resumir/);
  });

  it("limite de gasto atingido: nada é transcrito", async () => {
    const w = world();
    const base = w.fetch;
    const blocked = vi.fn(async (url: string, init?: RequestInit) =>
      url.endsWith("/ai_check_limits")
        ? new Response(JSON.stringify({ blocked: true, message: "Limite do mês atingido." }))
        : base(url, init),
    ) as unknown as typeof fetch;
    const res = await handleTaskAudio({ op: "work", audio: id }, "Bearer user", env, { ...w, fetch: blocked });
    expect(res.body.audio).toMatchObject({ status: "failed", error: "Limite do mês atingido." });
  });

  it("correção da transcrição: grava e refaz o resumo sem transcrever de novo", async () => {
    const w = world({ started: audio({ status: "ready", transcript: "antigo" }) });
    const res = await handleTaskAudio(
      { op: "edit", audio: id, transcript: long },
      "Bearer user",
      env,
      w,
    );
    expect(res.body.audio).toMatchObject({ status: "ready", transcript: long });
    expect(w.calls[0]).toEqual({ name: "edit_task_audio", args: { p_audio: id, p_transcript: long } });
    expect(w.calls.some((c) => c.name === "ai_log_usage" && c.args.p_kind === "audio_transcription")).toBe(false);
    expect(w.ask).toHaveBeenCalledTimes(1);
  });
});

describe("summaryPoints", () => {
  it("limpa numeração, negrito e títulos, e limita os tópicos", () => {
    expect(summaryPoints("Tópicos:\n1) **A**\n* B\n\n• C")).toBe("- A\n- B\n- C");
    expect(summaryPoints(Array.from({ length: 9 }, (_, i) => `- ${i}${i}`).join("\n")).split("\n")).toHaveLength(6);
  });
});
