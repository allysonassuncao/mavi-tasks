// Anotações do cliente: traz o bloco de notas dos clientes do MASO
// (maso_bloco_notas, dump do phpMyAdmin) para as Anotações do cliente
// (migrações 20270226090000_client_notes e 20270227090000_client_notes_legacy).
// Escreve arquivos SQL para o pgAdmin / editor SQL do Supabase (rodam como
// postgres, sem as RPCs; as checagens das tabelas valem):
//
//   node --env-file=.env.local scripts/import-maso-notes.mjs \
//     --input maso-notes/maso_bloco_notas.sql --users "maso-tarefas/usuarios_maso (1).sql" \
//     --company <uuid> --author <uuid> --out maso-notes-import
//   node scripts/import-maso-notes.mjs --send maso-notes-import [--credentials gcs-credentials.json]
//
// A chave dos secretos vem de CLIENT_NOTES_KEY (a mesma da Vercel; nunca na
// linha de comando). Grava:
//  * 01-conferencia.sql   só leitura: que clientes e pessoas o MAVI reconhece;
//  * 02-importacao.sql    uma transação; rodar de novo não duplica nada (os ids
//                         são derivados dos ids do MASO);
//  * arquivos.json + imagens/   as imagens coladas, que o --send põe no bucket
//                         (roda antes do 02).
//
// Regras combinadas com o usuário (02/10/2026):
//  * o MASO gravava uma linha a cada salvamento: cada cliente vira uma nota
//    ("Bloco de notas do MASO") e cada linha uma versão, na ordem, com o autor
//    e o horário originais (versões iguais à anterior não entram);
//  * o cliente é o do MAVI com o nome igual ao id_cliente (como nas outras
//    importações); a pessoa, pelo e-mail; quem não está no MAVI aparece pelo
//    nome do MASO ("Fulano (MASO)");
//  * as senhas viram secretos cifrados em todas as versões: "Senha: valor",
//    "Password: …", "Token: …", "Chave: …" (ou o rótulo sozinho numa linha e o
//    valor na seguinte); o mesmo valor no mesmo cliente é o mesmo secreto, e
//    as outras aparições dele no texto também somem. O que não é reconhecido
//    fica como texto e aparece na conferência (sem o valor);
//  * a MAVI lê a versão atual (os gatilhos põem as notas na fila do RAG).
import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { UsageError, cleanText, parseSqlDump, sqlString } from "./import-maso-campaigns.mjs";
import { htmlToBlocks, legacyUuid, send, serialize } from "./import-maso-tasks.mjs";

export const TABLE = "maso_bloco_notas";
export const TITLE = "Bloco de notas do MASO";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INLINE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const INLINE_MAX = 5 * 1024 * 1024;
const BUCKET = "maso_storage_main";
const BATCH = 200;
const USAGE = `Uso:
  node --env-file=.env.local scripts/import-maso-notes.mjs --input <maso_bloco_notas.sql> \\
    --users <usuarios_maso.sql> --company <uuid> --author <uuid de quem envia as imagens> --out <pasta>
  node scripts/import-maso-notes.mjs --send <pasta> [--credentials gcs-credentials.json]
A chave dos secretos vem de CLIENT_NOTES_KEY (32 bytes em base64), como na Vercel.`;

// ------------------------------------------------------------ secretos

/** O mesmo formato de api/_google.ts: "v1:" + base64(iv | tag | cifrado). */
export function seal(key, text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}
export function readKey(value) {
  const key = value ? Buffer.from(value, "base64") : null;
  if (!key || key.length !== 32)
    throw new UsageError("Falta CLIENT_NOTES_KEY (32 bytes em base64, a mesma da Vercel).");
  return key;
}

