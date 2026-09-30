import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleDrive, type DriveEnv, type GcsCredentials } from "./_drive.js";
import {
  claudeAsk,
  handleMeetings,
  meetingsEnv,
  streamMeetingAsk,
} from "./_meetings.js";
import { aiDeps, aiEnv, handleAi, streamAi } from "./_ai.js";
import {
  copilotRelated,
  handleDossierWorker,
  streamCopilot,
} from "./_copilot.js";
import { handleLearningWorker } from "./_copilot-learning.js";
import { handleTemperatureWorker } from "./_temperature.js";
import { serverModel } from "../src/ai-providers.js";
import { handleMcp, protectedResource } from "./_mcp.js";
import { handleMcpCallback } from "./_ai-mcp.js";
import { handleWhatsapp, whatsappEnv } from "./_whatsapp.js";
import { handleCases } from "./_cases.js";
import { handleNotices } from "./_notices.js";
import { handleNoticeWriter } from "./_notice-writer.js";
import { handleSkillCoach } from "./_skill-coach.js";
import { handleNoticeAnimate } from "./_notice-animation.js";
import { claudeComplete } from "./_social-leads.js";
import { openAiEmbedder } from "./_ai-embeddings.js";
import { waitUntil } from "@vercel/functions";
import { appOrigin } from "./_origin.js";
import { handlePublicApi } from "./_public-api.js";
import { handleTaskAudio, taskAudioEnv } from "./_task-audio.js";
import {
  handleTaskAudioCleanup,
  taskAudioCleanupEnv,
} from "./_task-audio-cleanup.js";

function credentials(): GcsCredentials | null {
  if (process.env.GCS_CREDENTIALS)
    return JSON.parse(process.env.GCS_CREDENTIALS);
  const localFile = path.resolve(process.cwd(), "gcs-credentials.json");
  return fs.existsSync(localFile)
    ? JSON.parse(fs.readFileSync(localFile, "utf8"))
    : null;
}

/** Environment for Drive requests; GCS_DRIVE_BUCKET lets Drive use its own (private) bucket. */
export function driveEnv(
  env: Record<string, string | undefined> = process.env,
): DriveEnv {
  return {
    supabaseUrl:
      env.VITE_SUPABASE_URL || "https://zajlipvbotjafkowohmn.supabase.co",
    supabaseKey:
      env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "",
    bucket: env.GCS_DRIVE_BUCKET || env.GCS_BUCKET || "maso_storage_main",
    credentials: credentials(),
  };
}

/**
 * A MAVI do Assistente das tarefas (ou do dossiê e do aprendizado, nos
 * workers): o modelo do padrão do servidor é o da funcionalidade (o Painel
 * da MAVI vence).
 */
function copilotEnv(
  feature:
    "task_copilot" | "client_dossier" | "copilot_learning" = "task_copilot",
) {
  const env = aiEnv(driveEnv());
  const model = serverModel(feature, process.env);
  return { ...env, model, dossierModel: model, learningModel: model };
}

/** Browser IP and user agent, for the Drive audit trail (Vercel sets x-forwarded-for). */
export function requestOrigin(req: IncomingMessage) {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?.split(",")[0]
    ?.trim();
  return {
    ip:
      first ||
      (req.headers["x-real-ip"] as string) ||
      req.socket?.remoteAddress,
    user_agent: req.headers["user-agent"],
  };
}

const MCP_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
};

async function readBody(req: IncomingMessage & { body?: any }) {
  if (typeof req.body === "object" && req.body !== null)
    return JSON.stringify(req.body);
  if (typeof req.body === "string") return req.body;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

/**
 * Servidor MCP (/api/mcp, reescrito para cá) e o documento de descoberta do
 * OAuth (/.well-known/oauth-protected-resource).
 */
async function mcpRoutes(
  req: IncomingMessage & { body?: any },
  res: ServerResponse,
  url: URL,
) {
  const env = { ...aiEnv(driveEnv()), appOrigin: appOrigin() };
  for (const [k, v] of Object.entries(MCP_CORS)) res.setHeader(k, v);
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (
    url.pathname.startsWith("/.well-known/oauth-protected-resource") ||
    url.searchParams.get("wk") === "1"
  ) {
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 200;
    res.end(JSON.stringify(protectedResource(env)));
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    res.statusCode = 405;
    res.end();
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)) || "null");
  } catch {
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 400;
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "JSON inválido." },
      }),
    );
    return;
  }
  const result = await handleMcp(
    body,
    (req.headers["authorization"] as string | undefined) ?? null,
    env,
    aiDeps(env),
  );
  for (const [k, v] of Object.entries(result.headers ?? {}))
    res.setHeader(k, v);
  res.statusCode = result.status;
  if (result.body === null) {
    res.end();
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(result.body));
}

