// Drive › "Gravações da MAVI": traz o histórico do gravador de reuniões (banco
// antigo) para o MAVI. Lê os dumps do Supabase antigo
//   meet_record_rows.sql            (INSERT … VALUES: agenda, cliente, quem gravou)
//   meet_record_transcription.sql   (pg_dump COPY: transcrição, resumo, vídeo)
// e escreve arquivos SQL para o pgAdmin (roda como postgres):
//   01-gravacoes.sql                 as reuniões (metadados e resumo)
//   02-transcricoes-parte-NN.sql     as transcrições, em partes de ~25 MB
//
//   node scripts/import-meeting-recordings.mjs \
//     --dir ~/Desktop/transcription-export --company <uuid> \
//     --out meeting-recordings-import [--credentials gcs-credentials.json]
//
// Só entram reuniões transcritas com cliente. O cliente é o customer_id do
// MASO (no MAVI, o cliente com esse nome — como nas outras importações);
// reuniões sem cliente (customer_id 0) entram só quando um participante
// externo ou o link do Meet já apareceu em reuniões de um único cliente. Com
// as credenciais do GCS, o vídeo só é ligado quando o arquivo ainda existe no
// bucket (a regra de ciclo de vida apagou os mais antigos). Rodar de novo não
// duplica nada (source_id = id do bot).
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";
import { UsageError, sqlString } from "./import-maso-campaigns.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = `Uso:
  node scripts/import-meeting-recordings.mjs --dir <pasta dos dumps> \\
    --company <uuid da empresa> --out <pasta de saída> [--credentials gcs-credentials.json]`;
/** Buckets em que o gravador guarda os vídeos. */
export const VIDEO_BUCKETS = ["meet_recording", "makecrm_meet"];
const PART_BYTES = 25 * 1024 * 1024;

// ------------------------------------------------------------ leitura
/** Linhas do INSERT … VALUES (…), (…) de um dump do Supabase. */
export function parseInsertRows(text) {
  const head = text.match(
    /INSERT INTO\s+"?\w+"?\."?(\w+)"?\s*\(([^)]*)\)\s*VALUES/i,
  );
  if (!head) throw new UsageError("O arquivo não tem um INSERT … VALUES.");
  const columns = head[2].split(",").map((c) => c.trim().replace(/"/g, ""));
  const rows = [];
  let i = head.index + head[0].length;
  const n = text.length;
  while (i < n) {
    if (text[i] !== "(") {
      i++;
      continue;
    }
    i++;
    const values = [];
    for (;;) {
      while (text[i] === " " || text[i] === "\n") i++;
      if (text[i] === "'") {
        let j = i + 1;
        let out = "";
        for (;;) {
          if (text[j] === "'" && text[j + 1] === "'") {
            out += "'";
            j += 2;
          } else if (text[j] === "'") break;
          else out += text[j++];
          if (j >= n) throw new UsageError("Texto sem fim no INSERT.");
        }
        values.push(out);
        i = j + 1;
      } else {
        let j = i;
        while (text[j] !== "," && text[j] !== ")") j++;
        const raw = text.slice(i, j).trim();
        values.push(raw.toLowerCase() === "null" ? null : raw);
        i = j;
      }
      while (text[i] === " ") i++;
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === ")") {
        i++;
        break;
      }
      throw new UsageError("INSERT fora do formato esperado.");
    }
    rows.push(Object.fromEntries(columns.map((c, k) => [c, values[k]])));
  }
  return { table: head[1], rows };
}

/** Um campo do COPY … FROM stdin (formato texto do pg_dump). */
export function unescapeCopy(field) {
  if (field === "\\N") return null;
  return field.replace(
    /\\(?:([0-7]{1,3})|x([0-9a-fA-F]{1,2})|(.))/g,
    (_, oct, hex, ch) => {
      if (oct) return String.fromCharCode(parseInt(oct, 8));
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      return { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" }[ch] ?? ch;
    },
  );
}

/** As linhas de uma tabela num dump do pg_dump (uma por vez, sem carregar o arquivo). */
export async function* copyRows(file, table) {
  const lines = createInterface({
    input: createReadStream(file, { encoding: "utf8", highWaterMark: 4 << 20 }),
    crlfDelay: Infinity,
  });
  let columns = null;
  for await (const line of lines) {
    if (!columns) {
      const m = line.match(
        new RegExp(
          `^COPY\\s+(?:\\w+\\.)?${table}\\s*\\(([^)]*)\\)\\s+FROM stdin;`,
        ),
      );
      if (m) columns = m[1].split(",").map((c) => c.trim());
      continue;
    }
    if (line === "\\.") return;
    const fields = line.split("\t");
    yield Object.fromEntries(columns.map((c, k) => [c, fields[k] ?? "\\N"]));
  }
  if (!columns) throw new UsageError(`O arquivo não tem o COPY de ${table}.`);
}

const parseJson = (value) => {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

// ------------------------------------------------------------ transcrição
const round = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const clean = (s) =>
  String(s ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Todos os formatos que o gravador usou, num só: { speakers: [nomes],
 * segments: [[início, fim, falante, texto]] } (início/fim null sem tempo).
 *  - Deepgram: parágrafos com utterances (frases) e falante por número, às
 *    vezes com speaker_name;
 *  - Recall: turnos { speaker: nome, words: [{start, end, word}] }, quebrados
 *    em frases;
 *  - sem tempo: [{ "Nome": "texto" }, …] (às vezes como texto JSON).
 */
export function normalizeTranscript(raw) {
  let data = raw;
  if (typeof data === "string") data = parseJson(data);
  if (data && !Array.isArray(data) && typeof data === "object") data = [data];
  if (!Array.isArray(data)) return { speakers: [], segments: [] };
  const speakers = [];
  const speakerIndex = new Map();
  const who = (key, label) => {
    if (!speakerIndex.has(key)) {
      speakerIndex.set(key, speakers.length);
      speakers.push(label);
    }
    return speakerIndex.get(key);
  };
  const segments = [];
  const push = (start, end, speaker, text) => {
    const t = clean(text);
    if (t) segments.push([round(start), round(end), speaker, t]);
  };
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item.utterances)) {
      const number = Number.isInteger(item.speaker) ? item.speaker : 0;
      const name =
        typeof item.speaker_name === "string" ? clean(item.speaker_name) : "";
      const s = name
        ? who(`name:${name}`, name)
        : who(`n:${number}`, `Falante ${number + 1}`);
      if (item.utterances.length)
        for (const u of item.utterances) push(u.start, u.end, s, u.transcript);
      else push(item.start, item.end, s, item.transcript);
    } else if (Array.isArray(item.words) && typeof item.speaker === "string") {
      const name = clean(item.speaker) || "Falante";
      const s = who(`name:${name}`, name);
      let words = [];
      const flush = () => {
        if (words.length)
          push(
            words[0].start,
            words[words.length - 1].end,
            s,
            words.map((w) => w.word).join(""),
          );
        words = [];
      };
      for (const w of item.words) {
        if (words.length && w.start - words[words.length - 1].end > 1.5)
          flush();
        words.push({
          start: Number(w.start),
          end: Number(w.end),
          word: String(w.word ?? ""),
        });
        if (
          /[.?!…]["”)]?$/.test(String(w.word ?? "").trim()) &&
          words.length >= 4
        )
          flush();
        else if (words.length >= 45) flush();
      }
      flush();
    } else {
      for (const [name, text] of Object.entries(item)) {
        if (typeof text !== "string") continue;
        const label =
          clean(name) && name !== "undefined" ? clean(name) : "Falante 1";
        push(null, null, who(`name:${label}`, label), text);
      }
    }
  }
  // A ordem do tempo (os parágrafos do Deepgram vêm por falante em alguns envios).
  if (segments.every((s) => s[0] != null)) segments.sort((a, b) => a[0] - b[0]);
  return { speakers, segments };
}

/** O resumo da IA do gravador, com as chaves de sempre. */
export function normalizeSummary(raw) {
  let s = raw;
  if (typeof s === "string") s = parseJson(s) ?? s;
  if (typeof s === "string") s = parseJson(s) ?? { overview: clean(s) };
  if (!s || typeof s !== "object" || Array.isArray(s)) return {};
  const list = (v) => (Array.isArray(v) ? v : []);
  const out = {};
  if (typeof s.title === "string" && clean(s.title))
    out.title = clean(s.title).slice(0, 300);
  if (typeof s.overview === "string" && clean(s.overview))
    out.overview = String(s.overview).trim();
  const notes = list(s.notes).filter((n) => n && (n.title || n.description));
  if (notes.length)
    out.notes = notes.map((n) => ({
      title: clean(n.title),
      description: String(n.description ?? "").trim(),
    }));
  const todo = list(s.todo ?? s["to-do"]).filter((t) => t && t.description);
  if (todo.length)
    out.todo = todo.map((t) => ({
      owner: clean(t.owner),
      description: String(t.description).trim(),
    }));
  const actions = list(s.action_items).filter((t) => t && t.description);
  if (actions.length)
    out.action_items = actions.map((t) => ({
      owner: clean(t.owner),
      description: String(t.description).trim(),
      deadline: clean(t.deadline),
    }));
  const words = (v) =>
    list(v)
      .filter((k) => typeof k === "string" && clean(k))
      .map(clean);
  if (words(s.keywords).length) out.keywords = words(s.keywords);
  if (words(s.tone).length) out.tone = words(s.tone);
  return out;
}

/** Bucket e objeto do link de vídeo gravado pelo bot. */
export function videoLocation(url) {
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== "storage.googleapis.com") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  let bucket, object;
  if (
    parts[0] === "download" &&
    parts[1] === "storage" &&
    parts[3] === "b" &&
    parts[5] === "o"
  ) {
    bucket = parts[4];
    object = parts.slice(6).join("/");
  } else {
    bucket = parts[0];
    object = parts.slice(1).join("/");
  }
  if (!VIDEO_BUCKETS.includes(bucket) || !object) return null;
  const path = decodeURIComponent(object);
  const ext = path.split(".").pop().toLowerCase();
  const type = {
    mp4: "video/mp4",
    webm: "video/webm",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav",
  }[ext];
  return { bucket, path, type: type ?? "video/mp4" };
}

// ------------------------------------------------------------ clientes
const fold = (s) =>
  String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
const namesOf = (speakers) =>
  Array.isArray(speakers)
    ? speakers
        .filter((s) => typeof s === "string")
        .map(fold)
        .filter(Boolean)
    : [];

/**
 * Participantes da agência (não servem para descobrir o cliente): quem grava,
 * "… da Make Vendas", o próprio bot e anotadores.
 */
export function staffMatcher(emails) {
  const people = [...new Set(emails)]
    .map((e) => fold(String(e).split("@")[0].replace(/[._]/g, " ")))
    .filter(Boolean)
    .map((n) => n.split(" "));
  return (name) => {
    if (/\b(make|mavi|mav ai|notetaker|fireflies|read\.ai|tldv)\b/.test(name))
      return true;
    const parts = name.split(" ");
    return people.some(
      (p) =>
        p[0] === parts[0] &&
        (p.length === 1 || parts.includes(p[p.length - 1])),
    );
  };
}

/**
 * Cliente de cada reunião: o customer_id; sem ele, o cliente das outras
 * reuniões com o mesmo link do Meet (peso 3) ou os mesmos participantes
 * externos (peso 1) — quando um cliente tem ao menos o dobro dos votos do
 * segundo.
 */
export function resolveClients(meetings) {
  const staff = staffMatcher(meetings.map((m) => m.user_email));
  const byName = new Map();
  const byLink = new Map();
  const vote = (map, key, client) => {
    const counts = map.get(key) ?? new Map();
    counts.set(client, (counts.get(client) ?? 0) + 1);
    map.set(key, counts);
  };
  for (const m of meetings) {
    if (!m.customer || m.customer === "0") continue;
    if (m.link) vote(byLink, m.link, m.customer);
    if (m.transcribed)
      for (const n of namesOf(m.speakers))
        if (!staff(n)) vote(byName, n, m.customer);
  }
  const result = new Map();
  for (const m of meetings) {
    if (m.customer && m.customer !== "0") {
      result.set(m.bot, { customer: m.customer, how: "customer_id" });
      continue;
    }
    const votes = new Map();
    const add = (counts, weight) => {
      for (const [c, v] of counts ?? [])
        votes.set(c, (votes.get(c) ?? 0) + v * weight);
    };
    if (m.link) add(byLink.get(m.link), 3);
    for (const n of namesOf(m.speakers)) if (!staff(n)) add(byName.get(n), 1);
    const ranked = [...votes].sort((a, b) => b[1] - a[1]);
    if (
      ranked.length &&
      (ranked.length === 1 || ranked[0][1] >= ranked[1][1] * 2)
    )
      result.set(m.bot, { customer: ranked[0][0], how: "participantes" });
  }
  return result;
}

// ------------------------------------------------------------ GCS
/** Os objetos (nome → tamanho) dos buckets de vídeo, só leitura. */
export async function listVideoObjects(credentials, fetchImpl = fetch) {
  const b64 = (o) =>
    Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString(
      "base64url",
    );
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/devstorage.read_only",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3000,
  })}`;
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(unsigned), credentials.private_key)
    .toString("base64url");
  const token = await (
    await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${unsigned}.${signature}`,
    })
  ).json();
  if (!token.access_token)
    throw new UsageError("As credenciais do GCS foram recusadas.");
  const objects = new Map();
  for (const bucket of VIDEO_BUCKETS) {
    let page = "";
    do {
      const url =
        `https://storage.googleapis.com/storage/v1/b/${bucket}/o?maxResults=1000&fields=nextPageToken,items(name,size)` +
        (page ? `&pageToken=${encodeURIComponent(page)}` : "");
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      if (!res.ok)
        throw new UsageError(
          `Não consegui listar o bucket ${bucket} (${res.status}).`,
        );
      const body = await res.json();
      for (const item of body.items ?? [])
        objects.set(`${bucket}/${item.name}`, Number(item.size));
      page = body.nextPageToken;
    } while (page);
  }
  return objects;
}

