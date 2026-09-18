import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { launch } from "./browser.ts";
import { runTask, type Event } from "./agent.ts";
import { jevVia } from "./jev.ts";

const PORT = Number(process.env.PORT ?? 8791);
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 6);
const IDLE_MS = Number(process.env.SESSION_IDLE_MS ?? 15 * 60_000);
const root = path.dirname(new URL(import.meta.url).pathname);
const indexHtml = () => fs.readFileSync(path.join(root, "public", "index.html"));

// One chat = one session = one browser. Tasks run one at a time on the same page, so
// "go to wikipedia" followed by "search for X" works as a conversation.
type Session = { id: string; browser: Awaited<ReturnType<typeof launch>>; busy: boolean; lastUsed: number; tasks: string[] };
const sessions = new Map<string, Session>();

async function closeSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  await s.browser.browser.close().catch(() => {});
}

setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) if (!s.busy && now - s.lastUsed > IDLE_MS) closeSession(s.id);
}, 60_000).unref();

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const URL_RE = /https?:\/\/[^\s"'<>)]+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|ai|io|dev|co|xyz|app|sh|me|info|edu|gov|uk|de|fr|jp)(?:\/[^\s"'<>)]*)?/i;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const m = url.pathname.match(/^\/api\/session\/([a-f0-9]+)(?:\/(task|close))?$/);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(indexHtml());
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { ok: true, via: jevVia(), sessions: sessions.size, busy: [...sessions.values()].filter((s) => s.busy).length });
  }
  if (req.method === "POST" && url.pathname === "/api/session") {
    if (sessions.size >= MAX_SESSIONS) {
      // evict the oldest idle session
      const idle = [...sessions.values()].filter((s) => !s.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) return json(res, 429, { error: "all browser sessions are busy, try again shortly" });
      await closeSession(idle.id);
    }
    const id = crypto.randomBytes(8).toString("hex");
    try {
      sessions.set(id, { id, browser: await launch(), busy: false, lastUsed: Date.now(), tasks: [] });
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
    return json(res, 200, { id });
  }
  if (m && req.method === "GET" && !m[2]) {
    const s = sessions.get(m[1]);
    if (!s) return json(res, 404, { error: "no such session" });
    const page = s.browser.page;
    return json(res, 200, { id: s.id, busy: s.busy, url: page.url(), title: await page.title().catch(() => "") });
  }
  if (m && req.method === "POST" && m[2] === "close") {
    await closeSession(m[1]);
    return json(res, 200, { ok: true });
  }
  if (m && req.method === "POST" && m[2] === "task") {
    const s = sessions.get(m[1]);
    if (!s) return json(res, 404, { error: "session expired, start a new chat" });
    if (s.busy) return json(res, 409, { error: "a task is already running in this chat" });
    let body: any;
    try {
      body = await readJson(req);
    } catch {
      return json(res, 400, { error: "bad json" });
    }
    const message = String(body.message ?? "").trim();
    if (!message) return json(res, 400, { error: "message required" });
    let target: string | undefined = body.url ? String(body.url) : message.match(URL_RE)?.[0];
    if (target && !/^https?:\/\//i.test(target)) target = "https://" + target;
    const onBlank = s.browser.page.url() === "about:blank";
    if (!target && onBlank) return json(res, 400, { error: "tell me where to start: include a url in the task" });

    s.busy = true;
    s.lastUsed = Date.now();
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache", "x-accel-buffering": "no" });
    let outcome = "";
    const send = (e: Event) => {
      if (e.type === "end") outcome = `${e.status}: ${e.message}`;
      if (!res.writableEnded) res.write(JSON.stringify(e) + "\n");
    };
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    const previousTasks = [...s.tasks];
    try {
      send({ type: "start", via: jevVia(), url: target ?? s.browser.page.url() });
      await runTask(
        s.browser.page,
        { url: target, goal: message, values: Array.isArray(body.values) ? body.values.map(String) : [], maxSteps: Number(body.maxSteps) || 20, previousTasks },
        send,
        ac.signal,
      );
    } catch (err) {
      send({ type: "end", status: "error", message: (err as Error).message, totalCostUsd: 0, steps: 0 });
    } finally {
      s.tasks.push(`user: ${message}` + (outcome ? ` → ${outcome}` : ""));
      if (s.tasks.length > 20) s.tasks.splice(0, s.tasks.length - 20);
      s.busy = false;
      s.lastUsed = Date.now();
      // a crashed browser should not poison the chat
      if (!s.browser.browser.isConnected()) await closeSession(s.id);
      res.end();
    }
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`checkto listening on http://0.0.0.0:${PORT} (jev via ${jevVia()})`);
});
