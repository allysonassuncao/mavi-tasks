// Carrega cada módulo do servidor (api/*.ts) sozinho, num processo próprio,
// como o Node faz na Vercel. Um import circular que só quebra numa ordem
// (um módulo lendo, ao carregar, um valor de outro que ainda não terminou)
// derruba a função inteira em produção, mas passa nos testes do vitest, que
// carregam em outra ordem. Foi o que aconteceu com IDENTITY_PARAMS em
// 07/10/2026 (corrigido em c4114c6).
import { spawn } from "node:child_process";
import { readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const files = readdirSync("api")
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => resolve("api", f));
const dir = mkdtempSync(join(tmpdir(), "mavi-imports-"));
const probe = join(dir, "probe.mts");
writeFileSync(
  probe,
  `const m = process.argv[2];\ntry { await import(m); } catch (e) { console.error(String(e?.stack ?? e).split("\\n").slice(0, 3).join("\\n")); process.exit(1); }\nprocess.exit(0);\n`,
);
const tsx = resolve("node_modules/.bin/tsx");
const run = (file) =>
  new Promise((done) => {
    let err = "";
    const p = spawn(tsx, [probe, file], { env: { ...process.env, VERCEL: "" }, stdio: ["ignore", "ignore", "pipe"] });
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => done({ file, ok: code === 0, err }));
  });
const results = [];
const queue = [...files];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (queue.length) results.push(await run(queue.shift()));
  }),
);
const bad = results.filter((r) => !r.ok);
for (const r of bad) console.error(`FAIL ${r.file.replace(`${process.cwd()}/`, "")}\n${r.err.trim()}\n`);
console.log(`${results.length - bad.length}/${results.length} módulos carregam sozinhos.`);
process.exit(bad.length ? 1 : 0);
