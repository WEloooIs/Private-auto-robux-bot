import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { StarvellReadClient } from "./readClient";

describe("StarvellReadClient.getProfile", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("maps balance and fills missing fields with 0 while warning", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ balance: { available: "10" } }),
    } as any);

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const client = new StarvellReadClient("session=abc", logger);
    const profile = await client.getProfile();

    expect(profile.available).toBe(10);
    expect(profile.pending).toBe(0);
    expect(profile.frozen).toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("throws when profile cannot be fetched", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => "",
    } as any);

    const client = new StarvellReadClient("session=abc", { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    await expect(client.getProfile()).rejects.toThrow("STARVELL_PROFILE_UNAVAILABLE");
  });
});
