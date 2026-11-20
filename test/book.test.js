import test from "node:test";
import assert from "node:assert/strict";
import { applyBuy, applySell, checkBook, newBook, valuation } from "../lib/book.js";

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test("a failed lookup (symbol null) keeps a known symbol on a second buy", () => {
  const b = newBook(10);
  applyBuy(b, { mint: "M", symbol: "DCTY", solIn: 1, tokensOut: 100 });
  applyBuy(b, { mint: "M", symbol: null, solIn: 1, tokensOut: 100 });
  assert.equal(b.positions.M.symbol, "DCTY");
  assert.equal(b.trades.at(-1).symbol, "DCTY");
});

test("applyBuy stores a null symbol for a new position; the CLI resolves the fallback", () => {
  const b = newBook(10);
  applyBuy(b, { mint: "M", symbol: null, solIn: 1, tokensOut: 100 });
  assert.equal(b.positions.M.symbol, null);
});

test("buying spends cash and opens a position", () => {
  const b = newBook(10);
  applyBuy(b, { mint: "M", symbol: "MEME", solIn: 2, tokensOut: 1000 });
  near(b.cash, 8);
  assert.equal(b.positions.M.tokens, 1000);
  near(b.positions.M.cost, 2);
});

test("you cannot spend more than you have, or buy nothing", () => {
  const b = newBook(1);
  assert.throws(() => applyBuy(b, { mint: "M", solIn: 2, tokensOut: 5 }), /Not enough/);
  assert.throws(() => applyBuy(b, { mint: "M", solIn: 0, tokensOut: 5 }));
  assert.throws(() => applyBuy(b, { mint: "M", solIn: 0.5, tokensOut: 0 }));
  near(b.cash, 1);
});

test("partial sells realize the sold share of the average cost", () => {
  const b = newBook(10);
  applyBuy(b, { mint: "M", solIn: 1, tokensOut: 100 });
  applyBuy(b, { mint: "M", solIn: 3, tokensOut: 100 }); // average 0.02 SOL per token
  const { pnl } = applySell(b, { mint: "M", tokensIn: 50, solOut: 2 });
  near(pnl, 2 - 1);
  near(b.positions.M.cost, 3);
  near(b.cash, 8);
});

test("selling everything closes the position and records it", () => {
  const b = newBook(10);
  applyBuy(b, { mint: "M", symbol: "MEME", solIn: 1, tokensOut: 100 });
  applySell(b, { mint: "M", tokensIn: 100, solOut: 0.4 });
  assert.equal(b.positions.M, undefined);
  near(b.closed[0].realized, -0.6);
  assert.throws(() => applySell(b, { mint: "M", tokensIn: 1, solOut: 1 }), /hold none/);
});

test("cannot sell more than held", () => {
  const b = newBook(10);
  applyBuy(b, { mint: "M", solIn: 1, tokensOut: 100 });
  assert.throws(() => applySell(b, { mint: "M", tokensIn: 101, solOut: 1 }), /You hold/);
});

test("valuation adds open value to cash and counts unpriced positions", () => {
  const b = newBook(10);
  applyBuy(b, { mint: "A", solIn: 2, tokensOut: 100 });
  applyBuy(b, { mint: "B", solIn: 1, tokensOut: 100 });
  applySell(b, { mint: "A", tokensIn: 50, solOut: 1.5 });
  const v = valuation(b, new Map([["A", 3]]));
  near(v.cash, 8.5);
  near(v.equity, 11.5);
  near(v.totalPnl, 1.5);
  near(v.realized, 0.5);
  assert.equal(v.unpriced, 1);
  assert.equal(v.winRate, 100);
  near(v.rows.find((r) => r.mint === "A").unrealized, 2);
});

test("checkBook validates portfolio shape correctly", () => {
  assert.equal(checkBook(null), false);
  assert.equal(checkBook({}), false);
  assert.equal(checkBook({ startSol: "10", cash: 10, positions: {}, trades: [] }), false);
  assert.equal(checkBook({ startSol: 10, cash: "10", positions: {}, trades: [] }), false);
  assert.equal(checkBook({ startSol: 10, cash: 10, positions: null, trades: [] }), false);
  assert.equal(checkBook({ startSol: 10, cash: 10, positions: {}, trades: null }), false);
  assert.equal(checkBook(newBook(10)), true);
});
