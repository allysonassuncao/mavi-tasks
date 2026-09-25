// Campanhas (migration 20260930090000_ad_campaigns): campaigns belong to a
// contracted product and go through cycles; the current cycle only changes
// by hand. The module is exclusive to the company's administrators.
import assert from "node:assert/strict";
import { createTestDatabase } from "./database-fixture.mjs";

const db = await createTestDatabase();
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, admin, admin2, manager, trafego, outsider] = [
  1, 2, 10, 11, 12, 13, 14,
].map(uid);
await db.query(`insert into auth.users select unnest($1::uuid[])`, [
  [admin, admin2, manager, trafego, outsider],
]);
await db.query(
  `insert into companies(id,name) values($1,'Make'),($2,'Outra agência')`,
  [A, B],
);
await db.query(
  `insert into memberships(company_id,user_id,name,role) values
   ($1,$3,'Ana Admin','admin'),($1,$4,'Beto Admin','admin'),
   ($1,$5,'Gabi Gestora','manager'),($1,$6,'Tiago Tráfego','member'),
   ($2,$7,'Fora','admin')`,
  [A, B, admin, admin2, manager, trafego, outsider],
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
const sql = async (text, args = []) => {
  await db.exec("reset role");
  return (await db.query(text, args)).rows;
};
const visible = async (user, table) => {
  await as(user);
  return (await db.query(`select * from ${table}`)).rows;
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

// Tiago's team (Tráfego) serves the client, but he is a collaborator: he
// neither sees nor changes campaigns. Gabi is a manager: since migration
// 20261009090000_ad_campaigns_leaders she uses the module like an admin.
await as(admin);
const team = await rpc("create_team", [A, "Tráfego", [trafego]]);
const client = await rpc("create_client", [A, "Vittalium", ""]);
const otherClient = await rpc("create_client", [A, "Outro cliente", ""]);
const makeAds = await rpc("create_product", [A, "Make Ads"]);
const contract = await rpc("create_contract", [
  A,
  client,
  makeAds,
  "Make Ads",
  team,
]);
const otherContract = await rpc("create_contract", [
  A,
  otherClient,
  makeAds,
  "Make Ads",
  team,
]);

const campaign = (user, args = {}) =>
  as(user).then(() =>
    rpc("create_ad_campaign", [
      A,
      args.contract ?? contract,
      args.name ?? "Motion - Meta - Mensagem",
      args.platform ?? "meta",
      args.briefing ?? "",
      args.plan ?? "",
      args.notes ?? "",
    ]),
  );
const cycle = (user, id, c = {}) =>
  as(user).then(() =>
    rpc("create_ad_cycle", [
      id,
      c.competence ?? c.start ?? "2026-08-31",
      c.start ?? "2026-08-31",
      c.end ?? "2026-09-30",
      c.objective ?? "message",
      c.goal ?? 100,
      c.budget ?? 3000,
      c.m ?? null,
      c.destination ?? "external_page",
      c.pages ?? [],
      c.niche ?? "Suplementos",
      JSON.stringify(c.links ?? [{ account_id: "act_1", campaign_id: "c1" }]),
      c.current ?? false,
    ]),
  );

let main, current;

await check(
  "administrador cadastra campanha, inativa e sem ciclo",
  async () => {
    main = await campaign(admin);
    const [row] = await sql("select * from ad_campaigns where id=$1", [main]);
    assert.equal(row.status, "inactive");
    assert.equal(row.current_cycle_id, null);
    assert.equal(row.contract_id, contract);
    assert.equal(row.created_by, admin);
    const events = await sql(
      "select action from ad_campaign_events where campaign_id=$1",
      [main],
    );
    assert.deepEqual(
      events.map((e) => e.action),
      ["created"],
    );
  },
);

await check("só administradores e gestores da empresa cadastram", async () => {
  await campaign(admin2, { name: "Google - Lead" });
  for (const user of [trafego, outsider])
    await assert.rejects(campaign(user), /exclusivo de administradores/);
  // Without permission, nothing is revealed about the contract.
  await assert.rejects(
    campaign(trafego, { contract: uid(999) }),
    /exclusivo de administradores/,
  );
  await assert.rejects(
    campaign(admin, { contract: uid(999) }),
    /Produto contratado inválido/,
  );
});

await check("links precisam começar com http(s)", async () => {
  await assert.rejects(
    campaign(admin, { briefing: "drive.google.com/x" }),
    /briefing precisa começar/,
  );
  await assert.rejects(
    campaign(admin, { plan: "ftp://plano" }),
    /plano de mídia precisa começar/,
  );
});

await check("só administradores e gestores da empresa leem", async () => {
  assert.equal((await visible(admin, "ad_campaigns")).length, 2);
  assert.equal((await visible(admin2, "ad_campaigns")).length, 2);
  for (const user of [trafego, outsider])
    assert.equal((await visible(user, "ad_campaigns")).length, 0);
  await as(null);
  await assert.rejects(
    db.query("select * from ad_campaigns"),
    /permission denied/,
  );
});

await check("ninguém escreve direto nas tabelas", async () => {
  await as(admin);
  await assert.rejects(
    db.query(
      `insert into ad_campaigns(company_id,contract_id,name,platform) values($1,$2,'X','meta')`,
      [A, contract],
    ),
    /permission denied/,
  );
  await assert.rejects(
    db.query(`update ad_cycles set budget=0`),
    /permission denied/,
  );
});

await check("ciclo novo: vínculos gravados; atual só se pedido", async () => {
  await assert.rejects(cycle(trafego, main), /Sem permissão/);
  const first = await cycle(admin, main);
  const [row] = await sql("select * from ad_campaigns where id=$1", [main]);
  assert.equal(row.current_cycle_id, null);
  const links = await sql(
    "select account_id,external_campaign_id from ad_cycle_links where cycle_id=$1",
    [first],
  );
  assert.deepEqual(links, [
    // Meta accounts are kept without the "act_" prefix.
    { account_id: "1", external_campaign_id: "c1" },
  ]);
  const [y] = await sql(
    "select competence_month::text,multiplier::float,budget::float from ad_cycles where id=$1",
    [first],
  );
  assert.deepEqual(y, {
    competence_month: "2026-08-01",
    multiplier: 1,
    budget: 3000,
  });
  current = first;
});

await check("ativar exige ciclo atual e motivo", async () => {
  await as(trafego);
  await assert.rejects(
    rpc("set_ad_campaign_current_cycle", [main, current]),
    /Sem permissão/,
  );
  await as(admin);
  await assert.rejects(
    rpc("set_ad_campaign_status", [main, "active", "Começou"]),
    /Defina o ciclo atual/,
  );
  await rpc("set_ad_campaign_current_cycle", [main, current]);
  await assert.rejects(
    rpc("set_ad_campaign_status", [main, "active", ""]),
    /Informe o motivo/,
  );
  await as(trafego);
  await assert.rejects(
    rpc("set_ad_campaign_status", [main, "active", "Ciclo de setembro"]),
    /Sem permissão/,
  );
  await as(admin);
  await rpc("set_ad_campaign_status", [main, "active", "Ciclo de setembro"]);
  await assert.rejects(
    rpc("set_ad_campaign_status", [main, "active", "De novo"]),
    /já está ativa/,
  );
  const [row] = await sql("select status from ad_campaigns where id=$1", [
    main,
  ]);
  assert.equal(row.status, "active");
});

await check(
  "períodos de ciclos da mesma campanha não se sobrepõem",
  async () => {
    await assert.rejects(
      cycle(admin, main, { start: "2026-09-30", end: "2026-10-29" }),
      /conflita com o ciclo de 31\/08\/2026 a 30\/09\/2026/,
    );
    await assert.rejects(
      cycle(admin, main, { start: "2026-10-10", end: "2026-10-01" }),
      /término precisa ser igual ou posterior/,
    );
    await assert.rejects(
      cycle(admin, main, {
        start: "2026-10-01",
        end: "2026-10-30",
        destination: "make_landing_page",
      }),
      /página de captura da Make/,
    );
  },
);

await check("sem M informado, o ciclo herda o do anterior", async () => {
  const october = await cycle(admin, main, {
    start: "2026-10-01",
    end: "2026-10-30",
    m: 2.5,
  });
  const november = await cycle(admin2, main, {
    start: "2026-10-31",
    end: "2026-11-29",
  });
  const rows = await sql(
    "select id,multiplier::float from ad_cycles where id=any($1)",
    [[october, november]],
  );
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.multiplier])), {
    [october]: 2.5,
    [november]: 2.5,
  });
});