const LABELS = {
  senha: "Senha", senhas: "Senha", password: "Senha", passwd: "Senha", pass: "Senha", pwd: "Senha", pw: "Senha",
  token: "Token", secret: "Segredo", segredo: "Segredo", chave: "Chave", key: "Chave", pin: "PIN",
};
const WORDS = Object.keys(LABELS).sort((a, b) => b.length - a.length).join("|");
// "Senha: valor", "Senha do Instagram: valor", "senha é: valor" (o valor
// pode estar na linha seguinte; até 4 palavras entre o rótulo e os dois-pontos) …
const INLINE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${WORDS})(?![\\p{L}\\p{N}])(?:[ \\t]+[\\p{L}\\p{N}@._/-]{1,30}){0,4}?(?:[ \\t]*[*_]*[:=]|[ \\t]+[\\-–—])[*_]*[ \\t]*(?:\\n[ \\t]*)?([^\\s*]\\S*)`,
  "giu",
);
// … "senha valor123" (sem separador: só um valor com número ou símbolo) …
const BARE = new RegExp(`(?<![\\p{L}\\p{N}])(${WORDS})(?![\\p{L}\\p{N}])[ \\t]*[.]?[ \\t]+(\\S{4,})`, "giu");
// Palavras que, depois de "senha", contam o que houve (não são a senha).
const NOT_PASSWORDS = new Set(("alterada alterado enviada enviado trocada trocado padrão padrao mesma mesmo igual " +
  "atual nova novo antiga antigo cliente provisoria provisória temporaria temporária abaixo acima correta " +
  "errada resetada redefinida bloqueada expirada pendente salva anotada").split(" "));
const looksSecret = (v, endOfLine) =>
  (endOfLine && /^\p{L}{6,}$/u.test(v) && !NOT_PASSWORDS.has(v.toLowerCase())) || /[\p{N}\p{S}\p{P}]/u.test(v) && !/:\/\//.test(v) && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v);
// … ou o rótulo sozinho na linha e o valor (uma palavra só) na seguinte.
const ALONE = new RegExp(`^[ \\t]*(${WORDS})[ \\t]*[:=\\-–—]?[ \\t]*\\n[ \\t]*([^\\s]+)[ \\t]*$`, "gimu");
/** Um valor que não é senha: vazio, pontuação ou outro rótulo. */
const notAValue = (v) => !v || /^[\p{P}\p{S}]+$/u.test(v) || NOT_PASSWORDS.has(v.toLowerCase().replace(/[.,;:!]+$/, "")) || new RegExp(`^(${WORDS}|login|usu[aá]rio|e-?mail)[:=]?$`, "iu").test(v);

const SECRET_MARK = "\u0000";
/**
 * Ficou alguma senha em texto? "senha"/"password" sem um secreto logo depois
 * (o MASO tem "a senha é a mesma do e-mail", "senha no grupo"…).
 */
export function hasLeftoverPassword(blocks) {
  const { text } = linearize(blocks);
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])(senhas?|password|passwd|pwd)(?![\p{L}\p{N}])/giu))
    if (!text.slice(m.index, m.index + m[0].length + 40).includes(SECRET_MARK)) return true;
  return false;
}
/** Um valor já trocado (6+ caracteres) que ficou grudado noutro texto. */
function hasKnownValue(blocks, known) {
  const texts = [];
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.type === "text" && !n.marks?.some((m) => m.type === "link")) texts.push(n.text);
      else walk(n.content);
    }
  };
  walk(blocks);
  const all = texts.join("\n");
  return known.some(({ value }) => value.length >= 6 && all.includes(value));
}
/**
 * O texto do documento numa linha só, com o mapa de volta para os nós de
 * texto: parágrafos, itens e quebras viram "\n".
 */
function linearize(blocks) {
  let text = "";
  const spans = []; // { start, end, parent, index }
  const walk = (nodes, parent) => {
    nodes.forEach((node, index) => {
      if (node.type === "text") {
        spans.push({ start: text.length, end: text.length + node.text.length, parent: nodes, index });
        text += node.text;
      } else if (node.type === "hardBreak") text += "\n";
      // Um secreto já trocado: um marcador sem texto (para a conferência).
      else if (node.type === "noteSecret") text += SECRET_MARK;
      else if (node.content) {
        if (text && !text.endsWith("\n")) text += "\n";
        walk(node.content, node);
        if (!text.endsWith("\n")) text += "\n";
      }
    });
  };
  walk(blocks, null);
  return { text, spans };
}

/** O nome do secreto: o que vem antes do rótulo na linha, ou a linha de cima. */
function secretLabel(text, at, word) {
  const kind = LABELS[word.toLowerCase()] ?? "Senha";
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  // Só o que vem antes de qualquer rótulo (o nome nunca leva outro valor).
  const beforeLabels = (s) => s.split(new RegExp(`(?<![\\p{L}\\p{N}])(?:${WORDS})(?![\\p{L}\\p{N}])`, "iu"))[0];
  const clean = (s) => beforeLabels(s).replace(/[\s:=\-–—|•·,;*_]+$/u, "").replace(/^[\s\-–—•·*_]+/u, "").trim();
  let context = clean(text.slice(lineStart, at));
  if (!context) {
    const prevEnd = lineStart - 1;
    const prevStart = prevEnd > 0 ? text.lastIndexOf("\n", prevEnd - 1) + 1 : 0;
    const prev = clean(text.slice(prevStart, Math.max(prevStart, prevEnd)));
    if (prev && prev.length <= 50 && !INLINE.test(prev)) context = prev;
    INLINE.lastIndex = 0;
  }
  if (context.length > 50) context = context.slice(-50).replace(/^\S*\s/, "");
  return (context ? `${context} · ${kind}` : kind).slice(0, 120);
}

/**
 * Troca as senhas reconhecidas por secretos. `secretFor(value, label)` dá o
 * id do secreto (o mesmo para o mesmo valor). Devolve os valores trocados.
 */
export function extractSecrets(blocks, secretFor, known = []) {
  const { text, spans } = linearize(blocks);
  const hits = [];
  for (const re of [INLINE, ALONE, BARE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const value = m[2];
      if (notAValue(value) || value.length > 4000) continue;
      if (re === BARE) {
        const after = text[m.index + m[0].length];
        if (!looksSecret(value, after === undefined || after === "\n")) continue;
      }
      const vs = m.index + m[0].length - (re === ALONE ? m[0].length - m[0].lastIndexOf(value) : value.length);
      hits.push({ vs, ve: vs + value.length, value, label: secretLabel(text, m.index + (m[0].length - m[0].trimStart().length), m[1]) });
    }
  }
  // As outras aparições de um valor já conhecido (6+ caracteres, como
  // palavra inteira e fora de links).
  const edge = (ch) => ch === undefined || /[\s(),;:"'\u0000]/.test(ch);
  const inLink = (pos) =>
    spans.some((s) => s.start <= pos && pos < s.end && s.parent[s.index].marks?.some((mk) => mk.type === "link"));
  for (const { value, label } of known) {
    if (value.length < 6) continue;
    for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + value.length)) {
      const after = text[at + value.length];
      if (!edge(text[at - 1]) || !(edge(after) || /[.!?]/.test(after ?? "")) || inLink(at)) continue;
      hits.push({ vs: at, ve: at + value.length, value, label });
    }
  }
  // O nome de um secreto nunca leva um valor (o de outro secreto na linha).
  for (const h of hits)
    if (hits.some((o) => o.value.length >= 3 && h.label.includes(o.value)))
      h.label = h.label.split(" · ").pop();
  // Sem sobreposição: a primeira que começa (e a mais longa) fica.
  hits.sort((a, b) => a.vs - b.vs || b.ve - a.ve);
  const chosen = [];
  for (const h of hits) if (!chosen.length || h.vs >= chosen.at(-1).ve) chosen.push(h);
  const found = [];
  const missed = [];
  // Do fim para o começo: os índices dos nós de antes continuam valendo.
  for (const h of chosen.reverse()) {
    let span = spans.find((s) => s.start <= h.vs && h.ve <= s.end);
    // O valor emendado no nó seguinte (um link colado): só a parte do primeiro.
    if (!span) {
      const head = spans.find((s) => s.start <= h.vs && h.vs < s.end);
      if (head && head.end - h.vs >= 3) {
        h.value = text.slice(h.vs, head.end);
        h.ve = head.end;
        span = head;
      }
    }
    if (!span) {
      missed.push(h.value);
      continue;
    }
    const node = span.parent[span.index];
    const from = h.vs - span.start;
    const to = h.ve - span.start;
    const parts = [];
    if (from > 0) parts.push({ ...node, text: node.text.slice(0, from) });
    parts.push({ type: "noteSecret", attrs: { secretId: secretFor(h.value, h.label), label: h.label } });
    if (to < node.text.length) parts.push({ ...node, text: node.text.slice(to) });
    span.parent.splice(span.index, 1, ...parts);
    found.push(h.value);
  }
  return { found, missed };
}

// ------------------------------------------------------------ modelo

const at = (r) => `${cleanText(r.data) || "2020-01-01"} ${cleanText(r.hora) || "00:00:00"}`;

/**
 * As notas (uma por cliente), as versões, os secretos e as imagens coladas.
 * `key`: a chave dos secretos (sem ela, nada é cifrado: só para os testes).
 */
export function buildModel({ notes: rows, users }, { company, author, key }) {
  const people = new Map();
  for (const u of users ?? []) {
    const id = cleanText(u.id);
    if (id) people.set(id, { id, name: cleanText(u.nome).replace(/\s+/g, " ").slice(0, 120) || `Pessoa ${id} do MASO`, email: cleanText(u.email).toLowerCase() });
  }
  const byClient = new Map();
  for (const r of rows) {
    const client = cleanText(r.id_cliente);
    if (!client) continue;
    if (!byClient.has(client)) byClient.set(client, []);
    byClient.get(client).push(r);
  }
  const notes = [];
  const versions = [];
  const secrets = new Map(); // id → { id, client, label, value, at, author }
  const images = [];
  const files = [];
  const blobs = new Map();
  const skipped = {};
  const skip = (why, n = 1) => (skipped[why] = (skipped[why] ?? 0) + n);
  const unrecognized = new Map(); // cliente → quantas versões citam senha sem trocar
  for (const [client, list] of [...byClient].sort((a, b) => Number(a[0]) - Number(b[0]) || a[0].localeCompare(b[0]))) {
    list.sort((a, b) => at(a).localeCompare(at(b)) || Number(a.id) - Number(b.id));
    const noteId = legacyUuid("client-note", client);
    const known = []; // os valores já trocados neste cliente
    const secretFor = (value, label) => {
      const id = legacyUuid("client-note-secret", `${client}:${crypto.createHash("sha256").update(value).digest("hex")}`);
      if (!secrets.has(id)) {
        secrets.set(id, { id, client, label, value });
        known.push({ value, label });
      }
      return id;
    };
    let imageCount = 0;
    const image = (row) => (mime, base64) => {
      const bytes = Buffer.from(base64.replace(/\s+/g, ""), "base64");
      if (!bytes.length || !INLINE_TYPES[mime] || bytes.length > INLINE_MAX) return { type: "text", text: "[imagem do MASO não importada]", marks: [{ type: "italic" }] };
      const hash = crypto.createHash("sha256").update(bytes).digest("hex");
      const id = legacyUuid("client-note-image", `${client}:${hash}`);
      if (!blobs.has(id)) {
        blobs.set(id, bytes);
        const name = `imagem-${++imageCount}.${INLINE_TYPES[mime]}`;
        const path = `${company}/${author}/${id}`;
        images.push({ id, client, note: noteId, name, path, size: bytes.length, at: at(row) });
        files.push({ path, local: `imagens/${id}`, contentType: mime });
      }
      const name = images.find((i) => i.id === id).name;
      return { type: "inlineImage", attrs: { imageId: id, alt: name } };
    };
    // 1ª passada: todas as senhas do cliente (de todas as versões), para a 2ª
    // trocar também as aparições sem rótulo, nas versões de antes e depois.
    for (const r of list) extractSecrets(htmlToBlocks(r.conteudo), secretFor, []);
    let last = null;
    const kept = [];
    for (const r of list) {
      const blocks = htmlToBlocks(r.conteudo, { image: image(r) });
      const { missed } = extractSecrets(blocks, secretFor, known);
      const body = serialize(blocks);
      if (body.length > 400000) {
        skip("versão grande demais (mais de 400 mil caracteres)");
        continue;
      }
      if (body === last) {
        skip("versão igual à anterior");
        continue;
      }
      last = body;
      if (missed.length || hasLeftoverPassword(blocks) || hasKnownValue(blocks, known))
        unrecognized.set(client, (unrecognized.get(client) ?? 0) + 1);
      kept.push({ row: r, body });
    }
    if (!kept.length || kept.every((k) => !k.body)) {
      skip("cliente só com notas vazias");
      continue;
    }
    // A primeira versão vazia não conta (o MASO criava o bloco em branco).
    while (kept.length > 1 && !kept[0].body) kept.shift();
    kept.forEach((k, i) =>
      versions.push({ note: noteId, client, version: i + 1, body: k.body, author: cleanText(k.row.id_usuario_maso), at: at(k.row), masoId: Number(k.row.id) }),
    );
    const first = kept[0];
    const final = kept.at(-1);
    notes.push({
      id: noteId, client, version: kept.length, body: final.body,
      createdBy: cleanText(first.row.id_usuario_maso), createdAt: at(first.row),
      updatedBy: cleanText(final.row.id_usuario_maso), updatedAt: at(final.row),
    });
    // O secreto nasce com a primeira versão que o usa.
    for (const s of secrets.values())
      if (s.client === client && !s.at) {
        const v = kept.find((k) => k.body.includes(s.id));
        s.at = v ? at(v.row) : at(first.row);
        s.author = v ? cleanText(v.row.id_usuario_maso) : cleanText(first.row.id_usuario_maso);
      }
  }
  // Só os secretos que ficaram em alguma versão guardada.
  const used = [...secrets.values()].filter((s) => versions.some((v) => v.client === s.client && v.body.includes(s.id)));
  const sealed = used.map((s) => ({ id: s.id, client: s.client, label: s.label, at: s.at, author: s.author, sealed: key ? seal(key, s.value) : "v1:AAAA" }));
  const authors = new Set(versions.map((v) => v.author));
  return {
    notes, versions, secrets: sealed, images, files, blobs, skipped,
    unrecognized: [...unrecognized].map(([client, n]) => ({ client, versions: n })),
    people: [...people.values()].filter((p) => authors.has(p.id)),
    rows: rows.length,
  };
}

// ------------------------------------------------------------ SQL

const values = (table, columns, list, row) => {
  const out = [];
  for (let i = 0; i < list.length; i += BATCH)
    out.push(`insert into ${table}(${columns}) values\n${list.slice(i, i + BATCH).map(row).join(",\n")};`);
  return out.join("\n");
};
const ts = (s) => sqlString(s);

/** As tabelas temporárias; a conferência vai sem os textos (só quem é quem). */
function stage(model, { bodies = true } = {}) {
  return [
    "drop table if exists maso_nota, maso_versao, maso_pessoa, maso_segredo, maso_imagem;",
    "create temp table maso_pessoa(id text primary key, nome text not null, email text not null);",
    values("maso_pessoa", "id, nome, email", model.people, (p) => `(${sqlString(p.id)},${sqlString(p.name)},${sqlString(p.email)})`),
    "create temp table maso_nota(id uuid primary key, cliente text not null, versao integer not null, corpo text not null, criada_por text, criada timestamp not null, mudada_por text, mudada timestamp not null);",
    values("maso_nota", "id, cliente, versao, corpo, criada_por, criada, mudada_por, mudada", model.notes,
      (n) => `('${n.id}',${sqlString(n.client)},${n.version},${bodies ? sqlString(n.body) : "''"},${sqlString(n.createdBy)},${ts(n.createdAt)},${sqlString(n.updatedBy)},${ts(n.updatedAt)})`),
    "create temp table maso_versao(nota uuid not null, versao integer not null, corpo text not null, autor text, em timestamp not null, primary key (nota, versao));",
    values("maso_versao", "nota, versao, corpo, autor, em", model.versions,
      (v) => `('${v.note}',${v.version},${bodies ? sqlString(v.body) : "''"},${sqlString(v.author)},${ts(v.at)})`),
    "create temp table maso_segredo(id uuid primary key, cliente text not null, rotulo text not null, cifrado text not null, autor text, em timestamp);",
    values("maso_segredo", "id, cliente, rotulo, cifrado, autor, em", bodies ? model.secrets : [],
      (s) => `('${s.id}',${sqlString(s.client)},${sqlString(s.label)},${sqlString(s.sealed)},${sqlString(s.author ?? "")},${ts(s.at)})`),
    "create temp table maso_imagem(id uuid primary key, nota uuid not null, nome text not null, path text not null, tamanho bigint not null, em timestamp);",
    values("maso_imagem", "id, nota, nome, path, tamanho, em", model.images,
      (i) => `('${i.id}','${i.note}',${sqlString(i.name)},${sqlString(i.path)},${i.size},${ts(i.at)})`),
  ].filter(Boolean).join("\n");
}

// Quem é quem: o cliente pelo nome (= id do MASO), a pessoa pelo e-mail.
const lookups = (c) => `
drop table if exists maso_fuso, maso_cliente, maso_quem;
create temp table maso_fuso as select 'America/Sao_Paulo'::text as tz;
create temp table maso_cliente as
 select n.cliente, (select cl.id from public.clients cl where cl.company_id = ${c} and btrim(cl.name) = n.cliente
   order by cl.archived, cl.created_at limit 1) as client_id
 from (select distinct cliente from maso_nota) n;
