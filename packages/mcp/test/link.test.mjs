/**
 * The shared link, end to end: real bridge processes on a spare port with a
 * throwaway HOME, a fake editor tab, and MCP spoken over each bridge's stdio.
 * What would silently rot here is the choreography — who holds the port, who
 * relays, what happens when the hub's session ends — so that is what is
 * measured, not the helpers.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { mcpIdentity } from "../src/identity.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "../src/cli.mjs");

/**
 * WHO the bridges under test serve. A neutral test product by default; a
 * product's own package runs this file with its identity
 * (`MCP_TEST_IDENTITY=<identity.json>`) and, where it has published older
 * bridges, with its history (`MCP_TEST_HISTORY=1`: those tests run old
 * releases out of git and pair them with this one).
 */
const IDENTITY_FILE = process.env.MCP_TEST_IDENTITY
  ? resolve(process.env.MCP_TEST_IDENTITY)
  :
  (() => {
    const f = join(mkdtempSync(join(tmpdir(), "mcp-identity-")), "identity.json");
    writeFileSync(f, JSON.stringify({ name: "Studio", ns: "studio", webOrigin: "https://app.example.com", port: 7318, sliceExt: ".motion" }));
    return f;
  })();
const ID = mcpIdentity(JSON.parse((await import("node:fs")).readFileSync(IDENTITY_FILE, "utf8")));
const HISTORY = process.env.MCP_TEST_HISTORY === "1" ? false : "runs the product's older published bridges (MCP_TEST_HISTORY=1)";
const spawned = [];
after(() => spawned.forEach((p) => p.kill()));
let port = 7400 + Math.floor(Math.random() * 400);

function env() {
  const home = mkdtempSync(join(tmpdir(), "mcp-home-"));
  writeFileSync(join(home, ID.home), "test-token");
  return { home, port: ++port };
}

