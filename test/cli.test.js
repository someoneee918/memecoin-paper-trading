import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "paper.js");
const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 10000, env: { ...process.env, NO_COLOR: "1", BLIX_NO_FOOTER: "1", BLIX_QUIET: "1", ...env } });

test("paper reset recovers a corrupt portfolio file, as the error message tells you to", () => {
  const file = join(mkdtempSync(join(tmpdir(), "paper-")), "portfolio.json");
  writeFileSync(file, "{broken");
  const bad = run(["history", "--file", file]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /run "paper reset"/);
  const r = run(["reset", "5", "--file", file]);
  assert.equal(r.status, 0, r.stderr);
  const book = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(book.cash, 5);
  assert.deepEqual(book.trades, []);
});

test("paper portfolio says when a position got no quote and counts as 0 in equity", async () => {
  const { createServer } = await import("node:http");
  const MINT = "9hjBLBrc7WZW2H8UQvBAvG5WiTZotXUv2Bdcn4f4pump";
  const server = createServer((req, res) => {
    if (req.url.startsWith("/price/v3")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ [MINT]: { usdPrice: 0.001, decimals: 6 } })); }
    res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "No routes found" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const file = join(mkdtempSync(join(tmpdir(), "paper-")), "portfolio.json");
  const book = { version: 1, startSol: 10, cash: 9, positions: { [MINT]: { mint: MINT, symbol: "GATOR", tokens: 1000, cost: 1, realized: 0, opened: 0, decimals: 6 } }, trades: [], createdAt: "2026-11-19T00:00:00Z" };
  writeFileSync(file, JSON.stringify(book));
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [cli, "portfolio", "--file", file], { env: { ...process.env, NO_COLOR: "1", BLIX_NO_FOOTER: "1", JUP_API_URL: `http://127.0.0.1:${server.address().port}` } });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  const code = await new Promise((r) => child.on("close", r));
  server.close();
  assert.equal(code, 0);
  assert.match(stdout, /no route/);
  assert.match(stdout, /1 position got no quote, so it counts as 0 SOL in equity/);
});

test("paper history validates count: non-positive or non-integer count exits 1, valid count limits rows", () => {
  const file = join(mkdtempSync(join(tmpdir(), "paper-")), "portfolio.json");
  const sampleTrades = [
    { time: 1000, side: "buy", mint: "mint1", symbol: "T1", tokens: 100, sol: 1, pnl: null },
    { time: 2000, side: "buy", mint: "mint2", symbol: "T2", tokens: 200, sol: 2, pnl: null },
    { time: 3000, side: "buy", mint: "mint3", symbol: "T3", tokens: 300, sol: 3, pnl: null },
    { time: 4000, side: "sell", mint: "mint1", symbol: "T1", tokens: 100, sol: 1.5, pnl: 0.5 }
  ];
  const book = { version: 1, startSol: 10, cash: 8.5, positions: {}, trades: sampleTrades, createdAt: "2026-11-19T00:00:00Z" };
  writeFileSync(file, JSON.stringify(book));

  // Invalid count: negative number (-3)
  const neg = run(["history", "-3", "--file", file]);
  assert.equal(neg.status, 1);
  assert.match(neg.stderr, /History count must be a whole number above 0/);

  // Invalid count: zero (0)
  const zero = run(["history", "0", "--file", file]);
  assert.equal(zero.status, 1);
  assert.match(zero.stderr, /History count must be a whole number above 0/);

  // Invalid count: non-number (abc)
  const nan = run(["history", "abc", "--file", file]);
  assert.equal(nan.status, 1);
  assert.match(nan.stderr, /History count must be a whole number above 0/);

  // Valid count: 2 with --json should return exactly 2 newest trades
  const valid = run(["history", "2", "--file", file, "--json"]);
  assert.equal(valid.status, 0);
  const rows = JSON.parse(valid.stdout);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, "T1"); // newest trade first
  assert.equal(rows[1].symbol, "T3");

  // Default count (omitted n) with --json should return all 4 trades
  const def = run(["history", "--file", file, "--json"]);
  assert.equal(def.status, 0);
  assert.equal(JSON.parse(def.stdout).length, 4);
});