await check("o ciclo atual não troca sozinho", async () => {
  const [row] = await sql(
    "select current_cycle_id from ad_campaigns where id=$1",
    [main],
  );
  assert.equal(row.current_cycle_id, current);
});

await check("ciclo atual precisa ser da própria campanha", async () => {
  const other = await campaign(admin, { contract: otherContract });
  const foreign = await cycle(admin, other, {
    links: [{ account_id: "act_2", campaign_id: "c9" }],
  });
  await as(admin);
  await assert.rejects(
    rpc("set_ad_campaign_current_cycle", [main, foreign]),
    /Ciclo inválido/,
  );
});

await check("edição registra antes e depois, e checa a versão", async () => {
  const [y] = await sql("select version from ad_cycles where id=$1", [current]);
  const edit = (version, budget) =>
    rpc("update_ad_cycle", [
      current,
      version,
      "2026-09-01",
      "2026-08-31",
      "2026-09-30",
      "message",
      120,
      budget,
      null,
      "external_page",
      [],
      "Suplementos",
      JSON.stringify([
        { account_id: "act_1", campaign_id: "c1" },
        { account_id: "act_1", campaign_id: "c2" },
      ]),
    ]);
  await as(trafego);
  await assert.rejects(edit(y.version, 3500), /Sem permissão/);
  await as(admin);
  await edit(y.version, 3500);
  await assert.rejects(edit(y.version, 3600), /alterado por outra pessoa/);
  const [event] = await sql(
    "select detail from ad_campaign_events where cycle_id=$1 and action='cycle_updated'",
    [current],
  );
  assert.deepEqual(event.detail.budget, { from: 3000, to: 3500 });
  assert.deepEqual(event.detail.goal_results, { from: 100, to: 120 });
  assert.equal(event.detail.links.to.length, 2);
  assert.equal(event.detail.multiplier, undefined);
});

await check(
  "ciclo encerrado continua editável pelo administrador",
  async () => {
    const old = await cycle(admin, main, {
      start: "2025-01-01",
      end: "2025-01-31",
    });
    const [y] = await sql("select version from ad_cycles where id=$1", [old]);
    await as(admin);
    await rpc("update_ad_cycle", [
      old,
      y.version,
      "2025-01-01",
      "2025-01-01",
      "2025-01-31",
      "lead",
      50,
      1000,
      3,
      "lead_form",
      [],
      "",
      "[]",
    ]);
    const [row] = await sql(
      "select multiplier::float,objective from ad_cycles where id=$1",
      [old],
    );
    assert.deepEqual(row, { multiplier: 3, objective: "lead" });
  },
);

await check("plataforma não muda com mais de um ciclo", async () => {
  const [a] = await sql("select version from ad_campaigns where id=$1", [main]);
  await as(admin);
  await assert.rejects(
    rpc("update_ad_campaign", [
      main,
      a.version,
      "Nome novo",
      "google",
      "",
      "",
      "",
    ]),
    /plataforma não muda/,
  );
  await rpc("update_ad_campaign", [
    main,
    a.version,
    "  Nome novo  ",
    "meta",
    "https://briefing",
    "",
    "Obs.",
  ]);
  const [row] = await sql(
    "select name,briefing_url from ad_campaigns where id=$1",
    [main],
  );
  assert.deepEqual(row, {
    name: "Nome novo",
    briefing_url: "https://briefing",
  });
});

await check(
  "ciclos, vínculos e histórico: só administradores e gestores",
  async () => {
    const events = await visible(admin2, "ad_campaign_events");
    assert.ok(events.some((e) => e.action === "status"));
    for (const user of [trafego, outsider])
      for (const table of ["ad_cycles", "ad_cycle_links", "ad_campaign_events"])
        assert.equal(
          (await visible(user, table)).length,
          0,
          `${user} ${table}`,
        );
  },
);

