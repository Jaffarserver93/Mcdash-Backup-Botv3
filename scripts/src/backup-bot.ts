import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import axios from "axios";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = path.join(__dirname, "..");

// ─── Config ───────────────────────────────────────────────────────────────────

const MCDASH_URL   = (process.env.MCDASH_URL  || "").replace(/\/$/, "");
const MCDASH_TOKEN = process.env.MCDASH_TOKEN  || "";
const API_ID       = parseInt(process.env.TELEGRAM_API_ID   || "");
const API_HASH     = process.env.TELEGRAM_API_HASH          || "";
const PHONE        = process.env.TELEGRAM_PHONE             || "";
const SESSION_ENV  = process.env.TELEGRAM_SESSION           || "";
const INTERVAL_MS  = parseInt(process.env.BACKUP_INTERVAL_SEC || "300") * 1000;
const PORT         = parseInt(process.env.BOT_PORT          || "8082");

for (const [k, v] of Object.entries({
  MCDASH_URL, MCDASH_TOKEN,
  TELEGRAM_API_ID: API_ID, TELEGRAM_API_HASH: API_HASH, TELEGRAM_PHONE: PHONE,
})) {
  if (!v) { console.error(`[bot] Missing required env var: ${k}`); process.exit(1); }
}

const SESSION_FILE = path.join(SCRIPTS_ROOT, ".telegram_session");
const STATE_FILE   = path.join(SCRIPTS_ROOT, ".bot_state.json");
const TMP_BACKUP   = path.join(SCRIPTS_ROOT, "mcdash_backup.zip");
const STATUS_FILE  = path.join(SCRIPTS_ROOT, ".bot_status.json");

// ─── State ────────────────────────────────────────────────────────────────────

interface BotState {
  previousBackupId:      number | null;
  previousTelegramMsgId: number | null;
}

function loadState(): BotState {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { previousBackupId: null, previousTelegramMsgId: null }; }
}

function saveState(state: BotState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function setStatus(data: Record<string, unknown>): void {
  fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2), "utf8");
}