// ------------------------------------------------------------ SQL
const sqlText = (v) => (v == null || v === "" ? "null" : sqlString(v));
const sqlArray = (list) =>
  list.length
    ? `array[${list.map(sqlString).join(",")}]::text[]`
    : `'{}'::text[]`;
const sqlJson = (v) => `${sqlString(JSON.stringify(v))}::jsonb`;
const sqlNum = (v) => (Number.isFinite(v) ? String(v) : "null");

/** Uma reunião pronta para o SQL (ou null quando não entra). */
export function buildRecording(meeting, transcription, client, videos) {
  const transcript = normalizeTranscript(
    parseJson(transcription.original_transcript),
  );
  const summary = normalizeSummary(transcription.summary);
  if (!transcript.segments.length && !summary.overview) return null;
  const video = videoLocation(transcription.video_record);
  const size =
    video && videos ? videos.get(`${video.bucket}/${video.path}`) : undefined;
  const keepVideo = video && (!videos || size !== undefined);
  const lastEnd = Math.max(0, ...transcript.segments.map((s) => s[1] ?? 0));
  const minutes = Number(meeting.duration);
  const attendees = parseJson(meeting.employees_attendees);
  const speakers = parseJson(transcription.speakers);
  return {
    source_id: meeting.bot_id,
    customer: client.customer,
    how: client.how,
    title: clean(meeting.title).slice(0, 300),
    recorded_at: meeting.created_at,
    duration_seconds:
      lastEnd > 0
        ? Math.round(lastEnd)
        : minutes > 0
          ? Math.round(minutes * 60)
          : null,
    recorded_by_email: clean(meeting.user_email).toLowerCase(),
    attendees: Array.isArray(attendees)
      ? attendees
          .filter((a) => typeof a === "string")
          .map((a) => a.trim().toLowerCase())
      : [],
    speakers: Array.isArray(speakers)
      ? speakers
          .filter((s) => typeof s === "string")
          .map(clean)
          .filter(Boolean)
      : [],
    meet_link: clean(meeting.link) || null,
    video: keepVideo ? { ...video, bytes: size ?? null } : null,
    videoMissing: !!video && !keepVideo,
    summary,
    cost: Number(meeting.cost) > 0 ? Number(meeting.cost) : null,
    transcript,
  };
}

