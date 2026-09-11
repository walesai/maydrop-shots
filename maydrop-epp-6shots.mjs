#!/usr/bin/env node
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
  sockets: Number(args.sockets ?? process.env.EPP_SOCKETS ?? 6),
  period: Number(args.period || 2),
  registrant: args.registrant || process.env.EPP_REGISTRANT || "MAYDROP-REG",
  dry: Boolean(args["dry-run"]),
  insecure: Boolean(args.insecure),
};

if (!CFG.domain) die("missing --domain");
if (!CFG.t0) die("missing --t0 ISO UTC");
if (!CFG.dry && (!CFG.user || !CFG.pass)) die("missing --user/--pass");
const T0_MS = Date.parse(CFG.t0);
if (Number.isNaN(T0_MS)) die("bad --t0");
const FIRE_MS = T0_MS - CFG.earlyMs;
const xml = buildCreateXml(CFG.domain, CFG.period, CFG.registrant);

console.log("=== Maydrop 6-shot EPP ===");
console.log("domain     " + CFG.domain);
console.log("t0         " + new Date(T0_MS).toISOString());
console.log("early      " + CFG.earlyMs + " ms");
console.log("fire start " + new Date(FIRE_MS).toISOString());
console.log("sockets    " + CFG.sockets);

if (CFG.dry) {
  console.log(xml);
  process.exit(0);
}

await run();

async function run() {
  const socks = [];
  for (let i = 0; i < CFG.sockets; i++) {
    const s = await openEpp(i + 1);
    socks.push(s);
    await login(s);
    console.log("[s" + s.id + "] login rtt=" + s.loginRttMs.toFixed(2) + "ms");
  }
  const waitMs = FIRE_MS - Date.now();
  if (waitMs > 0) {
    console.log("sleeping " + (waitMs / 1000).toFixed(3) + "s");
    await sleepUntil(FIRE_MS);
  }
  const tFire = stamp();
  const fireWall = Date.now();
  const results = await Promise.all(socks.map((s) => fireCreate(s, xml, tFire, fireWall)));
  printTimingTable(results);
  writeTimingLog(results);
  await Promise.all(socks.map((s) => logout(s).catch(() => {})));
  process.exit(results.some((r) => r.code === "1000") ? 0 : 2);
}

function buildCreateXml(domain, period, registrant) {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\n<epp xmlns=\"urn:ietf:params:xml:ns:epp-1.0\"><command><create><domain:create xmlns:domain=\"urn:ietf:params:xml:ns:domain-1.0\"><domain:name>" +
    esc(domain) + "</domain:name><domain:period unit=\"y\">" + period +
    "</domain:period><domain:registrant>" + esc(registrant) +
    "</domain:registrant><domain:authInfo><domain:pw></domain:pw></domain:authInfo></domain:create></create><clTRID>maydrop-" +
    Date.now() + "</clTRID></command></epp>";
}

function buildLoginXml() {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\n<epp xmlns=\"urn:ietf:params:xml:ns:epp-1.0\"><command><login><clID>" +
    esc(CFG.user) + "</clID><pw>" + esc(CFG.pass) +
    "</pw><options><version>1.0</version><lang>en</lang></options><svcs><objURI>urn:ietf:params:xml:ns:domain-1.0</objURI><objURI>urn:ietf:params:xml:ns:contact-1.0</objURI><objURI>urn:ietf:params:xml:ns:host-1.0</objURI></svcs></login><clTRID>maydrop-login-" +
    Date.now() + "</clTRID></command></epp>";
}

function buildLogoutXml() {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\n<epp xmlns=\"urn:ietf:params:xml:ns:epp-1.0\"><command><logout/><clTRID>maydrop-out</clTRID></command></epp>";
}

async function openEpp(id) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: CFG.host, port: CFG.port, rejectUnauthorized: !CFG.insecure, minVersion: "TLSv1.2" });
    sock.setNoDelay(true);
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

function sendFrame(sock, xmlStr) {
  const body = Buffer.from(xmlStr, "utf8");
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(body.length + 4, 0);
  sock.write(Buffer.concat([hdr, body]));
}

function recv(sock, timeoutMs) {
  timeoutMs = timeoutMs || 15000;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("s" + sock.id + " recv timeout")), timeoutMs);
    sock._waiters.push({ resolve: (frame) => { clearTimeout(t); resolve(frame); } });
  });
}

async function login(sock) {
  const t0 = stamp();
  sendFrame(sock, buildLoginXml());
  const resp = await recv(sock);
  sock.loginRttMs = elapsedMs(t0);
  const code = resultCode(resp);
  if (code !== "1000") throw new Error("login " + code);
}

