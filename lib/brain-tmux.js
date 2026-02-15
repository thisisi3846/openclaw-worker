/**
 * Brain Tmux — CC CLI interactive mode via tmux session
 *
 * Architecture:
 *   spawnBrain()  → tmux new-session + launch CC CLI interactive
 *   runMission()  → paste prompt + state-machine polling (DISPATCHED→BUSY→DONE)
 *   killBrain()   → tmux kill-session
 *
 * CRITICAL FIX (v29): CC CLI TUI always renders ❯ even when busy.
 * hasPrompt() alone is UNRELIABLE for completion detection.
 * runMission() uses state machine: require BUSY→IDLE transition or completion pattern.
 *
 * State machine for mission completion:
 *   DISPATCHED → BUSY → DONE
 *   Completion requires:
 *     (a) Completion pattern (Cooked/Sautéed/Churned for Xm Ys), OR
 *     (b) Was BUSY then became IDLE for 3 consecutive polls, OR
 *     (c) Never detected BUSY but elapsed > 45s and IDLE for 3 consecutive polls
 *
 * Context management: /clear every 3 missions, /compact every 5 missions
 * Crash recovery: auto-respawn with --continue, rate-limited 5/hr
 *
 * Exports: spawnBrain, killBrain, isBrainAlive, runMission, log
 */

const { execSync } = require('child_process');
const fs = require('fs');
const config = require('../config');

const TMUX_SESSION = 'tom_hum_brain';
const COMPACT_EVERY_N = 10; // Relaxed: Compact every 10 missions
const CLEAR_EVERY_N = 5;    // Relaxed: Clear every 5 missions
const MAX_RESPAWNS_PER_HOUR = 5;
const RESPAWN_COOLDOWN_MS = 5 * 60 * 1000;
const PROMPT_FILE = '/tmp/tom_hum_prompt.txt';
const MIN_MISSION_SECONDS = 15;   // SPEED BOOST: Reduced from 45s for faster local inference
const IDLE_CONFIRM_POLLS = 3;     // Consecutive idle polls required for completion

// --- DETECTION PATTERNS ---

// CC CLI activity indicators (present continuous = actively processing)
const BUSY_PATTERNS = [
  /Photosynthesizing/i, /Crunching/i, /Saut[eé]ing/i,
  /Crunching/i, /Saut[eé]ing/i,
  /Marinating/i, /Fermenting/i, /Braising/i,
  /Reducing/i, /Blanching/i, /Thinking/i,
  /Churning/i, /Cooking/i, /Toasting/i,
  /Simmering/i, /Steaming/i, /Grilling/i, /Roasting/i,
  /Hatching/i, /Envisioning/i, /Brewing/i, // v2.0 New States
  /Working/i, /Planning/i, /Executing/i,
  /Smooshing/i, /Mulling/i, /Concocting/i, /Billowing/i, /Germinating/i, // v2.1 Creative States
  /Sifting/i, /Smelting/i, /Pondering/i, /Deciphering/i,
  /⏺\s+planner/i, /⏺\s+Bash/i, /⏺\s+Left/i, // Tool execution
  /Vibing/i,                           // ClaudeKit status
  /[✻✽✶✴]\s+\w+ing/,                   // General: Star variants + any gerund verb
  // FIXED: Detect BOTH Up (Upload) and Down (Download) arrows
  /\d+[ms]\s+\d+[ms]\s*·\s*[↑↓]/,      // Timer + arrow: "4m 27s · ↑"
  /[↑↓]\s*[\d.]+k?\s*tokens/i,         // Counter: "↑ 0 tokens" or "↓ 4.5k tokens"
  /queued messages/i,
  /Press up to edit queued/i,
  /Cost:\s*\$[\d.]+/,                  // Cost display usually means busy calculating
];

// CC CLI completion indicators (past tense = finished cooking)
const COMPLETION_PATTERNS = [
  /(?:Cooked|Churned|Saut[eé]ed|Braised|Blanched|Reduced|Fermented|Marinated|Toasted|Simmered|Steamed|Grilled|Roasted)\s+for\s+\d+/i,
  /✻\s+\w+(?:ed|t)\s+for\s+\d+/i,     // General: ✻ + past tense + "for N"
];

// CC CLI asking for approval/confirmation
const APPROVE_PATTERNS = [
  /Do you want to run this command\?/,
  /Do you want to proceed\?/,
  /Do you want to execute this code\?/,
  /terraform apply/,
  /npm install/,
  /Allow this/i,
  /Enter your API key/, // Legacy prompt
  /Do you want to use this API key\?/, // <--- NEW: Custom Key Confirmation
  /\(y\/n\)/i, /\[y\/n\]/i, /\[Y\/n\]/i,
  /Do you want to continue/i,
  /Approve\?/i, /Confirm\?/i,
  /Press Enter/i, /waiting for input/i,
  /Would you like to/i, /Should I /i,
  /Use arrow keys to select/i, // More specific for menus
  /Press up to edit queued messages/i, // NEW: CC CLI v2.1.x
  /By proceeding, you accept all responsibility/i, // NEW: Bypass prompt
  /Yes, I accept/i,
  /Select an option/i,
  /Approve this code change/i, /2\.\s+No\s+\(recommended\)/i, // Catch the menu state directly
];

// CC CLI context exhaustion
const CONTEXT_LIMIT_PATTERNS = [
  /Context limit reached/i,
  /\/compact or \/clear/i,
  /context is full/i,
  /out of context/i,
];

// 🦴 GỠ XƯƠNG: CC CLI stuck in TUI menus (NOT a question, needs Escape to exit)
const STUCK_PATTERNS = [
  /Clarification/i,                     // CC CLI asking for clarification
  /What does.*mean.*Please clarify/i,    // "What does X mean?"
  /Enter to select.*navigate.*Esc/i,     // TUI selection menu
  /↑\/↓ to navigate.*Esc to cancel/i,    // Arrow key navigation menu
  /Pick a model/i,                       // Model selection menu
  /MCP server failed/i,                  // MCP server error
  /There's an issue with the selected model/i, // Model not available
  /Run \/model to pick a different model/i,    // Model fallback prompt
  /Always run.*Exit code/i,              // Exit/run menu
  /Checked command status/i,             // Stuck checking status
  /Rewind/i,                             // 🦴 Rewind screen (stale session)
  /Restore the code.*conversation/i,     // 🦴 Restore prompt
  /Enter to continue.*Esc to exit/i,     // 🦴 Rewind selection menu
  /Model.*not found/i,                   // 🦴 Model validation failure
  /No code changes/i,                    // 🦴 Rewind "No code changes" option
  /Interrupted · What should Claude do instead/i, // 🦴 Caught in a loop
];

