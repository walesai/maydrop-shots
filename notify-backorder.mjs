/** POST a caught name to backordering.uk. Does not throw. */
export async function notifyBackorder({ domain, tag, txid }) {
  const url = process.env.BACKORDER_HOOK_URL || "https://www.backordering.uk/api/catch";
  const secret = process.env.BACKORDER_HOOK_SECRET || process.env.MAYDROP_HOOK_SECRET || "";
  if (!secret) {
    console.log("hook skip: set BACKORDER_HOOK_SECRET");
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + secret,
      },
      body: JSON.stringify({
        domain: String(domain || "").toLowerCase(),
        code: "1000",
        tag: tag || process.env.EPP_TAG || "DIGITALWALES",
        txid: txid || "",
      }),
    });
    const text = await res.text();
    console.log("hook " + res.status + " " + text.slice(0, 400));
    return { ok: res.ok, status: res.status, body: text.slice(0, 400) };
  } catch (err) {
    console.log("hook fail " + err.message);
    return { ok: false, error: err.message };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const domain = process.argv[2];
  if (!domain) {
    console.error("usage: node notify-backorder.mjs example.co.uk");
    process.exit(1);
  }
  const result = await notifyBackorder({ domain, txid: "manual" });
  process.exit(result.ok ? 0 : 1);
}