async function fireCreate(sock, xmlStr, tFire, fireWall) {
  const frame = xmlStr.replace(/<clTRID>[^<]+<\/clTRID>/, "<clTRID>maydrop-s" + sock.id + "-" + Date.now() + "-" + randomUUID().slice(0, 6) + "</clTRID>");
  const sentAt = stamp();
  const sentWall = Date.now();
  sendFrame(sock, frame);
  let resp = ""; let code = "timeout"; let msg = ""; let replyWall = sentWall;
  try {
    resp = await recv(sock, 20000);
    replyWall = Date.now();
    code = resultCode(resp);
    msg = resultMsg(resp);
  } catch (e) {
    replyWall = Date.now();
    msg = e.message;
  }
  return {
    id: sock.id, domain: CFG.domain, t0: CFG.t0,
    sentIso: new Date(sentWall).toISOString(),
    replyIso: new Date(replyWall).toISOString(),
    sentVsT0Ms: sentWall - T0_MS,
    replyVsT0Ms: replyWall - T0_MS,
    sentVsFireMs: elapsedMs(tFire),
    wallVsFireMs: sentWall - fireWall,
    rttMs: elapsedMs(sentAt),
    code, msg,
    svTRID: svTRID(resp),
    verdict: verdict(code, sentWall - T0_MS),
  };
}

function svTRID(x) { const m = String(x || "").match(/<svTRID>([^<]+)<\/svTRID>/); return m ? m[1] : ""; }
function verdict(code, sentVsT0) {
  if (code === "1000") return "CAUGHT";
  if (code === "2302") return sentVsT0 < 0 ? "TOO EARLY / taken" : "TAKEN";
  if (code === "2400") return "BUSY";
  if (code === "timeout") return "NO REPLY";
  return "OTHER";
}
function fmtMs(n) { return (n >= 0 ? "+" : "") + n.toFixed(2) + "ms"; }
function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + Array(n - s.length + 1).join(" "); }

function printTimingTable(rows) {
  const hdr = "sock  sent UTC                  sent vs t0    rtt         reply vs t0   code    verdict           msg";
  const rule = Array(hdr.length + 1).join("-");
  console.log("");
  console.log("DROP / CATCH  domain=" + CFG.domain);
  console.log("t0            " + new Date(T0_MS).toISOString());
  console.log("armed         t0-" + CFG.earlyMs + "ms");
  console.log(rule); console.log(hdr); console.log(rule);
  for (const r of rows) {
    console.log([pad("s" + r.id, 4), pad(r.sentIso, 24), pad(fmtMs(r.sentVsT0Ms), 12), pad(r.rttMs.toFixed(2) + "ms", 10), pad(fmtMs(r.replyVsT0Ms), 12), pad(r.code, 6), pad(r.verdict, 16), pad(r.msg, 28)].join("  "));
  }
  console.log(rule);
  const caught = rows.filter((r) => r.code === "1000");
  const earliest = rows.slice().sort((a, b) => a.sentVsT0Ms - b.sentVsT0Ms)[0];
  const fastest = rows.slice().sort((a, b) => a.rttMs - b.rttMs)[0];
  console.log("summary  earliest send " + fmtMs(earliest.sentVsT0Ms) + "   fastest RTT s" + fastest.id + " " + fastest.rttMs.toFixed(2) + "ms   caught " + caught.length + "/" + rows.length);
}

function writeTimingLog(rows) {
  const file = process.env.EPP_LOG || "maydrop-timing.jsonl";
  try {
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), domain: CFG.domain, t0: CFG.t0, earlyMs: CFG.earlyMs, shots: rows }) + "\n");
    console.log("log      " + file);
  } catch (e) { console.warn(e.message); }
}

async function logout(sock) {
  try { sendFrame(sock, buildLogoutXml()); await recv(sock, 3000); } catch (e) {}
  sock.end();
}
function resultCode(x) { const m = String(x).match(/result\s+code=["'](\d+)["']/); return m ? m[1] : "????"; }
function resultMsg(x) { const m = String(x).match(/<msg[^>]*>([^<]+)<\/msg>/); return m ? m[1].trim() : ""; }
function stamp() { return hrtime.bigint(); }
function elapsedMs(t0) { return Number(hrtime.bigint() - t0) / 1e6; }
async function sleepUntil(targetMs) {
  for (;;) {
    const left = targetMs - Date.now();
    if (left <= 0) return;
    if (left > 12) await new Promise((r) => setTimeout(r, left - 8));
    else await new Promise((r) => setImmediate(r));
  }
}
function esc(s) { return String(s).replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">").replace(/"/g, """); }
function die(msg) { console.error(msg); process.exit(1); }
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