await check("administrador desativado perde o acesso", async () => {
  await sql("update memberships set active=false where user_id=$1", [admin2]);
  assert.equal((await visible(admin2, "ad_campaigns")).length, 0);
  await assert.rejects(campaign(admin2), /exclusivo de administradores/);
});

// ------------------------------------------------------------ connections
const rows = async (name, args) =>
  (
    await db.query(
      `select * from public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")})`,
      args,
    )
  ).rows;
const cipher = (n) => `v1:${"x".repeat(n)}`;

await check(
  "uma campanha da plataforma pertence a uma só campanha",
  async () => {
    const other = await campaign(admin, {
      contract: otherContract,
      name: "Outra",
    });
    await assert.rejects(
      cycle(admin, other, {
        links: [
          { account_id: "1", campaign_id: "c1", campaign_name: "Leads BF" },
        ],
      }),
      /campanha Leads BF da plataforma já está vinculada à campanha "Nome novo"/,
    );
    // The same campaign's next cycles keep linking it.
    await cycle(admin, main, {
      start: "2026-11-30",
      end: "2026-12-29",
      links: [{ account_id: "act_1", campaign_id: "c1" }],
    });
  },
);

await check("Google: conta sem traços, MCC e nomes gravados", async () => {
  const g = await campaign(admin, {
    contract: otherContract,
    name: "Google - Pesquisa",
    platform: "google",
  });
  const y = await cycle(admin, g, {
    links: [
      {
        account_id: "123-456-7890",
        campaign_id: "555",
        manager_id: "987-654-3210",
        account_name: "Vittalium Ads",
        campaign_name: "Pesquisa - Marca",
      },
    ],
  });
  const [link] = await sql(
    "select account_id,external_campaign_id,manager_id,account_name,campaign_name from ad_cycle_links where cycle_id=$1",
    [y],
  );
  assert.deepEqual(link, {
    account_id: "1234567890",
    external_campaign_id: "555",
    manager_id: "9876543210",
    account_name: "Vittalium Ads",
    campaign_name: "Pesquisa - Marca",
  });
});

let metaState;
// Begins a Meta connection for a client (as the "Conectar o Facebook do
// cliente" button) and finishes it as Facebook's redirect would.
const metaLogin = async (
  who,
  clientId,
  fbId,
  fbName,
  token,
  accounts,
  campaignId = null,
) => {
  await as(who);
  const state = await rpc("ad_begin_connect", [
    A,
    "meta",
    clientId,
    campaignId,
  ]);
  await as(null);
  return rpc("ad_complete_meta_connect", [
    state,
    fbId,
    fbName,
    token,
    null,
    JSON.stringify(accounts),
  ]);
};
await check(
  "só administradores e gestores conectam; o Meta pede o cliente",
  async () => {
    for (const user of [trafego, outsider]) {
      await as(user);
      await assert.rejects(
        rpc("ad_begin_connect", [A, "meta", client, null]),
        /exclusivo de administradores/,
      );
    }
    await as(admin);
    await assert.rejects(
      rpc("ad_begin_connect", [A, "tiktok", null, null]),
      /inválida/,
    );
    await assert.rejects(
      rpc("ad_begin_connect", [A, "meta", null, null]),
      /Escolha o cliente/,
    );
    metaState = await rpc("ad_begin_connect", [A, "meta", client, main]);
    assert.match(metaState, /^[0-9a-f]{64}$/);
  },
);

let pendingId;
await check(
  "Meta: as contas ficam pendentes até escolher as do cliente",
  async () => {
    await as(null);
    const accounts = JSON.stringify([
      {
        account_id: "111",
        name: "Vittalium",
        currency: "BRL",
        account_status: 1,
      },
      { account_id: "222", name: "Outro", currency: "BRL", account_status: 2 },
      { account_id: "act_x", name: "Inválida" },
    ]);
    const args = (state) => [
      state,
      "fb1",
      "Ana no Facebook",
      cipher(10),
      "2026-11-20T00:00:00Z",
      accounts,
    ];
    await assert.rejects(
      rpc("ad_complete_google_connect", [
        metaState,
        "a@x",
        "",
        cipher(5),
        null,
        null,
      ]),
      /Conexão expirada/,
    );
    const back = await rpc("ad_complete_meta_connect", args(metaState));
    assert.equal(back.campaign, main);
    pendingId = back.pending;
    await assert.rejects(
      rpc("ad_complete_meta_connect", args(metaState)),
      /Conexão expirada/,
    );
    await as(admin);
    // Nothing is the client's until chosen.
    assert.deepEqual(await rows("ad_meta_account_list", [A]), []);
    const pending = await rpc("ad_meta_pending", [pendingId]);
    assert.equal(pending.client, "Vittalium");
    assert.equal(pending.profile, "Ana no Facebook");
    assert.deepEqual(
      pending.accounts.map((a) => [a.account_id, a.client_id]),
      [
        ["222", null],
        ["111", null],
      ],
    );
    assert.ok(
      !JSON.stringify(pending).includes(cipher(10)),
      "no token in the chooser",
    );
    await as(trafego);
    await assert.rejects(
      rpc("ad_meta_pending", [pendingId]),
      /exclusivo de administradores/,
    );
    await as(admin);
    await assert.rejects(
      rpc("ad_confirm_meta_accounts", [pendingId, []]),
      /Marque ao menos uma/,
    );
    assert.equal(
      await rpc("ad_confirm_meta_accounts", [pendingId, ["111", "222"]]),
      2,
    );
    await assert.rejects(rpc("ad_meta_pending", [pendingId]), /expirou/);
    const list = await rows("ad_meta_account_list", [A]);
    assert.deepEqual(
      list.map((a) => [a.account_id, a.client_name, a.fb_user_name]),
      [
        ["222", "Vittalium", "Ana no Facebook"],
        ["111", "Vittalium", "Ana no Facebook"],
      ],
    );
    const [token] = await rows("ad_meta_token", [A, "111"]);
    assert.equal(token.token_cipher, cipher(10));
    const status = await rpc("ad_connections", [A]);
    assert.equal(status.meta.accounts, 2);
    assert.equal(status.google, null);
    // A profile that sees no account: nothing to choose.
    assert.equal(
      await metaLogin(admin, client, "fb0", "Vazio", cipher(3), []),
      null,
    );
  },
);

