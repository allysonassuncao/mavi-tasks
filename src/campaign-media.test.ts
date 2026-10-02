import { describe, expect, it } from "vitest";
import { canRelease, cycleFit, demoMediaRoom, runway, type MediaRoom } from "./campaign-media";

const room = (over: Partial<MediaRoom> = {}): MediaRoom => ({
  ...demoMediaRoom({ id: "k1", client: "Vittalium", product: "Make Ads" }, []),
  balance: 4000,
  reserved: 3500,
  available: 500,
  reservations: [
    {
      cycle_id: "y1",
      campaign_id: "c1",
      campaign_name: "Motion - Meta",
      start_date: "2026-10-01",
      end_date: "2026-10-30",
      budget: 3000,
      spent: 1000,
      remaining: 2000,
    },
    {
      cycle_id: "y2",
      campaign_id: "c2",
      campaign_name: "Motion - Google",
      start_date: "2026-10-01",
      end_date: "2026-10-30",
      budget: 1500,
      spent: 0,
      remaining: 1500,
    },
  ],
  ...over,
});
const today = "2026-10-02";

describe("cycleFit", () => {
  it("a new cycle must fit the available", () => {
    expect(cycleFit(room(), { id: null, end_date: "2026-11-30", budget: 500 }, today)).toMatchObject({
      need: 500,
      available: 500,
      shortfall: 0,
      free: false,
    });
    expect(cycleFit(room(), { id: null, end_date: "2026-11-30", budget: 800 }, today).shortfall).toBe(300);
  });
  it("an ended cycle reserves nothing", () => {
    expect(cycleFit(room(), { id: null, end_date: "2026-10-01", budget: 9000 }, today)).toMatchObject({
      shortfall: 0,
      free: true,
    });
  });
  it("on an edit only the increase counts, with the cycle's own spend", () => {
    // y1: spent 1000, reserved 2000; the available without it is 2500.
    expect(cycleFit(room(), { id: "y1", end_date: "2026-10-30", budget: 2800 }, today).free).toBe(true);
    expect(cycleFit(room(), { id: "y1", end_date: "2026-10-30", budget: 3500 }, today)).toMatchObject({
      need: 2500,
      available: 2500,
      shortfall: 0,
    });
    expect(cycleFit(room(), { id: "y1", end_date: "2026-10-30", budget: 3600 }, today).shortfall).toBe(100);
  });
  it("an overbooked account asks for everything missing", () => {
    const over = room({ available: -500 });
    expect(cycleFit(over, { id: null, end_date: "2026-11-30", budget: 1000 }, today).shortfall).toBe(1500);
  });
});

describe("canRelease", () => {
  it("leaders release up to the cap", () => {
    expect(canRelease(room({ override_cap: 1000 }), 1000)).toBe(true);
    expect(canRelease(room({ override_cap: 1000 }), 1000.01)).toBe(false);
    expect(canRelease(room({ override_cap: 0 }), 10)).toBe(false);
    expect(canRelease(room({ can_override: false }), 10)).toBe(false);
  });
});

describe("runway", () => {
  it("days the balance lasts at the last week's pace", () => {
    expect(runway(room({ daily: 0 }))).toBeNull();
    expect(runway(room({ daily: 150 }))).toBe(26);
    expect(runway(room({ balance: -10, daily: 150 }))).toBe(0);
  });
});
