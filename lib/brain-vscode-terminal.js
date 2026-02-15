/**
 * Brain VS Code Terminal — CC CLI visible in Terminal.app alongside Antigravity
 *
 * Architecture:
 *   - CC CLI runs in Terminal.app with full TUI (drag tab into Antigravity)
 *   - Prompts dispatched via Terminal.app `do script` (no Accessibility needed)
 *   - Task-watcher runs in background, monitors CC CLI process state
 *   - Falls back to headless `claude -p` if Terminal.app unavailable
 *
 * Why this approach:
 *   - NO System Events keystroke (no Accessibility permission)
 *   - NO tmux (crashes)
 *   - Full ClaudeKit TUI visible
 *   - Terminal.app `do script` is bulletproof
 *
 * Exports: spawnBrain, killBrain, isBrainAlive, runMission, log
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const config = require('../config');

let missionCount = 0;

// --- Logging ---
function log(msg) {
    const timestamp = new Date().toISOString().slice(11, 19);
    const formatted = `[${timestamp}] [tom-hum] ${msg}\n`;
    process.stderr.write(formatted);
    try { fs.appendFileSync(config.LOG_FILE, formatted); } catch (e) { }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- AppleScript helper ---
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

// --- CC CLI config ---
function getProxyConfig() {
    const proxyUrl = config.CLOUD_BRAIN_URL || 'http://127.0.0.1:11436';
    const proxyPort = new URL(proxyUrl).port || '11436';
    return {
        proxyUrl,
        configDir: `${HOME}/.claude_antigravity_${proxyPort}`,
    };
}

// --- Brain lifecycle ---

function spawnBrain() {
    log('BRAIN MODE: Antigravity Terminal — CC CLI in Terminal.app');

    const { proxyUrl, configDir } = getProxyConfig();

    // Create launcher script
    const launcher = '/tmp/tom_hum_cc_launcher.sh';
    fs.writeFileSync(launcher, [
        '#!/bin/bash',
        `export ANTHROPIC_API_KEY="ollama"`,
        `export ANTHROPIC_BASE_URL="${proxyUrl}"`,
        `export CLAUDE_BASE_URL="${proxyUrl}"`,
        `export CLAUDE_CONFIG_DIR="${configDir}"`,
        'unset ANTHROPIC_AUTH_TOKEN',
        `cd "${config.MEKONG_DIR}"`,
        'echo "🦞 TÔM HÙM Worker — CC CLI Interactive"',
        'echo "================================"',
        `claude --model ${config.MODEL_NAME} --dangerously-skip-permissions`,
    ].join('\n'), { mode: 0o755 });

    // Open in Terminal.app via AppleScript (no Accessibility needed)
    runAppleScriptFile(`
tell application "Terminal"
  activate
  do script "/tmp/tom_hum_cc_launcher.sh"
end tell
`);

    log('BRAIN: CC CLI launched in Terminal.app');
    log('TIP: Drag Terminal tab into Antigravity for integrated view');
}

function killBrain() {
    log('BRAIN: Killing CC CLI...');
    try {
        const pid = execSync('pgrep -f "claude.*dangerously-skip-permissions" | head -1', {
            encoding: 'utf-8', timeout: 3000
        }).trim();
        if (pid) execSync(`kill ${pid}`, { timeout: 3000 });
    } catch (e) { }
}

function isBrainAlive() {
    try {
        execSync('pgrep -f "claude.*dangerously-skip-permissions"', { timeout: 3000 });
        return true;
    } catch (e) { return false; }
}

// --- Send prompt to CC CLI via Terminal.app `do script` ---
function typeInTerminal(text) {
    fs.writeFileSync('/tmp/tom_hum_paste.txt', text);

    // Terminal.app `do script` — reliable, no permissions needed
    const result = runAppleScriptFile(`
set promptText to (read POSIX file "/tmp/tom_hum_paste.txt")

tell application "Terminal"
  set targetTab to null
  repeat with w in windows
    repeat with t in tabs of w
      try
        set tabContent to contents of t
        if tabContent contains "TÔM HÙM Worker" then
          set targetTab to t
        end if
      end try
    end repeat
  end repeat
  
  if targetTab is not null then
    do script promptText in targetTab
  else
    set targetTab to do script "/tmp/tom_hum_cc_launcher.sh"
    delay 5
    do script promptText in targetTab
  end if
  activate
end tell
`);
    return true;
}

// --- Headless fallback ---
function runHeadlessFallback(prompt, projectDir, timeoutMs) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        let resolved = false;
        const { proxyUrl } = getProxyConfig();

        const args = ['-p', prompt, '--model', config.MODEL_NAME, '--dangerously-skip-permissions'];
        log(`FALLBACK HEADLESS: claude -p [cwd=${projectDir}] [timeout=${Math.round(timeoutMs / 60000)}min]`);

        const child = spawn('claude', args, {
            cwd: projectDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                ANTHROPIC_API_KEY: 'ollama',
                ANTHROPIC_BASE_URL: proxyUrl,
                CLAUDE_BASE_URL: proxyUrl,
            },
            timeout: timeoutMs,
        });

        child.stdout.on('data', (chunk) => {
            const last = chunk.toString().trim().split('\n').pop();
            if (last && last.length > 5) {
                const line = last.length > 200 ? last.slice(0, 200) + '...' : last;
                try { fs.appendFileSync(config.LOG_FILE, `[${new Date().toISOString().slice(11, 19)}] [headless] ${line}\n`); } catch (e) { }
            }
        });

        const timer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            try { child.kill('SIGTERM'); } catch (e) { }
            resolve({ success: false, result: 'timeout', elapsed: Math.round((Date.now() - startTime) / 1000) });
        }, timeoutMs);

        child.on('close', (code) => {
            clearTimeout(timer);
            if (resolved) return;
            resolved = true;
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            resolve({ success: code === 0, result: code === 0 ? 'done' : `exit_${code}`, elapsed });
        });

        child.on('error', () => {
            clearTimeout(timer);
            if (resolved) return;
            resolved = true;
            resolve({ success: false, result: 'spawn_error', elapsed: 0 });
        });
    });
}

// --- Core: Run mission ---
async function runMission(prompt, projectDir, timeoutMs) {
    missionCount++;
    const num = missionCount;
    const startTime = Date.now();

    log(`MISSION #${num}: ${prompt.slice(0, 150)}...`);
    log(`PROJECT: ${projectDir} | MODE: Antigravity Terminal`);

    // If CC CLI not running, spawn it
    if (!isBrainAlive()) {
        log('CC CLI not running — spawning...');
        spawnBrain();
        await sleep(12000);
        if (!isBrainAlive()) {
            log('CC CLI failed to start — headless fallback');
            return runHeadlessFallback(prompt, projectDir, timeoutMs);
        }
    }

    // Build prompt with context
    let fullPrompt = prompt;
    if (projectDir && projectDir !== config.MEKONG_DIR) {
        fullPrompt = `CONTEXT: Target Project inside '${projectDir}'. At ROOT.\n${prompt}`;
    }

    // Dispatch to Terminal.app
    typeInTerminal(fullPrompt);
    log(`DISPATCHED: Mission #${num} sent to Antigravity terminal`);

    // Monitor CC CLI process state
    const deadline = Date.now() + timeoutMs;
    let wasBusy = false;
    let idleCount = 0;
    await sleep(8000);

    while (Date.now() < deadline) {
        const alive = isBrainAlive();
        const elapsedSec = Math.round((Date.now() - startTime) / 1000);

        if (!alive && wasBusy) {
            log(`COMPLETE: Mission #${num} — CC CLI ended (${elapsedSec}s)`);
            return { success: true, result: 'done', elapsed: elapsedSec };
        }

        if (alive) {
            try {
                const cpu = parseFloat(execSync(
                    'ps -p $(pgrep -f "claude.*dangerously-skip-permissions" | head -1) -o %cpu= 2>/dev/null',
                    { encoding: 'utf-8', timeout: 3000 }
                ).trim()) || 0;

                if (cpu > 5) {
                    wasBusy = true;
                    idleCount = 0;
                    if (elapsedSec % 30 === 0) log(`BUSY: Mission #${num} (CPU:${cpu}%, ${elapsedSec}s)`);
                } else if (wasBusy) {
                    idleCount++;
                    if (idleCount >= 6) {
                        log(`COMPLETE: Mission #${num} — idle after processing (${elapsedSec}s)`);
                        return { success: true, result: 'done', elapsed: elapsedSec };
                    }
                }
            } catch (e) {
                if (wasBusy) {
                    log(`COMPLETE: Mission #${num} — process ended (${elapsedSec}s)`);
                    return { success: true, result: 'done', elapsed: elapsedSec };
                }
            }
        }

        await sleep(5000);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`TIMEOUT: Mission #${num} (${Math.round(timeoutMs / 1000)}s)`);
    return { success: false, result: 'timeout', elapsed };
}

module.exports = { spawnBrain, killBrain, isBrainAlive, runMission, log };