/** API pública v1 (/api/v1/…, reescrita para cá): ver docs/API.md. */
async function publicApiRoute(
  req: IncomingMessage & { body?: any },
  res: ServerResponse,
  url: URL,
) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const method = req.method ?? "GET";
  let body: unknown = null;
  if (method === "POST") {
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : null;
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "JSON inválido no corpo." }));
      return;
    }
  }
  const path =
    url.searchParams.get("v1") ?? url.pathname.replace(/^\/api\/v1\/?/, "");
  const result = await handlePublicApi(
    { method, path, query: url.searchParams, headers: req.headers, body },
    driveEnv(),
  );
  for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, v);
  res.statusCode = result.status;
  res.end(JSON.stringify(result.body));
}

export default async function handler(
  req: IncomingMessage & { body?: any },
  res: ServerResponse,
) {
  const url = new URL(req.url ?? "/", "https://mavi.invalid");
  if (url.pathname.startsWith("/api/v1/") || url.searchParams.has("v1")) {
    try {
      await publicApiRoute(req, res, url);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }
  // A volta do login (OAuth) de uma conexão da MAVI (/api/mavi-mcp/callback).
  if (url.pathname === "/api/mavi-mcp/callback" || url.searchParams.get("mcpcb") === "1") {
    res.setHeader("Cache-Control", "no-store");
    const env = aiEnv(driveEnv());
    let location = `${appOrigin()}/?mcp=erro`;
    try {
      location = await handleMcpCallback(
        url.searchParams,
        {
          supabaseUrl: env.supabaseUrl,
          supabaseKey: env.supabaseKey,
          providerKey: env.providerKey,
          appOrigin: appOrigin(),
        },
        { fetch },
      );
    } catch {
      /* volta com erro */
    }
    res.statusCode = 302;
    res.setHeader("Location", location);
    res.end();
    return;
  }
  if (
    url.pathname === "/api/mcp" ||
    url.pathname.startsWith("/.well-known/oauth-protected-resource") ||
    url.searchParams.get("mcp") === "1" ||
    url.searchParams.get("wk") === "1"
  ) {
    try {
      await mcpRoutes(req, res, url);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "Método não permitido" }));
    return;
  }
  let raw = "";
  if (typeof req.body === "object" && req.body !== null) {
    raw = JSON.stringify(req.body);
  } else {
    for await (const chunk of req) raw += chunk;
  }
  try {
    const body = JSON.parse(raw || "{}");
    const authorization =
      (req.headers["authorization"] as string | undefined) ?? null;
    const action = typeof body?.action === "string" ? body.action : "";
    // Perguntas à IA em tempo real: uma linha JSON por evento (passos,
    // raciocínio, texto) até "done" ou "error".
    if (body?.stream && (action === "ai-ask" || action === "meeting-ask")) {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("X-Accel-Buffering", "no");
      res.statusCode = 200;
      // Quem saiu da página não recebe mais nada (e nada quebra).
      res.on("error", () => {});
      const write = (event: unknown) => {
        if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
      };
      if (action === "ai-ask") {
        const env = aiEnv(driveEnv());
        // A conexão caiu antes do fim: parou ou saiu (a resposta continua e avisa).
        const closed: (() => void)[] = [];
        let done = false;
        res.on("close", () => {
          if (!done) for (const listener of closed.splice(0)) listener();
        });
        const work = streamAi(body, authorization, env, aiDeps(env), write, {
          // O resumo da conversa longa segue depois da resposta.
          later: (task) => waitUntil(task.catch(() => {})),
          onClose: (listener) => {
            if (res.destroyed && !done) listener();
            else closed.push(listener);
          },
        }).finally(() => {
          done = true;
        });
        // Na Vercel, o que segue depois que a pessoa sai precisa do waitUntil.
        waitUntil(work.catch(() => {}));
        await work;
      } else
        await streamMeetingAsk(
          body,
          authorization,
          meetingsEnv(driveEnv()),
          { fetch, ask: claudeAsk },
          write,
        );
      res.end();
      return;
    }
    // Assistente MAVI nas tarefas: a análise chega aos poucos e para quando
    // a pessoa volta a digitar (o navegador cancela a requisição).
    if (action === "ai-copilot-review") {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("X-Accel-Buffering", "no");
      res.statusCode = 200;
      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) abort.abort();
      });
      const env = copilotEnv();
      await streamCopilot(
        body,
        authorization,
        env,
        aiDeps(env),
        (event) => {
          if (!abort.signal.aborted) res.write(`${JSON.stringify(event)}\n`);
        },
        abort.signal,
      );
      res.end();
      return;
    }
    if (
      action === "ai-copilot" ||
      action === "ai-dossier" ||
      action === "ai-learning"
    ) {
      const env = copilotEnv(
        action === "ai-dossier"
          ? "client_dossier"
          : action === "ai-learning"
            ? "copilot_learning"
            : "task_copilot",
      );
      const result =
        action === "ai-copilot"
          ? await copilotRelated(body, authorization, env, aiDeps(env))
          : action === "ai-dossier"
            ? await handleDossierWorker(authorization, env, aiDeps(env))
            : await handleLearningWorker(authorization, env, aiDeps(env));
      res.statusCode = result.status;
      res.end(JSON.stringify(result.body));
      return;
    }
    // Termômetro do cliente: o worker do pg_cron (o Jev lê, a MAVI explica
    // com o modelo da funcionalidade 'client_temperature_text').
    if (action === "ai-temperature") {
      const env = {
        ...aiEnv(driveEnv()),
        model: serverModel("client_temperature_text", process.env),
      };
      const result = await handleTemperatureWorker(authorization, env, aiDeps(env));
      res.statusCode = result.status;
      res.end(JSON.stringify(result.body));
      return;
    }
    // Gravações da MAVI, a IA (/api/ai é reescrito para cá), a coleta do
    // Whatsapp (/api/whatsapp), as mídias dos Cases de Sucesso e os anexos do
    // Mural de avisos vivem na
    // mesma função: o plano Hobby da Vercel limita o número de funções.
    let result: { status: number; body: unknown };
    // Áudios das tarefas: transcrição e resumo da MAVI (funcionalidade
    // 'task_audio'); quem gravou espera a resposta.
    if (action === "task-audio")
      result = await handleTaskAudio(
        body,
        authorization,
        taskAudioEnv(driveEnv()),
        { fetch, ask: claudeAsk },
      );
    // A limpeza dos rascunhos e dos arquivos que ninguém usa mais: o worker
    // do pg_cron (mavi_private.task_audio_cleanup_kick).
    else if (action === "task-audio-cleanup")
      result = await handleTaskAudioCleanup(
        authorization,
        taskAudioCleanupEnv(driveEnv()),
        { fetch },
      );
    else if (action.startsWith("whatsapp-"))
      result = await handleWhatsapp(
        body,
        authorization,
        whatsappEnv(driveEnv()),
        { fetch, ask: claudeAsk },
        requestOrigin(req),
      );
    else if (action.startsWith("case-"))
      result = await handleCases(body, authorization, driveEnv(), fetch);
    else if (action === "notice-mavi") {
      // A MAVI na escrita de um aviso (funcionalidade 'notice_writer').
      const env = {
        ...aiEnv(driveEnv()),
        model: serverModel("notice_writer", process.env),
      };
      result = await handleNoticeWriter(body, authorization, env, aiDeps(env));
    } else if (action === "skill-mavi") {
      // O validador e o assistente das skills (funcionalidade 'skill_coach').
      const env = {
        ...aiEnv(driveEnv()),
        model: serverModel("skill_coach", process.env),
      };
      result = await handleSkillCoach(body, authorization, env, aiDeps(env));
    } else if (action === "notice-animate") {
      // A animação do aviso: responde na hora e gera em segundo plano
      // (na Vercel, até o maxDuration desta função).
      const env = {
        ...aiEnv(driveEnv()),
        model: serverModel("notice_animation", process.env),
      };
      result = await handleNoticeAnimate(body, authorization, env, {
        fetch,
        embed: openAiEmbedder(env, fetch),
        complete: claudeComplete,
        background: (work) => waitUntil(work.catch(() => {})),
      });
    } else if (action.startsWith("notice-"))
      result = await handleNotices(body, authorization, driveEnv(), fetch);
    else if (action.startsWith("meeting-"))
      result = await handleMeetings(
        body,
        authorization,
        meetingsEnv(driveEnv()),
        { fetch, ask: claudeAsk },
        requestOrigin(req),
      );
    else if (action.startsWith("ai-")) {
      const env = aiEnv(driveEnv());
      result = await handleAi(body, authorization, env, {
        ...aiDeps(env),
        // A leitura dos anexos termina mesmo se a pessoa sair da tela.
        background: (work) => waitUntil(work.catch(() => {})),
      });
    } else
      result = await handleDrive(
        body,
        authorization,
        driveEnv(),
        fetch,
        requestOrigin(req),
      );
    res.statusCode = result.status;
    res.end(JSON.stringify(result.body));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}