/** A bridge process, spoken to as its agent app would. */
function bridge({ home, port }, client = "test-client", cli = CLI, { cwd, quietMs, leaseMs, softWaitMs } = {}) {
  const p = spawn(process.execPath, [cli, "--identity", IDENTITY_FILE], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      [`${ID.envPrefix}_PORT`]: String(port),
      ...(quietMs ? { [`${ID.envPrefix}_QUIET_MS`]: String(quietMs) } : {}),
      ...(leaseMs ? { [`${ID.envPrefix}_LEASE_MS`]: String(leaseMs) } : {}),
      ...(softWaitMs ? { [`${ID.envPrefix}_SOFT_WAIT_MS`]: String(softWaitMs) } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  spawned.push(p);
  let buf = "";
  let seq = 0;
  const waiting = new Map();
  const notes = [];
  p.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      if (msg.id !== undefined) waiting.get(msg.id)?.(msg);
      else notes.push(msg);
    }
  });
  let err = "";
  p.stderr.on("data", (d) => (err += d));
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = ++seq;
      waiting.set(id, resolve);
      p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const nextId = () => seq + 1;
  const ready = rpc("initialize", { clientInfo: { name: client } });
  return {
    p,
    stderr: () => err,
    ready,
    call: async (name, args = {}, meta) => (await rpc("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) })).result,
    nextId,
    notes,
    cancel: (requestId) => p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } })}\n`),
    tools: async () => (await rpc("tools/list")).result.tools.map((t) => t.name),
    // A session ending closes the bridge's stdin; a bridge must exit on that alone (3.x did not — `kill` is for those).
    end: (kill = false) =>
      new Promise((r) => {
        if (p.exitCode !== null) return r();
        p.once("exit", r);
        p.stdin.end();
        if (kill) p.kill();
      }),
  };
}

/**
 * A fake editor tab: answers every call with the call's own name and session,
 * unless `onCall` takes it (return true) — then `onCall(msg, ws)` answers.
 */
function tab({ port }, onCall) {
  const seen = [];
  let sessions = [];
  const open = () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: "http://localhost:3000" } });
      ws.on("open", () =>
        ws.send(JSON.stringify({ kind: "hello", token: "", app: "Studio test", tools: [{ name: "doc_overview", description: "", inputSchema: { type: "object" } }] })),
      );
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.kind === "welcome") resolve(ws);
        if (msg.kind === "sessions") sessions = msg.sessions;
        if (msg.kind !== "call") seen.push(msg);
        if (msg.kind === "call") {
          seen.push(msg);
          if (onCall?.(msg, ws)) return;
          ws.send(JSON.stringify({ kind: "result", id: msg.id, content: [{ type: "text", text: `${msg.name} from ${msg.session?.client}` }] }));
        }
      });
      ws.on("error", reject);
    });
  return { open, seen, sessions: () => sessions };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (r) => r.content[0].text;

test("every session reaches the tab at once, each call tagged with its session", async () => {
  const e = env();
  const a = bridge(e, "session-a");
  await a.ready;
  await sleep(300);
  const b = bridge(e, "session-b");
  await b.ready;
  const t = tab(e);
  await t.open();
  const [ra, rb] = await Promise.all([a.call("doc_overview"), b.call("doc_overview")]);
  assert.equal(textOf(ra), "doc_overview from session-a");
  assert.equal(textOf(rb), "doc_overview from session-b");
  await sleep(100);
  assert.deepEqual(t.sessions().map((s) => s.client).sort(), ["session-a", "session-b"]);
  await Promise.all([a.end(), b.end()]);
});

test("when the hub's session ends, another becomes the hub and the tab finds it", async () => {
  const e = env();
  const a = bridge(e, "first");
  await a.ready;
  await sleep(300);
  const b = bridge(e, "second");
  await b.ready;
  const t = tab(e);
  await t.open();
  assert.equal(textOf(await b.call("doc_overview")), "doc_overview from second");
  await a.end(); // the hub's agent app closed the session
  await sleep(400);
  await t.open(); // the tab knocks again
  assert.equal(textOf(await b.call("doc_overview")), "doc_overview from second");
  await b.end();
});

test("a new session lists the last editor's tools before its tab answers, and a call waits for the tab", async () => {
  const e = env();
  const a = bridge(e, "linked-once");
  await a.ready;
  const t = tab(e);
  await t.open();
  await a.call("doc_overview");
  await a.end();
  await sleep(200);
  const b = bridge(e, "fresh");
  await b.ready;
  assert.deepEqual(await b.tools(), [ID.statusTool, "doc_overview"]);
  const pending = b.call("doc_overview");
  await sleep(500);
  await t.open();
  assert.equal(textOf(await pending), "doc_overview from fresh");
  await b.end();
});

test("an older 3.x bridge holding the port is asked to hand over when this session calls", { skip: HISTORY }, async () => {
  const e = env();
  const { execFileSync } = await import("node:child_process");
  const { rmSync } = await import("node:fs");
  // Beside this file, so it finds ws and ../package.json the way the real one does.
  const oldCli = join(dirname(fileURLToPath(import.meta.url)), ".old-cli.mjs");
  writeFileSync(oldCli, execFileSync("git", ["show", "v4.1.0:packages/mcp/src/cli.mjs"], { cwd: dirname(CLI) }));
  try {
    const old = bridge(e, "old", oldCli);
    await old.ready; // its session never called a tool, so it is idle
    await sleep(300);
    const b = bridge(e, "new");
    await b.ready;
    const t = tab(e);
    const pending = b.call("doc_overview");
    await sleep(800);
    await t.open();
    assert.equal(textOf(await pending), "doc_overview from new");
    // The old bridge, asking back, is declined: yielding would cut off every joined session.
    assert.match(textOf(await old.call("doc_overview")), new RegExp(`restart this session's ${ID.name} MCP server`));
    await Promise.all([old.end(true), b.end()]);
  } finally {
    rmSync(oldCli, { force: true });
  }
});

const answer = (ws, id, text) => ws.send(JSON.stringify({ kind: "result", id, content: [{ type: "text", text }] }));

