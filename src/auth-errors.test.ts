import { describe, expect, it } from "vitest";
import { authErrorMessage } from "./auth-errors";

describe("erros de login em português", () => {
  it("pelo código do Supabase", () => {
    expect(
      authErrorMessage({
        name: "AuthApiError",
        code: "invalid_credentials",
        message: "Invalid login credentials",
        status: 400,
      }),
    ).toBe("E-mail ou senha incorretos.");
    expect(authErrorMessage({ code: "email_not_confirmed" })).toMatch(
      /ainda não foi confirmado/,
    );
    expect(authErrorMessage({ code: "weak_password" })).toMatch(/fraca/);
    expect(authErrorMessage({ code: "same_password" })).toMatch(/diferente/);
  });
  it("pela mensagem, quando não há código", () => {
    expect(authErrorMessage({ message: "Invalid login credentials" })).toBe(
      "E-mail ou senha incorretos.",
    );
    expect(
      authErrorMessage({
        message:
          "For security purposes, you can only request this after 37 seconds.",
      }),
    ).toBe("Por segurança, aguarde 37 segundos antes de tentar de novo.");
    expect(
      authErrorMessage({ message: "Request rate limit reached", status: 429 }),
    ).toMatch(/Muitas tentativas/);
    expect(
      authErrorMessage({
        message: "Password should be at least 6 characters.",
      }),
    ).toMatch(/fraca/);
  });
  it("sem internet", () => {
    for (const message of [
      "Failed to fetch",
      "Load failed",
      "NetworkError when attempting to fetch resource.",
    ])
      expect(
        authErrorMessage({ name: "AuthRetryableFetchError", message }),
      ).toMatch(/Sem conexão/);
  });
  it("nunca mostra o inglês do Supabase; mantém as mensagens do app", () => {
    expect(
      authErrorMessage({
        name: "AuthApiError",
        message: "Something we never saw",
        status: 400,
      }),
    ).toMatch(/^Não foi possível concluir agora/);
    expect(
      authErrorMessage(
        Error("A conexão com Supabase ainda não foi configurada."),
      ),
    ).toBe("A conexão com Supabase ainda não foi configurada.");
  });
});