function log(tag: string, msg: string): void {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── MCDash API ───────────────────────────────────────────────────────────────
// Auth: header "Authorization: <token>" (no Bearer prefix)
// All mutating requests use application/x-www-form-urlencoded

interface MCDashBackup {
  id:    number;
  modes: string[];
  size:  number;
}

const mcdash = axios.create({
  baseURL: `${MCDASH_URL}/api`,
  headers: { Authorization: MCDASH_TOKEN },
  timeout: 60_000,
});

async function listBackups(): Promise<MCDashBackup[]> {
  const res = await mcdash.get<MCDashBackup[]>("/backups/");
  return res.data ?? [];
}

async function createBackup(): Promise<void> {
  // mode "12" = worlds (1) + plugins (2)
  await mcdash.put("/backups/", "mode=12", {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

async function deleteBackup(id: number): Promise<void> {
  await mcdash.delete("/backups/", {
    data: `backup_id=${id}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

async function deleteAllBackups(): Promise<void> {
  const backups = await listBackups();
  if (!backups.length) { log("mcdash", "No existing backups to delete"); return; }
  log("mcdash", `Deleting ${backups.length} existing backup(s)...`);
  for (const b of backups) {
    try { await deleteBackup(b.id); log("mcdash", `Deleted backup ${b.id}`); }
    catch (e) { log("mcdash", `Could not delete ${b.id}: ${e}`); }
  }
}

async function waitForBackup(): Promise<MCDashBackup> {
  log("mcdash", "Waiting for backup to appear...");
  for (let i = 0; i < 60; i++) {
    await sleep(15_000);
    const backups = await listBackups();
    if (backups.length > 0) {
      const b = backups[0]!;
      log("mcdash", `Backup ready: id=${b.id} size=${(b.size / 1024 / 1024).toFixed(2)} MB`);
      return b;
    }
    log("mcdash", `Not ready yet (attempt ${i + 1}/60)...`);
  }
  throw new Error("Backup timed out after 15 minutes");
}

async function downloadBackup(id: number, dest: string): Promise<void> {
  log("download", "Starting download...");
  await fsp.rm(dest, { force: true });
  const response = await mcdash.get(`/backups/download?backup_id=${id}`, {
    responseType: "stream",
    timeout: 15 * 60_000,
  });
  const writer = fs.createWriteStream(dest);
  (response.data as NodeJS.ReadableStream).pipe(writer);
  await new Promise<void>((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
    (response.data as NodeJS.ReadableStream).on("error", reject);
  });
  const mb = (fs.statSync(dest).size / 1024 / 1024).toFixed(2);
  log("download", `Done — ${mb} MB`);
}

// ─── Built-in HTTP server (OTP + status) ─────────────────────────────────────

let pendingOtp: ((code: string) => void) | null = null;

const OTP_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Backup Bot — OTP</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{background:#1e293b;border-radius:12px;padding:32px;max-width:420px;width:100%;border:1px solid #334155}
    h1{font-size:20px;margin-bottom:8px}
    p{color:#94a3b8;font-size:14px;margin-bottom:20px;line-height:1.5}
    label{display:block;font-size:13px;font-weight:600;color:#cbd5e1;margin-bottom:6px}
    input{width:100%;padding:12px;background:#0f172a;border:1px solid #475569;border-radius:8px;color:#f1f5f9;font-size:22px;letter-spacing:8px;text-align:center;outline:none}
    input:focus{border-color:#3b82f6}
    button{width:100%;padding:12px;margin-top:14px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
    button:hover{background:#2563eb}
    .status{margin-top:20px;padding:12px;background:#0f172a;border-radius:8px;font-size:12px;font-family:monospace;color:#64748b;white-space:pre-wrap;max-height:140px;overflow:auto}
  </style>
</head>
<body>
  <div class="card">
    <h1>🤖 MCDash Backup Bot</h1>
    <p>A login code was sent to your Telegram. Enter it below to authorize the bot.</p>
    <form method="POST" action="/otp">
      <label>Telegram OTP Code</label>
      <input name="code" type="text" placeholder="12345" autofocus maxlength="10" inputmode="numeric"/>
      <button type="submit">Submit →</button>
    </form>
    <div class="status" id="s">Loading...</div>
  </div>
  <script>
    const refresh = () => fetch('/status').then(r=>r.json()).then(d=>{
      document.getElementById('s').textContent = JSON.stringify(d,null,2);
    }).catch(()=>{});
    refresh(); setInterval(refresh, 3000);
  </script>
</body>
</html>`;

const SUCCESS_PAGE = `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0">
<div style="font-size:48px;margin-bottom:16px">✅</div>
<h2>OTP submitted!</h2><p>The bot is completing login. You can close this page.</p></body></html>`;

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === "GET" && (req.url === "/" || req.url === "")) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(OTP_PAGE);
    return;
  }

  if (req.method === "POST" && req.url === "/otp") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const code = new URLSearchParams(body).get("code")?.trim() ?? "";
      if (code && pendingOtp) {
        pendingOtp(code);
        pendingOtp = null;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(SUCCESS_PAGE);
      } else {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("No pending OTP request");
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/status") {
    try {
      const status = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ phase: "starting" }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

async function waitForOtp(): Promise<string> {
  setStatus({ phase: "awaiting_otp", message: "Check your Telegram — enter the OTP code in the terminal" });
  log("telegram", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  log("telegram", `OTP sent to ${PHONE}. Type the code and press Enter:`);
  log("telegram", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  process.stdout.write("OTP code: ");
  return new Promise<string>((resolve) => {
    let code = "";
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.once("data", (chunk) => {
      code = String(chunk).trim();
      process.stdin.pause();
      resolve(code);
    });
    setTimeout(() => {
      process.stdin.pause();
      resolve("");
    }, 10 * 60_000);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("bot", `MCDash backup bot starting — panel: ${MCDASH_URL} | interval: ${INTERVAL_MS / 1000}s`);
  setStatus({ phase: "starting", message: "Initializing..." });

  // Start HTTP server for OTP + status
  const httpServer = createServer(handleRequest);
  httpServer.listen(PORT, () => log("http", `Listening on port ${PORT}`));

  // Load Telegram session (env var → file → fresh)
  let sessionString = SESSION_ENV;
  if (!sessionString) {
    try { sessionString = fs.readFileSync(SESSION_FILE, "utf8").trim(); log("telegram", "Session loaded from file"); }
    catch { log("telegram", "No saved session — will authenticate"); }
  } else {
    log("telegram", "Session loaded from TELEGRAM_SESSION env var");
  }

  let session: StringSession;
  try {
    session = new StringSession(sessionString);
  } catch {
    log("telegram", "Saved session was invalid — starting fresh authentication");
    session = new StringSession("");
  }
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
    retryDelay: 3_000,
  });

  setStatus({ phase: "connecting", message: "Connecting to Telegram..." });
  await client.start({
    phoneNumber: async () => PHONE,
    phoneCode: waitForOtp,
    onError: (err: Error) => { log("telegram", `Auth error: ${err.message}`); throw err; },
  });

  const savedSession = client.session.save() as unknown as string;
  try { fs.writeFileSync(SESSION_FILE, savedSession, "utf8"); } catch { /* no persistent disk */ }

  log("telegram", "✅ Logged in — session saved");
  log("telegram", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  log("telegram", "TELEGRAM_SESSION (set this as a secret to skip OTP on restart):");
  log("telegram", savedSession);
  log("telegram", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  log("bot", `Ready — first backup in ${INTERVAL_MS / 1000}s`);
  setStatus({ phase: "ready", message: `First backup in ${INTERVAL_MS / 1000}s` });
  await sleep(INTERVAL_MS);

  while (true) {
    const cycleStart = Date.now();
    const state = loadState();

    try {
      // ── 1. Delete all existing MCDash backups ──
      setStatus({ phase: "cycle", step: "deleting_old_backups" });
      await deleteAllBackups();

      // ── 2. Create new backup (worlds + plugins) ──
      setStatus({ phase: "cycle", step: "creating_backup" });
      log("mcdash", "Creating backup (worlds + plugins, mode=12)...");
      await createBackup();

      // ── 3. Wait for backup to appear in list ──
      setStatus({ phase: "cycle", step: "waiting_for_backup" });
      const backup = await waitForBackup();

      // ── 4. Download the backup ──
      setStatus({ phase: "cycle", step: "downloading" });
      await downloadBackup(backup.id, TMP_BACKUP);
      const sizeMb = (fs.statSync(TMP_BACKUP).size / 1024 / 1024).toFixed(2);

      // ── 5. Delete previous Telegram message ──
      if (state.previousTelegramMsgId) {
        try {
          await client.deleteMessages("me", [state.previousTelegramMsgId], { revoke: true });
          log("telegram", `Deleted old message ${state.previousTelegramMsgId}`);
        } catch (e) { log("telegram", `Could not delete old message: ${e}`); }
      }

      // ── 6. Upload to Saved Messages ──
      setStatus({ phase: "cycle", step: "uploading_to_telegram" });
      log("telegram", "Uploading backup to Saved Messages...");
      const ts = new Date().toISOString();
      const sentMsg = await client.sendFile("me", {
        file: TMP_BACKUP,
        caption: `🗄 *MCDash Backup*\n📅 ${ts}\n💾 ${sizeMb} MB\n🆔 ${backup.id}\n📦 worlds + plugins`,
        forceDocument: true,
        workers: 4,
      });

      log("telegram", `Uploaded — message ID ${sentMsg.id}`);

      // ── 7. Delete previous MCDash backup (keep panel clean) ──
      if (state.previousBackupId && state.previousBackupId !== backup.id) {
        try { await deleteBackup(state.previousBackupId); log("mcdash", `Deleted old backup ${state.previousBackupId}`); }
        catch (e) { log("mcdash", `Could not delete old backup: ${e}`); }
      }

      // ── 8. Persist state ──
      saveState({ previousBackupId: backup.id, previousTelegramMsgId: sentMsg.id });

      // Cleanup temp file
      try { await fsp.rm(TMP_BACKUP, { force: true }); } catch { /* ignore */ }

      const elapsed = Date.now() - cycleStart;
      const waitMs = Math.max(0, INTERVAL_MS - elapsed);

      setStatus({
        phase: "waiting",
        message: `Next backup in ${Math.ceil(waitMs / 1000)}s`,
        lastCycleAt: ts,
        lastBackupId: backup.id,
        lastTelegramMsgId: sentMsg.id,
        lastSizeMb: sizeMb,
        cycleElapsedSec: Math.round(elapsed / 1000),
      });

      log("bot", `Cycle done in ${(elapsed / 1000).toFixed(1)}s — sleeping ${(waitMs / 1000).toFixed(0)}s`);
      await sleep(waitMs);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log("bot", `Cycle error: ${msg}`);
      setStatus({ phase: "error", message: msg, errorAt: new Date().toISOString() });
      try { await fsp.rm(TMP_BACKUP, { force: true }); } catch { /* ignore */ }
      await sleep(30_000);
    }
  }
}

main().catch((err: unknown) => {
  console.error("[bot] Fatal:", err);
  process.exit(1);
});