await check(
  "uma conta é de um cliente só; reconectar o cliente renova o token",
  async () => {
    await sql("update memberships set active=true where user_id=$1", [admin2]);
    const other = await metaLogin(
      admin2,
      otherClient,
      "fb2",
      "Beto no Facebook",
      cipher(20),
      [{ account_id: "111", name: "Vittalium" }],
    );
    await as(admin2);
    const offer = await rpc("ad_meta_pending", [other.pending]);
    assert.equal(offer.accounts[0].client, "Vittalium");
    await assert.rejects(
      rpc("ad_confirm_meta_accounts", [other.pending, ["111"]]),
      /A conta 111 já é do cliente Vittalium/,
    );
    const again = await metaLogin(
      admin2,
      client,
      "fb2",
      "Beto no Facebook",
      cipher(20),
      [{ account_id: "111", name: "Vittalium" }],
    );
    await as(admin2);
    assert.equal(
      await rpc("ad_confirm_meta_accounts", [again.pending, ["111"]]),
      1,
    );
    const [row] = await sql(
      "select fb_user_name,connected_by,token_cipher,client_id from mavi_private.ad_meta_accounts where company_id=$1 and account_id='111'",
      [A],
    );
    assert.deepEqual(row, {
      fb_user_name: "Beto no Facebook",
      connected_by: admin2,
      token_cipher: cipher(20),
      client_id: client,
    });
  },
);

await check(
  "estado expirado, de outra plataforma ou de ex-admin não vale",
  async () => {
    await as(admin);
    const old = await rpc("ad_begin_connect", [A, "google"]);
    await sql(
      "update mavi_private.ad_oauth_states set created_at=now()-interval '16 minutes' where state=$1",
      [old],
    );
    const complete = (state) =>
      as(null).then(() =>
        rpc("ad_complete_google_connect", [
          state,
          "agencia@x",
          "adwords",
          cipher(8),
          cipher(4),
          null,
        ]),
      );
    await assert.rejects(complete(old), /Conexão expirada/);
    await as(admin);
    const demoted = await rpc("ad_begin_connect", [A, "google"]);
    await sql("update memberships set role='member' where user_id=$1", [admin]);
    await assert.rejects(complete(demoted), /Conexão expirada/);
    await sql("update memberships set role='admin' where user_id=$1", [admin]);
  },
);

await check(
  "Google: um token da agência, renovável e desconectável",
  async () => {
    await as(admin);
    const state = await rpc("ad_begin_connect", [A, "google"]);
    await as(null);
    await rpc("ad_complete_google_connect", [
      state,
      "agencia@make.com",
      "https://www.googleapis.com/auth/adwords",
      cipher(8),
      cipher(4),
      "2026-10-01T10:00:00Z",
    ]);
    await as(admin);
    const [tokens] = await rows("ad_google_tokens", [A]);
    assert.equal(tokens.refresh_token_cipher, cipher(8));
    await rpc("ad_google_save_access", [A, cipher(6), "2026-10-01T11:00:00Z"]);
    const status = await rpc("ad_connections", [A]);
    assert.equal(status.google.email, "agencia@make.com");
    await as(trafego);
    await assert.rejects(rows("ad_google_tokens", [A]), /exclusivo/);
    await assert.rejects(rpc("ad_connections", [A]), /exclusivo/);
    await as(admin);
    await rpc("ad_disconnect", [A, "google"]);
    assert.equal((await rpc("ad_connections", [A])).google, null);
    assert.equal((await rpc("ad_connections", [A])).meta.accounts, 2);
  },
);

await check("ninguém lê as conexões direto nas tabelas", async () => {
  for (const user of [admin, manager, null]) {
    await as(user);
    for (const table of [
      "ad_meta_accounts",
      "ad_google_connections",
      "ad_oauth_states",
      "ad_meta_pending",
    ])
      await assert.rejects(
        db.query(`select * from mavi_private.${table}`),
        /permission denied/,
      );
  }
});

// ------------------------------------------------------------ metrics sync
const secret = "s".repeat(40);
await sql(
  "insert into mavi_private.ad_sync_config(url, secret) values ('https://app.example/api/ads-sync', $1)",
  [secret],
);
// A Meta campaign with a running cycle linked to account 111.
const synced = await campaign(admin, {
  contract: otherContract,
  name: "Sync - Meta",
});
const today = (
  await sql("select mavi_private.company_today($1)::text as d", [A])
)[0].d;
const shift = (n) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const syncCycle = await cycle(admin, synced, {
  start: shift(-10),
  end: shift(20),
  goal: 100,
  budget: 3000,
  m: 2.5,
  links: [{ account_id: "111", campaign_id: "c-sync" }],
});
const targets = async (who, p = [null, null, 15]) => {
  await as(who);
  return rpc("ad_sync_targets", p);
};

await check(
  "sincronização: segredo do agendamento ou administrador",
  async () => {
    await assert.rejects(
      targets(null, ["errado".repeat(8), null, 15]),
      /Sem permissão/,
    );
    await assert.rejects(targets(admin), /Sem permissão/);
    await assert.rejects(targets(trafego, [null, synced, 15]), /Sem permissão/);
    const mine = await targets(admin, [null, synced, 15]);
    assert.deepEqual(
      mine.map((t) => t.cycle_id),
      [syncCycle],
    );
    const all = await targets(null, [secret, null, 50]);
    const t = all.find((x) => x.cycle_id === syncCycle);
    assert.equal(t.platform, "meta");
    assert.deepEqual(t.links, [
      { account_id: "111", campaign_id: "c-sync", manager_id: "" },
    ]);
    // The connected account's encrypted token comes along.
    assert.equal(t.meta_tokens["111"].token_cipher, cipher(20));
    assert.equal(t.last_day, null);
    // The Make capture pages go along (destination make_landing_page).
    assert.deepEqual(t.landing_pages, []);
    // Future cycles and cycles without links are left out.
    assert.ok(all.every((x) => x.start_date < today));
  },
);

