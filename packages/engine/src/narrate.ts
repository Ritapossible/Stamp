import { ISSUER_LABEL } from "./issuer.js";
import type { DecisionTicket, ReasonCode } from "./types.js";

type Fields = Omit<DecisionTicket, "narration">;

/**
 * Plain-English sentences filled from ticket fields, after the verdict exists.
 * Not hashed, and never an input to anything. No LLM.
 */
export function narrate(t: Fields): string {
  const parts: string[] = [];
  const name = t.chosen ? `${t.chosen.symbol} (${ISSUER_LABEL[t.chosen.issuer]})` : null;

  parts.push(`${t.verdict}.`);
  for (const r of t.reasons) {
    const s = sentence(r, t, name);
    if (s) parts.push(s);
  }
  if (t.tokenUnits && t.economicShares && t.notionalUsd && name) {
    parts.push(`$${t.notionalUsd} buys ${count(t.tokenUnits, `${t.chosen!.symbol} token`)} = ${count(t.economicShares, "share")} (multiplier ${t.multiplier}).`);
  }
  if (t.notes.includes("THIN_BOOK") && t.premiumBps !== null) {
    parts.push(`It is ${-t.premiumBps} bps below the reference; Stamp does not buy more because it looks cheap.`);
  }
  const others = t.rejected.filter((r) => r.reason === "NEVER_SWITCH");
  if (others.length > 0) parts.push(`Not the same instrument: ${list(others)}.`);
  parts.push(`Hash ${t.hash.slice(0, 12)}…`);
  return parts.join(" ");
}

function sentence(r: ReasonCode, t: Fields, name: string | null): string | null {
  const q = "query" in t.intent ? t.intent.query : t.intent.raw;
  switch (r) {
    case "OK":
      return `${name} passes every check.`;
    case "UNPARSEABLE_INTENT":
      return `Could not read the order. Try "Buy $20 of NVIDIA" or "Buy 1 share of Netflix". v1 only buys.`;
    case "UNKNOWN_TOKEN":
      return `No supported tokenized stock on BSC matches "${q}".`;
    case "AMBIGUOUS_QUERY":
      return `"${q}" is both a token symbol and a different stock's ticker. Name the company or the exact token.`;
    case "AMBIGUOUS_ISSUER":
      return `"${q}" exists from several issuers, and they are different products. Name one: ${list(t.rejected)}.`;
    case "ISSUER_NOT_ALLOWED": {
      const asked = t.rejected.filter((r) => r.reason === "ISSUER_NOT_ALLOWED");
      return asked.length > 0
        ? `You asked for ${list(asked)}, which your policy does not allow. Stamp never swaps you into another issuer's product.`
        : `There is no version of "${q}" from the issuer your policy allows, and Stamp never swaps issuers.`;
    }
    case "INCOMPLETE_STATUS":
      return `Binance did not return complete status or price data for ${name}. Missing data is never treated as "trading".`;
    case "NO_MULTIPLIER":
      return `No share multiplier for ${name}, so the number of shares per token is unknown.`;
    case "MULTIPLIER_CONFLICT":
      return `Binance's two sources disagree on how many shares one ${t.chosen?.symbol} token holds (${t.listMultiplier} vs ${t.multiplier}). That is a split-sized difference.`;
    case "MULTIPLIER_DRIFT":
      return `The share multiplier differs slightly between Binance's sources (${t.listMultiplier} vs ${t.multiplier}).`;
    case "UNIT_AMBIGUOUS": {
      const u = t.unitReadings;
      if (!u || !t.chosen) return `The amount could mean tokens or shares.`;
      const amt = "amount" in t.intent ? t.intent.amount : "?";
      return `"${amt} ${q}" could mean ${amt} token = ${trim(u.asTokens.shares)} shares ≈ $${u.asTokens.usd}, or ${amt} share = ${trim(u.asShares.tokens)} token ≈ $${u.asShares.usd}. One ${t.chosen.symbol} token holds ${t.multiplier} shares. Say "$… of" or "… shares of".`;
    }
    case "HALTED_CORPORATE_ACTION":
      return `${name} is halted for a corporate action (${t.reasonMsg}).`;
    case "MARKET_HALTED":
      return `Trading in ${name} is paused (${t.reasonCode}${t.reasonMsg ? `: ${t.reasonMsg}` : ""}).`;
    case "VENUE_CLOSED":
      return `Binance reports ${name} is not open for trading right now.`;
    case "SESSION_DISAGREEMENT":
      return `The New York clock and Binance disagree about whether the US market is open (Binance says ${t.marketStatus}).`;
    case "SESSION_UNKNOWN":
      return `The market session is unknown.`;
    case "NO_REFERENCE":
      return `There is no official stock price to compare against, so Stamp cannot tell whether the price is fair.`;
    case "PRICE_IMPLAUSIBLE":
      return `${name} is ${t.premiumBps} bps from the stock's price ($${t.economicPriceUsd} vs $${t.referenceUsd}). More than 5% apart is treated as bad data, not a bargain.`;
    case "SESSION_RICH":
      return `${sessionWords(t)}, ${t.chosen?.symbol} is ${t.premiumBps} bps above ${refWords(t)} — about $${t.overpayUsd} of overpay on this order. Parked.`;
    case "OVER_CAP":
      return `$${t.notionalUsd} is over the policy cap.`;
    default:
      return null;
  }
}

function sessionWords(t: Fields): string {
  switch (t.session) {
    case "regular":
      return "During market hours";
    case "extended":
      return "Outside regular hours";
    case "closed":
      return "While the US market is closed";
    default:
      return "In an unknown session";
  }
}

function refWords(t: Fields): string {
  if (t.referenceSource === "lastOfficialClose") return `the last official close ($${t.referenceUsd})`;
  if (t.referenceSource === "stockInfo-sibling") return `the stock price ($${t.referenceUsd}, via ${t.referenceSibling})`;
  return `the stock price ($${t.referenceUsd})`;
}

function list(rs: Array<{ symbol: string; issuer: keyof typeof ISSUER_LABEL }>): string {
  return rs.map((r) => `${r.symbol} (${ISSUER_LABEL[r.issuer]})`).join(", ");
}

function count(qty: string, noun: string): string {
  const q = trim(qty);
  return `${q} ${noun}${q === "1" ? "" : "s"}`;
}

/** "0.02792300" → "0.027923" for reading; the ticket keeps the fixed-width value. */
function trim(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
