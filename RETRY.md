# Post-2302 retry (live catch-worker)

Do **not** change MAYDROP_LEADS to +55. Keep `-10,-10,-10,-10,-10,-10`.

After the first 6 CREATEs, if none returned 1000 and at least one returned 2302:

1. Keep the 6 TLS sessions logged in.
2. Wait until `t0 + 2000ms`, rebuild 6 CREATE frames with new clTRIDs, write all 6.
3. If still no 1000, wait until `t0 + 30000ms`, write again.
4. Stop on first 1000. Log `retry +2s` / `retry +30s` and `DONE caught` or `DONE missed`.

Only one name at a time. Do not overlap retries onto the next armed drop.

Stand-alone shooter: `maydrop-epp-6shots.mjs` now does this. Copy the same loop into `/opt/maydrop-full/scripts/catch-worker.mjs` then:

```bash
sudo systemctl restart maydrop-catcher
```
