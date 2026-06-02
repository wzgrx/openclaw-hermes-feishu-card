"use strict";
/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * File-scanning token aggregation daemon.
 *
 * Scans ~/.openclaw/cron/runs/*.jsonl every 5 minutes and accumulates
 * token usage from cron/dreaming session runs. Independent from the
 * Event-driven TokenAggregator (which handles Feishu agent sessions).
 *
 * Uses (global - oldDaemon) + newDaemon formula to safely merge
 * its contribution without overwriting the Event path's totals.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.startTokenAggregatorDaemon = startTokenAggregatorDaemon;
exports.stopTokenAggregatorDaemon = stopTokenAggregatorDaemon;
exports.isDaemonAlive = isDaemonAlive;
// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const lark_logger_1 = require("../core/lark-logger.js");
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FLUSH_INTERVAL_MS = 30 * 1000; // flush stats every 30s
const DAEMON_ALIVE_THRESHOLD_MS = 360 * 1000; // 6 minutes (Bug#12 fix: was 120s)
const HOME_DIR = (0, os_1.homedir)();
const DEFAULT_CRON_RUNS_DIR = path_1.join(HOME_DIR, '.openclaw', 'cron', 'runs');
const DEFAULT_TOKEN_STATS_PATH = path_1.join(HOME_DIR, '.openclaw', 'token-stats.json');
// ---------------------------------------------------------------------------
// Helpers (must use UTC methods, locale-independent)
// ---------------------------------------------------------------------------
function getShanghaiDateKey() {
    const d = new Date(Date.now() + SHANGHAI_OFFSET_MS);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function getShanghaiMonthKey() {
    const d = new Date(Date.now() + SHANGHAI_OFFSET_MS);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function getShanghaiTimeWindow() {
    const nowUtc = Date.now();
    const shanghaiNow = new Date(nowUtc + SHANGHAI_OFFSET_MS);
    const todayShanghai = new Date(shanghaiNow);
    todayShanghai.setUTCHours(0, 0, 0, 0);
    const todayStartMs = todayShanghai.getTime() - SHANGHAI_OFFSET_MS;
    const monthStartMs = Date.UTC(shanghaiNow.getUTCFullYear(), shanghaiNow.getUTCMonth(), 1) - SHANGHAI_OFFSET_MS;
    return { todayStartMs, monthStartMs };
}
function parseTimestamp(value) {
    if (typeof value === 'number')
        return value;
    if (typeof value === 'string') {
        const n = Number(value);
        if (!isNaN(n))
            return n;
        const d = new Date(value);
        if (!isNaN(d.getTime()))
            return d.getTime();
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------
const log = (0, lark_logger_1.larkLogger)('token-aggregator-daemon');
let _scanTimer = null;
let _flushTimer = null;
let _running = false;
let daemonToday = 0;
let daemonMonth = 0;
let currentDateKey = '';
let currentMonthKey = '';
let daemonLastFlushMs = 0;
const fileState = new Map(); // filename → { lastLineIndex, lastTotalTokens }
// ---------------------------------------------------------------------------
// Scan Logic
// ---------------------------------------------------------------------------
function performScan(cronRunsDir) {
    try {
        if (!(0, fs_1.existsSync)(cronRunsDir)) {
            log.debug(`cron runs dir not found: ${cronRunsDir}`);
            return;
        }
        const key = getShanghaiDateKey();
        const monthKey = getShanghaiMonthKey();
        // Date/month boundary detection (Bug#11: startup also triggers recount)
        const dateChanged = !currentDateKey || currentDateKey !== key;
        const monthChanged = currentMonthKey && currentMonthKey !== monthKey;
        const isRecount = dateChanged || monthChanged;
        if (isRecount) {
            log.info(`boundary change: dateChanged=${dateChanged}, monthChanged=${monthChanged}, recounting`);
            daemonToday = 0;
            if (monthChanged) {
                daemonMonth = 0;
            }
            currentDateKey = key;
            currentMonthKey = monthKey;
            // Reset all file state for recount (Bug#11: must reset lastLineIndex too)
            for (const s of fileState.values()) {
                s.lastTotalTokens = 0;
                s.lastLineIndex = 0;
            }
        }
        const { todayStartMs, monthStartMs } = getShanghaiTimeWindow();
        let files;
        try {
            files = (0, fs_1.readdirSync)(cronRunsDir).filter((f) => f.endsWith('.jsonl')).sort();
        }
        catch {
            return;
        }
        // Scan new/changed files incrementally
        for (const file of files) {
            const filePath = path_1.join(cronRunsDir, file);
            const state = fileState.get(file) || { lastLineIndex: 0, lastTotalTokens: 0 };
            try {
                const content = (0, fs_1.readFileSync)(filePath, 'utf8');
                const lines = content.split('\n');
                if (lines.length <= state.lastLineIndex + 1) {
                    // No new lines (or fewer lines than before, e.g. truncation)
                    if (lines.length > 0 && lines.length - 1 <= state.lastLineIndex) {
                        // Could be truncated, let recount next time
                        state.lastLineIndex = 0;
                    }
                }
                else {
                    // New lines to scan
                    const scanFrom = dateChanged || monthChanged || state.lastTotalTokens === 0 ? 0 : state.lastLineIndex;
                    let fileDelta = 0;
                    for (let i = scanFrom; i < lines.length; i++) {
                        const trimmed = lines[i].trim();
                        if (!trimmed)
                            continue;
                        let entry;
                        try {
                            entry = JSON.parse(trimmed);
                        }
                        catch {
                            continue;
                        }
                        if (!entry || typeof entry !== 'object')
                            continue;
                        // Time window gate: only count today/month tokens
                        const ts = parseTimestamp(entry?.timestamp ?? entry?.ts);
                        if (ts != null) {
                            if (ts < todayStartMs)
                                continue; // skip older than today
                        }
                        const usage = entry?.usage;
                        if (!usage || typeof usage !== 'object')
                            continue;
                        const inputT = typeof usage.input === 'number' ? usage.input
                            : typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
                        const outputT = typeof usage.output === 'number' ? usage.output
                            : typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
                        if (inputT > 0 || outputT > 0) {
                            const lineTotal = inputT + outputT;
                            fileDelta += lineTotal;
                        }
                    }
                    if (fileDelta > 0) {
                        daemonToday += fileDelta;
                        daemonMonth += fileDelta;
                        state.lastTotalTokens = (state.lastTotalTokens || 0) + fileDelta;
                    }
                    state.lastLineIndex = Math.max(state.lastLineIndex, lines.length - 1);
                }
                fileState.set(file, state);
            }
            catch (err) {
                log.warn(`scan error for ${file}: ${err}`);
            }
        }
        log.debug(`scan complete: today=${daemonToday}, month=${daemonMonth}, files=${files.length}, recount=${isRecount}`);
    }
    catch (err) {
        log.warn(`scan failed: ${err}`);
    }
}
// ---------------------------------------------------------------------------
// Flush Logic
// ---------------------------------------------------------------------------
function flushStats(tokenStatsPath) {
    try {
        daemonLastFlushMs = Date.now();
        // Read current file
        let existing = {};
        try {
            if ((0, fs_1.existsSync)(tokenStatsPath)) {
                existing = JSON.parse((0, fs_1.readFileSync)(tokenStatsPath, 'utf8'));
            }
        }
        catch { /* ignore */ }
        const currentKey = getShanghaiDateKey();
        const prevDaemonToday = existing.daemonToday || 0;
        const prevDaemonMonth = existing.daemonMonth || 0;
        const sameDay = existing.dateKey === currentKey;
        const sameMonth = existing.dateKey
            && existing.dateKey.substring(0, 7) === getShanghaiMonthKey();
        let globalToday, globalMonth;
        if (sameDay) {
            const baseToday = Math.max((existing.todayTokens || 0) - prevDaemonToday, 0);
            globalToday = baseToday + daemonToday;
        }
        else {
            globalToday = daemonToday;
        }
        if (sameMonth) {
            const baseMonth = Math.max((existing.monthTokens || 0) - prevDaemonMonth, 0);
            globalMonth = baseMonth + daemonMonth;
        }
        else {
            globalMonth = daemonMonth;
        }
        // Preserve sessionTotals written by Event path
        const sessionTotalsObj = existing.sessionTotals && typeof existing.sessionTotals === 'object'
            ? existing.sessionTotals
            : {};
        const scannedFilesObj = {};
        for (const [filename, state] of fileState) {
            scannedFilesObj[filename] = { lastLineIndex: state.lastLineIndex, lastTotalTokens: state.lastTotalTokens };
        }
        const output = {
            dateKey: currentKey,
            todayTokens: globalToday,
            monthTokens: globalMonth,
            // Preserve allTimeTokens from Event path if available (it's the canonical cumulative counter)
            // If missing, fall back to monthTokens as starting cumulative value
            allTimeTokens: (existing.allTimeTokens && existing.allTimeTokens > 0)
                ? existing.allTimeTokens
                : globalMonth,
            daemonToday,
            daemonMonth,
            sessionTotals: sessionTotalsObj,
            scannedFiles: scannedFilesObj,
            updatedAt: new Date().toISOString(),
            source: 'token-aggregator-daemon',
        };
        var _daemonTmp = tokenStatsPath + '.tmp';
        (0, fs_1.writeFileSync)(_daemonTmp, JSON.stringify(output, null, 2), 'utf8');
        (0, fs_1.renameSync)(_daemonTmp, tokenStatsPath);
        log.debug(`flush: daemonToday=${daemonToday}, prev=${prevDaemonToday}, global=${globalToday}`);
    }
    catch (err) {
        log.warn(`flush failed: ${err}`);
    }
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function startTokenAggregatorDaemon(options) {
    const cronRunsDir = options?.cronRunsDir || DEFAULT_CRON_RUNS_DIR;
    const tokenStatsPath = options?.tokenStatsPath || DEFAULT_TOKEN_STATS_PATH;
    // Load existing state for date boundary detection
    try {
        if ((0, fs_1.existsSync)(tokenStatsPath)) {
            const raw = (0, fs_1.readFileSync)(tokenStatsPath, 'utf8');
            const data = JSON.parse(raw);
            if (data.dateKey) {
                currentDateKey = data.dateKey;
            }
            if (data.daemonToday != null) {
                daemonToday = data.daemonToday;
            }
            if (data.daemonMonth != null) {
                daemonMonth = data.daemonMonth;
            }
            // Load file scan state
            if (data.scannedFiles && typeof data.scannedFiles === 'object') {
                for (const [filename, state] of Object.entries(data.scannedFiles)) {
                    if (state && typeof state === 'object') {
                        fileState.set(filename, {
                            lastLineIndex: typeof state.lastLineIndex === 'number' ? state.lastLineIndex : 0,
                            lastTotalTokens: typeof state.lastTotalTokens === 'number' ? state.lastTotalTokens : 0,
                        });
                    }
                }
            }
            // Bug#11: Always force recount on startup
            // Set currentDateKey to empty so performScan triggers dateChanged=true
            currentDateKey = '';
            currentMonthKey = '';
            daemonToday = 0;
            daemonMonth = 0;
            log.info(`loaded from file, forcing initial recount`);
        }
        else {
            log.info('no existing token-stats.json, starting fresh');
        }
    }
    catch (err) {
        log.warn(`failed to load token-stats file: ${err}`);
    }
    _running = true;
    // Immediate first scan
    performScan(cronRunsDir);
    // Scan timer
    _scanTimer = setInterval(() => {
        if (!_running)
            return;
        performScan(cronRunsDir);
    }, SCAN_INTERVAL_MS);
    if (_scanTimer.unref)
        _scanTimer.unref();
    // Flush timer
    _flushTimer = setInterval(() => {
        if (!_running)
            return;
        flushStats(tokenStatsPath);
    }, FLUSH_INTERVAL_MS);
    if (_flushTimer.unref)
        _flushTimer.unref();
    log.info(`started (scanInterval=${SCAN_INTERVAL_MS}ms, flushInterval=${FLUSH_INTERVAL_MS}ms, cronDir=${cronRunsDir})`);
}
function stopTokenAggregatorDaemon() {
    _running = false;
    if (_scanTimer) {
        clearInterval(_scanTimer);
        _scanTimer = null;
    }
    if (_flushTimer) {
        clearInterval(_flushTimer);
        _flushTimer = null;
    }
    daemonLastFlushMs = 0; // signal death to health check
    log.info('stopped');
}
function isDaemonAlive() {
    if (daemonLastFlushMs === 0)
        return false; // never flushed or was stopped
    return Date.now() - daemonLastFlushMs < DAEMON_ALIVE_THRESHOLD_MS;
}