// 🦴 GỠ XƯƠNG: Nuclear patterns — need full CC CLI respawn, not just Escape
// NOTE: "Interrupted" is handled by STUCK_PATTERNS + isInterrupted (soft Enter).
// Do NOT put it here — tmux scrollback retains the text after clear-history,
// causing an infinite respawn loop.
const NUCLEAR_PATTERNS = [
  /There's an issue with the selected model/i,
  /Model.*not found/i,
  /Run \/model to pick a different model/i,
];

let missionCount = 0;
let respawnTimestamps = [];
let stuckRetryCount = {};  // Per-pane stuck retry counter
const activePaneLocks = new Set(); // v2026.2.14: Tracks panes currently executing a mission

// --- Logging ---

function log(msg) {
  const timestamp = new Date().toISOString().slice(11, 19);
  const formatted = `[${timestamp}] [tom-hum] ${msg}\n`;
  try { process.stderr.write(formatted); } catch (e) { /* EPIPE safe */ }
  try { fs.appendFileSync(config.LOG_FILE, formatted); } catch (e) { }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Strip ANSI escape codes + control characters from captured tmux text */
function stripAnsi(text) {
  return text
    .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '')         // CSI sequences (colors, cursor)
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '') // OSC sequences (BEL or ST)
    .replace(/\x1B[()][A-Za-z0-9]/g, '')              // Character set selection
    .replace(/\x1B[A-Za-z]/g, '')                      // Simple ESC sequences
    .replace(/[\x00-\x08\x0E-\x1F\x7F]/g, '');        // Control chars (keep \t \n \r)
}

// --- Tmux helpers ---

function tmuxExec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim();
  } catch (e) { return ''; }
}

