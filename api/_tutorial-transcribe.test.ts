import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { seal } from "./_google";
import {
  FILE_LIMIT,
  handleTutorialTranscribe,
  tutorialTranscribeAllowed,
  type TutorialTranscribeEnv,
} from "./_tutorial-transcribe";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const providerKey = crypto.randomBytes(32);
const SECRET = "s".repeat(40);
const env: TutorialTranscribeEnv = {
  supabaseUrl: "https://db.example.com",
  supabaseKey: "k",
  bucket: "drive-bucket",
  credentials: { client_email: "svc@example.iam", private_key: privateKey },
  openaiKey: "sk-openai",
  transcribeModel: "gpt-4o-mini-transcribe",
  workerSecret: SECRET,
  providerKey,
  budgetMs: 240_000,
};
const media = "00000000-0000-4000-8000-000000000009";
const job = (over = {}) => ({
  id: media,
  company_id: "00000000-0000-4000-8000-000000000001",
  tutorial_id: "00000000-0000-4000-8000-000000000002",
  path: "tutorials/c/t/m",
  name: "passo.mp4",
  content_type: "video/mp4",
  size_bytes: 400_000_000,
  duration_seconds: 120,
  job: null,
  created_by: "00000000-0000-4000-8000-000000000010",
  ...over,
});
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const route = (kind: string, model: string) => ({
  scope: "feature",
  provider_id: "00000000-0000-4000-8000-0000000000aa",
  provider: kind,
  kind,
  base_url: null,
  key_cipher: seal(providerKey, "provider-key"),
  model,
  price: null,
});

function deps(jobs: unknown[], resolved: unknown, provider: (url: string, init?: RequestInit) => Response | undefined) {
  const saved: Record<string, unknown>[] = [];
  let claimed = false;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/rpc/tutorial_transcribe_claim")) {
      const out = claimed ? [] : jobs;
      claimed = true;
      return json(out);
    }
    if (url.endsWith("/rpc/ai_worker_route")) return json(resolved);
    if (url.endsWith("/rpc/tutorial_transcribe_save")) {
      saved.push(JSON.parse(String(init?.body)));
      return json(null);
    }
    return provider(url, init) ?? json({}, 404);
  });
  return { fetch, saved };
}

describe("transcrição dos vídeos dos tutoriais", () => {
  it("só com o segredo do worker", async () => {
    expect(tutorialTranscribeAllowed(`Bearer ${SECRET}`, env)).toBe(true);
    expect(tutorialTranscribeAllowed("Bearer errado", env)).toBe(false);
    expect(tutorialTranscribeAllowed(null, env)).toBe(false);
    const { fetch } = deps([], null, () => undefined);
    expect((await handleTutorialTranscribe("Bearer errado", env, { fetch })).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Deepgram: manda o link assinado do vídeo, guarda o texto e o custo por minuto", async () => {
    let sent: { url: string; body: Record<string, unknown>; auth: string } | null = null;
    const { fetch, saved } = deps([job()], route("deepgram", "nova-3"), (url, init) => {
      if (!url.startsWith("https://api.deepgram.com/v1/listen")) return;
      sent = {
        url,
        body: JSON.parse(String(init?.body)),
        auth: (init?.headers as Record<string, string>).Authorization,
      };
      return json({
        metadata: { duration: 150 },
        results: { channels: [{ alternatives: [{ transcript: "plano", paragraphs: { transcript: "Abra a lista.\n\nClique em Nova tarefa." } }] }] },
      });
    });
    const res = await handleTutorialTranscribe(`Bearer ${SECRET}`, env, { fetch });
    expect(res.body).toEqual({ done: 1 });
    expect(sent!.url).toContain("model=nova-3");
    expect(sent!.url).toContain("language=pt-BR");
    expect(sent!.auth).toBe("Token provider-key");
    expect(new URL(String(sent!.body.url)).pathname).toBe("/drive-bucket/tutorials/c/t/m");
    expect(saved[0]).toMatchObject({
      p_media: media,
      p_transcript: "Abra a lista.\n\nClique em Nova tarefa.",
      p_error: null,
      p_model: "nova-3",
      p_cost: Math.round(2.5 * 0.0043 * 1e6) / 1e6,
      p_duration: 150,
      p_provider: "00000000-0000-4000-8000-0000000000aa",
    });
  });

  it("AssemblyAI: o pedido que ainda processa volta para a fila com o id", async () => {
    let now = 0;
    const { fetch, saved } = deps([job()], route("assemblyai", "universal"), (url, init) => {
      if (url === "https://api.assemblyai.com/v2/transcript" && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({ speech_model: "universal", language_code: "pt" });
        return json({ id: "abc" });
      }
      if (url === "https://api.assemblyai.com/v2/transcript/abc") return json({ status: "processing" });
    });
    await handleTutorialTranscribe(`Bearer ${SECRET}`, { ...env, budgetMs: 60_000 }, {
      fetch,
      now: () => now,
      sleep: async (ms) => {
        now += ms * 10;
      },
    });
    expect(saved[0]).toMatchObject({ p_media: media, p_transcript: null, p_job: "abc", p_cost: 0 });
  });

  it("AssemblyAI: retoma o pedido guardado e guarda o texto pronto", async () => {
    const { fetch, saved } = deps([job({ job: "abc" })], route("assemblyai", "universal"), (url) => {
      if (url === "https://api.assemblyai.com/v2/transcript/abc")
        return json({ status: "completed", text: "Pronto.", audio_duration: 60 });
    });
    await handleTutorialTranscribe(`Bearer ${SECRET}`, env, { fetch });
    expect(fetch.mock.calls.some(([u, i]) => u === "https://api.assemblyai.com/v2/transcript" && i?.method === "POST")).toBe(false);
    expect(saved[0]).toMatchObject({ p_transcript: "Pronto.", p_cost: 0.0025, p_duration: 60 });
  });

  it("sem regra e acima de 25 MB: fica grande demais (quem edita escreve)", async () => {
    const { fetch, saved } = deps([job({ size_bytes: FILE_LIMIT + 1 })], null, () => undefined);
    await handleTutorialTranscribe(`Bearer ${SECRET}`, env, { fetch });
    expect(saved[0]).toMatchObject({ p_skipped: true, p_transcript: null });
    expect(String(saved[0].p_error)).toMatch(/Deepgram ou a AssemblyAI/);
  });

  it("sem regra e até 25 MB: o arquivo vai para a OpenAI do servidor", async () => {
    const { fetch, saved } = deps([job({ size_bytes: 1000 })], null, (url) => {
      if (url.includes("storage.googleapis.com")) return new Response(new Uint8Array([1, 2, 3]));
      if (url === "https://api.openai.com/v1/audio/transcriptions") return json({ text: "Olá, time." });
    });
    await handleTutorialTranscribe(`Bearer ${SECRET}`, env, { fetch });
    expect(saved[0]).toMatchObject({ p_transcript: "Olá, time.", p_model: "gpt-4o-mini-transcribe", p_cost: 0.006 });
  });

  it("um erro do provedor fica no vídeo", async () => {
    const { fetch, saved } = deps([job()], route("deepgram", "nova-3"), (url) => {
      if (url.startsWith("https://api.deepgram.com")) return json({ err_msg: "Bad file" }, 400);
    });
    await handleTutorialTranscribe(`Bearer ${SECRET}`, env, { fetch });
    expect(saved[0]).toMatchObject({ p_transcript: null, p_error: "Deepgram (400): Bad file", p_cost: 0 });
  });
});
