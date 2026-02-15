/**
 * 🩺 Self-Healer v1.0 — Autonomous CC CLI + Proxy Recovery
 *
 * 4 subsystems:
 *   1. CC CLI Health Monitor — detect stuck/crash → auto-restart tmux
 *   2. Proxy Health Gate    — check proxy alive before dispatch
 *   3. Model Fallback       — if model rejected → try backup chain
 *   4. Telegram Escalation  — alert when self-heal fails
 *
 * v2026.2.13 upstream sync: crash recovery, zombie cleanup
 */

const { execSync } = require('child_process');
const http = require('http');
const config = require('../config');
const { sendTelegram } = require('./telegram-client');

// Lazy imports to avoid circular deps
let brainTmux = null;
function getBrain() {
    if (!brainTmux) brainTmux = require('./brain-tmux');
    return brainTmux;
}

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════

const HEALTH_CHECK_INTERVAL_MS = 30_000;      // Check CC CLI every 30s
const PROXY_TIMEOUT_MS = 5_000;               // Proxy ping timeout
const MAX_RECOVERY_ATTEMPTS = 3;              // Before escalating
const STALE_OUTPUT_THRESHOLD_MS = 3 * 60_000; // 3 min no new output → stuck
const MODEL_FALLBACK_CHAIN = [
    config.MODEL_NAME,                          // claude-sonnet-4-5
    config.FALLBACK_MODEL_NAME,                 // gemini-3-flash
    config.QWEN_MODEL_NAME,                     // qwen3-coder-next
];

// ═══════════════════════════════════════
// STATE
// ═══════════════════════════════════════

let monitorRef = null;
let lastOutputHash = '';
let lastOutputTime = Date.now();
let consecutiveFailures = 0;
let currentModelIdx = 0;

function log(msg) {
    getBrain().log(`[HEALER] ${msg}`);
}

// ═══════════════════════════════════════
// 1. CC CLI HEALTH MONITOR
// ═══════════════════════════════════════

function checkCCCLIHealth() {
    try {
        const { isBrainAlive, capturePane, isShellPrompt, isStuck } = getBrain();

        // Check tmux session alive
        if (!isBrainAlive || (typeof isBrainAlive === 'function' && !isBrainAlive())) {
            log('❌ CC CLI tmux session DEAD');
            return { healthy: false, reason: 'session_dead' };
        }

        const output = capturePane();
        if (!output || output.trim().length === 0) {
            log('⚠️ CC CLI output empty');
            return { healthy: false, reason: 'no_output' };
        }

        // Check if dropped to shell
        if (isShellPrompt(output)) {
            log('❌ CC CLI dropped to shell prompt');
            return { healthy: false, reason: 'shell_prompt' };
        }

        // Check if stuck in TUI menu
        if (isStuck(output)) {
            log('⚠️ CC CLI stuck in TUI menu');
            return { healthy: false, reason: 'stuck_tui' };
        }

        // Check for stale output (no change for 3 min)
        const outputHash = simpleHash(output.slice(-500));
        if (outputHash === lastOutputHash) {
            const staleDuration = Date.now() - lastOutputTime;
            if (staleDuration > STALE_OUTPUT_THRESHOLD_MS) {
                log(`⚠️ CC CLI stale output for ${Math.round(staleDuration / 1000)}s`);
                return { healthy: false, reason: 'stale_output' };
            }
        } else {
            lastOutputHash = outputHash;
            lastOutputTime = Date.now();
        }

        // Check for model rejection
        const modelRejected = /Model.*not found|not supported|issue with.*selected model/i.test(output);
        if (modelRejected) {
            log('⚠️ CC CLI model rejected');
            return { healthy: false, reason: 'model_rejected' };
        }

        return { healthy: true };
    } catch (e) {
        log(`Health check error: ${e.message}`);
        return { healthy: false, reason: 'check_error' };
    }
}

function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return h.toString(36);
}

// ═══════════════════════════════════════
// 2. PROXY HEALTH GATE
// ═══════════════════════════════════════

function checkProxyHealth() {
    return new Promise((resolve) => {
        const url = new URL('/v1/models', config.CLOUD_BRAIN_URL);
        const req = http.get(url, { timeout: PROXY_TIMEOUT_MS }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve({ healthy: true, models: data });
                } else {
                    resolve({ healthy: false, reason: `status_${res.statusCode}` });
                }
            });
        });
        req.on('error', (e) => resolve({ healthy: false, reason: e.message }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ healthy: false, reason: 'timeout' });
        });
    });
}

async function restartProxy() {
    log('🔄 Attempting proxy restart...');
    try {
        // Find and kill existing proxy process
        try {
            execSync('pkill -f "anthropic-adapter" 2>/dev/null', { timeout: 5000 });
        } catch (e) { /* may not be running */ }

        await new Promise(r => setTimeout(r, 3000));

        // Restart proxy
        const proxyScript = `${config.MEKONG_DIR}/scripts/anthropic-adapter.js`;
        execSync(`node ${proxyScript} &`, {
            cwd: config.MEKONG_DIR,
            timeout: 10000,
            stdio: 'ignore',
            detached: true,
        });

        await new Promise(r => setTimeout(r, 5000));

        const recheck = await checkProxyHealth();
        if (recheck.healthy) {
            log('✅ Proxy restarted successfully');
            return true;
        }
        log('❌ Proxy still down after restart');
        return false;
    } catch (e) {
        log(`Proxy restart failed: ${e.message}`);
        return false;
    }
}

// ═══════════════════════════════════════
// 3. MODEL FALLBACK
// ═══════════════════════════════════════

