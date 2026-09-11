#!/usr/bin/env node
/**
 * Fastest Maydrop 6-shot.
 * Prebuilds 6 length-prefixed CREATE buffers (no NS).
 * At t0-20ms the hot path is only socket.write().
 */
import fs from "node:fs";
import tls from "node:tls";
import { hrtime } from "node:process";
import { randomUUID } from "node:crypto";

const args = parseArgs(process.argv.slice(2));
const CFG = {
  host: args.host || process.env.EPP_HOST || "epp.nominet.org.uk",
  port: Number(args.port || process.env.EPP_PORT || 700),
  user: args.user || process.env.EPP_USER || "",
  pass: args.pass || process.env.EPP_PASS || "",
  domain: String(args.domain || process.env.EPP_DOMAIN || "").toLowerCase(),
  t0: args.t0 || process.env.EPP_T0 || "",
  earlyMs: Number(args["early-ms"] ?? process.env.EPP_EARLY_MS ?? 20),
  sockets: Math.min(6, Math.max(1, Number(args.sockets ?? process.env.EPP_SOCKETS ?? 6))),
  period: Number(args.period || process.env.EPP_PERIOD || 2),
  registrant: args.registrant || process.env.EPP_REGISTRANT || "",
  dry: Boolean(args["dry-run"]),
  insecure: Boolean(args.insecure),
};

if (!CFG.domain) die("missing --domain");
if (!CFG.t0) die("missing --t0");
if (!CFG.dry && (!CFG.user || !CFG.pass)) die("missing EPP_USER / EPP_PASS");
if (!CFG.dry && !CFG.registrant) die("missing EPP_REGISTRANT");

const T0_MS = Date.parse(CFG.t0);
if (Number.isNaN(T0_MS)) die("bad --t0");
const FIRE_MS = T0_MS - CFG.earlyMs;

const preview = createXml(CFG.domain, CFG.period, CFG.registrant, "CLTRID");
console.log("=== Maydrop fastest 6-shot ===");
console.log("domain     " + CFG.domain);
console.log("t0         " + new Date(T0_MS).toISOString());
console.log("fire       " + new Date(FIRE_MS).toISOString() + "  (t0-" + CFG.earlyMs + "ms)");
console.log("sockets    " + CFG.sockets);
console.log("registrant " + (CFG.registrant || "(dry placeholder)"));
console.log(preview);

if (CFG.dry) process.exit(0);

await main();

async function main() {
  const socks = [];
  for (let i = 1; i <= CFG.sockets; i++) {
    const s = await openEpp(i);
    await login(s);
    s.frame = eppFrame(createXml(CFG.domain, CFG.period, CFG.registrant, "maydrop-s" + i + "-" + Date.now() + "-" + randomUUID().slice(0, 6)));
    console.log("[s" + i + "] login " + s.loginRttMs.toFixed(2) + "ms  frame " + s.frame.length + "B");
    socks.push(s);
  }
  const wait = FIRE_MS - Date.now();
  if (wait > 0) {
    console.log("armed  sleep " + (wait / 1000).toFixed(3) + "s");
    await sleepUntil(FIRE_MS);
  }
  const tFire = hrtime.bigint();
  const fireWall = Date.now();
  for (let i = 0; i < socks.length; i++) socks[i].write(socks[i].frame);
  const rows = await Promise.all(socks.map((s) => collect(s, tFire, fireWall)));
  printTable(rows);
  try {
    fs.appendFileSync(process.env.EPP_LOG || "maydrop-timing.jsonl", JSON.stringify({ ts: new Date().toISOString(), domain: CFG.domain, t0: CFG.t0, earlyMs: CFG.earlyMs, shots: rows }) + "\n");
  } catch (e) {}
  await Promise.all(socks.map((s) => logout(s)));
  process.exit(rows.some((r) => r.code === "1000") ? 0 : 2);
}