function isSessionAlive() {
  try {
    execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`, { timeout: 5000 });
    return true;
  } catch (e) { return false; }
}

function capturePane(paneIdx) {
  const p = (paneIdx !== undefined) ? paneIdx : currentWorkerIdx;
  const target = `${TMUX_SESSION}:0.${p}`;
  return tmuxExec(`tmux capture-pane -t ${target} -p -S -50`);
}

/** Get clean last N lines from captured tmux output */
function getCleanTail(output, n) {
  return stripAnsi(output).split('\n').slice(-n);
}

// --- State detection functions ---

/** CC CLI is ACTIVELY PROCESSING (Photosynthesizing, Crunching, etc.) */
function isBusy(output) {
  const tail = getCleanTail(output, 25).join('\n');
  return BUSY_PATTERNS.some(p => p.test(tail));
}

/** Mission completion pattern found (Cooked for Xm Ys, Sautéed for Xm Ys) */
function hasCompletionPattern(output) {
  const tail = getCleanTail(output, 25).join('\n');
  return COMPLETION_PATTERNS.some(p => p.test(tail));
}

/** CC CLI prompt visible — ONLY meaningful when NOT busy.
 *  WARNING: CC CLI TUI always renders ❯ even when processing.
 *  This function gates on !isBusy() but callers should still treat
 *  this as a weak signal and require additional confirmation. */
function hasPrompt(output) {
  if (isBusy(output)) return false;
  for (const line of getCleanTail(output, 10)) {
    const t = line.trim();
    if (!t) continue;
    if (t.includes('❯')) return true;
    if (/^>\s*$/.test(t)) return true;
  }
  return false;
}

function hasApproveQuestion(output) {
  const tail = getCleanTail(output, 10).join('\n');
  return APPROVE_PATTERNS.some(p => p.test(tail));
}

function hasContextLimit(output) {
  const tail = getCleanTail(output, 15).join('\n');
  return CONTEXT_LIMIT_PATTERNS.some(p => p.test(tail));
}

/** 🦴 GỠ XƯƠNG: CC CLI stuck in TUI menu (Clarification, model select, etc.) */
function isStuck(output) {
  const tail = getCleanTail(output, 10).join('\n');
  return STUCK_PATTERNS.some(p => p.test(tail));
}

/** Check if the pane is sitting at a raw shell prompt (zsh/bash) instead of Claude */
function isShellPrompt(output) {
  const tail = getCleanTail(output, 5).join('\n');
  // Matches typical shell prompts: "user@host dir %", "bash-3.2$", etc.
  // CRITICAL: Claude's prompt is "❯" or ">". Shell is "%" or "$".
  if (tail.includes('❯')) return false; // Claude is active
  if (tail.includes('Choose a capability:')) return false; // Claude menu
  if (/^>\s*$/.test(tail.trim())) return false; // Simple interactive prompt

  if (/%[\s]*$/.test(tail)) return true; // zsh
  if (/\$ \s*$/.test(tail)) return true; // bash
  if (/# \s*$/.test(tail)) return true; // root
  return false;
}

/** Unified state detection from tmux output.
 *  Returns: 'busy' | 'complete' | 'context_limit' | 'stuck' | 'question' | 'idle' | 'unknown'
 *  CRITICAL: BUSY checked BEFORE completion — prevents stale "Cooked for"
 *  in scrollback from overriding active processing indicators. */
function detectState(output) {
  if (hasContextLimit(output)) return 'context_limit';
  // 九變 FIX: Check BUSY first — prevents stale "Interrupted" text from
  // overriding active processing. If CLI is actively working (Metamorphosing,
  // Searching, etc.), it is NOT stuck — even if old stuck text is in scrollback.
  if (isBusy(output)) return 'busy';
  // Then check stuck (menus, Interrupted, model errors)
  if (isStuck(output)) return 'stuck';
  // Questions (approve prompts) — need Enter/y
  if (hasApproveQuestion(output)) return 'question';
  if (hasCompletionPattern(output)) return 'complete';
  if (hasPrompt(output)) return 'idle';
  return 'unknown';
}

// --- Text dispatch ---

function pasteText(text, paneIdx) {
  const p = (paneIdx !== undefined) ? paneIdx : currentWorkerIdx;
  const bufferName = `buf_${p}`;
  // Use unique prompt files for parallel execution to avoid collisions
  const tempPromptFile = `/tmp/tom_hum_prompt_${p}.txt`;
  fs.writeFileSync(tempPromptFile, text);

  // v2026.2.14: Use NAMED BUFFERS to avoid global buffer race conditions
  tmuxExec(`tmux load-buffer -b ${bufferName} ${tempPromptFile}`);
  const target = `${TMUX_SESSION}:0.${p}`;
  tmuxExec(`tmux paste-buffer -b ${bufferName} -t ${target}`);

  try { fs.unlinkSync(tempPromptFile); } catch (e) { }
}

function sendEnter(paneIdx) {
  const p = (paneIdx !== undefined) ? paneIdx : currentWorkerIdx;
  const target = `${TMUX_SESSION}:0.${p}`;
  // ⚡ WARP SPEED: Instant Enter (No Sleep)
  tmuxExec(`tmux send-keys -t ${target} Enter`);
  tmuxExec(`tmux send-keys -t ${target} Enter`); // Double tap just in case (queue screen)
}

function sendCtrlC(paneIdx) {
  const p = (paneIdx !== undefined) ? paneIdx : currentWorkerIdx;
  const target = `${TMUX_SESSION}:0.${p}`;
  tmuxExec(`tmux send-keys -t ${target} C-c`);
}

/** Poll until prompt appears (used by spawnBrain/respawn/context management) */
async function waitForPrompt(timeoutMs = 120000, paneIdx) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasPrompt(capturePane(paneIdx))) return true;
    await sleep(200); // ⚡ WARP SPEED: 200ms check (was 3000ms)
  }
  return false;
}

// --- Respawn rate limiting ---

function canRespawn() {
  // USER DEMAND: "vòng lặp vô tận cấm off" (Infinite Loop, Never Off)
  // We disable the rate limiter entirely.
  // const cutoff = Date.now() - 3600000;
  // respawnTimestamps = respawnTimestamps.filter(ts => ts > cutoff);
  // return respawnTimestamps.length < MAX_RESPAWNS_PER_HOUR;
  return true;
}

function buildClaudeCmd() {
  // 🦴 PERMANENT FIX: Always use CLOUD_BRAIN_URL (port 11436) — PROXY_PORT (11434) is WRONG
  const baseUrl = config.CLOUD_BRAIN_URL || `http://127.0.0.1:11436`;
  const proxyPort = new URL(baseUrl).port || '11436';
  const model = config.MODEL_NAME;
  const claudeConfigDir = `${HOME}/.claude_antigravity_${proxyPort}`;
  // FIX: Set ALL env vars (match spawnBrain) — unset AUTH_TOKEN to prevent conflict
  const envVars = `unset ANTHROPIC_AUTH_TOKEN && export ANTHROPIC_API_KEY="ollama" && export ANTHROPIC_BASE_URL="${baseUrl}" && export CLAUDE_BASE_URL="${baseUrl}" && export CLAUDE_CONFIG_DIR="${claudeConfigDir}"`;
  return `${envVars} && claude --model ${model} --mcp-config "${claudeConfigDir}/mcp.json" --dangerously-skip-permissions`;
}

// --- Brain lifecycle ---

// Brain State
let currentWorkerIdx = 1; // Start at P1 (P0 is Monitor), unless Full CLI

function spawnBrain() {
  const teamSize = config.AGENT_TEAM_SIZE_DEFAULT || 4; // Default 4 (P0-P3)

  if (isSessionAlive()) {
    try {
      const paneCount = parseInt(execSync(`tmux list-panes -t ${TMUX_SESSION} | wc -l`, { encoding: 'utf-8' }).trim());
      if (paneCount >= teamSize) {
        log(`BRAIN: tmux session exists (Panes: ${paneCount}/${teamSize}) — reusing`);
        return;
      }
      log(`BRAIN: Session exists but has ${paneCount}/${teamSize} panes. REPAIRING...`);

      // FIXED: Use Cloud Brain URL (Serveo/Ollama)
      const proxyUrl = config.CLOUD_BRAIN_URL;

      // FIX: Standardize all env vars to 'ollama' bridge protocol
      // 🦴 PERMANENT FIX: Use port from CLOUD_BRAIN_URL (11436), NOT config.PROXY_PORT (11434)
      const proxyPortNum = new URL(proxyUrl).port || '11436';
      const claudeConfigDir = `${HOME}/.claude_antigravity_${proxyPortNum}`;
      // FIX: Standardize all env vars to 'ollama' bridge protocol
      // REMOVED ANTHROPIC_AUTH_TOKEN to avoid conflict (502/Auth Warning)
      const envVars = `export ANTHROPIC_API_KEY="ollama" && export ANTHROPIC_BASE_URL="${proxyUrl}" && export CLAUDE_BASE_URL="${proxyUrl}" && export CLAUDE_CONFIG_DIR="${claudeConfigDir}"`;
      const geminiCmd = `${envVars} && claude --model ${config.MODEL_NAME} --mcp-config "${claudeConfigDir}/mcp.json" --dangerously-skip-permissions`;

      // Repair Loop: Add missing panes
      for (let i = paneCount; i < teamSize; i++) {
        log(`BRAIN: Spawning missing Worker P${i}...`);
        tmuxExec(`tmux split-window -t ${TMUX_SESSION}:0`);
        tmuxExec(`tmux select-layout -t ${TMUX_SESSION}:0 tiled`);
        execSync('sleep 1');
        tmuxExec(`tmux send-keys -t ${TMUX_SESSION}:0.${i} '${geminiCmd}' Enter`);
        // AUTO-ACCEPT Bypass Permissions for repaired panes
        execSync('sleep 5');
        tmuxExec(`tmux send-keys -t ${TMUX_SESSION}:0.${i} Down Enter`);
        execSync('sleep 2');
        tmuxExec(`tmux send-keys -t ${TMUX_SESSION}:0.${i} Down Enter`); // Double Down just in case
        tmuxExec(`tmux send-keys -t ${TMUX_SESSION}:0.${i} Enter`);
      }
      return; // Repair done
    } catch (e) {
      log(`BRAIN: Error checking/repairing session: ${e.message}`);
    }
  }

  log(`BRAIN: Creating tmux session with CC CLI interactive (Team Size: ${teamSize})...`);
  if (config.FULL_CLI_MODE) log('BRAIN: ⚡️ ANTIGRAVITY GOD MODE ACTIVE: P0 IS A WORKER ⚡️');

  // FORCE correct proxy URL — ignore shell env to prevent ECONNREFUSED
  const proxyUrl = config.CLOUD_BRAIN_URL || `http://127.0.0.1:${config.PROXY_PORT}`;
  log(`BRAIN: Connecting to Brain URL: ${proxyUrl}`);

  // Create explicit config with CLAUDEKIT INJECTION 💉
  // 🦴 PERMANENT FIX: Use port from CLOUD_BRAIN_URL (11436), NOT config.PROXY_PORT (11434)
  const proxyPortNum = new URL(proxyUrl).port || '11436';
  const claudeConfigDir = `${HOME}/.claude_antigravity_${proxyPortNum}`;
  const fs = require('fs');
  if (!fs.existsSync(claudeConfigDir)) fs.mkdirSync(claudeConfigDir, { recursive: true });

  // 🦴 SEED .claude.json: Prevent CC CLI first-run prompts (OAuth login, effort level, security notes)
  const claudeJsonPath = `${claudeConfigDir}/.claude.json`;
  const sourceDir = '${HOME}/.claude_antigravity_11434';
  if (!fs.existsSync(claudeJsonPath) || fs.statSync(claudeJsonPath).size < 2000) {
    // Try copy from working _11434 dir first
    if (fs.existsSync(`${sourceDir}/.claude.json`)) {
      try {
        fs.copyFileSync(`${sourceDir}/.claude.json`, claudeJsonPath);
        log('BRAIN: Seeded .claude.json from _11434 (full auth + history)');
      } catch (e) { log(`BRAIN: Copy .claude.json failed: ${e.message}`); }
    } else {
      // Fallback: create minimal .claude.json with required fields
      const minClaudeJson = {
        numStartups: 999,
        installMethod: 'global',
        customApiKeyResponses: { approved: ['ollama', 'ollama', 'ollama'], rejected: [] },
        hasCompletedOnboarding: true,
        hasAcknowledgedDisclaimer: true,
      };
      fs.writeFileSync(claudeJsonPath, JSON.stringify(minClaudeJson, null, 2));
      log('BRAIN: Seeded minimal .claude.json (no source dir)');
    }
  }
  // Seed settings.json
  const settingsPath = `${claudeConfigDir}/settings.json`;
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, JSON.stringify({
      model: config.MODEL_NAME,
      skipDangerousModePermissionPrompt: true,
      effortLevel: 'medium',
    }, null, 2));
    log('BRAIN: Seeded settings.json');
  }

  // MCP INJECTION: ClaudeKit + Filesystem + Google Suite (gogcli)
  const mcpConfig = {
    "mcpServers": {
      "claudekit": {
        "command": "/opt/homebrew/bin/ck",
        "args": ["mcp"]
      },
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "process.cwd()"]
      },
      "google": {
        "command": "/opt/homebrew/bin/gog",
        "args": ["mcp"],
        "env": {
          "GOG_ACCOUNT": ""
        }
      }
    }
  };

  const configContent = {
    "completedProjectSetup": true,
    "lastUpdateCheck": Date.now(),
    "primaryColor": "#D97757", // Tôm Hùm Orange
    "theme": "dark",
    "verbose": true,
    "dangerouslySkipPermissions": true,
    "agreedToBypassPermissions": true,
    "bypassPermissions": true,
    // "mcp": mcpConfig.mcpServers // Native CLI might ignore this in main config
  };

  // Inject API Key if present to avoid prompts
  // Inject API Key to avoid prompts (Standard Ollama protocol)
  configContent.anthropicApiKey = "ollama";
  configContent.anthropicAuthToken = "ollama"; // Bypass Login via Ollama protocol
  configContent.agreedToBypassPermissions = true;
  configContent.bypassPermissions = true;

  fs.writeFileSync(`${claudeConfigDir}/config.json`, JSON.stringify(configContent, null, 2));

  // Write dedicated MCP config file for --mcp-config flag
  fs.writeFileSync(`${claudeConfigDir}/mcp.json`, JSON.stringify(mcpConfig, null, 2));

  // FORCE API URL via wrapper env function
  // We use config.MODEL_NAME to bypass CLI validation (Opus masquerade)
  const apiKeyExport = process.env.ANTHROPIC_API_KEY ? `export ANTHROPIC_API_KEY="${process.env.ANTHROPIC_API_KEY}" && ` : '';
  // FIX: Unset AUTH_TOKEN to prevent auth conflict
  const envVars = `unset ANTHROPIC_AUTH_TOKEN && export ANTHROPIC_API_KEY="ollama" && export ANTHROPIC_BASE_URL="${proxyUrl}" && export CLAUDE_BASE_URL="${proxyUrl}" && export CLAUDE_CONFIG_DIR="${claudeConfigDir}"`;

  // FIX: Run 'claude' directly to avoid wrapper logic overhead
  const geminiCmd = `${envVars} && claude --model ${config.MODEL_NAME} --mcp-config "${claudeConfigDir}/mcp.json" --dangerously-skip-permissions`;

  // Create session (Pane 0) - MONITOR (Standard) OR WORKER (God Mode)
  let p0Cmd = `tail -f ${config.LOG_FILE}`;
  let p0Title = "P0: SUPERVISOR (Auto-CTO)";

  if (config.FULL_CLI_MODE) {
    p0Cmd = geminiCmd;
    p0Title = "P0: GOD MODE WORKER (Antigravity)";
  }

  tmuxExec(`tmux new-session -d -s ${TMUX_SESSION} -n brain -x 200 -y 50`);
  tmuxExec(`tmux send-keys -t ${TMUX_SESSION}:0.0 '${p0Cmd}' Enter`);
  tmuxExec(`tmux select-pane -t ${TMUX_SESSION}:0.0 -T "${p0Title}"`);

  // Create additional panes - WORKERS (Gemini 3 Pro High)
  for (let i = 1; i < teamSize; i++) {
    tmuxExec(`tmux split-window -t ${TMUX_SESSION}:0`);
    tmuxExec(`tmux select-layout -t ${TMUX_SESSION}:0 tiled`);
    execSync('sleep 1'); // Stagger boot to prevent API rate spikes
    tmuxExec(`tmux send-keys -t ${TMUX_SESSION}:0.${i} '${geminiCmd}' Enter`);
  }

  // AUTO-ACCEPT Bypass Permissions for all Workers
  log('BRAIN: Auto-accepting Bypass Permissions for all panes...');
  execSync('sleep 8');
  for (let i = 0; i < teamSize; i++) {
    // Only workers (and P0 if God Mode)
    if (i === 0 && !config.FULL_CLI_MODE) continue;
    // FIXv34: User request "cứ đẩy lệnh luôn" — Remove "y", just use Enter
    tmuxExec(`tmux send-keys -t ${TMUX_SESSION}:0.${i} Enter`);
    execSync('sleep 0.1');
    tmuxExec(`tmux send-keys -t ${TMUX_SESSION}:0.${i} Enter`);
  }

  // Clear history for all active panes to remove stale boot errors
  for (let i = 0; i < teamSize; i++) {
    tmuxExec(`tmux clear-history -t ${TMUX_SESSION}:0.${i}`);
  }

  // Set initial focus to P0 (if God Mode) or P1
  const startPane = config.FULL_CLI_MODE ? 0 : 1;
  tmuxExec(`tmux select-pane -t ${TMUX_SESSION}:0.${startPane}`);

  log(`BRAIN: Spawned [session=${TMUX_SESSION}] [panes=${teamSize}]`);
  log(`BRAIN: P0=${config.FULL_CLI_MODE ? 'WORKER' : 'MONITOR'}, P1-${teamSize - 1}=WORKERS`);
}

