/**
 * Brain Terminal.app — CC CLI interactive in macOS Terminal tabs
 *
 * Uses AppleScript to control Terminal.app (no tmux needed):
 *   - spawnBrain()  → Opens Terminal.app tab with CC CLI interactive
 *   - runMission()  → Pastes prompt into Terminal tab + monitors output
 *   - Full ClaudeKit TUI visible in native Terminal.app
 *
 * Why Terminal.app > tmux:
 *   - Native macOS, way more stable than tmux
 *   - Full TUI rendering (colors, unicode, ClaudeKit agents visible)
 *   - No tmux buffer/paste issues
 *   - User can see everything real-time
 *
 * Exports: spawnBrain, killBrain, isBrainAlive, runMission, log
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');

let missionCount = 0;
const PROMPT_FILE = '/tmp/tom_hum_terminal_prompt.txt';
const OUTPUT_FILE = '/tmp/tom_hum_terminal_output.log';

// --- Logging ---
function log(msg) {
    const timestamp = new Date().toISOString().slice(11, 19);
    const formatted = `[${timestamp}] [tom-hum] ${msg}\n`;
    process.stderr.write(formatted);
    try { fs.appendFileSync(config.LOG_FILE, formatted); } catch (e) { }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- AppleScript helpers ---

/**
 * Run AppleScript command
 */
function runAppleScript(script) {
    try {
        return execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
            encoding: 'utf-8',
            timeout: 10000,
        }).trim();
    } catch (e) {
        log(`APPLESCRIPT ERROR: ${e.message}`);
        return '';
    }
}

/**
 * Run multi-line AppleScript
 */
function runAppleScriptFile(script) {
    const tmpFile = '/tmp/tom_hum_applescript.scpt';
    fs.writeFileSync(tmpFile, script);
    try {
        return execSync(`osascript ${tmpFile}`, { encoding: 'utf-8', timeout: 15000 }).trim();
    } catch (e) {
        log(`APPLESCRIPT ERROR: ${e.message}`);
        return '';
    } finally {
        try { fs.unlinkSync(tmpFile); } catch (e) { }
    }
}

// --- Brain lifecycle ---

/**
 * Open Terminal.app with CC CLI interactive in a new tab
 */
function spawnBrain() {
    log('BRAIN MODE: Terminal.app — CC CLI interactive in native macOS Terminal');

    const proxyUrl = config.CLOUD_BRAIN_URL || 'http://127.0.0.1:11436';
    const proxyPort = new URL(proxyUrl).port || '11436';
    const configDir = `${HOME}/.claude_antigravity_${proxyPort}`;

    // Build the CC CLI command
    const envSetup = [
        `export ANTHROPIC_API_KEY="ollama"`,
        `export ANTHROPIC_BASE_URL="${proxyUrl}"`,
        `export CLAUDE_BASE_URL="${proxyUrl}"`,
        `export CLAUDE_CONFIG_DIR="${configDir}"`,
        `unset ANTHROPIC_AUTH_TOKEN`,
    ].join(' && ');

    const claudeCmd = `claude --model ${config.MODEL_NAME} --dangerously-skip-permissions`;
    const fullCmd = `${envSetup} && ${claudeCmd}`;

    // AppleScript to open Terminal.app with CC CLI
    const script = `
tell application "Terminal"
  activate
  set newTab to do script "${fullCmd.replace(/"/g, '\\"')}"
  set custom title of newTab to "🦞 TÔM HÙM Worker"
end tell
`;

    runAppleScriptFile(script);
    log('BRAIN: Terminal.app tab opened with CC CLI interactive');
}

function killBrain() {
    log('BRAIN: Sending Ctrl+C to Terminal.app CC CLI...');
    const script = `
tell application "Terminal"
  set targetTab to null
  repeat with w in windows
    repeat with t in tabs of w
      if custom title of t contains "TÔM HÙM" then
        set targetTab to t
      end if
    end repeat
  end repeat
  if targetTab is not null then
    do script "exit" in targetTab
  end if
end tell
`;
    runAppleScriptFile(script);
}

function isBrainAlive() {
    try {
        execSync('pgrep -f "claude.*dangerously-skip-permissions"', { timeout: 3000 });
        return true;
    } catch (e) { return false; }
}

// --- Type text into Terminal.app CC CLI tab ---

