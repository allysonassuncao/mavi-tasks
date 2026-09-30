// Drive › Gravações da MAVI › Link público (migration
// 20270104090000_meeting_public_links): quem cria e altera, o que a página
// pública recebe (só o que o link mostra), validade, senha com bloqueio,
// vídeo e download, contagem e histórico do Drive.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, admin, member, colleague, outsider] = [1, 10, 11, 12, 13].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, member, colleague, outsider],
]);
await db.query(`insert into companies(id,name) values($1,'Agência A')`, [A]);
await db.query(
  `insert into memberships(company_id,user_id,name,role,active) values
   ($1,$2,'Ana Admin','admin',true),($1,$3,'Bruno Equipe','member',true),
   ($1,$4,'Clara Equipe','member',true),($1,$5,'Davi Fora','member',true)`,
  [A, admin, member, colleague, outsider],
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
const team = await rpc("create_team", [A, "Equipe A", [member, colleague]]);
const client = await rpc("create_client", [A, "4282", "", [team]]);
const summary = {
  title: "Alinhamento de campanha",
  overview: "Falamos da verba.",
  notes: [{ title: "Verba", description: "Sobe em outubro." }],
  todo: [{ owner: "Ana", description: "Enviar proposta" }],
  action_items: [{ owner: "Bruno", description: "Ajustar anúncio" }],
  keywords: ["verba"],
};
const [{ id: recording }] = await sql(
  `insert into meeting_recordings(company_id,client_id,source_id,recorded_at,title,recorded_by_email,attendees,speakers,
    video_bucket,video_path,video_type,summary,duration_seconds)
   values($1,$2,'bot-1','2026-09-01T14:00:00Z','R2 4282','ana@agencia.com',
    '{ana@agencia.com}','{Cliente,Ana}','meet_recording','k/reuniao.mp4','video/mp4',$3,1800) returning id`,
  [A, client, JSON.stringify(summary)],
);
await sql(
  `insert into meeting_transcripts(recording_id,company_id,speakers,segments)
   values($1,$2,'{Cliente,Ana}',$3)`,
  [
    recording,
    A,
    JSON.stringify([
      [0, 4, 0, "Bom dia"],
      [5, 9, 1, "Vamos falar da verba"],
    ]),
  ],
);
const [{ id: noVideo }] = await sql(
  `insert into meeting_recordings(company_id,client_id,source_id,recorded_at,summary)
   values($1,$2,'bot-2',now(),'{}') returning id`,
  [A, client],
);
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const share = (user, rec, opts = {}) =>
  as(user).then(() =>
    rpc("set_meeting_share", [
      rec,
      opts.video ?? true,
      opts.transcript ?? true,
      opts.summary ?? true,
      opts.download ?? false,
      opts.expires ?? null,
      opts.password ?? null,
      opts.keep ?? true,
    ]),
  );
const audit = async (action) =>
  (
    await sql(
      `select actor_id, details from drive_audit where action=$1 order by id`,
      [action],
    )
  ).map((r) => ({ actor: r.actor_id, ...r.details }));
const publicView = async (token, password = null, opened = false) => {
  await as(null);
  return rpc("meeting_public", [token, password, opened]);
};

// ------------------------------------------------------------ gerenciar
await check("a tabela não é lida direto por ninguém", async () => {
  for (const user of [admin, member, null]) {
    await as(user);
    await assert.rejects(
      () => db.query(`select token from meeting_shares`),
      /permission denied/,
    );
  }
});

let token;
await check(
  "quem vê o cliente cria o link; quem é de fora não vê nem cria",
  async () => {
    await as(member);
    assert.equal(await rpc("meeting_share", [recording]), null);
    const s = await share(member, recording);
    assert.match(s.token, /^[0-9a-f]{64}$/);
    assert.equal(s.can_manage, true);
    assert.equal(s.has_password, false);
    assert.equal(s.opens, 0);
    token = s.token;
    await as(outsider);
    await assert.rejects(
      () => rpc("meeting_share", [recording]),
      /Sem acesso a esta gravação/,
    );
    await assert.rejects(
      () => share(outsider, recording),
      /Sem acesso a esta gravação/,
    );
    await as(null);
    await assert.rejects(
      () => rpc("meeting_share", [recording]),
      /permission denied/,
    );
    const [log] = await audit("recording_shared");
    assert.equal(log.actor, member);
    assert.equal(log.created, true);
    assert.equal(log.recording, recording);
  },
);

await check(
  "só quem criou ou um líder altera e desativa; os outros só veem",
  async () => {
    await as(colleague);
    const seen = await rpc("meeting_share", [recording]);
    assert.equal(seen.token, token);
    assert.equal(seen.can_manage, false);
    await assert.rejects(
      () => share(colleague, recording, { download: true }),
      /Só quem criou o link ou um líder/,
    );
    await as(colleague);
    await assert.rejects(
      () => rpc("delete_meeting_share", [recording]),
      /Só quem criou o link ou um líder/,
    );
    const byAdmin = await share(admin, recording, { download: true });
    assert.equal(byAdmin.token, token, "mudar as opções mantém o endereço");
    assert.equal(byAdmin.allow_download, true);
  },
);

await check("precisa mostrar algo e a validade precisa ser futura", async () => {
  await assert.rejects(
    () =>
      share(member, recording, {
        video: false,
        transcript: false,
        summary: false,
      }),
    /Escolha o que o link mostra/,
  );
  await assert.rejects(
    () => share(member, recording, { expires: "2020-01-01T00:00:00Z" }),
    /validade no futuro/,
  );
  await assert.rejects(
    () => share(member, recording, { password: "abc", keep: false }),
    /de 4 a 72 caracteres/,
  );
});

await check("o selo da lista mostra as gravações com link", async () => {
  await as(member);
  const list = await rows("meeting_shared_recordings", [A, client]);
  assert.deepEqual(
    list.map((r) => r.recording_id),
    [recording],
  );
  await as(outsider);
  assert.equal((await rows("meeting_shared_recordings", [A, client])).length, 0);
});

// ------------------------------------------------------------ página pública
await check(
  "a página recebe só o que o link mostra, sem próximos passos nem e-mails",
  async () => {
    const v = await publicView(token);
    assert.equal(v.status, "ok");
    assert.equal(v.company, "Agência A");
    assert.equal(v.title, "Alinhamento de campanha");
    assert.equal(v.video, true);
    assert.equal(v.download, true);
    assert.equal(v.duration_seconds, 1800);
    assert.deepEqual(v.speakers, ["Cliente", "Ana"]);
    assert.equal(v.summary.overview, "Falamos da verba.");
    assert.equal(v.summary.todo, undefined);
    assert.equal(v.summary.action_items, undefined);
    assert.equal(v.transcript.segments.length, 2);
    const text = JSON.stringify(v);
    for (const secret of ["ana@agencia.com", "k/reuniao.mp4", "meet_recording", "Enviar proposta"])
      assert.ok(!text.includes(secret), `não vaza ${secret}`);

    await share(member, recording, { transcript: false, video: false });
    const onlySummary = await publicView(token);
    assert.equal(onlySummary.transcript, null);
    assert.equal(onlySummary.video, false);
    assert.equal(onlySummary.show_transcript, false);
    await share(member, recording, { summary: false });
    const noSummary = await publicView(token);
    assert.equal(noSummary.summary, null);
    assert.equal(noSummary.transcript.segments.length, 2);
  },
);

await check("token desconhecido ou malformado não abre nada", async () => {
  assert.equal(await publicView("0".repeat(64)), null);
  assert.equal(await publicView("nao-e-token"), null);
});

await check("abrir conta uma vez por visita e entra no histórico", async () => {
  await publicView(token, null, true);
  await publicView(token, null, false);
  await as(member);
  const s = await rpc("meeting_share", [recording]);
  assert.equal(s.opens, 1);
  assert.ok(s.last_opened_at);
  const logs = await audit("recording_public_opened");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].actor, null);
});