/**
 * 虛實 (Xu Shi) — 1 chạy 2 nghỉ Strategy
 * Round-robin P1→P2→P3: daemon bay vào pane để chạy
 * task-queue isProcessing mutex = chỉ 1 active tại 1 thời điểm
 * Pane nghỉ = idle ở prompt, visible nhưng không tốn proxy
 */
function rotateWorker() {
  const teamSize = config.AGENT_TEAM_SIZE_DEFAULT || 4;
  const minIdx = config.FULL_CLI_MODE ? 0 : 1;
  const maxIdx = teamSize - 1;

  // 🚀 FIXED: Find first IDLE pane that isn't locked
  // This prevents multiple parallel missions from hitting the same pane
  for (let i = 0; i < teamSize; i++) {
    // Round-robin starting from currentWorkerIdx
    const candidate = ((currentWorkerIdx + i) % teamSize);
    if (candidate < minIdx) continue;

    if (!activePaneLocks.has(candidate)) {
      currentWorkerIdx = candidate;
      log(`DISPATCH: Selected IDLE Worker P${currentWorkerIdx}`);
      tmuxExec(`tmux select-pane -t ${TMUX_SESSION}:0.${currentWorkerIdx}`);
      return currentWorkerIdx;
    }
  }

  // Fallback: This shouldn't happen if MAX_CONCURRENT_MISSIONS <= workers
  log(`WARNING: All worker panes busy! Forcing rotation to next...`);
  currentWorkerIdx++;
  if (currentWorkerIdx >= teamSize) currentWorkerIdx = minIdx;
  return currentWorkerIdx;
}

