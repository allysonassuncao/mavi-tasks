import { describe, expect, it } from "vitest";
import { clientNotesEnv, handleClientNotes } from "./_client-notes";
import { unseal } from "./_google";

const KEY = Buffer.alloc(32, 7);
const env = { supabaseUrl: "https://db.test", supabaseKey: "anon", key: KEY };
const company = "00000000-0000-4000-8000-000000000001";
const client = "00000000-0000-4000-8000-000000000020";
const secret = "00000000-0000-4000-8000-000000000030";
const auth = "Bearer user-jwt";

function fakeDb(answer: (name: string, args: any) => [number, unknown]) {
  const calls: { name: string; args: any; auth: string }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const name = url.split("/rpc/")[1];
    const args = JSON.parse(String(init.body));
    calls.push({
      name,
      args,
      auth: (init.headers as Record<string, string>).Authorization,
    });
    const [status, body] = answer(name, args);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe("secretos das anotações", () => {
  it("cifra o valor antes do banco, com o login da pessoa", async () => {
    const db = fakeDb(() => [200, { id: secret, label: "Senha do Meta" }]);
    const r = await handleClientNotes(
      { action: "create", company, client, label: "Senha do Meta", value: "s3nh@" },
      auth,
      env,
      db.impl,
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: secret, label: "Senha do Meta" });
    const [call] = db.calls;
    expect(call.name).toBe("client_note_secret_create");
    expect(call.auth).toBe(auth);
    expect(call.args.p_sealed).toMatch(/^v1:/);
    expect(JSON.stringify(call.args)).not.toContain("s3nh@");
    expect(unseal(KEY, call.args.p_sealed)).toBe("s3nh@");
  });

  it("abre o valor só depois do banco conferir e registrar", async () => {
    const { seal } = await import("./_google");
    const sealed = seal(KEY, "token-123");
    const db = fakeDb(() => [200, { id: secret, label: "Token", sealed }]);
    const r = await handleClientNotes(
      { action: "open", secret, note: "x", how: "copy" },
      auth,
      env,
      db.impl,
    );
    expect(r.body).toEqual({ id: secret, label: "Token", value: "token-123" });
    expect(db.calls[0].args).toEqual({
      p_secret: secret,
      p_note: null,
      p_action: "copy",
    });
  });

  it("repassa a recusa do banco e não decifra", async () => {
    const db = fakeDb(() => [400, { message: "Secreto não encontrado." }]);
    const r = await handleClientNotes(
      { action: "open", secret },
      auth,
      env,
      db.impl,
    );
    expect(r).toEqual({ status: 400, body: { error: "Secreto não encontrado." } });
  });

  it("recusa sem login, sem chave, valor vazio ou longo demais", async () => {
    const db = fakeDb(() => [200, {}]);
    expect((await handleClientNotes({ action: "open", secret }, null, env, db.impl)).status).toBe(401);
    expect(
      (await handleClientNotes({ action: "open", secret }, auth, { ...env, key: null }, db.impl)).status,
    ).toBe(503);
    expect(
      (await handleClientNotes({ action: "create", company, client, label: "x", value: "" }, auth, env, db.impl))
        .status,
    ).toBe(400);
    expect(
      (
        await handleClientNotes(
          { action: "create", company, client, label: "x", value: "a".repeat(4001) },
          auth,
          env,
          db.impl,
        )
      ).status,
    ).toBe(400);
    expect(db.calls).toHaveLength(0);
  });

  it("a chave só vale com 32 bytes", () => {
    expect(clientNotesEnv({ CLIENT_NOTES_KEY: KEY.toString("base64") }).key).toEqual(KEY);
    expect(clientNotesEnv({ CLIENT_NOTES_KEY: "curta" }).key).toBeNull();
    expect(clientNotesEnv({}).key).toBeNull();
  });
});