await check(
  "sincronização grava dias, acumulado e status Bom/Ruim",
  async () => {
    await as(null);
    const day = (d, spend, conversions) => ({
      day: shift(d),
      spend,
      impressions: 1000,
      reach: 800,
      clicks: 40,
      conversions,
    });
    const n = await rpc("ad_sync_store", [
      secret,
      syncCycle,
      "schedule",
      "ok",
      "",
      JSON.stringify([day(-2, 50, 10), day(-1, 60, 12), day(-30, 999, 1)]),
      JSON.stringify({
        period_end: shift(-1),
        spend: 110,
        impressions: 2000,
        reach: 1500,
        clicks: 80,
        conversions: 22,
      }),
    ]);
    assert.equal(n, 2, "the day outside the cycle is ignored");
    const days = await sql(
      "select day::text, spend::float, multiplier::float, source from ad_daily_metrics where cycle_id=$1 order by day",
      [syncCycle],
    );
    assert.deepEqual(days, [
      { day: shift(-2), spend: 50, multiplier: 2.5, source: "meta" },
      { day: shift(-1), spend: 60, multiplier: 2.5, source: "meta" },
    ]);
    // CPA 110/22 = 5 ≤ (3000/2.5)/100 = 12 → Bom.
    const [snap] = await sql(
      "select goal_status, period_start::text, period_end::text, author_label from ad_cycle_snapshots where cycle_id=$1",
      [syncCycle],
    );
    assert.deepEqual(snap, {
      goal_status: "good",
      period_start: shift(-10),
      period_end: shift(-1),
      author_label: "Sincronização diária",
    });
    // Synced today: the schedule skips it; the button still finds it.
    const again = await targets(null, [secret, null, 50]);
    assert.ok(again.every((x) => x.cycle_id !== syncCycle));
    assert.equal(
      (await targets(admin, [null, synced, 15]))[0].last_day,
      shift(-1),
    );
  },
);

await check(
  "reprocessar substitui o dia da plataforma, não o digitado",
  async () => {
    await sql(
      "update ad_daily_metrics set source='manual', spend=70 where cycle_id=$1 and day=$2",
      [syncCycle, shift(-2)],
    );
    await as(admin);
    await rpc("ad_sync_store", [
      null,
      syncCycle,
      "manual",
      "ok",
      "",
      JSON.stringify([
        { day: shift(-2), spend: 55, conversions: 1 },
        { day: shift(-1), spend: 65, conversions: 1 },
      ]),
      JSON.stringify({ period_end: shift(-1), spend: 900, conversions: 5 }),
    ]);
    const days = await sql(
      "select day::text, spend::float from ad_daily_metrics where cycle_id=$1 order by day",
      [syncCycle],
    );
    assert.deepEqual(days, [
      { day: shift(-2), spend: 70 },
      { day: shift(-1), spend: 65 },
    ]);
    // CPA 180 > 12 → Ruim; still one snapshot for today.
    const snaps = await sql(
      "select goal_status, author_label from ad_cycle_snapshots where cycle_id=$1",
      [syncCycle],
    );
    assert.deepEqual(snaps, [
      { goal_status: "bad", author_label: "Sincronização manual" },
    ]);
    const runs = await sql(
      "select trigger, status, days from ad_sync_runs where cycle_id=$1 order by id",
      [syncCycle],
    );
    assert.deepEqual(runs, [
      { trigger: "schedule", status: "ok", days: 2 },
      { trigger: "manual", status: "ok", days: 2 },
    ]);
  },
);

await check(
  "erro da plataforma fica registrado, sem apagar números",
  async () => {
    await as(null);
    await rpc("ad_sync_store", [
      secret,
      syncCycle,
      "schedule",
      "error",
      "Facebook: token expirado",
      "[]",
      null,
    ]);
    const [last] = await sql(
      "select status, message from ad_sync_runs where cycle_id=$1 order by id desc limit 1",
      [syncCycle],
    );
    assert.deepEqual(last, {
      status: "error",
      message: "Facebook: token expirado",
    });
    assert.equal(
      (
        await sql(
          "select count(*)::int as n from ad_daily_metrics where cycle_id=$1",
          [syncCycle],
        )
      )[0].n,
      2,
    );
    await as(trafego);
    await assert.rejects(
      rpc("ad_sync_store", [null, syncCycle, "manual", "ok", "", "[]", null]),
      /Sem permissão/,
    );
  },
);

await check(
  "números e sincronizações: só administradores e gestores leem",
  async () => {
    assert.ok((await visible(admin, "ad_daily_metrics")).length >= 2);
    assert.ok((await visible(admin, "ad_cycle_snapshots")).length >= 1);
    for (const user of [trafego, outsider])
      for (const table of [
        "ad_daily_metrics",
        "ad_cycle_snapshots",
        "ad_sync_runs",
      ])
        assert.equal(
          (await visible(user, table)).length,
          0,
          `${user} ${table}`,
        );
    await as(admin);
    await assert.rejects(
      db.query(
        "insert into ad_daily_metrics(company_id,campaign_id,cycle_id,day,multiplier,source) values ($1,$2,$3,now(),1,'manual')",
        [A, synced, syncCycle],
      ),
      /permission denied/,
    );
  },
);

// ------------------------------------------------------------ paged list
const page = (who, args = {}) =>
  as(who).then(() =>
    rpc("ad_campaign_page", [
      A,
      args.scope ?? "active",
      args.search ?? "",
      args.platform ?? "",
      args.attention ?? false,
      args.limit ?? 25,
      args.offset ?? 0,
    ]),
  );