create temp table maso_quem as
 select p.id, p.nome, (select m.user_id from public.memberships m left join auth.users u on u.id = m.user_id
   where m.company_id = ${c} and p.email <> ''
    and lower(btrim(coalesce(nullif(m.email, ''), u.email, ''))) = p.email
   order by m.active desc limit 1) as user_id
 from maso_pessoa p;`;

export function renderPreview(model, { company, author }) {
  const c = `'${company}'::uuid`;
  return [
    "-- Anotações do cliente: CONFERÊNCIA da importação do bloco de notas do MASO (não muda nada).",
    `-- ${model.rows} linhas no arquivo → ${model.notes.length} notas, ${model.versions.length} versões, ${model.secrets.length} secretos, ${model.images.length} imagens.`,
    `-- Fora já no arquivo: ${JSON.stringify(model.skipped)}`,
    "-- Resultado numa tabela só (o pgAdmin mostra só a última consulta).",
    stage(model, { bodies: false }),
    lookups(c),
    `select * from (
 select 1 as ordem, '1. Clientes encontrados' as parte, count(*) filter (where client_id is not null)::text as resultado, null::text as detalhe from maso_cliente
 union all
 select 2, '2. Clientes que NÃO existem no MAVI (ficam de fora)', count(*) filter (where client_id is null)::text,
  string_agg(cliente, ', ' order by cliente) filter (where client_id is null) from maso_cliente
 union all
 select 3, '3. Notas que já estão no MAVI (não entram de novo)', count(*)::text, null
  from public.client_notes x where x.id in (select id from maso_nota)
 union all
 select 4, '4. Quem enviou as imagens (--author)', coalesce((select m.name from public.memberships m
   where m.company_id = ${c} and m.user_id = '${author}'::uuid), 'NÃO É MEMBRO DA EMPRESA: corrija o --author'), null
 union all
 select 5, '5. Autor: ' || q.nome, coalesce((select m.name from public.memberships m where m.company_id = ${c} and m.user_id = q.user_id),
   q.nome || ' (MASO)'), (select count(*) from maso_versao v where v.autor = q.id)::text || ' versões'
 from maso_quem q
 union all
 select 6, '6. Clientes com "senha" que ficou em texto (revisar)', ${sqlString(String(model.unrecognized.length))},
  ${sqlString(model.unrecognized.map((u) => u.client).join(", "))}
) r order by ordem, parte;`,
  ].join("\n");
}

export function renderImport(model, { company, author }) {
  const c = `'${company}'::uuid`;
  return [
    "-- Anotações do cliente: IMPORTAÇÃO do bloco de notas do MASO (maso_bloco_notas).",
    `-- ${model.notes.length} notas, ${model.versions.length} versões, ${model.secrets.length} secretos, ${model.images.length} imagens.`,
    "-- Uma transação; rodar de novo não duplica nada. Antes: o --send (as imagens no bucket).",
    "begin;",
    stage(model),
    lookups(c),
    `
