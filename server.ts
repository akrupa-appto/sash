import { readRecording, saveRecording, anchorRecording } from "./recordings.ts";
import os from "node:os";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { launch } from "./browser.ts";
import { runTask, type Event } from "./agent.ts";
import { jevVia } from "./jev.ts";
import { plannerModel } from "./planner.ts";

const PORT = Number(process.env.PORT ?? 8791);
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 6);
const IDLE_MS = Number(process.env.SESSION_IDLE_MS ?? 15 * 60_000);
const root = path.dirname(new URL(import.meta.url).pathname);
const indexHtml = () => fs.readFileSync(path.join(root, "public", "index.html"));

// One chat = one session = one browser. Tasks run one at a time on the same page, so
// "go to wikipedia" followed by "search for X" works as a conversation.
type Session = { id: string; browser: Awaited<ReturnType<typeof launch>>; busy: boolean; abort?: AbortController; lastUsed: number; tasks: string[]; recordingBusy?: boolean };
const sessions = new Map<string, Session>();
// Includes launches and browsers still closing, not just published sessions.
let occupiedSlots = 0;

async function closeSession(id: string) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  s.abort?.abort();
  const record = readRecording(id);
  if (record) { record.state = 'ended'; saveRecording(record); }
  await s.browser.close().catch((err) => console.warn((err as Error).message));
  occupiedSlots--;
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

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const m = url.pathname.match(/^\/api\/session\/([a-f0-9]+)(?:\/(task|close|recording-start|recording-stop))?$/);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(indexHtml());
  }
  if (req.method === "GET" && ["/playground", "/gallery"].includes(url.pathname)) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(root, "public", url.pathname.slice(1) + ".html")));
  }
  const recordingMatch = url.pathname.match(/^\/api\/recordings\/([a-f0-9]{16})$/);
  if (req.method === "GET" && recordingMatch) {
    try {
      const record = readRecording(recordingMatch[1]);
      if (!record) return json(res, 404, { error: "recording not found" });
      const { anchorId, ...publicRecord } = record;
      // A server restart closes the old browser. Never leave the gallery saying it is recording.
      if (!sessions.has(record.id)) publicRecord.state = 'ended';
      const items = publicRecord.state === 'ended' ? await anchorRecording(anchorId) : [];
      return json(res, 200, { ...publicRecord, videos: items.map((item: any) => ({ url: item.file_link, duration: item.duration })) });
    } catch (e) { return json(res, 502, { error: (e as Error).message }); }
  }
  if (m && req.method === "POST" && m[2]?.startsWith("recording-")) {
    const s = sessions.get(m[1]);
    if (!s) return json(res, 404, { error: "session expired; start a new chat" });
    if (s.recordingBusy) return json(res, 409, { error: "recording is updating; try again" });
    s.recordingBusy = true;
    try {
      const state = m[2] === 'recording-start' ? 'recording' : 'paused';
      const record = readRecording(s.id) || { id: s.id, anchorId: s.browser.anchorId, createdAt: new Date().toISOString(), title: 'Browser session', state: 'paused' as const };
      if (record.state !== state) await anchorRecording(s.browser.anchorId, state === 'recording' ? 'resume' : 'pause');
      record.state = state;
      record.title = (await s.browser.page.title().catch(() => '')) || record.title;
      saveRecording(record);
      s.lastUsed = Date.now();
      return json(res, 200, { id: s.id, state });
    } catch (e) { return json(res, 502, { error: (e as Error).message }); }
    finally { s.recordingBusy = false; }
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { ok: true, via: jevVia(), browser: "anchor", sessions: sessions.size, busy: [...sessions.values()].filter((s) => s.busy).length });
  }
  if (req.method === "POST" && url.pathname === "/api/session") {
    let evict: Session | undefined;
    if (occupiedSlots >= MAX_SESSIONS) {
      // evict the oldest idle session
      evict = [...sessions.values()].filter((s) => !s.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!evict) return json(res, 429, { error: "all browser sessions are busy, try again shortly" });
    }
    // Reserve synchronously; an eviction must finish before its replacement launches.
    occupiedSlots++;
    const id = crypto.randomBytes(8).toString("hex");
    try {
      if (evict) await closeSession(evict.id);
      const browser = await launch();
      try {
        // exe.dev alternate ports require the user's login. Fulfil only this app's
        // self-contained practice page inside Anchor, using Playwright's routing.
        const origins = new Set([
          `https://${os.hostname()}.exe.xyz:${PORT}`,
          `http://127.0.0.1:${PORT}`,
          `http://localhost:${PORT}`,
          process.env.PUBLIC_ORIGIN || `https://${os.hostname()}.exe.xyz`,
        ]);
        await browser.context.route(u => origins.has(u.origin) && u.pathname === '/playground', route =>
          route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(root, 'public', 'playground.html')) }));
        sessions.set(id, { id, browser, busy: false, lastUsed: Date.now(), tasks: [] });
      } catch (e) { await browser.close().catch(() => {}); throw e; }
    } catch (e) {
      occupiedSlots--;
      return json(res, 500, { error: (e as Error).message });
    }
    return json(res, 200, { id, liveViewUrl: sessions.get(id)!.browser.liveViewUrl });
  }
  if (m && req.method === "GET" && !m[2]) {
    const s = sessions.get(m[1]);
    if (!s) return json(res, 404, { error: "no such session" });
    const page = s.browser.page;
    return json(res, 200, { id: s.id, busy: s.busy, url: page.url(), title: await page.title().catch(() => ""), liveViewUrl: s.browser.liveViewUrl, recording: readRecording(s.id)?.state ?? "paused" });
  }
  if (m && req.method === "POST" && m[2] === "close") {
    if (sessions.get(m[1])?.recordingBusy) return json(res, 409, { error: "recording is updating; try ending the chat again" });
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
    // Reading the body yields: another request may have closed or claimed this session.
    if (sessions.get(s.id) !== s) return json(res, 404, { error: "session expired, start a new chat" });
    if (s.busy) return json(res, 409, { error: "a task is already running in this chat" });
    const message = String(body.message ?? "").trim();
    if (!message) return json(res, 400, { error: "message required" });
    let model = plannerModel();
    if (body.supervisor !== false && body.model !== undefined) {
      if (typeof body.model !== "string" || !/^[a-zA-Z0-9~][a-zA-Z0-9._:/@~-]{0,199}$/.test(body.model.trim())) {
        return json(res, 400, { error: "enter a valid model ID, such as deepseek/deepseek-v4.1-flash" });
      }
      model = body.model.trim();
    }
    const reasoning = body.supervisor === false ? "auto" : (body.reasoning ?? "auto");
    if (!["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoning)) {
      return json(res, 400, { error: "choose a valid reasoning level" });
    }
    const preset = ["deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3-flash", "moonshotai/kimi-k3"].includes(model);
    if (body.supervisor !== false && preset && (!["auto", "none", "low", "high", "max"].includes(reasoning) || (model === "z-ai/glm-5.3-flash" && reasoning === "none"))) {
      return json(res, 400, { error: "this model does not support that reasoning level; choose auto, low, high, or maximum" });
    }
    let target: string | undefined = body.url ? String(body.url) : message.match(URL_RE)?.[0];
    if (target && !/^https?:\/\//i.test(target)) target = "https://" + target;
    const onBlank = s.browser.page.url() === "about:blank";
    if (!target && onBlank) return json(res, 400, { error: "tell me where to start: include a url in the task" });

    s.busy = true;
    s.lastUsed = Date.now();
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache", "x-accel-buffering": "no" });
    let outcome = "";
    const send = (e: Event) => {
      if (e.type === "end") outcome = `${e.status}: ${e.answer ?? e.message}`;
      if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(e) + "\n");
    };
    const ac = new AbortController();
    s.abort = ac;
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });
    const previousTasks = [...s.tasks];
    try {
      send({ type: "start", via: jevVia(), url: target ?? s.browser.page.url(), supervisor: body.supervisor === false ? undefined : model });
      await runTask(
        s.browser.page,
        { url: target, goal: message, values: Array.isArray(body.values) ? body.values.map(String) : [], maxSteps: Number(body.maxSteps) || 60, previousTasks, supervisor: body.supervisor !== false, model, reasoning, liveView: true },
        send,
        ac.signal,
      );
    } catch (err) {
      send({ type: "end", status: "error", message: (err as Error).message, totalCostUsd: 0, steps: 0 });
    } finally {
      s.tasks.push(`user: ${message}` + (outcome ? ` → ${outcome}` : ""));
      if (s.tasks.length > 20) s.tasks.splice(0, s.tasks.length - 20);
      s.abort = undefined;
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

for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, async () => {
  server.close();
  const deadline = setTimeout(() => process.exit(1), 18000);
  await Promise.allSettled([...sessions.keys()].map(closeSession));
  clearTimeout(deadline);
  process.exit(0);
});