test("a call the tab keeps reporting on outlives the quiet window; a silent one is cancelled at the tab", async () => {
  const e = env();
  const a = bridge(e, "exporter", CLI, { quietMs: 400 });
  await a.ready;
  const t = tab(e, (msg, ws) => {
    if (msg.name !== "export_render") return false;
    if (msg.input.silent) return true; // never answers, never reports
    let n = 0;
    const beat = setInterval(() => {
      ws.send(JSON.stringify({ kind: "progress", id: msg.id, text: `Exporting · ${++n * 10}%` }));
      if (n === 6) {
        clearInterval(beat);
        answer(ws, msg.id, "exported");
      }
    }, 200);
    return true;
  });
  await t.open();
  // 1.2 s of work, three times the quiet window — alive because it reports. The client asked to hear it.
  assert.equal(textOf(await a.call("export_render", {}, { progressToken: "p1" })), "exported");
  const heard = a.notes.filter((n) => n.method === "notifications/progress");
  assert.equal(heard.length, 6);
  assert.equal(heard.at(-1).params.message, "Exporting · 60%");
  // Silence: the agent is told, and the tab is told to stop.
  const r = await a.call("export_render", { silent: true });
  assert.match(textOf(r), /went quiet/);
  const silentCall = t.seen.find((m) => m.kind === "call" && m.input.silent);
  await sleep(50);
  assert.ok(t.seen.some((m) => m.kind === "cancel" && m.id === silentCall.id));
  await a.end();
});

test("an agent's cancel reaches the tab through the hub", async () => {
  const e = env();
  const hubSession = bridge(e, "hub");
  await hubSession.ready;
  await sleep(300);
  const b = bridge(e, "member");
  await b.ready;
  const t = tab(e, (msg) => msg.name === "export_render");
  await t.open();
  const id = b.nextId();
  const pending = b.call("export_render", {});
  await sleep(200);
  b.cancel(id);
  assert.match(textOf(await pending), /cancelled/);
  await sleep(100);
  const call = t.seen.find((m) => m.kind === "call");
  assert.ok(t.seen.some((m) => m.kind === "cancel" && m.id === call.id));
  await Promise.all([hubSession.end(), b.end()]);
});

test("saveTo lands the tab's file in the calling session's folder, even when another session holds the tab", async () => {
  const e = env();
  const { readFileSync, existsSync } = await import("node:fs");
  const hubSession = bridge(e, "hub");
  await hubSession.ready;
  await sleep(300);
  const work = realpathSync(mkdtempSync(join(tmpdir(), "mcp-work-")));
  const b = bridge(e, "member", CLI, { cwd: work });
  await b.ready;
  const bytes = Buffer.from("a".repeat(5000) + "b".repeat(5000));
  const t = tab(e, (msg, ws) => {
    if (msg.name !== "export_render") return false;
    // In three chunks, the way the editor streams a long export.
    const parts = [bytes.subarray(0, 4000), bytes.subarray(4000, 8000), bytes.subarray(8000)];
    parts.forEach((part, seq) =>
      ws.send(JSON.stringify({ kind: "file", id: msg.id, path: msg.input.saveTo, name: "reel.mp4", seq, data: part.toString("base64"), last: seq === 2 })),
    );
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.kind === "filed" && m.id === msg.id) answer(ws, msg.id, JSON.stringify(m));
    });
    return true;
  });
  await t.open();
  const filed = JSON.parse(textOf(await b.call("export_render", { saveTo: "renders/" })));
  assert.equal(filed.path, join(work, "renders", "reel.mp4"));
  assert.deepEqual(readFileSync(filed.path), bytes);
  assert.equal(existsSync(`${filed.path}.part`), false);
  await Promise.all([hubSession.end(), b.end()]);
});

// ── 3.8: mixed versions, handover, takeover, file IO per session, export jobs ──

const { execFileSync } = await import("node:child_process");
const { mkdirSync, rmSync, readFileSync, existsSync, copyFileSync } = await import("node:fs");
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
/** This code's release, as its package says — what "this bridge" reports. */
const THIS = JSON.parse(readFileSync(join(TEST_DIR, "../package.json"), "utf8")).version;
const THIS_RE = THIS.replace(/\./g, "\\.");
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/**
 * A bridge of another release, laid out the way a real one is
 * (`…/packages/mcp/src/cli.mjs` beside its package.json), under this folder so
 * it finds `ws`. `from`: a git ref for an old release; omitted = this code.
 */
function release(version, from) {
  const root = join(TEST_DIR, `.v${version}`);
  const src = join(root, "packages/mcp/src");
  mkdirSync(src, { recursive: true });
  if (from) writeFileSync(join(src, "cli.mjs"), execFileSync("git", ["show", `${from}:packages/mcp/src/cli.mjs`], { cwd: TEST_DIR }));
  else {
    copyFileSync(CLI, join(src, "cli.mjs"));
    copyFileSync(join(dirname(CLI), "identity.mjs"), join(src, "identity.mjs"));
  }
  writeFileSync(join(root, "packages/mcp/package.json"), JSON.stringify({ version }));
  made.push(root);
  return join(src, "cli.mjs");
}