function killBrain() {
  if (isSessionAlive()) {
    tmuxExec(`tmux kill-session -t ${TMUX_SESSION}`);
    log('BRAIN: tmux session killed');
  }
}

function isBrainAlive() {
  if (!isSessionAlive()) return false;
  try {
    execSync('pgrep -f "claude"', { timeout: 3000 });
    return true;
  } catch (e) { return false; }
}

// --- Context management ---
// NOTE: 🔋 XX% via Antigravity Proxy is FAKE (tracks Anthropic limits but routes
// through Gemini). Use mission count instead.

function parseContextUsage(output) {
  const match = output.match(/🔋\s*(\d+)%/);
  return match ? parseInt(match[1]) : -1;
}

async function manageContext(paneIdx) {
  if (missionCount > 0 && missionCount % CLEAR_EVERY_N === 0) {
    log(`CONTEXT: /clear (mission #${missionCount}) on P${paneIdx}`);
    pasteText('/clear', paneIdx);
    await sleep(1000);
    sendEnter(paneIdx);
    await sleep(5000);
    await waitForPrompt(30000, paneIdx);
    return true;
  }
  return false;
}

async function compactIfNeeded(paneIdx) {
  if (missionCount > 0 && missionCount % COMPACT_EVERY_N === 0) {
    log(`CONTEXT: /compact (mission #${missionCount}) on P${paneIdx}`);
    pasteText('/compact', paneIdx);
    await sleep(1000);
    sendEnter(paneIdx);
    await sleep(10000);
    await waitForPrompt(60000, paneIdx);
  }
}

// --- Crash recovery ---

async function respawnBrain(useContinue = true) {
  if (!canRespawn()) {
    log(`RESPAWN: Rate limit (${MAX_RESPAWNS_PER_HOUR}/hr) — cooldown ${RESPAWN_COOLDOWN_MS / 1000}s`);
    await sleep(RESPAWN_COOLDOWN_MS);
    respawnTimestamps = [];
  }
  respawnTimestamps.push(Date.now());
  killBrain();
  await sleep(5000); // Wait for cleanup

  // REUSE spawnBrain() logic to ensure P0=Monitor, P1..=Workers layout
  spawnBrain();

  // Clear history of all panes after respawn to remove stale errors
  for (let i = 0; i < (config.AGENT_TEAM_SIZE_DEFAULT || 4); i++) {
    tmuxExec(`tmux clear-history -t ${TMUX_SESSION}:0.${i}`);
  }

  log(`RESPAWN: Session rebuilt via spawnBrain()`);
  return waitForPrompt(120000);
}

// --- Core: run mission via tmux (state machine) ---