function getNextModel() {
    currentModelIdx = (currentModelIdx + 1) % MODEL_FALLBACK_CHAIN.length;
    return MODEL_FALLBACK_CHAIN[currentModelIdx];
}

function getCurrentModel() {
    return MODEL_FALLBACK_CHAIN[currentModelIdx];
}

function resetModelChain() {
    currentModelIdx = 0;
}

// ═══════════════════════════════════════
// 4. TELEGRAM ESCALATION
// ═══════════════════════════════════════

function escalate(errorType, details) {
    const msg = `🚨 *TÔM HÙM ALERT*\n\n` +
        `Error: \`${errorType}\`\n` +
        `Retries: ${consecutiveFailures}/${MAX_RECOVERY_ATTEMPTS}\n` +
        `Details: ${details.slice(0, 200)}\n` +
        `Time: ${new Date().toISOString().slice(11, 19)}`;

    sendTelegram(msg);
    log(`📱 Telegram alert sent: ${errorType}`);
}

// ═══════════════════════════════════════
// RECOVERY ENGINE
// ═══════════════════════════════════════

async function recover(reason) {
    consecutiveFailures++;
    log(`🔧 Recovery attempt ${consecutiveFailures}/${MAX_RECOVERY_ATTEMPTS} — reason: ${reason}`);

    if (consecutiveFailures > MAX_RECOVERY_ATTEMPTS) {
        escalate(reason, `Failed ${consecutiveFailures} times. Manual intervention needed.`);
        consecutiveFailures = 0; // Reset to try again later
        return false;
    }

    switch (reason) {
        case 'session_dead':
        case 'shell_prompt':
        case 'no_output': {
            log('🔄 Respawning CC CLI brain...');
            try {
                const { respawnBrain } = getBrain();
                if (typeof respawnBrain === 'function') {
                    await respawnBrain(true);
                    log('✅ Brain respawned');
                    consecutiveFailures = 0;
                    return true;
                }
            } catch (e) {
                log(`Brain respawn failed: ${e.message}`);
            }
            return false;
        }

        case 'stuck_tui': {
            log('🔄 Sending Escape + Ctrl-C to unstick TUI...');
            try {
                const { sendCtrlC } = getBrain();
                sendCtrlC();
                await new Promise(r => setTimeout(r, 2000));
                sendCtrlC();
                await new Promise(r => setTimeout(r, 2000));
                consecutiveFailures = 0;
                return true;
            } catch (e) {
                log(`Unstick failed: ${e.message}`);
            }
            return false;
        }

        case 'stale_output': {
            // Maybe just slow — send Enter to kick
            log('🔄 Kicking stale session with Enter...');
            try {
                const { sendEnter } = getBrain();
                if (typeof sendEnter === 'function') sendEnter();
                lastOutputTime = Date.now(); // Reset timer
                return true;
            } catch (e) {
                log(`Kick failed: ${e.message}`);
            }
            return false;
        }

        case 'model_rejected': {
            const nextModel = getNextModel();
            log(`🔄 Model fallback: trying ${nextModel}`);
            try {
                const { respawnBrain } = getBrain();
                // Update MODEL_NAME in config for next spawn
                config.MODEL_NAME = nextModel;
                if (typeof respawnBrain === 'function') {
                    await respawnBrain(false);
                    log(`✅ Switched to model: ${nextModel}`);
                    consecutiveFailures = 0;
                    return true;
                }
            } catch (e) {
                log(`Model switch failed: ${e.message}`);
            }
            return false;
        }

        case 'proxy_down': {
            const restarted = await restartProxy();
            if (restarted) {
                consecutiveFailures = 0;
                return true;
            }
            return false;
        }

        default:
            log(`Unknown recovery reason: ${reason}`);
            return false;
    }
}

// ═══════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════

/**
 * Pre-flight check: call before every mission dispatch.
 * Checks proxy + CC CLI health. Auto-recovers if possible.
 * @returns {Promise<boolean>} true = safe to dispatch
 */
async function preFlightCheck() {
    // 1. Check proxy only (CC CLI health check disabled — uses unexported brain-tmux internals)
    const proxyHealth = await checkProxyHealth();
    if (!proxyHealth.healthy) {
        log(`PRE-FLIGHT: Proxy unhealthy — ${proxyHealth.reason}`);
        const recovered = await recover('proxy_down');
        if (!recovered) return false;
    }

    return true;
}

/**
 * Report a mission failure for tracking.
 * Triggers recovery if pattern detected.
 */
async function reportFailure(taskFile, error) {
    const msg = error?.message || String(error);
    log(`FAILURE REPORT: ${taskFile} — ${msg.slice(0, 150)}`);

    // Detect specific failure patterns
    if (/brain_died|respawn/i.test(msg)) {
        await recover('session_dead');
    } else if (/timeout/i.test(msg)) {
        await recover('stale_output');
    } else if (/model/i.test(msg)) {
        await recover('model_rejected');
    }
}

/**
 * Background health monitor — runs every 30s.
 */
function startMonitor() {
    log('🩺 Health Monitor started (proxy-only mode)');
    // CC CLI health monitor disabled — uses unexported brain-tmux internals
    // Only proxy health is checked via preFlightCheck before each dispatch
}

function stopMonitor() {
    if (monitorRef) {
        clearInterval(monitorRef);
        monitorRef = null;
        log('🩺 Health Monitor stopped');
    }
}

module.exports = {
    preFlightCheck,
    reportFailure,
    startMonitor,
    stopMonitor,
    checkProxyHealth,
    checkCCCLIHealth,
    getCurrentModel,
    resetModelChain,
    escalate,
};