/**
 * A tab of this app: follows `moved` on a second socket, answers each call on
 * the socket it came on. `slow` names a call it answers after 600 ms — one that
 * is in flight across a handover.
 */
const tabs = [];
after(() => tabs.forEach((t) => t.stop()));
function followingTab({ port }, onCall, hello = {}) {
  const sockets = [];
  const seen = [];
  const all = [];
  let stopped = false;
  const open = () =>
    new Promise((resolve) => {
      if (stopped) return resolve(null);
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: "http://localhost:3000" } });
      all.push(ws);
      ws.on("open", () =>
        ws.send(JSON.stringify({ kind: "hello", token: "", app: "Studio test", bridge: THIS, features: ["moved"], tools: [{ name: "doc_overview", description: "", inputSchema: { type: "object" } }], ...hello })),
      );
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        seen.push(msg);
        if (msg.kind === "welcome") {
          sockets.push(ws);
          resolve(ws);
        }
        if (msg.kind === "moved") setTimeout(open, 10);
        if (msg.kind !== "call") return;
        if (onCall?.(msg, ws)) return;
        const reply = () => answer(ws, msg.id, `${msg.name} from ${msg.session?.client}`);
        if (msg.input?.slow) setTimeout(reply, 600);
        else reply();
      });
      ws.on("error", () => !stopped && setTimeout(() => open().then(resolve), 200));
      // A legacy hub's tab never hears `moved`; it knocks again, as the real tab does.
      ws.on("close", (code) => !stopped && code !== 1000 && code !== 4000 && sockets.at(-1) === ws && setTimeout(open, 250));
    });
  const t = {
    open,
    sockets,
    seen,
    stop() {
      stopped = true;
      all.forEach((ws) => ws.terminate());
    },
  };
  tabs.push(t);
  return t;
}

const status = async (b, args) => textOf(await b.call(ID.statusTool, args));
const holdsLink = (t) => /it holds the link \(the hub\)/.test(t);

test("a newer bridge joining an older hub is handed the hub; a call in flight finishes; no session loses its link", async () => {
  const e = env();
  const older = bridge(e, "older"); // this code
  await older.ready;
  await sleep(300);
  const t = followingTab(e);
  await t.open();
  const inFlight = older.call("doc_overview", { slow: true });
  await sleep(50);
  const newer = bridge(e, "newer", release("3.99.0"));
  await newer.ready;
  assert.equal(textOf(await inFlight), "doc_overview from older"); // answered on the old path
  await sleep(600);
  assert.ok(holdsLink(await status(newer)), "the newer bridge holds the hub");
  assert.ok(!holdsLink(await status(older)));
  assert.equal(t.sockets.length, 2, "the tab followed on a second socket");
  const [a, b] = await Promise.all([older.call("doc_overview"), newer.call("doc_overview")]);
  assert.equal(textOf(a), "doc_overview from older");
  assert.equal(textOf(b), "doc_overview from newer");
  // Every bridge says what it is; the older one is told it is stale.
  const s = await status(older);
  assert.match(s, /Bridges on the link \(2\)/);
  assert.match(s, /3\.99\.0/);
  assert.match(s, new RegExp(`PID ${older.p.pid} runs ${THIS_RE}, 3\\.99\\.0 is out`));
  await Promise.all([older.end(), newer.end()]);
});

test("hard takeover works from either side, reports whom it took from, and keeps both sessions", async () => {
  const e = env();
  const a = bridge(e, "a", release("3.99.0")); // the newer one holds the hub; no soft handover to an older bridge
  await a.ready;
  await sleep(300);
  const b = bridge(e, "b");
  await b.ready;
  const t = followingTab(e);
  await t.open();
  await b.call("doc_overview");
  assert.ok(holdsLink(await status(a)));
  const took = await status(b, { takeOver: true });
  assert.match(took, new RegExp(`Took over from PID ${a.p.pid} · 3\\.99\\.0`));
  assert.ok(holdsLink(took));
  assert.equal(textOf(await a.call("doc_overview")), "doc_overview from a");
  // And back the other way.
  const back = await status(a, { takeOver: true });
  assert.match(back, new RegExp(`Took over from PID ${b.p.pid} · ${THIS_RE}`));
  const [ra, rb] = await Promise.all([a.call("doc_overview"), b.call("doc_overview")]);
  assert.equal(textOf(ra), "doc_overview from a");
  assert.equal(textOf(rb), "doc_overview from b");
  assert.match(await status(b, { takeOver: true }), /Took over/);
  assert.match(await status(b, { takeOver: true }), new RegExp(`already holds the ${ID.name} link`));
  await Promise.all([a.end(), b.end()]);
});

