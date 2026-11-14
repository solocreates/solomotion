import { dialectFor } from "./runtime";
import { classify } from "./retry";
import { baseUrlOf, providerDef, type Connection, type ModelDef } from "./providers";

/**
 * The Setup dialog's "Test" button: one tiny real request through the same
 * dialect a chat would use, so a green check means the chat will work — key,
 * endpoint, model name and browser access all at once. A provider that lists
 * models is asked for the list too, so the picker can offer what the key can
 * actually reach.
 */
export interface ConnectionTest {
  ok: boolean;
  ms: number;
  reply?: string;
  error?: string;
  code?: string;
  models?: ModelDef[];
}

export async function testConnection(connection: Connection, model: string, signal?: AbortSignal): Promise<ConnectionTest> {
  const started = performance.now();
  const def = providerDef(connection.providerId);
  if (def && !def.dialect) return probeMediaProvider(connection, started, signal);
  let models: ModelDef[] | undefined;
  try {
    const dialect = dialectFor(connection);
    if (def?.listsModels) models = await dialect.listModels(connection, signal).catch(() => undefined);
    const res = await dialect.run(
      {
        connection,
        model,
        system: "You are a connection check. Reply with the single word: ready",
        messages: [{ id: "t", role: "user", parts: [{ type: "text", text: "ping" }], createdAt: Date.now() }],
        tools: [],
        effort: "low",
        maxOutputTokens: 2048,
        signal: signal ?? new AbortController().signal,
      },
      () => {},
    );
    const reply = res.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("").trim();
    return { ok: true, ms: Math.round(performance.now() - started), reply: reply.slice(0, 80), models };
  } catch (err) {
    const e = classify(err);
    return { ok: false, ms: Math.round(performance.now() - started), error: e.message, code: e.code, models };
  }
}

/**
 * A media-only provider has nothing to chat with, so the check is one cheap
 * AUTHENTICATED request that creates nothing and costs nothing: the key is
 * right, the endpoint answers, and the browser is allowed to reach it.
 */
async function probeMediaProvider(c: Connection, started: number, signal?: AbortSignal): Promise<ConnectionTest> {
  const key = c.values.apiKey ?? "";
  const done = (ok: boolean, reply?: string, error?: string, code?: string): ConnectionTest => ({ ok, ms: Math.round(performance.now() - started), reply, error, code });
  try {
    let res: Response;
    if (c.providerId === "elevenlabs") {
      res = await fetch(`${baseUrlOf(c)}/models`, { headers: { "xi-api-key": key }, signal });
      // A key scoped away from this endpoint is still a valid key.
      if (res.status === 401 && /missing_permissions/.test(await res.clone().text())) return done(true, "key accepted (limited scope)");
    } else if (c.providerId === "fal") {
      // Asks for an upload slot and never uses it.
      res = await fetch("https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3", {
        method: "POST",
        headers: { authorization: `Key ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ content_type: "text/plain", file_name: "connection-check.txt" }),
        signal,
      });
    } else return done(false, undefined, "Nothing to test for this provider.");
    if (res.ok) return done(true, "key accepted");
    const e = classify({ status: res.status, message: (await res.text()).slice(0, 300) });
    return done(false, undefined, e.message, e.code);
  } catch (err) {
    const e = classify(err);
    return done(false, undefined, e.message, e.code);
  }
}
