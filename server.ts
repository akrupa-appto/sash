import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { launch } from "./browser.ts";
import { runTask, type Event } from "./agent.ts";
import { jevVia } from "./jev.ts";

const PORT = Number(process.env.PORT ?? 8791);
const root = path.dirname(new URL(import.meta.url).pathname);
const indexHtml = () => fs.readFileSync(path.join(root, "public", "index.html"));

let active = 0;
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE ?? 3);

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(indexHtml());
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, via: jevVia(), active }));
  }
  if (req.method === "POST" && url.pathname === "/api/run") {
    let body: any;
    try {
      body = await readJson(req);
    } catch {
      res.writeHead(400);
      return res.end("bad json");
    }
    const goal = String(body.goal ?? "").trim();
    let target = String(body.url ?? "").trim();
    if (target && !/^https?:\/\//i.test(target)) target = "https://" + target;
    if (!goal || !target) {
      res.writeHead(400);
      return res.end("url and goal required");
    }
    if (active >= MAX_ACTIVE) {
      res.writeHead(429);
      return res.end("too many concurrent runs, try again shortly");
    }
    active++;
    res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    });
    const send = (e: Event) => {
      if (!res.writableEnded) res.write(JSON.stringify(e) + "\n");
    };
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    let browser: Awaited<ReturnType<typeof launch>>["browser"] | undefined;
    try {
      const l = await launch();
      browser = l.browser;
      send({ type: "start", via: jevVia(), url: target });
      await runTask(
        l.page,
        {
          url: target,
          goal,
          values: Array.isArray(body.values) ? body.values.map(String) : String(body.values ?? "").split("\n"),
          maxSteps: Number(body.maxSteps) || 20,
        },
        send,
        ac.signal,
      );
    } catch (err) {
      send({ type: "end", status: "error", message: (err as Error).message, totalCostUsd: 0, steps: 0 });
    } finally {
      active--;
      await browser?.close().catch(() => {});
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
