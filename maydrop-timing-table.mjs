#!/usr/bin/env node
/**
 * Reprint drop/catch timing tables from maydrop-timing.jsonl
 *
 *   node maydrop-timing-table.mjs                  # last event
 *   node maydrop-timing-table.mjs --all
 *   node maydrop-timing-table.mjs --demo
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const file = argVal("--log") || process.env.EPP_LOG || "maydrop-timing.jsonl";
const demo = args.includes("--demo");
const all = args.includes("--all");

if (demo) {
  printEvent({
    domain: "example.uk",
    t0: "2026-09-11T10:00:00.000Z",
    earlyMs: 20,
    shots: [
      row(1, -18.4, 2.15, "2302", "Object exists"),
      row(2, -18.1, 2.08, "2302", "Object exists"),
      row(3, -17.9, 1.94, "2302", "Object exists"),
      row(4, -1.2, 2.01, "1000", "Command completed successfully"),
      row(5, +0.4, 2.22, "2302", "Object exists"),
      row(6, +1.1, 2.18, "2302", "Object exists"),
    ],
  });
  process.exit(0);
}

if (!fs.existsSync(file)) {
  console.error(`no log yet: ${file}\nrun the shooter first, or --demo`);
  process.exit(1);
}

const events = fs
  .readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const pick = all ? events : events.slice(-1);
for (const ev of pick) printEvent(ev);

function row(id, sentVsT0Ms, rttMs, code, msg) {
  const t0 = Date.parse("2026-09-11T10:00:00.000Z");
  return {
    id,
    sentIso: new Date(t0 + sentVsT0Ms).toISOString(),
    sentVsT0Ms,
    rttMs,
    replyVsT0Ms: sentVsT0Ms + rttMs,
    code,
    msg,
    verdict: code === "1000" ? "CAUGHT" : sentVsT0Ms < 0 ? "TOO EARLY / taken" : "TAKEN",
    svTRID: "",
  };
}

function printEvent(ev) {
  const rows = ev.shots || [];
  const t0 = ev.t0;
  console.log("");
  console.log(`DROP / CATCH  domain=${ev.domain}`);
  console.log(`t0            ${t0}`);
  console.log(`armed         t0-${ev.earlyMs ?? 20}ms`);
  const hdr = "sock  sent UTC                  sent vs t0    rtt         reply vs t0   code    verdict           msg";
  console.log("-" .repeat(hdr.length));
  console.log(hdr);
  console.log("-" .repeat(hdr.length));
  for (const r of rows) {
    console.log(
      [
        pad("s" + r.id, 4),
        pad(r.sentIso, 24),
        pad(fmt(r.sentVsT0Ms), 12),
        pad((r.rttMs ?? 0).toFixed(2) + "ms", 10),
        pad(fmt(r.replyVsT0Ms), 12),
        pad(r.code, 6),
        pad(r.verdict || "", 16),
        pad(r.msg || "", 28),
      ].join("  ")
    );
  }
  console.log("-" .repeat(hdr.length));
}

function fmt(n) {
  const x = Number(n) || 0;
  return `${x >= 0 ? "+" : ""}${x.toFixed(2)}ms`;
}
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
