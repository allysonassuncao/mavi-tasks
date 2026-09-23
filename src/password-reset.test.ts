import { describe, expect, it } from "vitest";
import { passwordResetError } from "./profile";

describe("passwordResetError", () => {
  it("diz quantos segundos esperar quando o Supabase informa", () => {
    expect(
      passwordResetError({
        status: 429,
        code: "over_email_send_rate_limit",
        message:
          "For security purposes, you can only request this after 42 seconds.",
      }),
    ).toBe("Por segurança, aguarde 42 segundos antes de pedir outro link.");
  });

  it("explica o limite de envio sem prazo definido", () => {
    expect(
      passwordResetError({ status: 429, message: "email rate limit exceeded" }),
    ).toMatch(/Muitos pedidos/);
  });

  it("aponta e-mail inválido", () => {
    expect(
      passwordResetError({ code: "validation_failed", message: "x" }),
    ).toBe("Confira o e-mail digitado.");
  });

  it("não expõe detalhes técnicos nos demais erros", () => {
    const msg = passwordResetError({ message: "Error sending recovery email" });
    expect(msg).not.toMatch(/SMTP|Error/);
    expect(msg).toMatch(/administrador/);
  });
});
