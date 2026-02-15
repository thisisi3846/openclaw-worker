/**
 * Brain Headless — Spawns claude -p per mission as isolated child process
 *
 * Each mission = one short-lived `claude -p` process.
 * Crash in one mission does NOT affect the daemon.
 * stdin MUST be 'ignore' — piped stdin causes infinite hang.
 *
 * Exports: spawnBrain, killBrain, isBrainAlive, runMission, log
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { diagnoseFailure, truncatePrompt } = require('./mission-recovery');

let missionCount = 0;
let activeMission = null; // Track current child process

// --- Logging ---

function log(msg) {
  const timestamp = new Date().toISOString().slice(11, 19);
  const formatted = `[${timestamp}] [tom-hum] ${msg}\n`;
  process.stderr.write(formatted);
  try { fs.appendFileSync(config.LOG_FILE, formatted); } catch (e) { }
}

// --- Brain lifecycle (headless = no persistent brain) ---

function spawnBrain() {
  log('BRAIN MODE: headless — each mission spawns claude -p. No persistent brain.');
}

function killBrain() {
  if (activeMission) {
    try { activeMission.kill('SIGTERM'); } catch (e) { }
    activeMission = null;
  }
  log('BRAIN MODE: headless — active mission killed (if any).');
}

function isBrainAlive() {
  // Headless mode: brain is always "alive" — we spawn on demand
  return true;
}

// --- Core: run one mission via claude -p ---

/**
 * Spawn claude -p with prompt, wait for exit, return result.
 * @param {string} prompt - Full mission prompt
 * @param {string} projectDir - Working directory for the mission
 * @param {number} timeoutMs - Max runtime before kill
 * @param {object} [opts] - Options: { model, isRetry }
 * @returns {Promise<{success: boolean, result: string, elapsed: number}>}
 */
function spawnMission(prompt, projectDir, timeoutMs, opts = {}) {
  const model = opts.model || config.MODEL_NAME;
  const isRetry = opts.isRetry || false;

  return new Promise((resolve) => {
    const startTime = Date.now();
    const num = missionCount;
    let resolved = false;
    let stdout = '';
    let stderr = '';

    const args = [
      '-p', prompt,
      '--model', model,
      '--dangerously-skip-permissions',
    ];

    log(`SPAWN #${num}${isRetry ? ' (RETRY)' : ''}: claude -p [model=${model}] [cwd=${projectDir}] [timeout=${Math.round(timeoutMs / 60000)}min]`);

    const child = spawn('claude', args, {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'], // stdin MUST be ignore
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'ollama',
        ANTHROPIC_BASE_URL: config.CLOUD_BRAIN_URL,
        CLAUDE_BASE_URL: config.CLOUD_BRAIN_URL,
      },
      timeout: timeoutMs,
    });

    activeMission = child;

    // Stream stdout to log
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      // Log last meaningful line for visibility
      const lines = chunk.toString().trim().split('\n');
      const last = lines[lines.length - 1];
      if (last && last.length > 5) {
        const truncated = last.length > 200 ? last.slice(0, 200) + '...' : last;
        try { fs.appendFileSync(config.LOG_FILE, `[${new Date().toISOString().slice(11, 19)}] [mission-${num}] ${truncated}\n`); } catch (e) { }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    // Timeout kill
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      activeMission = null;
      try { child.kill('SIGTERM'); } catch (e) { }
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      log(`TIMEOUT: Mission #${num} exceeded ${Math.round(timeoutMs / 1000)}s — killed`);
      resolve({ success: false, result: 'timeout', elapsed });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      activeMission = null;
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const success = code === 0;
      log(`${success ? 'COMPLETE' : 'FAILED'}: Mission #${num} (exit=${code}, ${elapsed}s)`);
      resolve({ success, result: success ? 'done' : `exit_${code}`, elapsed, stderr });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (resolved) return;
      resolved = true;
      activeMission = null;
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      log(`ERROR: Mission #${num} spawn failed: ${err.message}`);
      resolve({ success: false, result: 'spawn_error', elapsed, stderr: err.message });
    });
  });
}

/**
 * Run a mission with automatic recovery (model failover + context truncation).
 * @param {string} prompt - Mission prompt
 * @param {string} projectDir - Working directory
 * @param {number} timeoutMs - Timeout in ms
 * @returns {Promise<{success: boolean, result: string, elapsed: number}>}
 */
async function runMission(prompt, projectDir, timeoutMs) {
  missionCount++;
  const num = missionCount;
  log(`MISSION #${num}: ${prompt.slice(0, 150)}...`);
  log(`PROJECT: ${projectDir} | MODE: headless`);

  // First attempt
  const result = await spawnMission(prompt, projectDir, timeoutMs);

  if (result.success) return result;

  // Recovery: check if failure is recoverable
  const diagnosis = diagnoseFailure(result.stderr || '');

  if (diagnosis.action === 'model_failover') {
    log(`RECOVERY: Model failover → ${diagnosis.model}`);
    return spawnMission(prompt, projectDir, timeoutMs, { model: diagnosis.model, isRetry: true });
  }

  if (diagnosis.action === 'context_truncate') {
    log(`RECOVERY: Context overflow → truncating prompt`);
    const truncated = truncatePrompt(prompt);
    return spawnMission(truncated, projectDir, timeoutMs, { isRetry: true });
  }

  return result;
}

module.exports = { spawnBrain, killBrain, isBrainAlive, runMission, log };
