const fs = require('fs');
const path = require('path');
const config = require('../config');
const { log } = require('./brain-tmux');
const { checkSafety } = require('./safety-guard');
const { executeTask, detectProjectDir } = require('./mission-dispatcher');
const { classifyContentTimeout } = require('./mission-complexity-classifier');
const { pauseIfOverheating, waitForSafeTemperature } = require('./m1-cooling-daemon');
const { runFullGate } = require('./post-mission-gate');
const { preFlightCheck, reportFailure } = require('./self-healer');
const { sendTelegram } = require('./telegram-client');

let isProcessing = false; // Legacy lock (unused but kept for safety reference)
let activeMissions = 0;   // 🚀 WARP SPEED: Track active parallel missions
let currentTaskFile = null; // Only tracks the *latest* dispatched task (for logging)
const queue = [];
const processingFiles = new Set(); // 🚀 FIX: Track files in-flight to prevent re-queueing
let pollIntervalRef = null;
let watcher = null;

async function processQueue() {
  // 🚀 WARP SPEED: Loop until we hit concurrency limit or queue empty
  while (queue.length > 0 && activeMissions < (config.MAX_CONCURRENT_MISSIONS || 3)) {

    // Thermal gate: block NEW missions if system is overheating
    // (Existing running missions continue)
    const isHot = await pauseIfOverheating();
    if (isHot) {
      await waitForSafeTemperature();
    }

    // v2026.2.13: Pre-flight health check (proxy + CC CLI)
    // We check once per dispatch to ensure we don't spawn into a dead system
    const healthy = await preFlightCheck();
    if (!healthy) {
      log(`PRE-FLIGHT FAILED: ${queue[0] || 'unknown'} — halting dispatch for 30s`);
      setTimeout(processQueue, 30000); // Retry later
      return;
    }

    const taskFile = queue.shift();
    if (processingFiles.has(taskFile)) {
      log(`SKIPPED DUPLICATE: ${taskFile} is already running`);
      continue;
    }

    processingFiles.add(taskFile); // Mark as processing
    currentTaskFile = taskFile; // For logging purpose
    const filePath = path.join(config.WATCH_DIR, taskFile);

    // Increment counter *before* async work start
    activeMissions++;
    log(`🚀 DISPATCHING: ${taskFile} (Active: ${activeMissions}/${config.MAX_CONCURRENT_MISSIONS || 3})`);

    // ASYNC EXECUTION (Do NOT await here, or we block the loop)
    // We launch the mission and attach a .finally() handler to decrement counter
    (async () => {
      try {
        if (!fs.existsSync(filePath)) {
          log(`Ghost file ignored: ${taskFile}`);
          return;
        }
        const content = fs.readFileSync(filePath, 'utf-8').trim();

        // --- 🛡️ SAFETY GATE (Phase 1) ---
        const safety = await checkSafety(content);
        if (!safety.safe) {
           log(`🛑 SAFETY BLOCK: ${taskFile} rejected. Reason: ${safety.reason}`);
           sendTelegram(`🛑 *SAFETY BLOCK*: \`${taskFile}\`\nReason: ${safety.reason}`);

           // Ensure rejected dir exists (double check)
           if (!fs.existsSync(config.REJECTED_DIR)) {
              fs.mkdirSync(config.REJECTED_DIR, { recursive: true });
           }
           fs.renameSync(filePath, path.join(config.REJECTED_DIR, taskFile));
           return;
        }
        // --------------------------------

        const { complexity, timeout } = classifyContentTimeout(content);
        log(`EXECUTING [${complexity.toUpperCase()}/${Math.round(timeout / 60000)}min]: ${taskFile}`);
        sendTelegram(`🦞 *STARTED* [${complexity.toUpperCase()}]: \`${taskFile}\`\n⏳ Timeout: ${Math.round(timeout / 60000)}m\n🚀 Active: ${activeMissions}`);

        const result = await executeTask(content, taskFile, timeout, complexity);

        // === 軍形 CI/CD GATE ===
        let gateStatus = "Skipped";
        if (result && result.success) {
          const projectMatch = taskFile.match(/^(?:HIGH_|MEDIUM_|LOW_)?mission_([a-z0-9_-]+?)_(?:auto_)?/i);
          // Alias map: project names that share a codebase with another project
          const PROJECT_ALIASES = { 'wellnexus': 'anima119' };
          const rawProject = projectMatch ? projectMatch[1].replace(/_/g, '-') : null;
          const project = rawProject ? (PROJECT_ALIASES[rawProject] || rawProject) : null;
          const missionId = taskFile.replace(/^.*?_auto_/, '').replace('.txt', '');

          if (project) {
            log(`GATE: 軍形 verify for ${project}/${missionId}...`);
            const gate = runFullGate(project, missionId);
            if (gate.build) {
              const pushMsg = gate.pushed ? 'PUSHED' : 'no changes';
              log(`GATE: ✅ GREEN — ${pushMsg}`);
              gateStatus = `✅ GREEN (${pushMsg})`;
            } else {
              log(`GATE: ❌ RED — build failed, NOT pushing`);
              gateStatus = "❌ RED (Build Failed)";
            }
          }
        }

        if (fs.existsSync(filePath)) {
          // v2026.2.14: Fast-failure (quota) protection — do NOT archive, keep for retry
          if (result && result.result === 'fast_failure') {
            log(`RETRY: ${taskFile} — fast failure (quota), keeping in queue`);
            return;
          }
          fs.renameSync(filePath, path.join(config.PROCESSED_DIR, taskFile));
          log(`Archived: ${taskFile}`);
        }

        // Telegram Notification
        if (result && result.success) {
          sendTelegram(`✅ *COMPLETED*: \`${taskFile}\`\nGate: ${gateStatus}\n📉 Active: ${activeMissions - 1}`);
        } else {
          sendTelegram(`⚠️ *COMPLETED (With Issues)*: \`${taskFile}\`\nResult: ${JSON.stringify(result)}\n📉 Active: ${activeMissions - 1}`);
        }
      } catch (error) {
        log(`Error processing ${taskFile}: ${error.message}`);
        sendTelegram(`❌ *FAILED*: \`${taskFile}\`\nError: ${error.message}`);
        reportFailure(taskFile, error).catch(() => { });
      } finally {
        activeMissions--;
        processingFiles.delete(taskFile); // Release lock
        log(`🏁 FINISHED: ${taskFile} (Active: ${activeMissions})`);

        // Trigger next dispatch immediately if queue has items
        if (queue.length > 0) {
          processQueue();
        }
      }
    })();

    // Slight delay between parallel launches to prevent TMUX race conditions
    await new Promise(r => setTimeout(r, 2000));
  }
}