// Three active campaigns with known alerts, on a client with an accent.
const acme = await (async () => {
  await as(admin);
  const client = await rpc("create_client", [A, "Açaí Ltda", ""]);
  return rpc("create_contract", [A, client, makeAds, "Make Ads", team]);
})();
const activeWith = async (name, platform, c) => {
  const id = await campaign(admin, { contract: acme, name, platform });
  if (c) {
    const y = await cycle(admin, id, { ...c, links: [], current: true });
    if (c.next)
      await cycle(admin, id, {
        start: shift(c.nextStart),
        end: shift(c.nextEnd),
        links: [],
      });
    void y;
  } else {
    // An active campaign whose cycle was deleted is rare; one without a
    // current cycle: create a cycle, activate, then clear the pointer.
    await cycle(admin, id, {
      start: shift(-5),
      end: shift(5),
      links: [],
      current: true,
    });
  }
  await as(admin);
  await rpc("set_ad_campaign_status", [id, "active", "Teste da lista"]);
  return id;
};
const ok = await activeWith("Zeta ok", "meta", {
  start: shift(-5),
  end: shift(25),
});
const ending = await activeWith("Beta terminando", "google", {
  start: shift(-20),
  end: shift(4),
});
const ended = await activeWith("Alfa encerrado", "meta", {
  start: shift(-40),
  end: shift(-3),
  next: true,
  nextStart: -2,
  nextEnd: 27,
});
const noCurrent = await activeWith("Delta sem atual", "meta", null);
await sql("update ad_campaigns set current_cycle_id = null where id = $1", [
  noCurrent,
]);
// A new campaign, never activated: out of the list, in "pending".
const fresh = await campaign(admin, {
  contract: acme,
  name: "Nova aguardando",
});

await check("lista paginada: só ativas, com ciclo atual e alerta", async () => {
  const all = await page(admin, { search: "açai" });
  const byName = Object.fromEntries(all.rows.map((r) => [r.campaign.name, r]));
  assert.deepEqual(Object.keys(byName).sort(), [
    "Alfa encerrado",
    "Beta terminando",
    "Delta sem atual",
    "Zeta ok",
  ]);
  assert.equal(byName["Zeta ok"].alert.kind, "none");
  assert.equal(byName["Zeta ok"].client_name, "Açaí Ltda");
  assert.equal(byName["Zeta ok"].current.end_date, shift(25));
  assert.deepEqual(
    [
      byName["Beta terminando"].alert.kind,
      byName["Beta terminando"].alert.days,
    ],
    ["ending", 5],
  );
  assert.equal(byName["Alfa encerrado"].alert.kind, "ended");
  assert.equal(byName["Alfa encerrado"].alert.days, 3);
  // The cycle covering today is the one to switch to.
  assert.equal(byName["Alfa encerrado"].alert.next.start_date, shift(-2));
  assert.equal(byName["Delta sem atual"].alert.kind, "no_current");
  assert.ok(byName["Delta sem atual"].alert.next);
  assert.ok(all.rows.every((r) => r.campaign.status === "active"));
  // Company-wide (other checks above also left never-activated ones).
  assert.ok(all.pending >= 1);
  // Everything active in the company, and those needing attention.
  assert.ok(all.all >= 4);
  assert.ok(all.attention >= 3);
});

await check("busca sem acento, plataforma, atenção e paginação", async () => {
  assert.equal((await page(admin, { search: "ACAI zeta" })).total, 0);
  assert.equal((await page(admin, { search: "zeta" })).rows[0].campaign.id, ok);
  assert.deepEqual(
    (await page(admin, { search: "açaí", platform: "google" })).rows.map(
      (r) => r.campaign.id,
    ),
    [ending],
  );
  const attention = await page(admin, { search: "acai", attention: true });
  assert.deepEqual(
    attention.rows.map((r) => r.campaign.name),
    ["Alfa encerrado", "Beta terminando", "Delta sem atual"],
  );
  // Sorted by client, then name; two per page.
  const first = await page(admin, { search: "acai", limit: 2 });
  const second = await page(admin, { search: "acai", limit: 2, offset: 2 });
  assert.equal(first.total, 4);
  assert.deepEqual(
    [...first.rows, ...second.rows].map((r) => r.campaign.name),
    ["Alfa encerrado", "Beta terminando", "Delta sem atual", "Zeta ok"],
  );
  assert.equal((await page(admin, { limit: 1000 })).rows.length <= 100, true);
});

await check("aguardando ativação: novas nunca ativadas, à parte", async () => {
  const pending = await page(admin, { scope: "pending", search: "acai" });
  assert.deepEqual(
    pending.rows.map((r) => r.campaign.id),
    [fresh],
  );
  assert.equal(pending.rows[0].alert.kind, "no_cycle");
  // Once activated and inactivated again, it is simply inactive: out of both.
  const y = await cycle(admin, fresh, {
    start: shift(-1),
    end: shift(29),
    links: [],
    current: true,
  });
  void y;
  await as(admin);
  await rpc("set_ad_campaign_status", [fresh, "active", "Começou"]);
  await rpc("set_ad_campaign_status", [fresh, "inactive", "Pausou"]);
  assert.equal(
    (await page(admin, { scope: "pending", search: "acai" })).total,
    0,
  );
  assert.ok(
    (await page(admin, { search: "acai" })).rows.every(
      (r) => r.campaign.id !== fresh,
    ),
  );
  // Imported campaigns (legacy_id) never count as pending.
  await sql("update ad_campaigns set legacy_id = 'x1' where id = $1", [fresh]);
});

await check("lista paginada: só administradores e gestores", async () => {
  for (const user of [trafego, outsider])
    await assert.rejects(page(user), /exclusivo de administradores/);
});

// ------------------------------------------------------------ workspace
await check(
  "Meta por cliente: a lista e a remoção de um cliente só",
  async () => {
    const carla = await metaLogin(
      admin,
      otherClient,
      "fb3",
      "Carla no Facebook",
      cipher(30),
      [{ account_id: "333", name: "Conta da Carla" }],
    );
    await as(admin);
    await rpc("ad_confirm_meta_accounts", [carla.pending, ["333"]]);
    const clients = await rpc("ad_meta_clients", [A]);
    const byName = Object.fromEntries(clients.map((c) => [c.client, c]));
    assert.deepEqual(
      byName["Vittalium"].accounts.map((a) => a.account_id).sort(),
      ["111", "222"],
    );
    assert.deepEqual(
      byName["Outro cliente"].accounts.map((a) => a.account_id),
      ["333"],
    );
    // A client with active Meta campaigns and no connection still shows up.
    assert.deepEqual(byName["Açaí Ltda"].accounts, []);
    assert.ok(byName["Açaí Ltda"].campaigns >= 1);
    assert.equal(await rpc("ad_disconnect_meta_client", [A, otherClient]), 1);
    const after = await rows("ad_meta_account_list", [A]);
    assert.ok(after.every((a) => a.account_id !== "333"));
    assert.ok(after.some((a) => a.account_id === "111"));
    await as(trafego);
    await assert.rejects(
      rpc("ad_meta_clients", [A]),
      /exclusivo de administradores/,
    );
    await assert.rejects(
      rpc("ad_disconnect_meta_client", [A, client]),
      /exclusivo de administradores/,
    );
  },
);

