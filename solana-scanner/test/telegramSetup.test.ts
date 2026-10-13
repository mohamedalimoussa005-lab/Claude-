import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkConfigOffline, chatsFromUpdates, findChat, getMe, loadEnvFile, mergeEnvText, parseEnvFile, testNotification, writeEnvKeys } from "../src/detective/breaking-signal/index.ts";
import type { TgFetch } from "../src/detective/breaking-signal/index.ts";

const TOKEN = "123456789:AAH_fake_token_value_for_tests_0123456789";
const reply = (status: number, body: unknown): TgFetch => async (u) => ((reply.urls ??= []).push(u), { status, json: async () => body });
reply.urls = [] as string[];

test("getMe validates the token and never leaks it in the error", async () => {
  assert.deepEqual(await getMe(reply(200, { ok: true, result: { is_bot: true, username: "DetectiveBreakingSignalBot" } }), TOKEN), { ok: true, username: "DetectiveBreakingSignalBot", isBot: true, error: null });
  const bad = await getMe(async () => { throw new Error(`fetch failed https://api.telegram.org/bot${TOKEN}/getMe`); }, TOKEN);
  assert.equal(bad.ok, false);
  assert.doesNotMatch(bad.error ?? "", /AAH_fake|123456789:/);
  const unauthorized = await getMe(reply(401, { ok: false, description: "Unauthorized" }), TOKEN);
  assert.equal(unauthorized.ok, false);
  assert.match(unauthorized.error ?? "", /401/);
});

const upd = (chat: Record<string, unknown>, text = "/start", date = 1_760_000_000) => ({ update_id: Math.floor(Math.random() * 1e6), message: { chat, text, date } });

test("getUpdates: one private chat → chosen automatically; several or none → never guessed", async () => {
  const one = await findChat(reply(200, { ok: true, result: [upd({ id: 4242, type: "private", first_name: "Mohamed" }), upd({ id: 4242, type: "private", first_name: "Mohamed" }, "salut", 1_760_000_100)] }), TOKEN);
  assert.equal(one.state, "found");
  if (one.state === "found") assert.equal(one.chat.id, "4242");
  const many = await findChat(reply(200, { ok: true, result: [upd({ id: 1, type: "private", first_name: "A" }), upd({ id: 2, type: "private", first_name: "B" })] }), TOKEN);
  assert.equal(many.state, "ambiguous");
  const group = await findChat(reply(200, { ok: true, result: [upd({ id: -100123, type: "supergroup", title: "G" })] }), TOKEN);
  assert.equal(group.state, "ambiguous", "a group is never picked silently");
  const none = await findChat(reply(200, { ok: true, result: [] }), TOKEN);
  assert.equal(none.state, "none");
  const hook = await findChat(reply(409, { ok: false, description: "Conflict: can't use getUpdates method while webhook is active" }), TOKEN);
  assert.equal(hook.state, "error");
  if (hook.state === "error") assert.match(hook.error, /webhook/);
  assert.equal(chatsFromUpdates({ result: [{ update_id: 1 }] }).length, 0);
});

test(".env file: keys merged without touching other lines, mode 600, loading never overrides and never reveals values", () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-"));
  const p = join(dir, ".env.breaking");
  writeFileSync(p, "OTHER=keep\n# comment\nBREAKING_SIGNAL_TELEGRAM_SEND=no\n");
  writeEnvKeys(p, { BREAKING_SIGNAL_TELEGRAM_TOKEN: TOKEN, BREAKING_SIGNAL_TELEGRAM_SEND: "no" });
  writeEnvKeys(p, { BREAKING_SIGNAL_TELEGRAM_CHAT_ID: "4242" });
  const text = readFileSync(p, "utf8");
  assert.match(text, /^OTHER=keep$/m);
  assert.match(text, /^# comment$/m);
  assert.equal((text.match(/BREAKING_SIGNAL_TELEGRAM_SEND=/g) ?? []).length, 1);
  assert.equal(statSync(p).mode & 0o777, 0o600);
  const env: Record<string, string | undefined> = { BREAKING_SIGNAL_TELEGRAM_CHAT_ID: "999" };
  const names = loadEnvFile(p, env);
  assert.ok(names.includes("BREAKING_SIGNAL_TELEGRAM_TOKEN") && !names.includes("BREAKING_SIGNAL_TELEGRAM_CHAT_ID"), "existing variable not overridden");
  assert.equal(env.BREAKING_SIGNAL_TELEGRAM_CHAT_ID, "999");
  assert.ok(names.every((n) => !n.includes(TOKEN)));
  assert.deepEqual(loadEnvFile(join(dir, "missing"), {}), []);
  assert.equal(parseEnvFile("export A='x y'\nB=\"z\"\n#C=1").A, "x y");
  assert.equal(mergeEnvText("", { A: "1" }), "A=1\n");
});