async function runMission(prompt, projectDir, timeoutMs, modelOverride) {
  missionCount++;
  const num = missionCount;
  const startTime = Date.now();

  log(`MISSION #${num}: ${prompt.slice(0, 150)}...`);
  log(`PROJECT: ${projectDir} | MODE: tmux-interactive${modelOverride ? ` | MODEL: ${modelOverride} 🔥` : ''}`);

  // Rotate to next worker pane (Round Robin P1..N)
  // 🚀 FIXED: Capture paneIdx LOCALLY and LOCK it to avoid race conditions
  const paneIdx = rotateWorker();
  activePaneLocks.add(paneIdx);
  const paneKey = `P${paneIdx}`;

  try {
    // Thermal gate
    const { waitForSafeTemperature } = require('./m1-cooling-daemon');
    await waitForSafeTemperature();

    // Context management (pane-aware)
    await manageContext(paneIdx);
    await compactIfNeeded(paneIdx);

    // 虛實 Model Switch: DISABLED — CC CLI /model command validates against internal list, NOT proxy
    // Proxy handles model routing based on prompt complexity. Startup --model flag is sufficient.
    if (modelOverride) {
      log(`🔥 MODEL INTENT: ${modelOverride} (Binh Phap) — proxy routes automatically, /model DISABLED`);
      // DO NOT send /model command — CC CLI rejects it → Rewind loop → stuck
    }

    // Build full prompt
    let fullPrompt = prompt;
    if (projectDir && projectDir !== config.MEKONG_DIR) {
      // 🧠 SMART CONTEXT: Don't force CD, just provide context to avoid ENOWORKSPACES
      fullPrompt = `CONTEXT: Target Project is inside '${projectDir}'. You are at ROOT. Detect package.json/workspaces before running npm install. \n${prompt}`;
    }

    // CC CLI activity indicators (present continuous = actively processing)
    const BUSY_PATTERNS = [
      /Photosynthesizing/i, /Crunching/i, /Saut[eé]ing/i,
      /Marinating/i, /Fermenting/i, /Braising/i,
      /Reducing/i, /Blanching/i, /Thinking/i,
      /Churning/i, /Cooking/i, /Toasting/i,
      /Simmering/i, /Steaming/i, /Grilling/i, /Roasting/i,
      /Vibing/i,                           // ClaudeKit status
      /✻\s+\w+ing/,                        // General: ✻ + any gerund verb
      /\d+[ms]\s+\d+[ms]\s*·\s*↓/,         // Timer + download: "4m 27s · ↓"
      /↓\s*[\d.]+k?\s*tokens/i,            // Download counter: "↓ 4.5k tokens"
      /queued messages/i,
      /Press up to edit queued/i,
    ];

    // ... (patterns remain)

    function sendEnter() {
      tmuxExec(`tmux send-keys -t ${TMUX_SESSION} Enter`);
    }

    // ... (helpers remain)

    // SAFETY CHECK: Ensure Claude is actually running before dispatching
    // If we paste into a raw ZSH shell, we get "Command not found" errors.
    const checkOutput = capturePane();
    if (!isBrainAlive() || isShellPrompt(checkOutput)) {
      log(`CRITICAL: Brain died or dropped to shell! check=${!isBrainAlive()} shell=${isShellPrompt(checkOutput)}`);
      // Attempt rapid recovery
      const respawnSuccess = await respawnBrain(true);
      if (!respawnSuccess) {
        return { success: false, result: 'brain_died_fatal', elapsed: 0 };
      }
      // Give post-respawn some time to settle
      await sleep(5000);
    }

    // Dispatch via paste-buffer (reliable for long text + special chars)
    pasteText(fullPrompt, paneIdx);
    await sleep(3000); // FIXED: Increased from 1000ms to allow TUI to render large pastes
    sendEnter(paneIdx);
    log(`DISPATCHED: Mission #${num} sent to tmux (Pane P${paneIdx})`);

    // ═══════════════════════════════════════════════════════════════
    // STATE MACHINE: DISPATCHED → BUSY → DONE
    //
    // CC CLI TUI always renders ❯ even when busy — hasPrompt() alone
    // is NOT reliable. We track wasBusy and require either:
    //   (a) Completion pattern found (Cooked/Sautéed for Xm Ys)
    //   (b) Was BUSY → 3x consecutive IDLE polls
    //   (c) Never saw BUSY but elapsed > 45s → 3x consecutive IDLE
    // ═══════════════════════════════════════════════════════════════

    let wasBusy = false;
    let idleConfirmCount = 0;
    const deadline = Date.now() + timeoutMs;
    let lastLogTime = Date.now();
    let kickStartCount = 0;

    // Give CC CLI time to parse prompt and begin processing
    await sleep(5000); // Reduced initial sleep to check for early failures

    while (Date.now() < deadline) {
      if (!isSessionAlive()) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        log(`BRAIN DIED: Mission #${num} (${elapsed}s)`);
        await respawnBrain(true);
        return { success: false, result: 'brain_died', elapsed };
      }

      const output = capturePane(paneIdx);
      const state = detectState(output);
      const elapsedSec = Math.round((Date.now() - startTime) / 1000);

      /* KICK-START DISABLED: User reported it causes phantom inputs (wasted tokens)
      // KICK-START: If idle and never busy in first 30s, press Enter again
      if (state === 'idle' && !wasBusy && elapsedSec < 30 && kickStartCount < 2) {
        log(`KICK-START: Idle detected early (${elapsedSec}s) — sending Enter again...`);
        sendEnter(paneIdx);
        kickStartCount++;
        await sleep(2000);
        continue;
      }
      */

      // STUCK INTERVENTION (Parallel Cooling): Kill stuck task if Hot & Long
      if (checkStuckIntervention(elapsedSec, num, paneIdx)) {
        return { success: false, result: 'killed_stuck', elapsed: elapsedSec };
      }

      switch (state) {
        case 'complete': {
          // Guard against stale completion from previous mission still in scrollback
          if (!wasBusy && elapsedSec < MIN_MISSION_SECONDS) {
            break; // Likely stale — wait for BUSY or more elapsed time
          }
          const usage = parseContextUsage(output);
          log(`COMPLETE: Mission #${num} (${elapsedSec}s) [cooked-pattern]${usage >= 0 ? ` [ctx=${usage}%]` : ''}`);
          return { success: true, result: 'done', elapsed: elapsedSec };
        }

        case 'busy':
          if (!wasBusy) log(`BUSY: Mission #${num} — CC CLI started processing (Pane P${paneIdx})`);
          wasBusy = true;
          idleConfirmCount = 0;
          break;

        case 'question':
          log(`QUESTION: Mission #${num} — auto-approving (Pane P${paneIdx})`);
          const targetPane = `${TMUX_SESSION}:0.${paneIdx}`;

          // SPECIAL CASE: Queued messages (v2.1.x)
          if (/Press up to edit queued messages/i.test(output)) {
            log(`QUESTION: Queued messages detected — sending DOUBLE ENTER to submit`);
            tmuxExec(`tmux send-keys -t ${targetPane} Enter Enter`);
          }
          // SPECIAL CASE: API Key Confirmation (Needs "1" + Enter for "Yes")
          else if (/2\.\s+No\s+\(recommended\)/i.test(output)) {
            log(`QUESTION: API Key detected in P${paneIdx} — selecting '1. Yes'`);
            tmuxExec(`tmux send-keys -t ${targetPane} 1 Enter`);
          }
          // SPECIAL CASE: Kick-Start waiting for Enter (bypass permissions)
          else if (/By proceeding, you accept all responsibility/i.test(output) || /Yes, I accept/i.test(output)) {
            log(`QUESTION: Bypass Permissions prompt — ACCEPTING with Enter (No 'y')`);
            tmuxExec(`tmux send-keys -t ${targetPane} Enter`);
          } else {
            // Default: Just send Enter (safer than 'y')
            log(`QUESTION: Generic question detected — sending Enter`);
            tmuxExec(`tmux send-keys -t ${targetPane} Enter`);
          }
          await sleep(3000);
          idleConfirmCount = 0;
          continue; // Re-check immediately

        case 'stuck': {
          // 🦴 九變 Recovery State Machine v3: Ctrl+C → Clear → Re-dispatch
          const stuckPane = `${TMUX_SESSION}:0.${paneIdx}`;
          const paneKey = `P${paneIdx}`;

          // 九變 GUARD: Don't fire stuck recovery in the first 15s — CC CLI
          // needs time for tool calls (search, read). Early recovery sends
          // Escape/Ctrl+C that INTERRUPTS active processing.
          const MIN_STUCK_SECONDS = 15;
          if (elapsedSec < MIN_STUCK_SECONDS) {
            log(`🦴 九變: P${paneIdx} stuck detected at ${elapsedSec}s — SKIPPING (< ${MIN_STUCK_SECONDS}s guard)`);
            break;
          }

          stuckRetryCount[paneKey] = (stuckRetryCount[paneKey] || 0) + 1;
          const retries = stuckRetryCount[paneKey];

          // Check specific stuck sub-states
          const currentOutput = capturePane(paneIdx);
          const isNuclear = NUCLEAR_PATTERNS.some(p => p.test(currentOutput));
          const isRewind = /Rewind|Restore the code|Enter to continue.*Esc to exit/i.test(currentOutput);
          const isInterrupted = /Interrupted\s+·\s+What\s+should\s+Claude\s+do\s+instead/i.test(currentOutput);

          if (isNuclear || retries >= 5) {
            // 🦴 NUCLEAR RESPAWN + RE-DISPATCH (九變 Biến 4)
            log(`🦴 九變 NUCLEAR: P${paneIdx} — ${isNuclear ? 'model error' : `stuck ${retries}x`} — full respawn + re-dispatch`);
            tmuxExec(`tmux send-keys -t ${stuckPane} C-c C-c`);
            await sleep(1000);
            tmuxExec(`tmux send-keys -t ${stuckPane} '/exit' Enter`);
            await sleep(3000);
            // Clear BOTH visible buffer AND scrollback BEFORE relaunch
            tmuxExec(`tmux send-keys -t ${stuckPane} C-l`);
            tmuxExec(`tmux clear-history -t ${stuckPane}`);
            await sleep(500);
            // Respawn with correct model
            const cmd = buildClaudeCmd();
            log(`🦴 九變: Respawning P${paneIdx} with fresh CC CLI`);
            tmuxExec(`tmux send-keys -t ${stuckPane} '${cmd}' Enter`);
            stuckRetryCount[paneKey] = 0;
            // Auto-accept bypass permissions prompt (Down → Enter × 2)
            await sleep(5000);
            tmuxExec(`tmux send-keys -t ${stuckPane} Down Enter`);
            await sleep(2000);
            tmuxExec(`tmux send-keys -t ${stuckPane} Down Enter`);
            tmuxExec(`tmux send-keys -t ${stuckPane} Enter`);
            // Wait for CLI to boot + re-dispatch the original mission
            const respawnReady = await waitForPrompt(45000, paneIdx);
            if (respawnReady) {
              log(`🦴 九變: P${paneIdx} respawned — RE-DISPATCHING mission #${num}`);
              pasteText(fullPrompt, paneIdx);
              await sleep(2000);
              sendEnter(paneIdx);
              wasBusy = false;
              idleConfirmCount = 0;
            } else {
              log(`🦴 九變: P${paneIdx} respawn TIMEOUT — returning failure`);
              activePaneLocks.delete(paneIdx);
              return { success: false, result: 'respawn_failed', elapsed: elapsedSec };
            }
          } else if (isInterrupted) {
            // 🦴 九變 Biến 2: Ctrl+C abort → clear scrollback → re-dispatch mission
            log(`🦴 九變: P${paneIdx} Interrupted — Ctrl+C abort + re-dispatch (retry ${retries}/5)`);
            tmuxExec(`tmux send-keys -t ${stuckPane} C-c`);
            await sleep(2000);
            // Clear stale "Interrupted" text from scrollback
            tmuxExec(`tmux send-keys -t ${stuckPane} C-l`);
            tmuxExec(`tmux clear-history -t ${stuckPane}`);
            await sleep(1000);
            const postCtrlC = capturePane(paneIdx);
            if (hasPrompt(postCtrlC)) {
              log(`🦴 九變: P${paneIdx} back to prompt — RE-DISPATCHING mission #${num}`);
              pasteText(fullPrompt, paneIdx);
              await sleep(2000);
              sendEnter(paneIdx);
              wasBusy = false;
              idleConfirmCount = 0;
              stuckRetryCount[paneKey] = 0;
            }
          } else if (isRewind) {
            // 🦴 GỠ XƯƠNG: Rewind screen — press Enter to accept current state
            log(`🦴 GỠ XƯƠNG: P${paneIdx} stuck on Rewind — pressing Enter`);
            tmuxExec(`tmux send-keys -t ${stuckPane} Enter`);
            await sleep(3000);
          } else {
            // Standard: Escape out of TUI menu
            log(`🦴 GỠ XƯƠNG: Mission #${num} — P${paneIdx} stuck in TUI menu (retry ${retries}/5) — sending Escape`);
            tmuxExec(`tmux send-keys -t ${stuckPane} Escape Escape`);
            await sleep(1000);
            const postEsc = capturePane(paneIdx);
            if (hasPrompt(postEsc)) {
              log(`🦴 GỠ XƯƠNG: P${paneIdx} back to prompt — re-entering mission`);
              stuckRetryCount[paneKey] = 0;
              sendEnter(paneIdx);
            }
          }
          await sleep(2000);
          idleConfirmCount = 0;
          continue;
        }

        case 'context_limit':
          log(`CONTEXT LIMIT: Mission #${num} — sending /clear`);
          tmuxExec(`tmux send-keys -t ${TMUX_SESSION}:0.${paneIdx} '/clear' Enter`);
          await sleep(5000);
          continue;

        case 'idle':
          if (wasBusy) {
            // 九變 CHECK: Is there "Interrupted" text visible? If so, this is a FAILED
            // mission that looks idle because ❯ prompt appeared after Interrupted.
            // Re-dispatch instead of completing.
            const idleOutput = capturePane(paneIdx);
            const wasInterrupted = /Interrupted\s+·\s+What\s+should\s+Claude\s+do\s+instead/i.test(idleOutput);
            if (wasInterrupted && elapsedSec < 120) {
              log(`🦴 九變: P${paneIdx} IDLE but has Interrupted text — Ctrl+C + RE-DISPATCH (#${num})`);
              const idlePane = `${TMUX_SESSION}:0.${paneIdx}`;
              tmuxExec(`tmux send-keys -t ${idlePane} C-c`);
              await sleep(1000);
              tmuxExec(`tmux send-keys -t ${idlePane} C-l`);
              tmuxExec(`tmux clear-history -t ${idlePane}`);
              await sleep(1000);
              pasteText(fullPrompt, paneIdx);
              await sleep(2000);
              sendEnter(paneIdx);
              wasBusy = false;
              idleConfirmCount = 0;
              continue;
            }

            // Was processing, now idle — confirm over multiple polls
            idleConfirmCount++;
            if (idleConfirmCount >= IDLE_CONFIRM_POLLS) {
              const elapsed = Math.round((Date.now() - startTime) / 1000);

              // REQUIRE > 60s for "auto-complete" if it was just idle
              if (elapsed < 60 && !/successfully implemented/i.test(output)) {
                log(`FINISH: Mission #${num} — IGNORED (Possible failure at ${elapsed}s)`);
                return { success: false, result: 'fast_failure', elapsed };
              }

              log(`COMPLETE: Mission #${num} (${elapsed}s) [idle-confirm]`);
              return { success: true, result: 'done', elapsed };
            }
          } else if (elapsedSec > 30) { // Reduced from MIN_MISSION_SECONDS to catch fast-start idle
            // Never saw BUSY — might be very fast or isBusy missed it
            idleConfirmCount++;
            if (idleConfirmCount >= IDLE_CONFIRM_POLLS) {
              log(`COMPLETE: Mission #${num} (${elapsedSec}s) [idle-no-busy]`);
              return { success: true, result: 'done', elapsed: elapsedSec };
            }
          }
          break;

        default: // 'unknown' — can't classify, reset idle counter
          idleConfirmCount = 0;
          break;
      }

      // Progress logging every 60s
      if (Date.now() - lastLogTime > 60000) {
        log(`Mission #${num} [${state}] — ${elapsedSec}s${wasBusy ? ' (was-busy)' : ''}`);
        lastLogTime = Date.now();
      }

      // PROJECT FLASH: Ultra Speed Polling (1s)
      await sleep(1000);
    }
    return { success: false, result: 'timeout', elapsed: Math.round(timeoutMs / 1000) };
  } finally {
    // 🔓 RELEASE LOCK
    activePaneLocks.delete(paneIdx);
    log(`RELEASE: Pane P${paneIdx} is available (Active: ${activePaneLocks.size})`);
  }
}