test("a hub before 3.7 refuses saveTo with the way out; a hard takeover stops it and this session keeps its link", { skip: HISTORY }, async () => {
  const e = env();
  const old = bridge(e, "old", release("3.6.0", "v4.18.0"));
  await old.ready;
  await sleep(300);
  const b = bridge(e, "new");
  await b.ready;
  const t = followingTab(e);
  await t.open();
  assert.equal(textOf(await b.call("doc_overview")), "doc_overview from new");
  const refused = await b.call("export_render", { saveTo: "x.mp4" });
  assert.match(textOf(refused), new RegExp(`PID ${old.p.pid} · before 3\\.7 · repo`));
  assert.match(textOf(refused), /takeOver: true/);
  assert.match(await status(b), /cannot list the other bridges/);
  const took = await status(b, { takeOver: true });
  assert.match(took, new RegExp(`Took over from PID ${old.p.pid} · before 3\\.7`));
  assert.match(took, /process was stopped/);
  assert.ok(holdsLink(took));
  await sleep(100);
  assert.notEqual(old.p.exitCode ?? old.p.signalCode, null, "the old bridge was stopped");
  assert.equal(textOf(await b.call("doc_overview")), "doc_overview from new");
  await b.end();
});

test("a 3.7 hub still joins the link: a 3.8 session's localPath (inside api_batch too) and saveTo work through it", { skip: HISTORY }, async () => {
  const e = env();
  const old = bridge(e, "old", release("3.7.0", "v4.22.0"));
  await old.ready;
  await sleep(300);
  const work = realpathSync(mkdtempSync(join(tmpdir(), "mcp-work-")));
  writeFileSync(join(work, "vo.wav"), "RIFF-voice");
  const b = bridge(e, "new", CLI, { cwd: work });
  await b.ready;
  const t = followingTab(e, (msg, ws) => {
    if (msg.name === "api_batch") return answer(ws, msg.id, Buffer.from(msg.input.calls[0].input.localFile.base64, "base64").toString()), true;
    if (msg.name !== "export_render") return false;
    ws.send(JSON.stringify({ kind: "file", id: "f1", session: msg.session.id, path: msg.input.saveTo, name: "a.mp4", seq: 0, data: Buffer.from("film").toString("base64"), last: true }));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.kind === "filed" && m.id === "f1") answer(ws, msg.id, JSON.stringify(m));
    });
    return true;
  });
  await t.open();
  const batch = await b.call("api_batch", { calls: [{ command: "media.import", input: { localPath: "vo.wav" } }] });
  assert.equal(textOf(batch), "RIFF-voice");
  const filed = JSON.parse(textOf(await b.call("export_render", { saveTo: "out/" })));
  assert.equal(readFileSync(filed.path, "utf8"), "film");
  await Promise.all([old.end(true), b.end()]);
});

