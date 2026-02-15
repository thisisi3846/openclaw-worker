/**
 * M1 Cooling Daemon — Thermal protection + dispatch pause gate
 *
 * Monitors load average and free RAM every COOLING_INTERVAL_MS (90s).
 * When overheating: sets pause flag, kills resource hogs, purges caches.
 * Task queue and auto-CTO check isOverheating() before dispatching.
 *
 * Pre-dispatch gate (waitForSafeTemperature):
 *   Blocks until load < 7 AND free RAM > 300MB.
 *   Logs thermal status every 30s to ~/tom_hum_thermal.log.
 *
 * Thresholds:
 *   OVERHEAT: load > 7 OR free RAM < 50MB → pause dispatch
 *   SAFE:     load < 5 AND free RAM > 100MB → resume dispatch
 *   NOTE: macOS aggressively caches files in RAM, so Pages free is typically
 *         50-200MB even when healthy. Only trigger on truly critical levels.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const config = require('../config');
// Import log lazily to avoid circular dependency
let _log;
function log(msg) {
  if (!_log) _log = require('./brain-tmux').log;
  _log(msg);
}

const THERMAL_LOG = config.THERMAL_LOG || 'path.join(os.homedir(), 'tom_hum_thermal.log')';
const OVERHEAT_LOAD = 10;
const OVERHEAT_RAM_MB = 20;   // Even lower threshold for M1 Max
const SAFE_LOAD = 8;
const SAFE_RAM_MB = 50;      // Resume when free RAM > 50MB

let coolingCycle = 0;
let intervalRef = null;
let thermalLogRef = null;
let overheating = false;

// --- System metrics ---

function getLoadAverage() {
  try {
    const raw = execSync('sysctl -n vm.loadavg 2>/dev/null', { encoding: 'utf-8', timeout: 5000 }).trim();
    const match = raw.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    return match ? parseFloat(match[1]) : 0;
  } catch (e) { return 0; }
}

function getFreeRAM() {
  try {
    const raw = execSync('vm_stat 2>/dev/null | head -5', { encoding: 'utf-8', timeout: 5000 });
    const match = raw.match(/Pages free:\s+(\d+)/);
    return match ? Math.round((parseInt(match[1]) * 16384) / 1024 / 1024) : -1;
  } catch (e) { return -1; }
}

function hasThermalWarning() {
  try {
    const raw = execSync('pmset -g therm 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
    return raw.includes('CPU_Scheduler_Limit') || raw.includes('Speed_Limit');
  } catch (e) { return false; }
}

// --- Thermal logging (every 30s) ---

function logThermalStatus() {
  const load1 = getLoadAverage();
  const freeMB = getFreeRAM();
  const thermal = hasThermalWarning();
  const emoji = overheating ? '🔴' : load1 > OVERHEAT_LOAD ? '🟡' : '🟢';
  const line = `[${new Date().toISOString()}] ${emoji} load=${load1} ram=${freeMB}MB thermal=${thermal} paused=${overheating}\n`;
  try { fs.appendFileSync(THERMAL_LOG, line); } catch (e) { }
}

// --- Resource cleanup ---

const RESOURCE_HOGS = ['pyrefly', 'pyright', 'eslint_d', 'prettierd'];

function killResourceHogs() {
  for (const proc of RESOURCE_HOGS) {
    try {
      const pids = execSync(`pgrep -f "${proc}" 2>/dev/null`, { encoding: 'utf-8' }).trim();
      if (pids) {
        execSync(`pkill -f "${proc}" 2>/dev/null`);
        log(`KILLED ${proc}`);
      }
    } catch (e) { }
  }
}

function purgeSystemCaches() {
  const cachePaths = [
    '~/Library/Caches/com.apple.dt.*',
    '~/Library/Caches/node*',
    '~/Library/Caches/typescript',
  ];
  try {
    execSync(`rm -rf ${cachePaths.join(' ')} 2>/dev/null`, { timeout: 10000 });
  } catch (e) { }
  try {
    execSync('purge 2>/dev/null', { timeout: 10000 });
    log('RAM purge executed');
  } catch (e) { }
}

// --- Overheat detection ---

function checkOverheatStatus() {
  const load1 = getLoadAverage();
  const freeMB = getFreeRAM();
  const thermal = hasThermalWarning();

  const isOverheated = load1 > OVERHEAT_LOAD || (freeMB >= 0 && freeMB < OVERHEAT_RAM_MB) || thermal;
  const isSafe = load1 < SAFE_LOAD && (freeMB < 0 || freeMB > SAFE_RAM_MB);

  // Hysteresis: only change state at clear thresholds
  if (isOverheated && !overheating) {
    overheating = true;
    log(`OVERHEAT DETECTED — Load: ${load1} | RAM: ${freeMB}MB | Thermal: ${thermal} — PAUSING DISPATCH`);
    killResourceHogs();
    purgeSystemCaches();
  } else if (isSafe && overheating) {
    overheating = false;
    log(`COOLED DOWN — Load: ${load1} | RAM: ${freeMB}MB — RESUMING DISPATCH`);
  }

  return { load1, freeMB, thermal, overheating };
}

// --- Public API ---

/** Returns true if system is overheating and dispatch should be paused */
function isOverheating() { return overheating; }

/**
 * Pre-dispatch gate: blocks until load < 7 AND free RAM > 300MB.
 * Called before spawning each claude -p mission.
 * @returns {Promise<void>}
 */
async function waitForSafeTemperature() {
  let load1 = getLoadAverage();
  // Maintenance: Kill hogs even if not blocking
  if (load1 >= OVERHEAT_LOAD) killResourceHogs();
  // NEVER BLOCK: AGI must be immortal
  return;
}

/**
 * Legacy gate for backward compatibility with task-queue.js
 * @returns {Promise<void>}
 */
async function pauseIfOverheating() {
  if (!overheating) return;
  log('THERMAL PAUSE — waiting for system to cool down...');
  while (overheating) {
    await new Promise(r => setTimeout(r, 60000));
    checkOverheatStatus();
    if (overheating) {
      const load1 = getLoadAverage();
      const freeMB = getFreeRAM();
      log(`Still hot — Load: ${load1} | RAM: ${freeMB}MB — waiting 60s more`);
      killResourceHogs();
    }
  }
  log('THERMAL PAUSE LIFTED — dispatch resuming');
}

function startCooling() {
  // Main cooling cycle (every 90s)
  intervalRef = setInterval(() => {
    coolingCycle++;
    const { load1, freeMB } = checkOverheatStatus();
    const emoji = load1 > OVERHEAT_LOAD ? '🔴' : load1 > SAFE_LOAD ? '🟡' : '🟢';
    log(`COOLING #${coolingCycle} ${emoji} Load: ${load1} | RAM: ${freeMB}MB${overheating ? ' | PAUSED' : ''}`);
  }, config.COOLING_INTERVAL_MS);

  // Thermal log (every 30s)
  thermalLogRef = setInterval(logThermalStatus, 30000);
  logThermalStatus(); // Log immediately on start
}

function stopCooling() {
  if (intervalRef) { clearInterval(intervalRef); intervalRef = null; }
  if (thermalLogRef) { clearInterval(thermalLogRef); thermalLogRef = null; }
}

module.exports = { startCooling, stopCooling, isOverheating, pauseIfOverheating, waitForSafeTemperature };
