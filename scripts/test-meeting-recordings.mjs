// Drive › Gravações da MAVI (migration 20261018090000_meeting_recordings e
// scripts/import-meeting-recordings.mjs): importação do gravador antigo,
// leitura pela regra do Drive, caminho do vídeo fora do alcance, busca com o
// tempo do trecho, comentários e avisos ao vivo.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";
import {
  buildRecording,
  normalizeSummary,
  normalizeTranscript,
  parseInsertRows,
  renderRecordingsSql,
  renderTranscriptsSql,
  resolveClients,
  unescapeCopy,
  videoLocation,
} from "./import-meeting-recordings.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, teamMember, outsider] = [1, 10, 11, 12].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, teamMember, outsider],
]);
await db.query(`insert into companies(id,name) values($1,'Empresa A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Bruno Equipe','member',true),
   ($1,$4,'Carla Fora','member',true)`,
  [A, admin, teamMember, outsider],
);
async function as(user) {
  await db.exec("reset role");
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    user ?? "",
  ]);
  await db.exec(`set role ${user ? "authenticated" : "anon"}`);
}
async function rpc(name, args) {
  return (
    await db.query(
      `select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})) as result`,
      args,
    )
  ).rows[0].result;
}
const rows = async (name, args) =>
  (
    await db.query(
      `select * from public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})`,
      args,
    )
  ).rows;