export function renderRecordingsSql(company, recordings, stats) {
  const rows = recordings.map(
    (r) =>
      ` (${[
        sqlString(r.source_id),
        sqlString(r.customer),
        sqlString(r.title),
        sqlString(r.recorded_at),
        sqlNum(r.duration_seconds),
        sqlString(r.recorded_by_email),
        sqlArray(r.attendees),
        sqlArray(r.speakers),
        sqlText(r.meet_link),
        sqlText(r.video?.bucket),
        sqlText(r.video?.path),
        sqlText(r.video?.type),
        sqlNum(r.video?.bytes),
        sqlJson(r.summary),
        sqlNum(r.cost),
      ].join(", ")})`,
  );
  return `-- Drive › Gravações da MAVI: reuniões do gravador antigo trazidas para o MAVI.
-- Gerado por scripts/import-meeting-recordings.mjs em ${new Date().toISOString()}.
-- ${stats}
-- No pgAdmin: Query Tool → abrir este arquivo → Execute script (F5). Depois,
-- as partes 02-transcricoes-*.sql, em ordem. Rodar de novo não duplica nada.
begin;
create temporary table maso_meetings (source_id text primary key, customer text not null, title text,
 recorded_at timestamptz, duration_seconds integer, recorded_by_email text, attendees text[], speakers text[],
 meet_link text, video_bucket text, video_path text, video_type text, video_bytes bigint, summary jsonb, cost numeric
) on commit drop;
insert into maso_meetings values
${rows.join(",\n")};

do $$ declare missing integer; added integer; begin
 select count(*) into missing from maso_meetings m
  where not exists (select 1 from public.clients c where c.company_id = ${sqlString(company)} and c.name = m.customer);
 insert into public.meeting_recordings(company_id, client_id, source_id, title, recorded_at, duration_seconds,
  recorded_by_email, attendees, speakers, meet_link, video_bucket, video_path, video_type, video_bytes, summary, cost)
 select ${sqlString(company)}, c.id, m.source_id, coalesce(m.title, ''), m.recorded_at, m.duration_seconds,
  coalesce(m.recorded_by_email, ''), m.attendees, m.speakers, m.meet_link, m.video_bucket, m.video_path, m.video_type,
  m.video_bytes, coalesce(m.summary, '{}'), m.cost
 from maso_meetings m
 join lateral (select c.id from public.clients c where c.company_id = ${sqlString(company)} and c.name = m.customer
  order by c.archived, c.created_at limit 1) c on true
 on conflict (company_id, source_id) do nothing;
 get diagnostics added = row_count;
 raise notice 'Gravações novas: %; sem cliente com esse id no MAVI: %', added, missing;
end $$;
commit;
`;
}

