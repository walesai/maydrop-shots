#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import pg from "pg";

const port = Number(process.env.ARM_PORT || 8787);
const secret = process.env.BACKORDER_HOOK_SECRET || "";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const logPath = process.env.ARM_LOG || "/var/log/maydrop-arm.log";

function log(line) {
  const row = new Date().toISOString() + " " + line + "\n";
  console.log(row.trim());
  try { fs.appendFileSync(logPath, row); } catch {}
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end("POST only");
    return;
  }
  if (!secret || req.headers.authorization !== "Bearer " + secret) {
    log("unauthorized");
    res.writeHead(401);
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const domain = String(body.domain || "").toLowerCase().trim();
  const dropAt = body.dropAt || new Date(Date.now() + 86400000).toISOString();
  if (!domain.includes(".")) {
    log("bad domain");
    res.writeHead(400);
    res.end(JSON.stringify({ ok: false, error: "domain required" }));
    return;
  }
  const sql = `INSERT INTO catch_queue (domain, user_id, drop_at, certainty) VALUES ($1,$2,$3,$4)`;
  const values = [domain, "logi5xUK2AMy4ErFCgg0T1HFhql7U25b", dropAt, "drop"];
  try {
    await pool.query(sql, values);
    log("armed " + domain + " drop " + dropAt);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, domain, armed: true }));
  } catch (err) {
    log("fail " + domain + " " + err.message);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

server.listen(port, "127.0.0.1", () => log("arm server " + port));
