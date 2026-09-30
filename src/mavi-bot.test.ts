import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAVI_WEBHOOK,
  clientCodes,
  clientFromEvent,
  inviteMavi,
  maviInvite,
  meetingLink,
} from "./mavi-bot";
import type { Client } from "./types";

const client = (id: string, name: string, archived = false): Client => ({
  id,
  company_id: "c1",
  name,
  email: "",
  color: "",
  archived,
});
const clients = [
  client("1", "Aurora Studio"),
  client("2", "Açaí da Praça"),
  client("3", "Praça"),
  client("4", "Sol", true),
  client("5", "BR"),
  client("6", "2745 - Facilita"),
  client("7", "4316"),
  client("8", "4316 - Daselis antigo"),
  client("9", "9999 - Arquivado", true),
];

describe("Adicionar MAVI", () => {
  it("aceita links de reunião, com ou sem https", () => {
    expect(meetingLink(" https://meet.google.com/abc-defg-hij ")).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
    expect(meetingLink("meet.google.com/abc-defg-hij")).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
    expect(meetingLink("")).toBeNull();
    expect(meetingLink("reunião amanhã")).toBeNull();
    expect(meetingLink("ftp://meet.google.com/x")).toBeNull();
  });

  it("identifica o cliente pelo título, sem acentos nem maiúsculas", () => {
    expect(clientFromEvent(clients, "Alinhamento - AURORA studio")?.id).toBe(
      "1",
    );
    // O nome mais longo vence ("Açaí da Praça" contém "Praça").
    expect(clientFromEvent(clients, "Reunião acai da praca")?.id).toBe("2");
  });

  it("procura na descrição quando o título não diz", () => {
    expect(
      clientFromEvent(clients, "Daily", "Pauta do cliente Praça")?.id,
    ).toBe("3");
  });

  it("só casa palavras inteiras e ignora arquivados e nomes curtos", () => {
    expect(clientFromEvent(clients, "Auroras e estúdios")).toBeNull();
    expect(clientFromEvent(clients, "Reunião no Sol")).toBeNull();
    expect(clientFromEvent(clients, "Time BR")).toBeNull();
  });

  it("lê os códigos de 3 a 5 dígitos do texto", () => {
    expect(clientCodes("(SME) 4316 - Daselis")).toEqual(["4316"]);
    expect(clientCodes("#232 Marcos às 14:30")).toEqual(["232"]);
    expect(clientCodes("123456 e 12 não; 2745-X sim")).toEqual(["2745"]);
  });

  it("identifica o cliente pelo código no título ou na descrição", () => {
    expect(clientFromEvent(clients, "Alinhamento 2745")?.id).toBe("6");
    // Uma data (2026) não é cliente; segue para o próximo código.
    expect(clientFromEvent(clients, "30/09/2026 · 2745")?.id).toBe("6");
    // Quem se chama só pelo código vence.
    expect(clientFromEvent(clients, "(SME) 4316")?.id).toBe("7");
    expect(clientFromEvent(clients, "Reunião", "Cliente #2745")?.id).toBe("6");
    expect(clientFromEvent(clients, "Reunião 9999")).toBeNull();
    expect(clientFromEvent(clients, "Reunião 27450")).toBeNull();
  });

  it("monta o payload com o cliente, quando há", () => {
    expect(maviInvite("a@make.com", "https://meet.google.com/x")).toEqual({
      user_email: "a@make.com",
      link_meet: "https://meet.google.com/x",
      customer_id: null,
      customer_name: null,
    });
    expect(
      maviInvite("a@make.com", "https://meet.google.com/x", clients[0]),
    ).toMatchObject({ customer_id: "1", customer_name: "Aurora Studio" });
  });

  describe("envio", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("faz POST em JSON no webhook", async () => {
      const fetch = vi.fn().mockResolvedValue(new Response("{}"));
      vi.stubGlobal("fetch", fetch);
      const invite = maviInvite("a@make.com", "https://meet.google.com/x");
      await inviteMavi(invite);
      expect(fetch).toHaveBeenCalledWith(
        MAVI_WEBHOOK,
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(invite),
        }),
      );
    });

    it("explica quando o webhook recusa ou não responde", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("", { status: 500 })),
      );
      await expect(
        inviteMavi(maviInvite("a@make.com", "https://meet.google.com/x")),
      ).rejects.toThrow("erro 500");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError()));
      await expect(
        inviteMavi(maviInvite("a@make.com", "https://meet.google.com/x")),
      ).rejects.toThrow("Não foi possível falar com a MAVI");
    });
  });
});