await check(
  "vídeo: só com o vídeo no link; baixar só com download liberado, e conta",
  async () => {
    await share(member, recording, { download: false });
    await as(null);
    const [view] = await rows("meeting_public_video", [token, null, false, null]);
    assert.deepEqual(
      [view.bucket, view.path, view.content_type],
      ["meet_recording", "k/reuniao.mp4", "video/mp4"],
    );
    assert.equal(
      (await rows("meeting_public_video", [token, null, true, null])).length,
      0,
    );
    await share(member, recording, { download: true });
    await as(null);
    assert.equal(
      (
        await rows("meeting_public_video", [
          token,
          null,
          true,
          JSON.stringify({ ip: "200.1.1.1" }),
        ])
      ).length,
      1,
    );
    await as(member);
    assert.equal((await rpc("meeting_share", [recording])).downloads, 1);
    const [log] = await audit("recording_public_downloaded");
    assert.equal(log.origin.ip, "200.1.1.1");

    await share(member, recording, { video: false });
    await as(null);
    assert.equal(
      (await rows("meeting_public_video", [token, null, false, null])).length,
      0,
    );
    // Gravação sem vídeo: o link nunca devolve um caminho.
    const other = await share(member, noVideo, { transcript: false });
    const v = await publicView(other.token);
    assert.equal(v.video, false);
    await as(null);
    assert.equal(
      (await rows("meeting_public_video", [other.token, null, false, null]))
        .length,
      0,
    );
  },
);