insert into public.client_note_secrets(id, company_id, client_id, label, sealed, created_by, created_at)
 select s.id, ${c}, k.client_id, s.rotulo, s.cifrado, q.user_id, coalesce(s.em at time zone (select tz from maso_fuso), now())
 from maso_segredo s join maso_cliente k on k.cliente = s.cliente and k.client_id is not null
 left join maso_quem q on q.id = s.autor
 on conflict (id) do nothing;

insert into public.client_notes(id, company_id, client_id, title, body, version, created_by, created_at,
  updated_by, updated_at, legacy_created_by, legacy_updated_by)
 select n.id, ${c}, k.client_id, ${sqlString(TITLE)}, n.corpo, n.versao,
  a.user_id, n.criada at time zone (select tz from maso_fuso),
  b.user_id, n.mudada at time zone (select tz from maso_fuso),
  case when a.user_id is null then coalesce(a.nome, 'Pessoa ' || n.criada_por || ' do MASO') end,
  case when b.user_id is null then coalesce(b.nome, 'Pessoa ' || n.mudada_por || ' do MASO') end
 from maso_nota n join maso_cliente k on k.cliente = n.cliente and k.client_id is not null
 left join maso_quem a on a.id = n.criada_por
 left join maso_quem b on b.id = n.mudada_por
 on conflict (id) do nothing;