function createXml(domain, period, registrant, clTRID) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="no"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><command><create><domain:create xmlns:domain="urn:ietf:params:xml:ns:domain-1.0"><domain:name>' + esc(domain) + '</domain:name><domain:period unit="y">' + period + '</domain:period><domain:registrant>' + esc(registrant || "MAYDROP-REG") + '</domain:registrant><domain:authInfo><domain:pw></domain:pw></domain:authInfo></domain:create></create><clTRID>' + clTRID + '</clTRID></command></epp>';
}
function eppFrame(xmlStr) {
  const body = Buffer.from(xmlStr, "utf8");
  const buf = Buffer.allocUnsafe(4 + body.length);
  buf.writeUInt32BE(4 + body.length, 0);
  body.copy(buf, 4);
  return buf;
}
function loginXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="no"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><command><login><clID>' + esc(CFG.user) + '</clID><pw>' + esc(CFG.pass) + '</pw><options><version>1.0</version><lang>en</lang></options><svcs><objURI>urn:ietf:params:xml:ns:domain-1.0</objURI><objURI>urn:ietf:params:xml:ns:contact-1.0</objURI><objURI>urn:ietf:params:xml:ns:host-1.0</objURI></svcs></login><clTRID>maydrop-login-' + Date.now() + '</clTRID></command></epp>';
}
async function openEpp(id) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: CFG.host, port: CFG.port, servername: CFG.host, rejectUnauthorized: !CFG.insecure, minVersion: "TLSv1.2" });
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 5000);
    sock.id = id;
    sock._buf = Buffer.alloc(0);
    sock._waiters = [];
    sock.on("data", (chunk) => {
      sock._buf = Buffer.concat([sock._buf, chunk]);
      while (sock._buf.length >= 4) {
        const len = sock._buf.readUInt32BE(0);
        if (len < 4 || sock._buf.length < len) break;
        const frame = sock._buf.subarray(4, len).toString("utf8");
        sock._buf = sock._buf.subarray(len);
        const w = sock._waiters.shift();
        if (w) w.resolve(frame);
      }
    });
    sock.on("error", reject);
    sock.on("secureConnect", async () => {
      try { await recv(sock, 8000); resolve(sock); } catch (e) { reject(e); }
    });
  });
}
function sendXml(sock, xmlStr) { sock.write(eppFrame(xmlStr)); }
function recv(sock, timeoutMs) {
  timeoutMs = timeoutMs || 15000;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("s" + sock.id + " timeout")), timeoutMs);
    sock._waiters.push({ resolve: (frame) => { clearTimeout(t); resolve(frame); } });
  });
}
async function login(sock) {
  const t0 = hrtime.bigint();
  sendXml(sock, loginXml());
  const resp = await recv(sock);
  sock.loginRttMs = Number(hrtime.bigint() - t0) / 1e6;
  if (codeOf(resp) !== "1000") throw new Error("login " + codeOf(resp));
}
async function collect(sock, tFire, fireWall) {
  const sentWall = Date.now();
  const sentOff = Number(hrtime.bigint() - tFire) / 1e6;
  let resp = ""; let code = "timeout"; let msg = ""; let replyWall = sentWall;
  try { resp = await recv(sock, 20000); replyWall = Date.now(); code = codeOf(resp); msg = msgOf(resp); }
  catch (e) { replyWall = Date.now(); msg = e.message; }
  return { id: sock.id, sentIso: new Date(sentWall).toISOString(), sentVsT0Ms: sentWall - T0_MS, replyVsT0Ms: replyWall - T0_MS, sentVsFireMs: sentOff, wallVsFireMs: sentWall - fireWall, rttMs: replyWall - sentWall, code, msg, verdict: code === "1000" ? "CAUGHT" : code === "2302" ? (sentWall - T0_MS < 0 ? "TOO EARLY / taken" : "TAKEN") : code === "2400" ? "BUSY" : "OTHER" };
}
async function logout(sock) {
  try { sendXml(sock, '<?xml version="1.0" encoding="UTF-8" standalone="no"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><command><logout/><clTRID>out</clTRID></command></epp>'); await recv(sock, 2000); } catch (e) {}
  try { sock.end(); } catch (e) {}
}
function printTable(rows) {
  const hdr = "sock  sent UTC                  sent vs t0    rtt         reply vs t0   code    verdict";
  const rule = Array(hdr.length + 1).join("-");
  console.log(""); console.log("DROP / CATCH  " + CFG.domain); console.log("t0            " + new Date(T0_MS).toISOString()); console.log(rule); console.log(hdr); console.log(rule);
  for (const r of rows) console.log(pad("s" + r.id, 4) + "  " + pad(r.sentIso, 24) + "  " + pad(ms(r.sentVsT0Ms), 12) + "  " + pad(r.rttMs.toFixed(2) + "ms", 10) + "  " + pad(ms(r.replyVsT0Ms), 12) + "  " + pad(r.code, 6) + "  " + r.verdict);
  console.log(rule);
  const caught = rows.filter((r) => r.code === "1000");
  const early = rows.slice().sort((a, b) => a.sentVsT0Ms - b.sentVsT0Ms)[0];
  console.log("summary  earliest " + ms(early.sentVsT0Ms) + "   caught " + caught.length + "/" + rows.length);
}
async function sleepUntil(targetMs) {
  for (;;) {
    const left = targetMs - Date.now();
    if (left <= 0) return;
    if (left > 8) await new Promise((r) => setTimeout(r, left - 4));
    else await new Promise((r) => setImmediate(r));
  }
}
function codeOf(x) { const m = String(x).match(/result\s+code=["'](\d+)["']/); return m ? m[1] : "????"; }
function msgOf(x) { const m = String(x).match(/<msg[^>]*>([^<]+)<\/msg>/); return m ? m[1].trim() : ""; }
function ms(n) { return (n >= 0 ? "+" : "") + Number(n).toFixed(2) + "ms"; }
function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + Array(n - s.length + 1).join(" "); }
function esc(s) {
  return String(s).replace(/[&<>"]/g, function (ch) {
    if (ch === "&") return "&#38;";
    if (ch === "<") return "&#60;";
    if (ch === ">") return "&#62;";
    return "&#34;";
  });
}
function die(m) { console.error(m); process.exit(1); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.slice(0, 2) !== "--") continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.slice(0, 2) === "--") out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