// --- SYSTEM MONITORING (User Request: "Giám sát nhiệt độ & API") ---

function getSystemMetrics() {
  try {
    // macOS Load Average
    const loadString = execSync('sysctl -n vm.loadavg').toString().trim();
    // Format: "{ 2.15 2.05 1.98 }" -> remove braces -> split
    const parts = loadString.replace(/[{}]/g, '').trim().split(/\s+/);
    const load1min = parseFloat(parts[0]);

    // Memory Usage (Approximate RSS)
    const mem = process.memoryUsage().rss / 1024 / 1024;

    return { load: load1min, mem: Math.round(mem) };
  } catch (e) {
    return { load: 0, mem: 0 };
  }
}

function isOverheating() {
  const metrics = getSystemMetrics();
  // THRESHOLD: Load > 4.0 is "Overheating" (Intervention Zone)
  if (metrics.load > 4.0) {
    // ACTIVE INTERVENTION: Monitor & Support
    const coolingTime = 10000; // 10s Cooling Nap
    appendFileSync(config.THERMAL_LOG, `[${new Date().toISOString()}] 🔥 HIGH LOAD (${metrics.load}). Intervening... Sleeping ${coolingTime / 1000}s\n`);

    // We intentionally block here to force the system to slow down.
    // This supports the machine as requested ("can thiệp hỗ trợ").
    execSync(`sleep ${coolingTime / 1000}`);

    return true;
  }
  return false;
}

// STUCK INTERVENTION: If task > 5min AND Load > 4.0, assume stuck model -> Ctrl+C
function checkStuckIntervention(elapsedSec, num, paneIdx) {
  const metrics = getSystemMetrics();
  // 300s = 5 minutes
  if (elapsedSec > 300 && metrics.load > 4.0) {
    log(`INTERVENTION: Mission #${num} stuck (${elapsedSec}s) & Hot (${metrics.load}) on P${paneIdx} — Sending Ctrl+C to unblock.`);
    sendCtrlC(paneIdx);
    return true;
  }
  return false;
}

module.exports = { spawnBrain, killBrain, isBrainAlive, runMission, log, isOverheating, getSystemMetrics, checkStuckIntervention };
