#!/usr/bin/env node
import http from "node:http";
import pg from "pg";

const port = Number(process.env.ARM_PORT || 8787);
const secret = process.env.BACKORDER_HOOK_SECRET || "";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end("POST only");
    return;
  }
  if (!secret || req.headers.authorization !== "Bearer " + secret) {
    res.writeHead(401);
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const domain = String(body.domain || "").toLowerCase().trim();
  const dropAt = body.dropAt || null;
  if (!domain.includes(".")) {
    res.writeHead(400);
    res.end(JSON.stringify({ ok: false, error: "domain required" }));
    return;
  }
  const cols = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'catch_queue'"
  );
  const names = new Set(cols.rows.map((r) => r.column_name));
  const fields = ["domain"];
  const values = [domain];
  if (names.has("drop_at") && dropAt) {
    fields.push("drop_at");
    values.push(dropAt);
  }
  if (names.has("status")) {
    fields.push("status");
    values.push("armed");
  }
  const placeholders = values.map((_, i) => "$" + (i + 1)).join(",");
  const sql = `INSERT INTO catch_queue (${fields.join(",")}) VALUES (${placeholders}) ON CONFLICT (domain) DO NOTHING`;
  try {
    await pool.query(sql, values);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, domain, armed: true }));
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

server.listen(port, "127.0.0.1", () => console.log("arm server " + port));
