import { describe, expect, it, vi } from "vitest";

const rpc = vi.fn(async (..._args: unknown[]) => null);
vi.mock("./api", () => ({ rpc: (...args: unknown[]) => rpc(...args) }));
const { describeDevice, logAccess, methodLabel, sessionLength } =
  await import("./access-logs");

describe("describeDevice", () => {
  it("names the browser and the system", () => {
    expect(
      describeDevice(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome no macOS");
    expect(
      describeDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari no iPhone");
    expect(
      describeDevice(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
      ),
    ).toBe("Edge no Windows");
    expect(
      describeDevice(
        "Mozilla/5.0 (Android 15; Mobile; rv:141.0) Gecko/141.0 Firefox/141.0",
      ),
    ).toBe("Firefox no Android");
  });
  it("falls back when the agent is missing or unknown", () => {
    expect(describeDevice(null)).toBe("Dispositivo desconhecido");
    expect(describeDevice("???")).toBe("Dispositivo desconhecido");
  });
});

describe("sessionLength", () => {
  const at = (min: number) =>
    new Date(Date.UTC(2026, 8, 1, 0, min)).toISOString();
  it("reads minutes, hours and days", () => {
    expect(sessionLength(at(0), at(0))).toBe("menos de 1 min");
    expect(sessionLength(at(0), at(45))).toBe("45 min");
    expect(sessionLength(at(0), at(192))).toBe("3 h 12 min");
    expect(sessionLength(at(0), at(120))).toBe("2 h");
    expect(sessionLength(at(0), at(60 * 72))).toBe("3 dias");
  });
});

describe("methodLabel", () => {
  it("translates the Auth methods", () => {
    expect(methodLabel("password")).toBe("Senha");
    expect(methodLabel("recovery")).toBe("Link de recuperação");
    expect(methodLabel(null)).toBe("");
  });
});

describe("logAccess", () => {
  it("calls the database once every 30 minutes per person and space", () => {
    const t = 1_000_000_000;
    expect(logAccess("u1", "c1", t)).toBe(true);
    expect(logAccess("u1", "c1", t + 10 * 60 * 1000)).toBe(false);
    expect(logAccess("u1", "c2", t)).toBe(true);
    expect(logAccess("u2", "c1", t)).toBe(true);
    expect(logAccess("u1", "c1", t + 31 * 60 * 1000)).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(4);
    expect(rpc).toHaveBeenCalledWith("log_access", { p_company: "c1" });
  });
});
