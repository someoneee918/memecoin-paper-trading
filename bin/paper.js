#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { SOL_MINT, c, compact, footer, isAddress, main, parseArgs, pct, table } from "../lib/core.js";
import { quote, tokenPrices } from "../lib/jupiter.js";
import { resolveSymbol, symbolOf } from "../lib/tokens.js";
import { applyBuy, applySell, checkBook, newBook, valuation } from "../lib/book.js";

const HELP = `memecoin-paper-trading: practise Solana memecoin trades with fake SOL at real prices

Usage:
  paper buy <mint> <sol>            Buy with paper SOL, filled at a live Jupiter quote
  paper sell <mint> <percent|all>   Sell part or all of a position (e.g. 50, 25%, all)
  paper portfolio                   Positions valued at what you would get selling now
  paper history [n]                 Your last n trades (default 20)
  paper reset [sol]                 Start over with a fresh balance (default 10 SOL)

Options:
  --slippage <bps>   Slippage for quotes in basis points (default 100 = 1%)
  --file <path>      Portfolio file (default ~/.blix-paper/portfolio.json, or $PAPER_FILE)
  --json             Machine-readable output
  --help             Show this help

Fills use real Jupiter routes and include price impact, so a trade that would
move a thin pool in real life moves it here too. No wallet, no keys, no real SOL.
`;

const LAMPORTS = 1e9;

function bookPath(args) {
  return resolve(String(args.file || process.env.PAPER_FILE || join(homedir(), ".blix-paper", "portfolio.json")));
}
function load(path) {
  if (!existsSync(path)) return newBook();
  try {
    const book = JSON.parse(readFileSync(path, "utf8"));
    if (!checkBook(book)) throw new Error("Invalid shape");
    return book;
  } catch {
    throw new Error(`Cannot read ${path}. Fix or delete it, or run "paper reset".`);
  }
}
function save(path, book) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", JSON.stringify(book, null, 2));
  renameSync(path + ".tmp", path); // atomic: a crash never leaves half a file
}
const sol = (n, d = 4) => `${n.toFixed(d)} SOL`;
/** "+0.0123", "-0.0123", and "0.0000" rather than "-0.0000". */
const plus = (n, d = 4) => { const s = n.toFixed(d); return /^-?0\.0+$/.test(s) ? s.replace("-", "") : (n > 0 ? "+" : "") + s; };
const signed = (n, text) => (n === null ? c.dim("?") : Math.abs(n) < 5e-5 ? text : n > 0 ? c.green(text) : c.red(text));

/** SOL you would receive selling every position now, using real quotes. */
async function liveValues(book, slippage) {
  const values = new Map();
  const prices = await tokenPrices(Object.keys(book.positions)).catch(() => new Map());
  for (const p of Object.values(book.positions)) {
    const decimals = prices.get(p.mint)?.decimals ?? p.decimals;
    if (decimals == null) continue;
    try {
      const q = await quote(p.mint, SOL_MINT, p.tokens * 10 ** decimals, slippage);
      values.set(p.mint, q.outAmount / LAMPORTS);
    } catch { /* no route: leave unpriced */ }
  }
  return values;
}