test("seven exports sent together from two sessions queue as jobs; each file is written by the bridge of the session that asked", async () => {
  const e = env();
  const hubWork = realpathSync(mkdtempSync(join(tmpdir(), "mcp-hub-")));
  const memberWork = realpathSync(mkdtempSync(join(tmpdir(), "mcp-member-")));
  const hubSession = bridge(e, "hub", CLI, { cwd: hubWork });
  await hubSession.ready;
  await sleep(300);
  const member = bridge(e, "member", CLI, { cwd: memberWork });
  await member.ready;
  // The app's render line, faked: export_render answers at once with a job id;
  // the jobs finish one at a time, 80 ms apart, each file addressed to its session
  // AFTER its call has answered; export_wait answers when its jobs are done.
  const jobs = [];
  const waits = [];
  let running = false;
  let ws0;
  const pump = () => {
    if (running) return;
    const job = jobs.find((j) => j.state === "queued");
    if (!job) return;
    running = true;
    job.state = "running";
    setTimeout(() => {
      ws0.send(JSON.stringify({ kind: "file", id: `f-${job.id}`, session: job.session, path: job.saveTo, name: `${job.id}.mp4`, seq: 0, data: Buffer.from(job.id).toString("base64"), last: true }));
    }, 80);
  };
  const t = followingTab(e, (msg, ws) => {
    ws0 = ws;
    if (msg.name === "export_render") {
      const job = { id: `job${jobs.length}`, session: msg.session.id, saveTo: msg.input.saveTo, state: "queued" };
      jobs.push(job);
      answer(ws, msg.id, JSON.stringify({ jobId: job.id, state: "queued" }));
      pump();
      return true;
    }
    if (msg.name === "export_wait") {
      waits.push({ ws, id: msg.id, ids: msg.input.jobIds });
      return true;
    }
    return false;
  });
  const ws = await t.open();
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.kind !== "filed") return;
    const job = jobs.find((j) => `f-${j.id}` === m.id);
    job.state = "done";
    job.path = m.path;
    running = false;
    pump();
    for (const w of waits.filter((w) => w.ids.every((id) => jobs.find((j) => j.id === id).state === "done"))) {
      waits.splice(waits.indexOf(w), 1);
      answer(w.ws, w.id, JSON.stringify(w.ids.map((id) => jobs.find((j) => j.id === id).path)));
    }
  });
  const asks = Array.from({ length: 7 }, (_, i) => (i % 2 ? member : hubSession).call("export_render", { saveTo: "renders/", waitMs: 0 }));
  const answers = (await Promise.all(asks)).map((r) => JSON.parse(textOf(r)));
  assert.equal(new Set(answers.map((a) => a.jobId)).size, 7);
  const mine = (b, parity) => answers.filter((_, i) => i % 2 === parity).map((a) => a.jobId);
  const [hubPaths, memberPaths] = await Promise.all([
    hubSession.call("export_wait", { jobIds: mine(hubSession, 0) }).then((r) => JSON.parse(textOf(r))),
    member.call("export_wait", { jobIds: mine(member, 1) }).then((r) => JSON.parse(textOf(r))),
  ]);
  assert.equal(hubPaths.length, 4);
  assert.equal(memberPaths.length, 3);
  for (const p of hubPaths) assert.ok(p.startsWith(join(hubWork, "renders")) && existsSync(p));
  for (const p of memberPaths) assert.ok(p.startsWith(join(memberWork, "renders")) && existsSync(p));
  // The member's files were written by the member's own bridge, not the hub.
  for (const p of memberPaths) {
    assert.ok(member.stderr().includes(`saved ${p}`));
    assert.ok(!hubSession.stderr().includes(`saved ${p}`));
  }
  await Promise.all([hubSession.end(), member.end()]);
});

test("a hub whose own session stopped calling hands the link to the session that is working", async () => {
  const e = env();
  const idle = bridge(e, "harness", CLI, { leaseMs: 300 }); // like a debug harness nobody drives
  await idle.ready;
  await sleep(300);
  const t = followingTab(e);
  await t.open();
  const worker = bridge(e, "worker");
  await worker.ready;
  await sleep(400);
  assert.equal(textOf(await worker.call("doc_overview")), "doc_overview from worker");
  await sleep(500);
  assert.ok(holdsLink(await status(worker)), "the working session leads now");
  assert.equal(textOf(await idle.call("doc_overview")), "doc_overview from harness");
  await Promise.all([idle.end(), worker.end()]);
});

test("export_wait answers before the client gives up while the tab is stuck mid-frame", async () => {
  const e = env();
  const b = bridge(e, "agent", CLI, { softWaitMs: 400 });
  await b.ready;
  const tools = [{ name: "export_wait", description: "", inputSchema: { type: "object", properties: { jobIds: { type: "array" } } } }];
  // A tab rendering a heavy frame: it hears the call and answers nothing for now.
  const t = followingTab(e, (msg) => msg.name === "export_wait", { tools });
  await t.open();
  await sleep(200);
  const text = textOf(await b.call("export_wait", { jobIds: ["export-7"] }));
  const body = JSON.parse(text);
  assert.equal(body.jobs[0].jobId, "export-7");
  assert.equal(body.jobs[0].state, "running");
  assert.match(body.note, /still running/);
  // The link is untouched: the next call goes straight through.
  assert.equal(textOf(await b.call("doc_overview")), "doc_overview from agent");
  await b.end();
});

