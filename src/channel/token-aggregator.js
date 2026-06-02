"use strict";
/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Event-driven token aggregation for Feishu card footer.
 *
 * Subscribes to `session_tokens_accrued` events published by
 * StreamingCardController. Accumulates today/month token totals
 * and flushes them to `token-stats.json` every 30 seconds.
 *
 * Dual-path design:
 * - Event path (this file): Feishu agent session tokens
 * - Daemon path (token-aggregator-daemon.js): Cron/dreaming session tokens
 *
 * Each path tracks its own contribution independently to avoid double-counting.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenAggregator = void 0;
const fs_1 = require("fs");
const path_1 = require("path");
const event_bus_1 = require("./event-bus.js");
const lark_logger_1 = require("../core/lark-logger.js");
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;
const FLUSH_INTERVAL_MS = 30 * 1000;
const ALIVE_THRESHOLD_MS = 360 * 1000; // 6 minutes (Bug#12 fix: was 120s)
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getShanghaiDateKey() {
    const d = new Date(Date.now() + SHANGHAI_OFFSET_MS);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function getShanghaiMonthKey() {
    const d = new Date(Date.now() + SHANGHAI_OFFSET_MS);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
// ---------------------------------------------------------------------------
// TokenAggregator
// ---------------------------------------------------------------------------
class TokenAggregator {
    constructor(tokenStatsPath) {
        this.tokenStatsPath = tokenStatsPath;
        this.log = (0, lark_logger_1.larkLogger)('TokenAggregator');
        this.todayTokens = 0;
        this.monthTokens = 0;
        this.allTimeTokens = 0;
        this._todayDateKey = getShanghaiDateKey();
        this._monthKey = getShanghaiMonthKey();
        this._sessionTotals = new Map(); // sessionKey → cumulativeTotal (persistent)
        this._loadedDaemonToday = 0; // Bug#10: daemon contribution snapshot at load time
        this._loadedDaemonMonth = 0;
        this._flushTimer = null;
        this._lastFlushMs = Date.now(); // for health-check isAlive()
        this._unsubscribe = null;
        this._loadFromFile();
        this._subscribe();
        this._startFlushTimer();
        this.log.info(`TokenAggregator started (path=${tokenStatsPath}, todayKey=${this._todayDateKey}, monthKey=${this._monthKey})`);
    }
    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    /** Health-check: returns true if flushed within ALIVE_THRESHOLD_MS. */
    isAlive() {
        // During startup before first flush, consider alive
        if (this._lastFlushMs === 0)
            return true;
        return Date.now() - this._lastFlushMs < ALIVE_THRESHOLD_MS;
    }
    stop() {
        if (this._flushTimer) {
            clearInterval(this._flushTimer);
            this._flushTimer = null;
        }
        if (this._unsubscribe) {
            this._unsubscribe();
            this._unsubscribe = null;
        }
        this.log.info('TokenAggregator stopped');
    }
    // -----------------------------------------------------------------------
    // Private: file I/O
    // -----------------------------------------------------------------------
    _loadFromFile() {
        try {
            if ((0, fs_1.existsSync)(this.tokenStatsPath)) {
                const raw = (0, fs_1.readFileSync)(this.tokenStatsPath, 'utf8');
                const data = JSON.parse(raw);
                const sameDay = data.dateKey === this._todayDateKey;
                const sameMonth = data.dateKey
                    && data.dateKey.substring(0, 7) === this._monthKey;
                if (sameDay) {
                    this.todayTokens = typeof data.todayTokens === 'number' ? data.todayTokens : 0;
                }
                if (sameMonth) {
                    this.monthTokens = typeof data.monthTokens === 'number' ? data.monthTokens : 0;
                }
                // Cumulative all-time total (always restored regardless of date)
                this.allTimeTokens = typeof data.allTimeTokens === 'number' ? data.allTimeTokens : 0;
                // Load daemon contribution snapshot (Bug#10)
                if (sameDay) {
                    this._loadedDaemonToday = typeof data.daemonToday === 'number' ? data.daemonToday : 0;
                }
                if (sameMonth) {
                    this._loadedDaemonMonth = typeof data.daemonMonth === 'number' ? data.daemonMonth : 0;
                }
                // Load session-level totals for dedup
                if (data.sessionTotals && typeof data.sessionTotals === 'object') {
                    for (const [key, val] of Object.entries(data.sessionTotals)) {
                        if (typeof val === 'number') {
                            this._sessionTotals.set(key, val);
                        }
                    }
                }
                this.log.info(`loaded from file: today=${this.todayTokens}, month=${this.monthTokens}, daemonToday=${this._loadedDaemonToday}, sessionKeys=${this._sessionTotals.size}`);
            }
        }
        catch (err) {
            this.log.warn(`failed to load token-stats file: ${err}`);
        }
    }
    _flush() {
        try {
            this._lastFlushMs = Date.now();
            // Read current file state
            let existing = {};
            try {
                if ((0, fs_1.existsSync)(this.tokenStatsPath)) {
                    existing = JSON.parse((0, fs_1.readFileSync)(this.tokenStatsPath, 'utf8'));
                }
            }
            catch { /* ignore */ }
            // Calculate Event path contribution: ourToday - loadedDaemonToday (Bug#10)
            const eventPathToday = Math.max(this.todayTokens - this._loadedDaemonToday, 0);
            const eventPathMonth = Math.max(this.monthTokens - this._loadedDaemonMonth, 0);
            // Read current daemon contribution from file
            const currentDaemonToday = typeof existing.daemonToday === 'number' ? existing.daemonToday : 0;
            const currentDaemonMonth = typeof existing.daemonMonth === 'number' ? existing.daemonMonth : 0;
            const sameDay = existing.dateKey === this._todayDateKey;
            const sameMonth = existing.dateKey
                && existing.dateKey.substring(0, 7) === this._monthKey;
            // Global total = Event path contribution + Daemon latest contribution
            const globalToday = sameDay
                ? eventPathToday + currentDaemonToday
                : this.todayTokens;
            const globalMonth = sameMonth
                ? eventPathMonth + currentDaemonMonth
                : this.monthTokens;
            // Build sessionTotals from Map for persistence
            const sessionTotalsObj = {};
            for (const [key, val] of this._sessionTotals) {
                sessionTotalsObj[key] = val;
            }
            const output = {
                dateKey: this._todayDateKey,
                todayTokens: globalToday,
                monthTokens: globalMonth,
                allTimeTokens: this.allTimeTokens,
                daemonToday: currentDaemonToday,
                daemonMonth: currentDaemonMonth,
                sessionTotals: sessionTotalsObj,
                updatedAt: new Date().toISOString(),
                source: 'token-aggregator',
            };
            // Preserve daemon's scannedFiles if present
            if (existing.scannedFiles && typeof existing.scannedFiles === 'object') {
                output.scannedFiles = existing.scannedFiles;
            }
            // Atomic write
            var _aggTmp = this.tokenStatsPath + '.tmp';
            (0, fs_1.writeFileSync)(_aggTmp, JSON.stringify(output, null, 2), 'utf8');
            (0, fs_1.renameSync)(_aggTmp, this.tokenStatsPath);
            this.log.debug(`flushed: eventPathToday=${eventPathToday}, daemonToday=${currentDaemonToday}, global=${globalToday}, month=${globalMonth}, sessions=${this._sessionTotals.size}`);
        }
        catch (err) {
            this.log.warn(`flush failed: ${err}`);
        }
    }
    // -----------------------------------------------------------------------
    // Private: event subscription
    // -----------------------------------------------------------------------
    _subscribe() {
        this._unsubscribe = (0, event_bus_1.subscribe)('session_tokens_accrued', (event) => {
            this._onTokensAccrued(event);
        });
    }
    _onTokensAccrued(event) {
        try {
            // Date boundary check
            const currentDateKey = getShanghaiDateKey();
            const currentMonthKey = getShanghaiMonthKey();
            if (currentDateKey !== this._todayDateKey) {
                this.log.info(`date boundary: ${this._todayDateKey} → ${currentDateKey}, resetting today`);
                this.todayTokens = 0;
                this._sessionTotals.clear();
                this._todayDateKey = currentDateKey;
                this._loadedDaemonToday = 0;
            }
            if (currentMonthKey !== this._monthKey) {
                this.log.info(`month boundary: ${this._monthKey} → ${currentMonthKey}, resetting month`);
                this.monthTokens = 0;
                this._monthKey = currentMonthKey;
                this._loadedDaemonMonth = 0;
            }
            // Accumulate tokens (directly trust event.tokens as delta)
            const tokens = typeof event.tokens === 'number' ? event.tokens : 0;
            if (tokens <= 0)
                return;
            this.todayTokens += tokens;
            this.monthTokens += tokens;
            this.allTimeTokens += tokens;
            // Session-level dedup
            if (event.sessionKey) {
                const prev = this._sessionTotals.get(event.sessionKey) || 0;
                this._sessionTotals.set(event.sessionKey, prev + tokens);
            }
            this.log.debug(`accrued: +${tokens}, today=${this.todayTokens}, month=${this.monthTokens}, session=${event.sessionKey ?? '-'}`);
        }
        catch (err) {
            this.log.warn(`onTokensAccrued error: ${err}`);
        }
    }
    // -----------------------------------------------------------------------
    // Private: flush timer
    // -----------------------------------------------------------------------
    _startFlushTimer() {
        this._flushTimer = setInterval(() => {
            this._flush();
        }, FLUSH_INTERVAL_MS);
        if (this._flushTimer.unref)
            this._flushTimer.unref();
    }
}
exports.TokenAggregator = TokenAggregator;
