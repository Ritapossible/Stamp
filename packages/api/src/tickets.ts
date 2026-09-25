import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type DecideInput, type DecisionTicket, ticketHash } from "@stamp/engine";

/** A ticket together with the exact inputs it was decided from, so anyone can recompute it. */
export interface StoredTicket {
  ticket: DecisionTicket;
  input: DecideInput;
}

export class TicketTamperedError extends Error {}

/**
 * Append-only JSONL store, indexed by ticket hash in memory. Every read re-hashes the
 * stored ticket; a mismatch is an error, never a silently served ticket.
 * `path: null` keeps it in memory only (tests).
 */
export class TicketStore {
  private readonly byHash = new Map<string, StoredTicket>();

  private constructor(private readonly path: string | null) {}

  static memory(): TicketStore {
    return new TicketStore(null);
  }

  static async open(path: string): Promise<TicketStore> {
    const store = new TicketStore(path);
    let text = "";
    try {
      text = await readFile(path, "utf8");
    } catch {
      await mkdir(dirname(path), { recursive: true });
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as StoredTicket;
        store.byHash.set(rec.ticket.hash, rec);
      } catch {
        // A torn final line from a crash is skipped; everything before it is intact.
      }
    }
    return store;
  }

  async put(rec: StoredTicket): Promise<void> {
    if (ticketHash(rec.ticket as unknown as Record<string, unknown>) !== rec.ticket.hash) {
      throw new TicketTamperedError("refusing to store a ticket whose hash does not match");
    }
    if (this.byHash.has(rec.ticket.hash)) return;
    this.byHash.set(rec.ticket.hash, rec);
    if (this.path) await appendFile(this.path, `${JSON.stringify(rec)}\n`);
  }

  get(hash: string): StoredTicket | null {
    const rec = this.byHash.get(hash);
    if (!rec) return null;
    if (ticketHash(rec.ticket as unknown as Record<string, unknown>) !== hash) throw new TicketTamperedError(`stored ticket ${hash} no longer matches its hash`);
    return rec;
  }

  /** Token price on the most recent decision for this instrument (used by the labelled fake wallet). */
  latestTokenPrice(contractAddress: string): string | null {
    let best: DecisionTicket | null = null;
    for (const { ticket } of this.byHash.values()) {
      if (ticket.chosen?.contractAddress !== contractAddress.toLowerCase() || !ticket.tokenPriceUsd) continue;
      if (!best || ticket.asOf > best.asOf) best = ticket;
    }
    return best?.tokenPriceUsd ?? null;
  }

  get size(): number {
    return this.byHash.size;
  }
}