test("an idle hub does not move while the tab is rendering", async () => {
  const e = env();
  const idle = bridge(e, "harness", CLI, { leaseMs: 300 });
  await idle.ready;
  await sleep(300);
  const t = followingTab(e);
  const ws = await t.open();
  // A long export is running at the tab.
  ws.send(JSON.stringify({ kind: "state", visible: true, rendering: true }));
  const worker = bridge(e, "worker");
  await worker.ready;
  await sleep(400);
  assert.equal(textOf(await worker.call("doc_overview")), "doc_overview from worker");
  await sleep(500);
  assert.ok(!holdsLink(await status(worker)), "the hub stays put under a render");
  assert.ok(!t.seen.some((m) => m.kind === "moved"), "the tab was never asked to re-link mid-render");
  await Promise.all([idle.end(), worker.end()]);
});

test("an agent's export with no saveTo is written to Downloads by its own bridge; status names the editor's origin, build and visibility", async () => {
  const e = env();
  const hubSession = bridge(e, "hub");
  await hubSession.ready;
  await sleep(300);
  const member = bridge(e, "member");
  await member.ready;
  const tools = [{ name: "export_render", description: "", inputSchema: { type: "object", properties: { saveTo: { type: "string" } } } }];
  const t = followingTab(
    e,
    (msg, ws) => {
      if (msg.name !== "export_render") return false;
      ws.send(JSON.stringify({ kind: "file", id: "f9", session: msg.session.id, path: msg.input.saveTo, name: "cut.mp4", seq: 0, data: Buffer.from("mp4").toString("base64"), last: true }));
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.kind === "filed" && m.id === "f9") answer(ws, msg.id, JSON.stringify(m));
      });
      return true;
    },
    { tools, origin: "http://localhost:3000", dev: true, visible: false },
  );
  await t.open();
  const filed = JSON.parse(textOf(await member.call("export_render", {})));
  assert.equal(filed.path, join(e.home, "Downloads", "cut.mp4"));
  assert.equal(readFileSync(filed.path, "utf8"), "mp4");
  assert.ok(member.stderr().includes(`saved ${filed.path}`));
  const s = await status(member);
  assert.match(s, /Editor: Studio test at http:\/\/localhost:3000/);
  assert.match(s, /DEV build/);
  assert.match(s, /HIDDEN/);
  assert.match(s, /started by /);
  // Shown again: the warning goes.
  t.sockets.at(-1).send(JSON.stringify({ kind: "state", visible: true }));
  await sleep(100);
  assert.doesNotMatch(await status(member), /HIDDEN/);
  await Promise.all([hubSession.end(), member.end()]);
});

/** A bare tab socket: says hello as `who` with a claim, reports how it was closed. */
function rawTab({ port }, hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: "http://localhost:3000" } });
    const got = [];
    const out = { ws, got, closed: null, welcomed: false };
    ws.on("open", () =>
      ws.send(JSON.stringify({ kind: "hello", token: "", app: "Studio test", tools: [{ name: "doc_overview", description: "", inputSchema: { type: "object" } }], ...hello })),
    );
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      got.push(msg);
      if (msg.kind === "welcome") {
        out.welcomed = true;
        resolve(out);
      }
    });
    ws.on("close", (code) => {
      out.closed = code;
      resolve(out);
    });
  });
}

test("a tab knocking on its own never takes the link from another tab; the person's Link does, and a reloading tab gets its own back", async () => {
  const e = env();
  const a = bridge(e, "claims");
  await a.ready;
  await sleep(300);
  const holder = await rawTab(e, { tab: "tab-A", claim: "resume" });
  assert.equal(holder.welcomed, true);
  // Another linked tab's background retry: refused, the holder keeps it.
  const retry = await rawTab(e, { tab: "tab-B", claim: "resume" });
  assert.equal(retry.closed, 4002);
  assert.equal(holder.closed, null);
  // The holder reloads (a dev hot reload): during the grace another tab's retry is still refused…
  holder.ws.close();
  await sleep(100);
  const sneak = await rawTab(e, { tab: "tab-B", claim: "resume" });
  assert.equal(sneak.closed, 4002);
  // …and the same tab comes straight back.
  const back = await rawTab(e, { tab: "tab-A", claim: "resume" });
  assert.equal(back.welcomed, true);
  // The person presses Link in the other tab: that moves it.
  const linked = await rawTab(e, { tab: "tab-B", claim: "user" });
  assert.equal(linked.welcomed, true);
  await sleep(100);
  assert.equal(back.closed, 4000);
  await a.end(true);
});