function typeInTerminal(text) {
    // Write prompt to temp file
    const tmpFile = '/tmp/tom_hum_paste.txt';
    fs.writeFileSync(tmpFile, text);

    // Use Terminal.app's `do script` to send text directly — NO System Events needed
    // Escape for AppleScript string
    const escapedFile = tmpFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const script = `
set promptText to (read POSIX file "${escapedFile}")

tell application "Terminal"
  -- Find TÔM HÙM worker tab
  set targetTab to null
  repeat with w in windows
    repeat with t in tabs of w
      try
        if custom title of t contains "TÔM HÙM" then
          set targetTab to t
        end if
      end try
    end repeat
  end repeat
  
  -- If found, send prompt directly
  if targetTab is not null then
    do script promptText in targetTab
  else
    -- No worker tab found, create one
    set targetTab to do script promptText
    set custom title of targetTab to "🦞 TÔM HÙM Worker"
  end if
  
  activate
end tell
`;
    runAppleScriptFile(script);
}

// --- Core: Run mission in Terminal.app CC CLI ---

async function runMission(prompt, projectDir, timeoutMs) {
    missionCount++;
    const num = missionCount;
    const startTime = Date.now();

    log(`MISSION #${num}: ${prompt.slice(0, 150)}...`);
    log(`PROJECT: ${projectDir} | MODE: Terminal.app`);

    // Check CC CLI is running
    if (!isBrainAlive()) {
        log('BRAIN NOT RUNNING — spawning new Terminal.app tab...');
        spawnBrain();
        await sleep(10000); // Wait for CC CLI to boot
        if (!isBrainAlive()) {
            return { success: false, result: 'brain_spawn_failed', elapsed: 0 };
        }
    }

    // Build full prompt with context
    let fullPrompt = prompt;
    if (projectDir && projectDir !== config.MEKONG_DIR) {
        fullPrompt = `CONTEXT: Target Project is inside '${projectDir}'. You are at ROOT.\n${prompt}`;
    }

    // Type prompt into Terminal.app
    typeInTerminal(fullPrompt);
    log(`DISPATCHED: Mission #${num} typed into Terminal.app`);

    // ═══════════════════════════════════════════════════════════
    // MONITOR: Poll for CC CLI completion via process state
    //
    // Since we can't reliably scrape Terminal.app buffer,
    // we monitor the CC CLI process state:
    //   - pgrep shows claude running = BUSY
    //   - claude exits or shows prompt = DONE
    //   - Timeout = KILL
    // ═══════════════════════════════════════════════════════════

    const deadline = Date.now() + timeoutMs;
    let wasBusy = false;
    let idleCount = 0;

    // Initial wait for CC CLI to start processing
    await sleep(8000);

    while (Date.now() < deadline) {
        // Check if CC CLI process is alive
        const alive = isBrainAlive();
        const elapsedSec = Math.round((Date.now() - startTime) / 1000);

        if (!alive && wasBusy) {
            // CC CLI was busy but now process gone — likely completed + exited
            log(`COMPLETE: Mission #${num} — CC CLI process ended (${elapsedSec}s)`);
            return { success: true, result: 'done', elapsed: elapsedSec };
        }

        if (alive) {
            // Check CPU usage of claude process to determine busy vs idle
            try {
                const cpuInfo = execSync(
                    'ps -p $(pgrep -f "claude.*dangerously-skip-permissions" | head -1) -o %cpu= 2>/dev/null',
                    { encoding: 'utf-8', timeout: 3000 }
                ).trim();
                const cpuUsage = parseFloat(cpuInfo) || 0;

                if (cpuUsage > 5) {
                    wasBusy = true;
                    idleCount = 0;
                    if (elapsedSec % 30 === 0) {
                        log(`BUSY: Mission #${num} — CC CLI active (CPU: ${cpuUsage}%, ${elapsedSec}s)`);
                    }
                } else if (wasBusy) {
                    idleCount++;
                    if (idleCount >= 6) {  // 6 × 5s = 30s idle after being busy = done
                        log(`COMPLETE: Mission #${num} — CC CLI idle after processing (${elapsedSec}s)`);
                        return { success: true, result: 'done', elapsed: elapsedSec };
                    }
                }
            } catch (e) {
                // Process check failed — might have just exited
                if (wasBusy) {
                    log(`COMPLETE: Mission #${num} — CC CLI process ended (${elapsedSec}s)`);
                    return { success: true, result: 'done', elapsed: elapsedSec };
                }
            }
        }

        await sleep(5000);
    }

    // Timeout
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`TIMEOUT: Mission #${num} exceeded ${Math.round(timeoutMs / 1000)}s — leaving CC CLI running`);
    return { success: false, result: 'timeout', elapsed };
}

module.exports = { spawnBrain, killBrain, isBrainAlive, runMission, log };