insert into public.client_note_versions(company_id, note_id, version, title, body, action, saved_by, legacy_saved_by, saved_at)
 select ${c}, v.nota, v.versao, ${sqlString(TITLE)}, v.corpo, 'import', q.user_id,
  case when q.user_id is null then coalesce(q.nome, 'Pessoa ' || v.autor || ' do MASO') end,
  v.em at time zone (select tz from maso_fuso)
 from maso_versao v join public.client_notes x on x.id = v.nota
 left join maso_quem q on q.id = v.autor
 on conflict (note_id, version) do nothing;

insert into public.inline_images(id, company_id, note_id, uploaded_by, name, path, size_bytes, created_at)
 select i.id, ${c}, i.nota, '${author}'::uuid, i.nome, i.path, i.tamanho, coalesce(i.em at time zone (select tz from maso_fuso), now())
 from maso_imagem i where exists (select 1 from public.client_notes x where x.id = i.nota)
 on conflict (id) do nothing;

select (select count(*) from public.client_notes x where x.id in (select id from maso_nota)) as notas,
 (select count(*) from public.client_note_versions v where v.note_id in (select id from maso_nota)) as versoes,
 (select count(*) from public.client_note_secrets s where s.id in (select id from maso_segredo)) as secretos,
 (select count(*) from public.inline_images i where i.id in (select id from maso_imagem)) as imagens;