test("a saveTo path without an extension gets the file's own, and an existing folder takes the file inside it", async () => {
  const e = env();
  const a = bridge(e, "ext");
  await a.ready;
  await sleep(300);
  const t = await rawTab(e, { tab: "tab-E", claim: "user" });
  const dir = mkdtempSync(join(tmpdir(), "mcp-ext-"));
  const send = (id, path) => t.ws.send(JSON.stringify({ kind: "file", id, path, name: "Film-cut.wav", seq: 0, data: Buffer.from("RIFF").toString("base64"), last: true }));
  send("e1", join(dir, "mix"));
  send("e2", dir); // a folder that exists, named without the trailing slash
  await sleep(300);
  const filed = Object.fromEntries(t.got.filter((m) => m.kind === "filed").map((m) => [m.id, m.path]));
  assert.equal(filed.e1, join(dir, "mix.wav"));
  assert.equal(filed.e2, join(dir, "Film-cut.wav"));
  await a.end(true);
});

test("the link's holder moves with the hub: after a takeover another tab's resume is still refused, and the holder gets its link back", async () => {
  const e = env();
  const a = bridge(e, "first-hub");
  await a.ready;
  await sleep(300);
  const b = bridge(e, "second");
  await b.ready;
  const holder = await rawTab(e, { tab: "tab-H", claim: "user" });
  assert.equal(holder.welcomed, true);
  // The hub moves to b (its status answers once a tab has linked there).
  const took = status(b, { takeOver: true });
  await sleep(700);
  // In the moment before the holder follows, another linked tab's background retry knocks on the NEW hub…
  const sneak = await rawTab(e, { tab: "tab-X", claim: "resume" });
  assert.equal(sneak.closed, 4002);
  // …and the holder itself comes straight back.
  const back = await rawTab(e, { tab: "tab-H", claim: "resume" });
  assert.equal(back.welcomed, true);
  assert.match(await took, /Took over/);
  await Promise.all([a.end(true), b.end(true)]);
});

test("file chunks are acknowledged one by one, so a hidden tab paces by messages, not timers", async () => {
  const e = env();
  const a = bridge(e, "acks");
  await a.ready;
  await sleep(300);
  const t = await rawTab(e, { tab: "tab-F", claim: "user" });
  assert.ok(t.got.find((m) => m.kind === "welcome").features.includes("acks"));
  const dest = join(mkdtempSync(join(tmpdir(), "mcp-acks-")), "out.bin");
  const chunk = (seq, last) => t.ws.send(JSON.stringify({ kind: "file", id: "f1", path: dest, name: "out.bin", seq, data: Buffer.from(`part${seq}`).toString("base64"), last }));
  chunk(0, false);
  chunk(1, true);
  await sleep(300);
  assert.deepEqual(t.got.filter((m) => m.kind === "ack").map((m) => m.seq), [0, 1]);
  assert.equal(t.got.find((m) => m.kind === "filed").path, dest);
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(dest, "utf8"), "part0part1");
  await a.end(true);
});

test("a changed tool schema with the same tool count still tells the client the list changed", async () => {
  const e = env();
  const a = bridge(e, "schemas");
  await a.ready;
  await sleep(300);
  const v1 = await rawTab(e, { tab: "tab-S", claim: "user" });
  await sleep(100);
  const before = a.notes.filter((n) => n.method === "notifications/tools/list_changed").length;
  // The app reloads on a release whose catalog_list gained an enum value: same count, new schema.
  v1.ws.close();
  await sleep(100);
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${e.port}`, { headers: { origin: "http://localhost:3000" } });
    ws.on("open", () =>
      ws.send(JSON.stringify({ kind: "hello", token: "", app: "Studio test", tab: "tab-S", claim: "resume", tools: [{ name: "doc_overview", description: "now with looks", inputSchema: { type: "object" } }] })),
    );
    ws.on("message", (raw) => JSON.parse(String(raw)).kind === "welcome" && resolve());
  });
  await sleep(100);
  const after = a.notes.filter((n) => n.method === "notifications/tools/list_changed").length;
  // Unlinking announces once and relinking once more; the relink is what carries the new schema.
  assert.ok(after > before);
  await a.end(true);
});
