import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const env: Record<string, string | undefined> = {};
vi.mock("../src/config/env.js", () => ({ env }));

const { emsPost, EmsHttpError, IntegrationDisabled, integrationEnabled } = await import("../src/services/emsClient.js");
const { signRequest } = await import("../src/lib/signing.js");

const SECRET = "s".repeat(40);
const fetchMock = vi.fn();

beforeEach(() => {
  env.EMS_API_URL = "https://ems.example.test";
  env.INTEGRATION_SECRET = SECRET;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("emsPost", () => {
  it("posts a signed body to the DIS integration path", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const out = await emsPost("/events", { id: "e1" });
    expect(out).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://ems.example.test/api/integrations/dis/events");
    const ts = init.headers["X-DIS-Timestamp"];
    expect(ts).toMatch(/^\d+$/);
    expect(init.headers["X-DIS-Signature"]).toBe(signRequest(SECRET, ts, "POST", "/api/integrations/dis/events", init.body));
    expect(init.body).toBe(JSON.stringify({ id: "e1" }));
  });
  it("throws on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(emsPost("/events", {})).rejects.toThrow(/EMS 500/);
  });
  it("throws a typed EmsHttpError carrying the status", async () => {
    fetchMock.mockResolvedValue(new Response("bad", { status: 400 }));
    const err = await emsPost("/events", {}).catch((e) => e);
    expect(err).toBeInstanceOf(EmsHttpError);
    expect(err.status).toBe(400);
  });
  it("strips trailing slashes from EMS_API_URL", async () => {
    env.EMS_API_URL = "https://ems.example.test//";
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await emsPost("/events", {});
    expect(fetchMock.mock.calls[0]![0]).toBe("https://ems.example.test/api/integrations/dis/events");
  });
  it("throws IntegrationDisabled when unconfigured", async () => {
    env.EMS_API_URL = undefined;
    expect(integrationEnabled()).toBe(false);
    await expect(emsPost("/events", {})).rejects.toBeInstanceOf(IntegrationDisabled);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