commit;`,
  ].join("\n");
}

// ------------------------------------------------------------ CLI

export async function main(argv, { log = console.log, env = process.env } = {}) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, "");
    if (!["input", "users", "company", "author", "out", "send", "credentials"].includes(k))
      throw new UsageError(`Opção desconhecida: ${argv[i]}\n${USAGE}`);
    args[k] = argv[++i];
  }
  if (args.send) {
    const credentials = JSON.parse(await readFile(resolve(args.credentials ?? "gcs-credentials.json"), "utf8"));
    return send(resolve(args.send), credentials, log);
  }
  if (!args.input || !args.users || !args.out || !UUID.test(args.company ?? "") || !UUID.test(args.author ?? ""))
    throw new UsageError(USAGE);
  const key = readKey(env.CLIENT_NOTES_KEY);
  const company = args.company.toLowerCase();
  const author = args.author.toLowerCase();
  const notes = parseSqlDump(await readFile(resolve(args.input), "utf8"), args.input).get(TABLE) ?? [];
  const users = parseSqlDump(await readFile(resolve(args.users), "utf8"), args.users).get("usuarios_maso") ?? [];
  if (!notes.length) throw new UsageError(`Nenhuma linha de ${TABLE} em ${args.input}.`);
  log(`Lidos: ${notes.length} registros do bloco de notas, ${users.length} pessoas do MASO.`);
  const model = buildModel({ notes, users }, { company, author, key });
  const out = resolve(args.out);
  await mkdir(join(out, "imagens"), { recursive: true });
  await writeFile(join(out, "01-conferencia.sql"), renderPreview(model, { company, author }));
  await writeFile(join(out, "02-importacao.sql"), renderImport(model, { company, author }));
  for (const [id, bytes] of model.blobs) await writeFile(join(out, "imagens", id), bytes);
  await writeFile(join(out, "arquivos.json"), JSON.stringify({ bucket: BUCKET, files: model.files }, null, 1));
  log(`Notas: ${model.notes.length}; versões: ${model.versions.length}; secretos: ${model.secrets.length}; imagens: ${model.images.length}.`);
  log(`Fora já no arquivo: ${JSON.stringify(model.skipped)}`);
  log(`Clientes com "senha" que ficou em texto: ${model.unrecognized.length}.`);
  log(`Arquivos em ${out}: 01-conferencia.sql, 02-importacao.sql, arquivos.json (${model.files.length} imagens para o --send).`);
  return model;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof UsageError ? e.message : e.stack);
    process.exit(1);
  });