await check(
  "resumo da sincronização: devidos, sincronizados, erros e em dia",
  async () => {
    await as(admin);
    const o = await rpc("ad_sync_overview", [A]);
    assert.equal(o.configured, true);
    assert.equal(o.job, null, "no pg_cron in the test database");
    assert.equal(o.today, today);
    // The synced cycle ("Sync - Meta") is due; its last run today failed.
    assert.ok(o.due >= 1);
    assert.ok(o.failed >= 1);
    assert.ok(
      o.errors.some(
        (e) => e.campaign === "Sync - Meta" && /token expirado/.test(e.message),
      ),
    );
    assert.equal(o.synced + o.failed + o.pending, o.due);
    // Its data goes up to yesterday: up to date despite the error.
    assert.ok(o.up_to_date >= 1);
    assert.ok(o.last_schedule);
    await as(trafego);
    await assert.rejects(
      rpc("ad_sync_overview", [A]),
      /exclusivo de administradores/,
    );
  },
);

await check("comentários da campanha: tipo, ciclo atual e autor", async () => {
  await as(admin);
  const body = 'mavi:richtext:v1:{"type":"doc","content":[]}';
  // Without a current cycle, the comment belongs to the campaign only.
  const loose = await rpc("add_ad_campaign_comment", [
    synced,
    "information",
    body,
  ]);
  assert.equal(loose.cycle_id, null);
  await rpc("delete_ad_campaign_comment", [loose.id]);
  await rpc("set_ad_campaign_current_cycle", [synced, syncCycle]);
  const c = await rpc("add_ad_campaign_comment", [
    synced,
    "optimization",
    body,
  ]);
  assert.equal(c.cycle_id, syncCycle);
  assert.equal(c.author_id, admin);
  await assert.rejects(
    rpc("add_ad_campaign_comment", [synced, "outro", body]),
    /o que você realizou/,
  );
  await assert.rejects(
    rpc("add_ad_campaign_comment", [synced, "information", "  "]),
    /Escreva/,
  );
  await as(trafego);
  await assert.rejects(
    rpc("add_ad_campaign_comment", [synced, "information", body]),
    /Sem permissão/,
  );
  assert.equal((await visible(trafego, "ad_campaign_comments")).length, 0);
  assert.equal((await visible(admin2, "ad_campaign_comments")).length, 1);
  // Only the author removes it.
  await as(admin2);
  await assert.rejects(
    rpc("delete_ad_campaign_comment", [c.id]),
    /Só quem escreveu/,
  );
  await as(admin);
  await rpc("delete_ad_campaign_comment", [c.id]);
  assert.equal((await visible(admin, "ad_campaign_comments")).length, 0);
});

// ------------------------------------------------------------ edits
await check(
  "editar um dia: métricas e M, vira manual e fica no histórico",
  async () => {
    const day = shift(-1);
    await as(trafego);
    await assert.rejects(
      rpc("update_ad_daily_metric", [syncCycle, day, '{"spend":1}']),
      /Sem permissão/,
    );
    await as(admin);
    for (const [values, error] of [
      [{ clicks: 1.5 }, /Cliques é um número inteiro/],
      [{ spend: -1 }, /Investimento não pode ser negativo/],
      [{ conversions: "10" }, /Informe um número em Conversões/],
      [{ multiplier: 0 }, /O M deve ser maior que 0/],
      [{ spend: 1e12 }, /grande demais/],
    ])
      await assert.rejects(
        rpc("update_ad_daily_metric", [syncCycle, day, JSON.stringify(values)]),
        error,
      );
    await assert.rejects(
      rpc("update_ad_daily_metric", [syncCycle, shift(-9), "{}"]),
      /Sem permissão/,
      "a day without a record",
    );
    await rpc("update_ad_daily_metric", [
      syncCycle,
      day,
      JSON.stringify({ spend: 80.456, conversions: 4, multiplier: 3 }),
    ]);
    const [row] = await sql(
      "select spend::float, conversions::float, multiplier::float, source from ad_daily_metrics where cycle_id=$1 and day=$2",
      [syncCycle, day],
    );
    assert.deepEqual(row, {
      spend: 80.46,
      conversions: 4,
      multiplier: 3,
      source: "manual",
    });
    const events = async () =>
      sql(
        "select action, detail from ad_campaign_events where cycle_id=$1 and action like '%_edited' order by id",
        [syncCycle],
      );
    const [e] = await events();
    assert.equal(e.action, "daily_edited");
    assert.equal(e.detail.day, day);
    assert.deepEqual(Object.keys(e.detail.changes).sort(), [
      "conversions",
      "multiplier",
      "spend",
    ]);
    assert.deepEqual(e.detail.changes.spend, { from: 65, to: 80.46 });
    // Saving the same values changes nothing and logs nothing.
    await rpc("update_ad_daily_metric", [
      syncCycle,
      day,
      JSON.stringify({ spend: 80.46 }),
    ]);
    assert.equal((await events()).length, 1);
  },
);

