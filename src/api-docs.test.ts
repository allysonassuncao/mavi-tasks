import { describe, expect, it } from "vitest";
import { snippet } from "./ApiDocs";

const base = "https://app.test/api/v1";
const post = {
  id: "x",
  method: "POST" as const,
  path: "/clients/{id}/products",
  title: "",
  about: null,
  body: { products: ["SEO"], active: true, note: "it's" },
  status: "200 OK",
  response: {},
};
const get = { ...post, method: "GET" as const, path: "/clients", body: undefined, query: { email: "a@b.com" } };

describe("exemplos da documentação da API", () => {
  it("cURL: POST com corpo JSON e aspas simples escapadas", () => {
    const s = snippet("curl", base, post);
    expect(s).toMatch(/^curl -X POST "https:\/\/app\.test\/api\/v1\/clients\/[0-9a-f-]{36}\/products"/);
    expect(s).toContain('-H "Authorization: Bearer $WORKSPACE_API_KEY"');
    expect(s).toContain("it'\\''s");
  });
  it("GET leva os parâmetros na URL e nenhum corpo", () => {
    const s = snippet("curl", base, get);
    expect(s).toContain(`"${base}/clients?email=a%40b.com"`);
    expect(s).not.toContain("-d ");
    expect(snippet("js", base, get)).not.toContain("body:");
  });
  it("Python usa True/False e json=", () => {
    const s = snippet("python", base, post);
    expect(s).toContain("requests.post(");
    expect(s).toContain('"active": True');
    expect(s).toContain("json={");
  });
});
