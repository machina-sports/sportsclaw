// The trading block-list must stop order/wallet tools without hiding read-only
// market data tools that merely contain similar words.
import assert from "node:assert/strict";
import test from "node:test";

import { isBlockedTool } from "../dist/security.js";

test("order-placing and account tools are blocked when trading is off", () => {
  for (const name of [
    "polymarket-trading_market_order", "polymarket-trading_create_order", "polymarket-trading_cancel_order",
    "polymarket-trading_cancel_all_orders", "kalshi_place_order", "exchange_limit_order",
  ]) {
    assert.match(isBlockedTool(name, false) ?? "", /blocked pattern/, name);
  }
});

test("order-book and other read-only market tools stay available", () => {
  for (const name of [
    "kalshi_get_market_orderbook", "kalshi_get_market-orderbook", "polymarket_get_order_book",
    "kalshi_get_market", "markets_get_market_price", "polymarket_get_market_prices",
  ]) {
    assert.equal(isBlockedTool(name, false), null, name);
  }
});

test("allowTrading lifts the block", () => {
  assert.equal(isBlockedTool("polymarket-trading_market_order", true), null);
});
