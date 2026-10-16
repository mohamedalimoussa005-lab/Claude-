import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEvent } from "../../src/smart-money/contract/events.ts";
import { SmartMoneyStore } from "../../src/smart-money/store/store.ts";
import { tmpDir } from "./helpers.ts";

const ev = (key: string) => createEvent({ kind: "wallet.profile_computed", wallet: "W", dedupKey: key, evidenceTier: "VERIFIED", criteriaVersion: "c1", simulated: true, data: { key }, now: 1 });

test("events get increasing seq and are readable from a consumer cursor", async () => {
  const s = new SmartMoneyStore(tmpDir());
  const r = await s.appendEvents([ev("a"), ev("b"), ev("c")]);
  assert.deepEqual(r.map((x) => x.event.seq), [1, 2, 3]);
  assert.deepEqual(s.readEvents({ afterSeq: 1 }).events.map((e) => e.seq), [2, 3]);
  assert.deepEqual(s.readEvents({ afterSeq: 0, limit: 2 }).events.map((e) => e.seq), [1, 2]);
  assert.equal(s.status().lastSeq, 3);
});

test("appending the same fact twice is idempotent", async () => {
  const s = new SmartMoneyStore(tmpDir());
  await s.appendEvents([ev("a")]);
  const [again] = await s.appendEvents([ev("a")]);
  assert.equal(again.duplicate, true);
  assert.equal(s.status().events, 1);
});

test("a torn last line (crash mid-write) is skipped and the log keeps working", async () => {
  const dir = tmpDir();
  const s = new SmartMoneyStore(dir);
  await s.appendEvents([ev("a")]);
  appendFileSync(s.outboxPath, '{"schemaVersion":"smart-money.event/1","eventId":"sm1_tor');
  const read = s.readEvents();
  assert.equal(read.events.length, 1);
  assert.equal(read.corruptLines, 1);
  const [next] = await s.appendEvents([ev("b")]);
  assert.equal(next.event.seq, 2);
  assert.equal(s.readEvents().events.length, 2);
});

test("an invalid event is refused, never stored", async () => {
  const s = new SmartMoneyStore(tmpDir());
  await assert.rejects(s.appendEvents([{ ...ev("a"), evidenceTier: "SURE" as never }]), /invalid event/);
  assert.equal(s.status().events, 0);
});

test("concurrent writers never share a seq", async () => {
  const dir = tmpDir();
  const a = new SmartMoneyStore(dir);
  const b = new SmartMoneyStore(dir);
  await Promise.all([a.appendEvents([ev("a1"), ev("a2")]), b.appendEvents([ev("b1"), ev("b2")]), a.appendEvents([ev("a3")])]);
  const seqs = a.readEvents().events.map((e) => e.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
});

test("snapshots are written atomically and read back; bad names and corrupt files are safe", async () => {
  const dir = tmpDir();
  const s = new SmartMoneyStore(dir, () => 42);
  const f = await s.writeSnapshot("watchlist", { wallets: ["x"] });
  assert.equal(f.writtenAt, 42);
  assert.deepEqual(s.readSnapshot<{ wallets: string[] }>("watchlist")?.data, { wallets: ["x"] });
  await s.writeSnapshot("watchlist", { wallets: [] });
  assert.deepEqual(s.readSnapshot<{ wallets: string[] }>("watchlist")?.data, { wallets: [] });
  assert.deepEqual(readdirSync(join(dir, "snapshots")).filter((n) => n.endsWith(".tmp")), []);
  assert.equal(s.readSnapshot("missing"), null);
  writeFileSync(join(dir, "snapshots", "broken.json"), "{ not json");
  assert.equal(s.readSnapshot("broken"), null);
  assert.throws(() => s.readSnapshot("../etc/passwd"), /invalid snapshot name/);
  await assert.rejects(s.writeSnapshot("A/B", 1), /invalid snapshot name/);
});

test("the lock file is released after every write", async () => {
  const dir = tmpDir();
  const s = new SmartMoneyStore(dir);
  await s.appendEvents([ev("a")]);
  assert.equal(existsSync(join(dir, "observations.lock")), false);
});