await check("link vencido não abre, e ampliar a validade reabre", async () => {
  await share(member, recording, { expires: future });
  assert.equal((await publicView(token)).status, "ok");
  await sql(
    `update meeting_shares set expires_at = now() - interval '1 minute' where recording_id=$1`,
    [recording],
  );
  assert.deepEqual(await publicView(token), { status: "expired" });
  await as(null);
  assert.equal(
    (await rows("meeting_public_video", [token, null, false, null])).length,
    0,
  );
  await as(member);
  assert.equal((await rpc("meeting_share", [recording])).expired, true);
  await share(member, recording, { expires: future });
  assert.equal((await publicView(token)).status, "ok");
});

await check(
  "senha: pede, recusa a errada, bloqueia após 10 erros e nunca sai do banco",
  async () => {
    const s = await share(member, recording, {
      password: "segredo1",
      keep: false,
    });
    assert.equal(s.has_password, true);
    assert.ok(!JSON.stringify(s).includes("segredo1"));
    assert.deepEqual(await publicView(token), { status: "password" });
    assert.deepEqual(await publicView(token, "errada"), { status: "wrong" });
    assert.equal((await publicView(token, "segredo1")).status, "ok");
    await as(null);
    assert.equal(
      (await rows("meeting_public_video", [token, "errada", false, null]))
        .length,
      0,
    );
    assert.equal(
      (await rows("meeting_public_video", [token, "segredo1", false, null]))
        .length,
      1,
    );
    // Mudar outras opções mantém a senha.
    const kept = await share(member, recording, { download: true });
    assert.equal(kept.has_password, true);
    for (let i = 0; i < 10; i++) await publicView(token, `x${i}`);
    assert.deepEqual(await publicView(token, "segredo1"), { status: "locked" });
    // Trocar a senha desbloqueia; tirar a senha abre sem ela.
    await share(member, recording, { password: "novasenha", keep: false });
    assert.equal((await publicView(token, "novasenha")).status, "ok");
    const open = await share(member, recording, { keep: false });
    assert.equal(open.has_password, false);
    assert.equal((await publicView(token)).status, "ok");
  },
);

await check(
  "desativar apaga o link para sempre; um novo tem outro endereço",
  async () => {
    await as(member);
    await rpc("delete_meeting_share", [recording]);
    assert.equal(await publicView(token), null);
    await as(member);
    assert.equal(await rpc("meeting_share", [recording]), null);
    const [log] = await audit("recording_unshared");
    assert.equal(log.actor, member);
    const again = await share(member, recording);
    assert.notEqual(again.token, token);
    assert.equal(again.opens, 0);
  },
);

await check("apagar a gravação leva o link junto", async () => {
  const [{ token: t }] = await sql(
    `select token from meeting_shares where recording_id=$1`,
    [noVideo],
  );
  await sql(`delete from meeting_recordings where id=$1`, [noVideo]);
  assert.equal(await publicView(t), null);
});

await db.close();
console.log(`\n${passed} verificações do link público das gravações aprovadas.`);