const sql = async (text, args = []) => {
  await db.exec("reset role");
  return (await db.query(text, args)).rows;
};
let passed = 0;
async function check(title, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${title}`);
  } catch (e) {
    console.error(`FAIL ${title}`);
    throw e;
  }
}

await as(admin);
const team = await rpc("create_team", [A, "Equipe A", [teamMember]]);
const client = await rpc("create_client", [A, "4282", "", [team]]);
await as(admin);
const other = await rpc("create_client", [A, "5000", "", []]);

// ------------------------------------------------------------ importador
await check("lê o INSERT do dump com aspas e null", () => {
  const { table, rows } = parseInsertRows(
    `INSERT INTO "public"."meet_record" ("id", "bot_id", "title") VALUES (1, 'b1', 'R2 d''Ávila'), (2, 'b2', null);`,
  );
  assert.equal(table, "meet_record");
  assert.deepEqual(rows, [
    { id: "1", bot_id: "b1", title: "R2 d'Ávila" },
    { id: "2", bot_id: "b2", title: null },
  ]);
  assert.equal(unescapeCopy("a\\tb\\\\c\\nd"), "a\tb\\c\nd");
  assert.equal(unescapeCopy("\\N"), null);
});

await check("normaliza os três formatos de transcrição", () => {
  const deepgram = normalizeTranscript([
    {
      speaker: 1,
      speaker_name: "Kamilli Abreu",
      start: 5,
      end: 9,
      utterances: [
        { start: 5.004, end: 6.2, transcript: "Bom dia." },
        { start: 6.3, end: 9, transcript: "Tudo bem?" },
      ],
    },
    {
      speaker: 0,
      start: 0,
      end: 4,
      utterances: [{ start: 0, end: 4, transcript: "Oi" }],
    },
  ]);
  assert.deepEqual(deepgram.speakers, ["Kamilli Abreu", "Falante 1"]);
  assert.deepEqual(deepgram.segments[0], [0, 4, 1, "Oi"]);
  assert.deepEqual(deepgram.segments[1], [5, 6.2, 0, "Bom dia."]);

  const recall = normalizeTranscript([
    {
      speaker: "Estevam",
      offset: 1,
      words: [
        { start: 1, end: 1.2, word: "Olá" },
        { start: 1.3, end: 1.5, word: " a" },
        { start: 1.6, end: 1.8, word: " todos" },
        { start: 1.9, end: 2, word: " aqui." },
        { start: 5, end: 5.4, word: " Vamos" },
      ],
    },
  ]);
  assert.deepEqual(recall.segments, [
    [1, 2, 0, "Olá a todos aqui."],
    [5, 5.4, 0, "Vamos"],
  ]);

  const plain = normalizeTranscript(
    JSON.stringify([{ Ana: "oi" }, { Bia: "olá" }]),
  );
  assert.deepEqual(plain.segments, [
    [null, null, 0, "oi"],
    [null, null, 1, "olá"],
  ]);
});

await check(
  "resumo: chaves de sempre, 'to-do' vira todo, texto vira visão geral",
  () => {
    assert.deepEqual(
      normalizeSummary(
        '{"title":"T","to-do":[{"owner":"A","description":"x"}]}',
      ),
      {
        title: "T",
        todo: [{ owner: "A", description: "x" }],
      },
    );
    assert.deepEqual(normalizeSummary("Reunião curta"), {
      overview: "Reunião curta",
    });
  },
);

await check("link do vídeo: só dos buckets do gravador", () => {
  assert.deepEqual(
    videoLocation(
      "https://storage.googleapis.com/download/storage/v1/b/meet_recording/o/ana@x.com%2FR2%20%23mav.mp4?generation=1&alt=media",
    ),
    {
      bucket: "meet_recording",
      path: "ana@x.com/R2 #mav.mp4",
      type: "video/mp4",
    },
  );
  assert.equal(
    videoLocation("https://storage.googleapis.com/outro_bucket/a.mp4"),
    null,
  );
  assert.equal(videoLocation("https://example.com/a.mp4"), null);
});

await check(
  "sem customer_id: cliente pelos participantes externos ou pelo link",
  () => {
    const found = resolveClients([
      {
        bot: "a",
        user_email: "kamilli.abreu@make.com",
        customer: "4282",
        link: "L1",
        transcribed: true,
        speakers: ["Kamilli Abreu", "Leandro Lago"],
      },
      {
        bot: "b",
        user_email: "kamilli.abreu@make.com",
        customer: "0",
        link: null,
        transcribed: true,
        speakers: ["Kamilli Abreu", "Leandro Lago"],
      },
      {
        bot: "c",
        user_email: "kamilli.abreu@make.com",
        customer: "0",
        link: "L1",
        transcribed: true,
        speakers: [],
      },
      // Só a pessoa da agência em comum: não vale.
      {
        bot: "d",
        user_email: "kamilli.abreu@make.com",
        customer: "0",
        link: null,
        transcribed: true,
        speakers: ["Kamilli Abreu"],
      },
    ]);
    assert.equal(found.get("a").how, "customer_id");
    assert.equal(found.get("b").customer, "4282");
    assert.equal(found.get("c").customer, "4282");
    assert.equal(found.get("d"), undefined);
  },
);

const meeting = (bot, customer) => ({
  bot_id: bot,
  user_email: "kamilli.abreu@makevendas.com.br",
  created_at: "2026-09-01 13:00:00+00",
  customer_id: customer,
  title: "R2 4282",
  employees_attendees: '["aline.romera@makevendas.com.br"]',
  link: "https://meet.google.com/abc",
  cost: "0.3",
  duration: "27",
});
const transcription = (text) => ({
  speakers: '["Kamilli Abreu","Leandro Lago"]',
  video_record:
    "https://storage.googleapis.com/download/storage/v1/b/meet_recording/o/k%2Freuniao.mp4?alt=media",
  original_transcript: JSON.stringify([
    {
      speaker: 0,
      speaker_name: "Leandro Lago",
      utterances: [
        {
          start: 0,
          end: 4,
          transcript: "Precisamos falar do orçamento da campanha.",
        },
        { start: 4, end: 9, transcript: text },
      ],
    },
  ]),
  summary: JSON.stringify({
    title: "Alinhamento de campanha",
    overview: "Conversa sobre verba.",
    action_items: [
      {
        owner: "Kamilli",
        description: "Enviar proposta",
        deadline: "Até 05/09",
      },
    ],
  }),
});
const videos = new Map([["meet_recording/k/reuniao.mp4", 1234]]);
const one = buildRecording(
  meeting("bot-1", "4282"),
  transcription("E o criativo novo entra semana que vem."),
  { customer: "4282", how: "customer_id" },
  videos,
);
const gone = buildRecording(
  meeting("bot-2", "4282"),
  {
    ...transcription("Outra conversa."),
    video_record: "https://storage.googleapis.com/meet_recording/k/apagado.mp4",
  },
  { customer: "4282", how: "customer_id" },
  videos,
);
const unknown = buildRecording(
  meeting("bot-3", "9999"),
  transcription("Sem cliente no MAVI."),
  { customer: "9999", how: "customer_id" },
  videos,
);

await check(
  "vídeo apagado do bucket entra sem vídeo; duração pelo fim da fala",
  () => {
    assert.equal(one.video.bytes, 1234);
    assert.equal(one.duration_seconds, 9);
    assert.equal(gone.video, null);
    assert.equal(gone.videoMissing, true);
  },
);

await check(
  "os arquivos SQL importam e não duplicam ao rodar de novo",
  async () => {
    const recordings = [one, gone, unknown];
    for (let round = 0; round < 2; round++) {
      await db.exec("reset role");
      await db.exec(renderRecordingsSql(A, recordings, "teste"));
      await db.exec(renderTranscriptsSql(A, recordings, 1, 1));
    }
    const saved = await sql(
      `select r.source_id, r.client_id, r.video_path, t.timed, cardinality(t.speakers) speakers
     from meeting_recordings r join meeting_transcripts t on t.recording_id = r.id order by r.source_id`,
    );
    assert.deepEqual(
      saved.map((r) => [
        r.source_id,
        r.client_id,
        r.video_path,
        r.timed,
        r.speakers,
      ]),
      [
        ["bot-1", client, "k/reuniao.mp4", true, 1],
        ["bot-2", client, null, true, 1],
      ],
    );
  },
);

const [{ id: recording }] = await sql(
  `select id from meeting_recordings where source_id='bot-1'`,
);
const [{ id: noVideo }] = await sql(
  `select id from meeting_recordings where source_id='bot-2'`,
);

// ------------------------------------------------------------ acesso
const sees = async (user, table, where, args) => {
  await as(user);
  return (await db.query(`select 1 from ${table} where ${where}`, args)).rows
    .length;
};
await check(
  "equipe do cliente e líderes veem gravação e transcrição; quem é de fora não",
  async () => {
    for (const user of [admin, teamMember]) {
      assert.equal(
        await sees(user, "meeting_recordings", "id=$1", [recording]),
        1,
      );
      assert.equal(
        await sees(user, "meeting_transcripts", "recording_id=$1", [recording]),
        1,
      );
    }
    assert.equal(
      await sees(outsider, "meeting_recordings", "id=$1", [recording]),
      0,
    );
    assert.equal(
      await sees(outsider, "meeting_transcripts", "recording_id=$1", [
        recording,
      ]),
      0,
    );
  },
);

await check("o caminho do vídeo não sai para o navegador", async () => {
  await as(teamMember);
  await assert.rejects(
    () => db.query(`select video_path from meeting_recordings`),
    /permission denied/,
  );
  await assert.rejects(
    () => db.query(`select search from meeting_transcripts`),
    /permission denied/,
  );
  await assert.rejects(
    () =>
      db.query(
        `insert into meeting_recordings(company_id,client_id,source_id,recorded_at) values($1,$2,'x',now())`,
        [A, client],
      ),
    /permission denied/,
  );
});

await check(
  "vídeo: só com acesso ao cliente, e a abertura entra no histórico do Drive",
  async () => {
    await as(teamMember);
    const [target] = await rows("meeting_video_target", [recording, null]);
    assert.deepEqual(
      {
        bucket: target.bucket,
        path: target.path,
        type: target.content_type,
        title: target.title,
      },
      {
        bucket: "meet_recording",
        path: "k/reuniao.mp4",
        type: "video/mp4",
        title: "Alinhamento de campanha",
      },
    );
    await as(outsider);
    await assert.rejects(
      () => rows("meeting_video_target", [recording, null]),
      /Sem acesso/,
    );
    await as(teamMember);
    await assert.rejects(
      () => rows("meeting_video_target", [noVideo, null]),
      /não está disponível/,
    );
    const [audit] = await sql(
      `select action, item_name, client_id, actor_id from drive_audit where action='recording_view'`,
    );
    assert.deepEqual(audit, {
      action: "recording_view",
      item_name: "Alinhamento de campanha",
      client_id: client,
      actor_id: teamMember,
    });
  },
);

await check("busca no histórico devolve o trecho com o tempo", async () => {
  await as(teamMember);
  const hits = await rows("search_meeting_segments", [
    A,
    client,
    "criativo",
    10,
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].recording_id, recording);
  assert.equal(Number(hits[0].start_seconds), 4);
  assert.equal(hits[0].speaker, 0);
  assert.match(hits[0].text, /criativo novo/);
  // Plural e acento como na língua (radical do português).
  assert.equal(
    (await rows("search_meeting_segments", [A, client, "campanhas", 10]))
      .length,
    2,
  );
  await as(outsider);
  assert.equal(
    (await rows("search_meeting_segments", [A, client, "criativo", 10])).length,
    0,
  );
  await as(teamMember);
  assert.equal(
    (await rows("search_meeting_segments", [A, other, "criativo", 10])).length,
    0,
  );
});

await check(
  "comentário no minuto: quem vê comenta, só autor ou líder apaga, e avisa ao vivo",
  async () => {
    await sql(`delete from realtime.messages`);
    await as(teamMember);
    const comment = await rpc("add_meeting_comment", [
      recording,
      4.567,
      "  Ponto importante  ",
    ]);
    const [saved] = await sql(
      `select at_seconds, body, author_id from meeting_comments where id=$1`,
      [comment],
    );
    assert.deepEqual(
      [Number(saved.at_seconds), saved.body, saved.author_id],
      [4.57, "Ponto importante", teamMember],
    );
    await as(outsider);
    await assert.rejects(
      () => rpc("add_meeting_comment", [recording, 1, "oi"]),
      /Sem acesso/,
    );
    await assert.rejects(
      () => rpc("delete_meeting_comment", [comment]),
      /Só quem escreveu/,
    );
    const [notice] = await sql(`select topic, payload from realtime.messages`);
    assert.equal(notice.topic, `mavi:company:${A}`);
    assert.deepEqual(notice.payload, {
      kind: "meeting",
      table: "meeting_comments",
      recording,
    });
    await as(admin);
    await rpc("delete_meeting_comment", [comment]);
    assert.equal((await sql(`select 1 from meeting_comments`)).length, 0);
  },
);

await check("gravações novas: um aviso por cliente em cada envio", async () => {
  await sql(`delete from realtime.messages`);
  await sql(
    `insert into meeting_recordings(company_id,client_id,source_id,recorded_at) values ($1,$2,'n1',now()),($1,$2,'n2',now())`,
    [A, client],
  );
  const notices = await sql(`select payload from realtime.messages`);
  assert.deepEqual(
    notices.map((n) => n.payload),
    [{ kind: "meeting", table: "meeting_recordings", client }],
  );
});

await check(
  "custo da IA: só registra para quem vê o cliente; só líderes leem",
  async () => {
    await as(teamMember);
    await rpc("meeting_log_usage", [
      client,
      recording,
      "ask",
      "claude-sonnet-5",
      1000,
      200,
      0,
      0,
      0.004,
    ]);
    await assert.rejects(
      () =>
        rpc("meeting_log_usage", [
          other,
          null,
          "ask_client",
          "m",
          1,
          1,
          0,
          0,
          0.1,
        ]),
      /Sem permissão/,
    );
    assert.equal(
      (await db.query(`select 1 from meeting_ai_usage`)).rows.length,
      0,
    );
    await as(admin);
    assert.equal(
      (await db.query(`select 1 from meeting_ai_usage`)).rows.length,
      1,
    );
  },
);

await db.close();
console.log(`\n${passed} verificações das gravações aprovadas.`);