await check(
  "editar um acumulado: período, métricas e Bom/Ruim; a sincronização o preserva",
  async () => {
    const [{ id }] = await sql(
      "select id from ad_cycle_snapshots where cycle_id=$1",
      [syncCycle],
    );
    await as(trafego);
    await assert.rejects(
      rpc("update_ad_cycle_snapshot", [id, '{"conversions":1}']),
      /Sem permissão/,
    );
    await as(admin);
    await assert.rejects(
      rpc("update_ad_cycle_snapshot", [
        id,
        JSON.stringify({ period_end: shift(-11) }),
      ]),
      /A data final vai de/,
    );
    await assert.rejects(
      rpc("update_ad_cycle_snapshot", [id, '{"goal_status":"ótimo"}']),
      /Status inválido/,
    );
    // CPA 900/100 = 9 ≤ 12: by the goal it is Bom.
    await rpc("update_ad_cycle_snapshot", [
      id,
      JSON.stringify({
        conversions: 100,
        period_end: shift(-2),
        goal_status: "auto",
      }),
    ]);
    const snap = async () =>
      (
        await sql(
          "select conversions::float, period_end::text, goal_status, source from ad_cycle_snapshots where id=$1",
          [id],
        )
      )[0];
    assert.deepEqual(await snap(), {
      conversions: 100,
      period_end: shift(-2),
      goal_status: "good",
      source: "manual",
    });
    await rpc("update_ad_cycle_snapshot", [id, '{"goal_status":"bad"}']);
    assert.equal((await snap()).goal_status, "bad");
    const [e] = await sql(
      "select detail from ad_campaign_events where cycle_id=$1 and action='snapshot_edited' order by id limit 1",
      [syncCycle],
    );
    assert.deepEqual(Object.keys(e.detail.changes).sort(), [
      "conversions",
      "goal_status",
      "period_end",
    ]);
    // The sync of today keeps the edited snapshot and the edited day.
    await rpc("ad_sync_store", [
      null,
      syncCycle,
      "manual",
      "ok",
      "",
      JSON.stringify([{ day: shift(-1), spend: 1, conversions: 1 }]),
      JSON.stringify({ period_end: shift(-1), spend: 5, conversions: 1 }),
    ]);
    assert.deepEqual(await snap(), {
      conversions: 100,
      period_end: shift(-2),
      goal_status: "bad",
      source: "manual",
    });
    const [day] = await sql(
      "select spend::float from ad_daily_metrics where cycle_id=$1 and day=$2",
      [syncCycle, shift(-1)],
    );
    assert.equal(day.spend, 80.46);
  },
);

// ------------------------------------------------------------ managers
await check(
  "gestores usam o módulo como administradores; colaboradores não",
  async () => {
    // Reads the list, the numbers and the sync, like an administrator.
    assert.ok((await visible(manager, "ad_campaigns")).length > 0);
    assert.ok((await visible(manager, "ad_daily_metrics")).length > 0);
    assert.ok((await page(manager)).total >= 1);
    await as(manager);
    assert.ok((await rpc("ad_sync_overview", [A])).due >= 0);
    assert.ok((await targets(manager, [null, synced, 15])).length >= 1);
    // Creates a campaign and its cycle, and edits a day.
    const id = await campaign(manager, { name: "Gestora - Meta" });
    await cycle(manager, id, {
      start: "2026-01-01",
      end: "2026-01-31",
      current: true,
      links: [{ account_id: "act_9", campaign_id: "c-gabi" }],
    });
    await as(manager);
    await rpc("update_ad_daily_metric", [
      syncCycle,
      shift(-1),
      JSON.stringify({ spend: 81 }),
    ]);
    // Connects a client's Facebook, all the way back from the redirect.
    const done = await metaLogin(
      manager,
      client,
      "fb-gabi",
      "Gabi",
      cipher(12),
      [{ account_id: "777", name: "Conta da Gabi" }],
    );
    assert.ok(done.pending);
    await as(manager);
    assert.equal(
      await rpc("ad_confirm_meta_accounts", [done.pending, ["777"]]),
      1,
    );
    // A manager turned collaborator loses it all.
    await sql("update memberships set role='member' where user_id=$1", [
      manager,
    ]);
    assert.equal((await visible(manager, "ad_campaigns")).length, 0);
    await assert.rejects(
      page(manager),
      /exclusivo de administradores e gestores/,
    );
    await sql("update memberships set role='manager' where user_id=$1", [
      manager,
    ]);
  },
);

// ------------------------------------------------------------ Google from the MASO
await check(
  "Google vindo do MASO: impressões saem do 'alcance' (migração 20261012090000)",
  async () => {
    const { readFileSync } = await import("node:fs");
    const google = await campaign(admin, {
      name: "Google do MASO",
      platform: "google",
    });
    const gCycle = await cycle(admin, google, {
      start: "2026-03-01",
      end: "2026-03-31",
      links: [{ account_id: "2223334444", campaign_id: "g-maso" }],
    });
    const meta = await campaign(admin, { name: "Meta do MASO" });
    const mCycle = await cycle(admin, meta, {
      start: "2026-03-01",
      end: "2026-03-31",
      links: [{ account_id: "act_77", campaign_id: "m-maso" }],
    });
    for (const [c, y] of [
      [google, gCycle],
      [meta, mCycle],
    ]) {
      await sql(
        `insert into ad_cycle_snapshots(company_id, campaign_id, cycle_id, taken_on, period_start, period_end,
         impressions, reach, source) values ($1,$2,$3,'2026-03-10','2026-03-01','2026-03-09',0,5597,'maso')`,
        [A, c, y],
      );
      await sql(
        `insert into ad_daily_metrics(company_id, campaign_id, cycle_id, day, multiplier, impressions, reach, source)
         values ($1,$2,$3,'2026-03-09',1,0,306,'maso')`,
        [A, c, y],
      );
    }
    const migration = readFileSync(
      new URL(
        "../supabase/migrations/20261012090000_ad_google_maso_impressions.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const read = async (y) => ({
      snapshot: (
        await sql(
          "select impressions::int, reach::int from ad_cycle_snapshots where cycle_id=$1",
          [y],
        )
      )[0],
      day: (
        await sql(
          "select impressions::int, reach::int from ad_daily_metrics where cycle_id=$1",
          [y],
        )
      )[0],
    });
    for (let run = 0; run < 2; run++) {
      await db.exec("reset role");
      await db.exec(migration);
      assert.deepEqual(await read(gCycle), {
        snapshot: { impressions: 5597, reach: 0 },
        day: { impressions: 306, reach: 0 },
      });
      // Meta has reach: untouched.
      assert.deepEqual(await read(mCycle), {
        snapshot: { impressions: 0, reach: 5597 },
        day: { impressions: 0, reach: 306 },
      });
    }
  },
);

console.log(`\n${passed} verificações de campanhas passaram.`);