function enqueue(filename) {
  if (filename && config.TASK_PATTERN.test(filename)) {
    const filePath = path.join(config.WATCH_DIR, filename);
    // 🚀 FIX: Check processingFiles to avoid double-queueing active tasks
    if (fs.existsSync(filePath) && !queue.includes(filename) && filename !== currentTaskFile && !processingFiles.has(filename)) {
      log(`DETECTED: ${filename}`);
      queue.push(filename);
      // Trigger processing if idle
      processQueue();
    }
  }
}

function startWatching() {
  // Ensure processed dir exists
  if (!fs.existsSync(config.PROCESSED_DIR)) {
    fs.mkdirSync(config.PROCESSED_DIR, { recursive: true });
  }

  // fs.watch for instant detection
  if (fs.existsSync(config.WATCH_DIR)) {
    watcher = fs.watch(config.WATCH_DIR, (eventType, filename) => enqueue(filename));
  }

  // Periodic poll as backup (every 5s) — only log genuinely new tasks
  pollIntervalRef = setInterval(() => {
    try {
      const files = fs.readdirSync(config.WATCH_DIR);
      const tasks = files.filter(f => config.TASK_PATTERN.test(f));
      const newTasks = tasks.filter(f => !queue.includes(f) && f !== currentTaskFile && !processingFiles.has(f));
      if (newTasks.length > 0) {
        log(`Poll found new: ${newTasks.join(', ')}`);
      }
      tasks.forEach(enqueue);
    } catch (e) { }
  }, config.POLL_INTERVAL_MS); // PROJECT FLASH: 200ms Backup Poll
}

function stopWatching() {
  if (pollIntervalRef) {
    clearInterval(pollIntervalRef);
    pollIntervalRef = null;
  }
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

function isQueueEmpty() { return queue.length === 0 && !isProcessing; }

module.exports = { startWatching, stopWatching, isQueueEmpty, enqueue };
