/**
 * A durable replay guard for paid /x402 calls. The B402 library reserves a slot per payment
 * credential before settling, and marks it consumed or rejected afterwards; that record is what
 * stops one on-chain payment from being accepted twice. Studio's default keeps it in memory, so
 * a restart forgets every payment (Studio advisory M01). This keeps it in a JSON file instead.
 *
 * `update` is an atomic read-modify-write within this process: calls are serialised through a
 * promise chain, and each change is written to a temp file, flushed, then renamed over the old
 * one, so a crash leaves either the old or the new state, never half of one. It guards ONE agent
 * process with a persistent disk. Several instances would need a shared store (Redis etc.).
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** Structurally the library's B402ReplayStore / B402ReplayChange (the runtime doesn't re-export them). */
type Change<R> = { op: "noop"; result: R } | { op: "set"; value: unknown; result: R } | { op: "delete"; result: R };

export class FileReplayStore {
  private data: Record<string, unknown>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.data = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  }

  async get(key: string): Promise<unknown> {
    await this.queue.catch(() => {});
    return this.data[key];
  }

  update<R>(key: string, fn: (current: unknown) => Change<R>): Promise<R> {
    const run = this.queue.catch(() => {}).then(() => {
      const change = fn(this.data[key]);
      if (change.op === "noop") return change.result;
      const next = { ...this.data };
      if (change.op === "set") next[key] = change.value;
      else delete next[key];
      this.write(next); // throws on a disk error; the library treats that as "store unavailable"
      this.data = next;
      return change.result;
    });
    this.queue = run;
    return run;
  }

  private write(next: Record<string, unknown>): void {
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(next));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
}