/** Transcrições de várias reuniões (a gravação precisa existir: 01-gravacoes.sql). */
export function renderTranscriptsSql(company, recordings, part, parts) {
  const rows = recordings.map(
    (r) =>
      ` (${sqlString(r.source_id)}, ${sqlArray(r.transcript.speakers)}, ${sqlJson(r.transcript.segments)})`,
  );
  return `-- Drive › Gravações da MAVI: transcrições, parte ${part} de ${parts}.
-- Rode depois de 01-gravacoes.sql. Rodar de novo não duplica nada.
begin;
insert into public.meeting_transcripts(recording_id, company_id, speakers, segments)
select r.id, r.company_id, v.speakers, v.segments
from (values
${rows.join(",\n")}
) v(source_id, speakers, segments)
join public.meeting_recordings r on r.company_id = ${sqlString(company)} and r.source_id = v.source_id
on conflict (recording_id) do nothing;
commit;
`;
}

// ------------------------------------------------------------ CLI
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    out[key] = argv[++i];
  }
  return out;
}

async function main(argv) {
  const a = args(argv);
  if (!a.dir || !a.company || !a.out) throw new UsageError(USAGE);
  if (!UUID.test(a.company))
    throw new UsageError("--company precisa ser o uuid da empresa.");
  const dir = resolve(a.dir.replace(/^~/, process.env.HOME ?? "~"));
  const out = resolve(a.out);
  await mkdir(out, { recursive: true });

  const { rows } = parseInsertRows(
    await readFile(join(dir, "meet_record_rows.sql"), "utf8"),
  );
  console.log(`Reuniões agendadas: ${rows.length}`);

  // 1ª passada: quem tem transcrição e quem participou (para achar o cliente).
  const transcribed = new Map();
  for await (const t of copyRows(
    join(dir, "meet_record_transcription.sql"),
    "meet_record_transcription",
  ))
    transcribed.set(
      unescapeCopy(t.bot_id),
      parseJson(unescapeCopy(t.speakers)),
    );
  const meetings = rows.map((m) => ({
    bot: m.bot_id,
    user_email: m.user_email ?? "",
    customer: m.customer_id,
    link: m.link,
    transcribed: transcribed.has(m.bot_id),
    speakers: transcribed.get(m.bot_id),
  }));
  const clients = resolveClients(meetings);
  const meetingByBot = new Map(rows.map((m) => [m.bot_id, m]));

  let videos = null;
  const credentialsFile = a.credentials ?? "gcs-credentials.json";
  try {
    videos = await listVideoObjects(
      JSON.parse(await readFile(resolve(credentialsFile), "utf8")),
    );
    console.log(`Objetos nos buckets de vídeo: ${videos.size}`);
  } catch (e) {
    if (a.credentials) throw e;
    console.warn(
      `Sem ${credentialsFile}: os links de vídeo entram sem conferir se o arquivo ainda existe.`,
    );
  }

  // 2ª passada: normaliza e escreve as partes das transcrições.
  const recordings = [];
  const skipped = { sem_cliente: 0, vazia: 0, sem_agenda: 0 };
  let batch = [];
  let batchBytes = 0;
  const partFiles = [];
  const flushPart = async () => {
    if (!batch.length) return;
    partFiles.push(batch);
    batch = [];
    batchBytes = 0;
  };
  for await (const raw of copyRows(
    join(dir, "meet_record_transcription.sql"),
    "meet_record_transcription",
  )) {
    const t = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, unescapeCopy(v)]),
    );
    const meeting = meetingByBot.get(t.bot_id);
    if (!meeting) {
      skipped.sem_agenda++;
      continue;
    }
    const client = clients.get(t.bot_id);
    if (!client) {
      skipped.sem_cliente++;
      continue;
    }
    const r = buildRecording(meeting, t, client, videos);
    if (!r) {
      skipped.vazia++;
      continue;
    }
    // Só o necessário fica na memória; a transcrição vai para a parte.
    const size = JSON.stringify(r.transcript.segments).length;
    if (batchBytes + size > PART_BYTES) await flushPart();
    batch.push({ source_id: r.source_id, transcript: r.transcript });
    batchBytes += size;
    recordings.push({ ...r, transcript: undefined });
  }
  await flushPart();

  const byHow = recordings.reduce(
    (acc, r) => ((acc[r.how] = (acc[r.how] ?? 0) + 1), acc),
    {},
  );
  const withVideo = recordings.filter((r) => r.video).length;
  const stats = `${recordings.length} reuniões (${byHow.customer_id ?? 0} pelo customer_id, ${byHow.participantes ?? 0} pelos participantes/link), ${withVideo} com vídeo, ${recordings.filter((r) => r.videoMissing).length} com o vídeo já apagado do bucket. Fora: ${skipped.sem_cliente} sem cliente, ${skipped.vazia} vazias.`;
  await writeFile(
    join(out, "01-gravacoes.sql"),
    renderRecordingsSql(a.company, recordings, stats),
  );
  for (let i = 0; i < partFiles.length; i++)
    await writeFile(
      join(out, `02-transcricoes-parte-${String(i + 1).padStart(2, "0")}.sql`),
      renderTranscriptsSql(a.company, partFiles[i], i + 1, partFiles.length),
    );
  console.log(stats);
  console.log(
    `Arquivos em ${out}: 01-gravacoes.sql e ${partFiles.length} parte(s) de transcrições.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof UsageError ? e.message : e);
    process.exit(1);
  });