main(async () => {
  const args = parseArgs(process.argv.slice(2), { booleans: ["json", "help"] });
  const [cmd, a1, a2] = args._;
  if (args.help || !cmd) { console.log(HELP); process.exit(args.help ? 0 : 1); }
  const path = bookPath(args);
  const slippage = Math.max(1, Math.min(5000, Number(args.slippage) || 100));
  const out = (obj, text) => (args.json ? console.log(JSON.stringify(obj, null, 2)) : text());

  // reset never reads the old file, so it can recover from a corrupt one.
  if (cmd === "reset") {
    const start = a1 !== undefined ? Number(a1) : 10;
    if (!(Number.isFinite(start) && start > 0)) throw new Error("Starting balance must be a positive number of SOL.");
    save(path, newBook(start));
    return out({ reset: true, startSol: start, file: path }, () => console.log(`Fresh paper portfolio with ${sol(start, 2)} at ${c.dim(path)}`));
  }

  const book = load(path);

  if (cmd === "buy") {
    if (!isAddress(a1)) throw new Error("Usage: paper buy <mint> <sol>");
    const size = Number(a2);
    if (!(size > 0)) throw new Error("Give the buy size in SOL, e.g. paper buy <mint> 0.5");
    if (size > book.cash + 1e-12) throw new Error(`Not enough paper SOL: you have ${sol(book.cash)}.`);
    const [q, prices, fetchedSymbol] = await Promise.all([quote(SOL_MINT, a1, size * LAMPORTS, slippage), tokenPrices([a1]), symbolOf(a1)]);
    const symbol = resolveSymbol(fetchedSymbol, book.positions[a1]?.symbol, a1);
    const decimals = prices.get(a1)?.decimals;
    if (decimals == null) throw new Error("Could not read this token's decimals from Jupiter.");
    const tokens = q.outAmount / 10 ** decimals;
    const p = applyBuy(book, { mint: a1, symbol, solIn: size, tokensOut: tokens, impact: q.priceImpactPct });
    p.decimals = decimals;
    save(path, book);
    return out({ side: "buy", mint: a1, symbol, sol: size, tokens, priceImpactPct: q.priceImpactPct, route: q.route, cash: book.cash }, () => {
      console.log(`${c.green("Bought")} ${c.bold(compact(tokens))} ${c.bold(symbol)} for ${sol(size)}  ${c.dim(`via ${q.route}`)}`);
      if (q.priceImpactPct > 3) console.log(c.yellow(`Price impact ${q.priceImpactPct.toFixed(2)}%: this pool is thin for a trade this size.`));
      console.log(c.dim(`Paper SOL left: ${sol(book.cash)}`));
    });
  }

  if (cmd === "sell") {
    if (!isAddress(a1)) throw new Error("Usage: paper sell <mint> <percent|all>");
    const p = book.positions[a1];
    if (!p) throw new Error("You hold none of this token. Run \"paper portfolio\" to see positions.");
    const share = a2 === undefined || a2 === "all" ? 100 : Number(String(a2).replace("%", ""));
    if (!(share > 0 && share <= 100)) throw new Error("Sell amount must be a percent from 1 to 100, or \"all\".");
    const tokens = share === 100 ? p.tokens : p.tokens * (share / 100);
    const decimals = p.decimals ?? (await tokenPrices([a1])).get(a1)?.decimals;
    if (decimals == null) throw new Error("Could not read this token's decimals from Jupiter.");
    const q = await quote(a1, SOL_MINT, tokens * 10 ** decimals, slippage);
    const received = q.outAmount / LAMPORTS;
    const { pnl, costOut } = applySell(book, { mint: a1, tokensIn: tokens, solOut: received, impact: q.priceImpactPct });
    save(path, book);
    return out({ side: "sell", mint: a1, symbol: p.symbol, tokens, sol: received, pnl, roi: (pnl / costOut) * 100, priceImpactPct: q.priceImpactPct, cash: book.cash }, () => {
      console.log(`${c.red("Sold")} ${c.bold(compact(tokens))} ${c.bold(p.symbol)} for ${sol(received)}  ${signed(pnl, `${plus(pnl)} SOL (${pct((pnl / costOut) * 100)})`)}`);
      if (q.priceImpactPct > 3) console.log(c.yellow(`Price impact ${q.priceImpactPct.toFixed(2)}%.`));
      console.log(c.dim(`Paper SOL: ${sol(book.cash)}`));
    });
  }

  if (cmd === "portfolio" || cmd === "pf") {
    const v = valuation(book, await liveValues(book, slippage));
    return out(v, () => {
      console.log(`\n${c.bold("Paper portfolio")}  ${c.dim(path)}\n`);
      console.log(`  Equity     ${c.bold(sol(v.equity))}  ${signed(v.totalPnl, `${plus(v.totalPnl)} SOL (${pct(v.totalRoi)})`)} since starting with ${sol(book.startSol, 2)}`);
      console.log(`  Cash       ${sol(v.cash)}`);
      console.log(`  Realized   ${signed(v.realized, `${plus(v.realized)} SOL`)}${v.winRate === null ? "" : `  ·  ${v.winRate.toFixed(0)}% of ${v.sells} sells in profit`}\n`);
      if (!v.rows.length) { console.log(c.dim('  No open positions. Try: paper buy <mint> 0.5')); }
      else table(
        [{ title: "Token", width: 10 }, { title: "Tokens", width: 9, right: true }, { title: "Cost", width: 9, right: true }, { title: "Sell now", width: 9, right: true }, { title: "PnL", width: 9, right: true }, { title: "ROI", width: 8, right: true }, { title: "Mint", width: 44 }],
        v.rows.map((r) => [c.bold(r.symbol), compact(r.tokens), r.cost.toFixed(4), r.value === null ? c.dim("no route") : r.value.toFixed(4), signed(r.unrealized, r.unrealized === null ? "?" : plus(r.unrealized)), signed(r.roi, r.roi === null ? "?" : pct(r.roi, 0)), c.dim(r.mint)]),
      );
      console.log(c.dim("\n\"Sell now\" is a live Jupiter quote for the whole position, including price impact."));
      if (v.unpriced) console.log(c.yellow(`${v.unpriced} position${v.unpriced === 1 ? "" : "s"} got no quote, so ${v.unpriced === 1 ? "it counts" : "they count"} as 0 SOL in equity and PnL above.`));
      footer("/memecoin-paper-trading", "Paper trading with AI picks, live charts and a track record");
    });
  }

  if (cmd === "history") {
    let n = 20;
    if (a1 !== undefined) {
      n = Number(a1);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error("History count must be a whole number above 0.");
      }
    }
    const trades = book.trades.slice(-n).reverse();
    return out(trades, () => {
      if (!trades.length) return console.log(c.dim("No trades yet."));
      table(
        [{ title: "When", width: 17 }, { title: "Side", width: 4 }, { title: "Token", width: 10 }, { title: "Tokens", width: 9, right: true }, { title: "SOL", width: 9, right: true }, { title: "PnL", width: 9, right: true }],
        trades.map((t) => [new Date(t.time).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }), t.side === "buy" ? c.green("BUY") : c.red("SELL"), t.symbol, compact(t.tokens), t.sol.toFixed(4), t.side === "sell" ? signed(t.pnl, plus(t.pnl)) : ""]),
      );
    });
  }

  throw new Error(`Unknown command "${cmd}". Run paper --help.`);
});
