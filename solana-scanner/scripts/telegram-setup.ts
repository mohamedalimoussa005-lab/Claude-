/**
 * Telegram setup for Breaking Signal. Run it on YOUR machine (the token must never travel through a chat or a log).
 *
 *   npm run telegram -- token                 hidden prompt (or BREAKING_SIGNAL_TELEGRAM_TOKEN in the environment) → validated with getMe → .env.breaking (mode 600, git-ignored)
 *   npm run telegram -- chat-id [--chat-id N] getUpdates → your chat id → .env.breaking
 *   npm run telegram -- check [--online]      verifies the configuration (online: getMe), sends nothing
 *   npm run telegram -- test                  prepares the test notification, marked SIMULATION, NOT sent
 *   npm run telegram -- test --send --confirm-send-test   real test message: only with BREAKING_SIGNAL_TELEGRAM_SEND=yes too
 *
 * The token is never accepted as an argument (shell history), never printed, never logged. Nothing is committed.
 */

import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { ENV_FILE, TOKEN_RE, TelegramNotifier, checkConfigOffline, findChat, getMe, loadEnvFile, redact, telegramFromEnv, testNotification, writeEnvKeys } from "../src/detective/breaking-signal/index.ts";
import type { TgFetch } from "../src/detective/breaking-signal/index.ts";

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";
const flag = (n: string) => args.includes(`--${n}`);
const val = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const tgFetch: TgFetch = (u, i) => globalThis.fetch(u, i) as never;
const loaded = loadEnvFile(ENV_FILE, process.env);
const safe = (s: string) => redact(s, process.env.BREAKING_SIGNAL_TELEGRAM_TOKEN ?? null);
const say = (s: string) => console.log(safe(s));

async function hiddenPrompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("terminal interactif requis pour saisir le jeton sans l'afficher (ou définissez BREAKING_SIGNAL_TELEGRAM_TOKEN dans l'environnement)");
  let muted = false;
  const out = new Writable({ write(chunk, _e, cb) { if (!muted) process.stdout.write(chunk); cb(); } });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  return new Promise((resolve) => {
    process.stdout.write(question);
    muted = true;
    rl.question("", (a) => {
      rl.close();
      process.stdout.write("\n");
      resolve(a.trim());
    });
  });
}

if (cmd === "help" || flag("help")) {
  say("usage: npm run telegram -- token | chat-id [--chat-id N] | check [--online] | test [--send --confirm-send-test]");
  process.exit(0);
}

if (cmd === "token") {
  const token = (process.env.BREAKING_SIGNAL_TELEGRAM_TOKEN?.trim() || (await hiddenPrompt("Jeton du bot (saisie masquée): "))).trim();
  if (!TOKEN_RE.test(token)) {
    say("Format de jeton invalide (attendu: 123456789:AA…). Rien n'a été écrit.");
    process.exit(1);
  }
  const me = await getMe(tgFetch, token);
  if (!me.ok) {
    say(`Jeton refusé par Telegram: ${me.error ?? "pas un bot"}. Rien n'a été écrit.`);
    process.exit(1);
  }
  writeEnvKeys(ENV_FILE, { BREAKING_SIGNAL_TELEGRAM_TOKEN: token, BREAKING_SIGNAL_TELEGRAM_SEND: "no" });
  say(`Jeton valide pour @${me.username}. Écrit dans ${ENV_FILE} (permissions 600, ignoré par Git). Envoi réel: DÉSACTIVÉ (BREAKING_SIGNAL_TELEGRAM_SEND=no).`);
  say("Étape suivante: npm run telegram -- chat-id");
  process.exit(0);
}

const token = process.env.BREAKING_SIGNAL_TELEGRAM_TOKEN?.trim();

if (cmd === "chat-id") {
  if (!token || !TOKEN_RE.test(token)) {
    say("Jeton absent ou invalide: lancez d'abord `npm run telegram -- token`.");
    process.exit(1);
  }
  const forced = val("chat-id");
  if (forced) {
    if (!/^-?\d+$/.test(forced)) {
      say("--chat-id doit être un nombre.");
      process.exit(1);
    }
    writeEnvKeys(ENV_FILE, { BREAKING_SIGNAL_TELEGRAM_CHAT_ID: forced });
    say(`Identifiant de conversation enregistré dans ${ENV_FILE}.`);
    process.exit(0);
  }
  const r = await findChat(tgFetch, token);
  if (r.state === "found") {
    writeEnvKeys(ENV_FILE, { BREAKING_SIGNAL_TELEGRAM_CHAT_ID: r.chat.id });
    say(`Conversation trouvée: « ${r.chat.label} » (${r.chat.type}), identifiant ${r.chat.id}. Enregistré dans ${ENV_FILE}.`);
    say("Étape suivante: npm run telegram -- check --online");
  } else if (r.state === "ambiguous") {
    say("Plusieurs conversations ont écrit au bot; je ne devine pas. Relancez avec --chat-id <identifiant> :");
    for (const c of r.chats) say(`  ${c.id}  ${c.type}  « ${c.label} »${c.lastText ? `  dernier message: ${c.lastText}` : ""}`);
    process.exit(2);
  } else if (r.state === "none") {
    say(r.hint);
    process.exit(2);
  } else {
    say(`getUpdates a échoué: ${r.error}`);
    process.exit(1);
  }
  process.exit(0);
}

if (cmd === "check") {
  const c = checkConfigOffline(process.env);
  if (loaded.length) say(`Variables chargées depuis ${ENV_FILE}: ${loaded.join(", ")} (valeurs masquées)`);
  for (const l of c.lines) say(`${l.ok === true ? "[OK] " : l.ok === false ? "[KO] " : "[i]  "}${l.text}`);
  let online = true;
  if (flag("online") && token && TOKEN_RE.test(token)) {
    const me = await getMe(tgFetch, token);
    online = me.ok;
    say(`${me.ok ? "[OK] " : "[KO] "}getMe: ${me.ok ? `bot @${me.username}` : me.error}`);
  } else if (flag("online")) online = false;
  say(c.ready && online ? "Configuration complète. Les notifications restent en SIMULATION tant que BREAKING_SIGNAL_TELEGRAM_SEND n'est pas « yes »." : "Configuration incomplète.");
  process.exit(c.ready && online ? 0 : 1);
}

if (cmd === "test") {
  const now = Date.now();
  if (!flag("send")) {
    say("--- Notification de test (SIMULATION, non envoyée) ---");
    say(testNotification(now, "simulation"));
    say("--- fin ---");
    say("Pour un vrai message de test: BREAKING_SIGNAL_TELEGRAM_SEND=yes puis `npm run telegram -- test --send --confirm-send-test`.");
    process.exit(0);
  }
  const s = telegramFromEnv(process.env);
  if (!flag("confirm-send-test") || !s.sendAuthorized) {
    say("Envoi refusé: il faut --send --confirm-send-test ET BREAKING_SIGNAL_TELEGRAM_SEND=yes (avec jeton et identifiant valides). Rien n'a été envoyé.");
    process.exit(1);
  }
  const out = await new TelegramNotifier(s, tgFetch).send(testNotification(now, "sent"));
  say(out.ok ? "Message de test envoyé." : `Échec de l'envoi: ${out.error}`);
  process.exit(out.ok ? 0 : 1);
}

say(`commande inconnue "${cmd}"`);
process.exit(2);