test("configuration check: valid token + chat id stay in SIMULATION until SEND=yes; invalid formats are flagged", () => {
  const ok = checkConfigOffline({ BREAKING_SIGNAL_TELEGRAM_TOKEN: TOKEN, BREAKING_SIGNAL_TELEGRAM_CHAT_ID: "4242", BREAKING_SIGNAL_TELEGRAM_SEND: "no" });
  assert.equal(ok.ready, true);
  assert.match(ok.lines[2]!.text, /SIMULATION/);
  assert.ok(!JSON.stringify(ok).includes("AAH_fake"), "the token value is never printed");
  assert.equal(checkConfigOffline({}).ready, false);
  assert.equal(checkConfigOffline({ BREAKING_SIGNAL_TELEGRAM_TOKEN: "bad", BREAKING_SIGNAL_TELEGRAM_CHAT_ID: "x" }).ready, false);
  assert.match(checkConfigOffline({ BREAKING_SIGNAL_TELEGRAM_TOKEN: TOKEN, BREAKING_SIGNAL_TELEGRAM_CHAT_ID: "4", BREAKING_SIGNAL_TELEGRAM_SEND: "yes" }).lines[2]!.text, /AUTORISÉ/);
});

test("test notification is clearly marked SIMULATION and contains no alert, token or event", () => {
  const t = testNotification(Date.parse("2026-10-14T12:00:00Z"), "simulation");
  assert.match(t, /^\[SIMULATION\] Test de configuration/);
  assert.match(t, /ce n'est PAS une alerte/);
  assert.match(t, /Heure: 2026-10-14T12:00:00Z/);
  assert.doesNotMatch(t, /CONFIRMÉ|PROBABLE|[1-9A-HJ-NP-Za-km-z]{32,44}/);
  assert.match(testNotification(0, "sent"), /ENVOYÉ APRÈS VOTRE CONFIRMATION/);
});

test("CLI: `telegram test` prints the simulated notification and sends nothing; `--send` is refused without both confirmations; token never an argument", () => {
  const dir = mkdtempSync(join(tmpdir(), "tgcli-"));
  const run = (a: string[], env: Record<string, string>) => {
    try {
      return { out: execFileSync("node", ["--experimental-strip-types", "--no-warnings", join(process.cwd(), "scripts/telegram-setup.ts"), ...a], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] }), code: 0 };
    } catch (e) {
      const x = e as { stdout?: string; status?: number };
      return { out: x.stdout ?? "", code: x.status ?? 1 };
    }
  };
  const sim = run(["test"], {});
  assert.equal(sim.code, 0);
  assert.match(sim.out, /\[SIMULATION\] Test de configuration/);
  assert.match(sim.out, /non envoyée/);
  const refused = run(["test", "--send"], { BREAKING_SIGNAL_TELEGRAM_TOKEN: TOKEN, BREAKING_SIGNAL_TELEGRAM_CHAT_ID: "4242" });
  assert.equal(refused.code, 1);
  assert.match(refused.out, /Envoi refusé/);
  assert.doesNotMatch(refused.out, /AAH_fake/);
  const noConfirm = run(["test", "--send"], { BREAKING_SIGNAL_TELEGRAM_TOKEN: TOKEN, BREAKING_SIGNAL_TELEGRAM_CHAT_ID: "4242", BREAKING_SIGNAL_TELEGRAM_SEND: "yes" });
  assert.equal(noConfirm.code, 1, "SEND=yes alone is not enough: --confirm-send-test is also required");
  const chk = run(["check"], { BREAKING_SIGNAL_TELEGRAM_TOKEN: TOKEN, BREAKING_SIGNAL_TELEGRAM_CHAT_ID: "4242" });
  assert.equal(chk.code, 0);
  assert.doesNotMatch(chk.out, /AAH_fake|123456789:/);
});
