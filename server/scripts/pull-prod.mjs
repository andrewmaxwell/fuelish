// Copies production's recordings into the local `wrangler dev` state (server/.wrangler/state/v3), so the
// local site shows the same trips. Read-only against production. Run through tools/pull-prod.sh.
//
//   D1   rows exported with `wrangler d1 export --remote`, loaded into a freshly migrated local database
//        (local-only rows, such as test trips uploaded to wrangler dev, are replaced).
//   R2   mirrored object by object through a remote binding: new or changed objects are copied,
//        objects production no longer has are removed. APKs (app/) are skipped unless --apks.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy, unstable_readConfig, unstable_splitSqlQuery } from "wrangler";

const apks = process.argv.includes("--apks");
const skipR2 = process.argv.includes("--db-only");
const config = unstable_readConfig({ config: "wrangler.jsonc" });
const db = config.d1_databases[0];
const bucket = config.r2_buckets[0].bucket_name;
const state = ".wrangler/state/v3";
const tmp = mkdtempSync(join(tmpdir(), "fuelish-pull-"));
// Wrangler's own output is shown only for the export (its progress); errors always show.
const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args], { stdio: ["ignore", args[1] === "export" ? "inherit" : "ignore", "inherit"] });

try {
  // ---------- D1 ----------
  // Data only, loaded into a fresh local database built by our own migrations. The rows go in table
  // by table so each table's references exist first (the export lists tables alphabetically).
  console.log(`\n▸ Exporting the production database (${db.database_name})…`);
  const dump = join(tmp, "prod.sql");
  wrangler("d1", "export", db.database_name, "--remote", "--no-schema", "--output", dump);
  console.log("▸ Rebuilding the local database from it…");
  rmSync(join(state, "d1"), { recursive: true, force: true });
  wrangler("d1", "migrations", "apply", db.database_name, "--local");
  const schema = JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", db.database_name, "--local", "--json",
    "--command", "SELECT name, sql FROM sqlite_master WHERE type = 'table'"], { encoding: "utf8" }))[0].results;
  const refs = new Map(schema.map((t) => [t.name, [...(t.sql || "").matchAll(/REFERENCES\s+"?(\w+)"?/gi)].map((m) => m[1]).filter((r) => r !== t.name)]));
  const order = [];
  const visit = (t, seen = new Set()) => {
    if (order.includes(t) || seen.has(t)) return;
    seen.add(t);
    for (const r of refs.get(t) || []) visit(r, seen);
    order.push(t);
  };
  for (const t of refs.keys()) visit(t);
  const byTable = new Map();
  for (const stmt of unstable_splitSqlQuery(readFileSync(dump, "utf8"))) {
    const t = stmt.match(/^\s*INSERT\s+INTO\s+"?(\w+)"?/i)?.[1];
    if (!t || t === "d1_migrations" || t.startsWith("sqlite_") || t.startsWith("_cf_")) continue;
    (byTable.get(t) || byTable.set(t, []).get(t)).push(stmt.trim().replace(/;?$/, ";"));
  }
  const unknown = [...byTable.keys()].filter((t) => !refs.has(t));
  if (unknown.length) throw new Error(`Production has tables the local migrations don't create: ${unknown.join(", ")}. Pull main first.`);
  const data = join(tmp, "data.sql");
  writeFileSync(data, order.flatMap((t) => byTable.get(t) || []).join("\n") + "\n");
  wrangler("d1", "execute", db.database_name, "--local", "--file", data);
  console.log("  " + order.filter((t) => byTable.has(t)).map((t) => `${t} ${byTable.get(t).length}`).join(", "));

  // ---------- R2 ----------
  if (!skipR2) {
    console.log(`\n▸ Mirroring R2 (${bucket})${apks ? "" : ", without APKs"}…`);
    const proxyConfig = join(tmp, "wrangler.json");
    writeFileSync(proxyConfig, JSON.stringify({
      name: "fuelish-pull",
      compatibility_date: config.compatibility_date,
      account_id: config.account_id,
      r2_buckets: [
        { binding: "PROD", bucket_name: bucket, remote: true },
        { binding: "LOCAL", bucket_name: bucket },
      ],
    }));
    const proxy = await getPlatformProxy({ configPath: proxyConfig, persist: { path: state } });
    try {
      const { PROD, LOCAL } = proxy.env;
      const list = async (b) => {
        const all = new Map();
        let cursor;
        do {
          const page = await b.list({ cursor, limit: 1000 });
          for (const o of page.objects) all.set(o.key, o);
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        return all;
      };
      const [prod, local] = await Promise.all([list(PROD), list(LOCAL)]);
      const wanted = [...prod.values()].filter((o) => apks || !o.key.startsWith("app/"));
      const todo = wanted.filter((o) => { const l = local.get(o.key); return !l || l.size !== o.size || l.etag !== o.etag; });
      const keep = new Set(wanted.map((o) => o.key));
      const stale = [...local.keys()].filter((k) => !keep.has(k));
      const mb = (n) => (n / 1e6).toFixed(1);
      const total = todo.reduce((s, o) => s + o.size, 0);
      console.log(`  ${wanted.length} objects in production; ${todo.length} to copy (${mb(total)} MB), ${stale.length} to remove locally.`);
      let done = 0, bytes = 0;
      for (const o of todo) {
        const src = await PROD.get(o.key);
        await LOCAL.put(o.key, await src.arrayBuffer(), { httpMetadata: src.httpMetadata, customMetadata: src.customMetadata });
        bytes += o.size;
        process.stdout.write(`\r  copied ${++done}/${todo.length} (${mb(bytes)} of ${mb(total)} MB)`);
      }
      if (todo.length) process.stdout.write("\n");
      if (stale.length) await LOCAL.delete(stale);
    } finally {
      await proxy.dispose();
    }
  }
  console.log("\n✓ Local copy is up to date with production.");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
