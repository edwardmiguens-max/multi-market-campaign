/**
 * V2 quarter bank — artist-level sales storage.
 * Banked quarters ignore new uploads for that period; only unbanked quarters are overwritten.
 * Artist rollups must come from the bank, never by summing report snapshots.
 */
(function (global) {
    'use strict';

    const STORAGE_PREFIX = 'rep-v2-quarter-bank:';
    const IDB_NAME = 'rep-v2-quarter-bank-rows';
    const IDB_STORE = 'quarter_rows';
    const LOCAL_CHUNK_SIZE = 5000;

    function rowsFromStoredPayload(stored) {
        if (!stored) return [];
        if (Array.isArray(stored)) return stored;
        if (stored.v === 1 && Array.isArray(stored.chunks)) return stored.chunks.flat();
        return [];
    }

    function storedRowCount(stored) {
        if (!stored) return 0;
        if (Array.isArray(stored)) return stored.length;
        if (stored.v === 1) return stored.rowCount || rowsFromStoredPayload(stored).length;
        return 0;
    }
    function rowStoreKey(artistKey, quarterKey) {
        return `${slugifyArtistKey(artistKey)}::${quarterKey}`;
    }

    function openRowDb() {
        return new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') {
                reject(new Error('IndexedDB unavailable'));
                return;
            }
            const req = indexedDB.open(IDB_NAME, 1);
            req.onerror = () => reject(req.error);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(IDB_STORE)) {
                    req.result.createObjectStore(IDB_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
        });
    }

    async function readStoredPayload(bank, quarterKey) {
        if (!bank?.artistKey || !quarterKey) return null;
        const db = await openRowDb();
        const stored = await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(rowStoreKey(bank.artistKey, quarterKey));
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => reject(req.error);
        });
        db.close();
        return stored;
    }

    async function persistQuarterRowsLocal(bank, quarterKey, rows) {
        if (!bank?.artistKey || !quarterKey || !rows?.length) {
            return { ok: false, rowCount: 0, error: 'No rows to persist' };
        }
        try {
            const chunks = [];
            for (let i = 0; i < rows.length; i += LOCAL_CHUNK_SIZE) {
                chunks.push(rows.slice(i, i + LOCAL_CHUNK_SIZE));
            }
            const payload = { v: 1, rowCount: rows.length, chunks, savedAt: new Date().toISOString() };
            const db = await openRowDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).put(payload, rowStoreKey(bank.artistKey, quarterKey));
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
            db.close();
            const verify = await readStoredPayload(bank, quarterKey);
            const verified = storedRowCount(verify);
            if (verified !== rows.length) {
                return { ok: false, rowCount: verified, error: `Verify failed (${verified} vs ${rows.length})` };
            }
            return { ok: true, rowCount: verified, error: null };
        } catch (err) {
            return { ok: false, rowCount: 0, error: err?.message || String(err) };
        }
    }

    async function loadQuarterRowsLocal(bank, quarterKey) {
        if (!bank?.artistKey || !quarterKey) return [];
        try {
            const stored = await readStoredPayload(bank, quarterKey);
            return rowsFromStoredPayload(stored);
        } catch (_err) {
            return [];
        }
    }

    async function countQuarterRowsLocal(bank, quarterKey) {
        try {
            const stored = await readStoredPayload(bank, quarterKey);
            return storedRowCount(stored);
        } catch (_err) {
            return 0;
        }
    }

    async function verifyQuarterRowsLocal(bank, quarterKey, expectedCount) {
        const count = await countQuarterRowsLocal(bank, quarterKey);
        return count === expectedCount;
    }

    async function hydrateBankRowsLocal(bank, options) {
        if (!bank) return bank;
        bank._sessionRows = bank._sessionRows || {};
        const keys = options?.quarterKeys?.length
            ? options.quarterKeys
            : listQuarterKeys(bank);
        for (const qk of keys) {
            if (bank._sessionRows[qk]?.length) continue;
            const rows = await loadQuarterRowsLocal(bank, qk);
            if (!rows.length) continue;
            bank._sessionRows[qk] = rows;
            if (bank.quarters[qk]) {
                bank.quarters[qk].rows = rows;
                bank.quarters[qk].rowCount = rows.length;
            }
        }
        return bank;
    }

    async function persistAllBankRowsLocal(bank) {
        if (!bank?.artistKey) return [];
        const results = [];
        const keys = listQuarterKeys(bank);
        for (const qk of keys) {
            const rows = getQuarterRows(bank, qk);
            if (!rows.length) continue;
            results.push({ quarterKey: qk, ...(await persistQuarterRowsLocal(bank, qk, rows)) });
        }
        return results;
    }

    function slugifyArtistKey(name) {
        return String(name || 'unknown-artist').trim().toLowerCase()
            .replace(/[^\w\s-]+/g, '').replace(/\s+/g, '-')
            .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'unknown-artist';
    }

    function quarterKeyFromDate(isoDay) {
        if (!isoDay || !/^\d{4}-\d{2}-\d{2}/.test(String(isoDay))) return null;
        const y = parseInt(isoDay.slice(0, 4), 10);
        const m = parseInt(isoDay.slice(5, 7), 10);
        const q = m <= 3 ? 1 : m <= 6 ? 2 : m <= 9 ? 3 : 4;
        return `${y}-Q${q}`;
    }

    function quarterBounds(quarterKey) {
        const m = String(quarterKey || '').match(/^(\d{4})-Q([1-4])$/);
        if (!m) return null;
        const y = parseInt(m[1], 10);
        const q = parseInt(m[2], 10);
        const starts = [`${y}-01-01`, `${y}-04-01`, `${y}-07-01`, `${y}-10-01`];
        const ends = [`${y}-03-31`, `${y}-06-30`, `${y}-09-30`, `${y}-12-31`];
        return { start: starts[q - 1], end: ends[q - 1], label: quarterKey };
    }

    function quarterLabel(quarterKey) {
        const b = quarterBounds(quarterKey);
        if (!b) return quarterKey || '—';
        const q = quarterKey.slice(-1);
        const names = { 1: 'Jan–Mar', 2: 'Apr–Jun', 3: 'Jul–Sep', 4: 'Oct–Dec' };
        return `Q${q} ${b.start.slice(0, 4)} (${names[q]})`;
    }

    function parseRowDayToIso(v) {
        if (v == null || v === '') return null;
        if (v instanceof Date && !isNaN(v.getTime())) {
            const y = v.getFullYear();
            const mo = String(v.getMonth() + 1).padStart(2, '0');
            const d = String(v.getDate()).padStart(2, '0');
            return `${y}-${mo}-${d}`;
        }
        const s = String(v).trim();
        if (!s) return null;
        const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
        if (iso) return iso[1];
        const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
        if (us) {
            let y = parseInt(us[3], 10);
            if (y < 100) y += 2000;
            const m = parseInt(us[1], 10);
            const d = parseInt(us[2], 10);
            if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
                return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            }
        }
        const parsed = new Date(s);
        if (!isNaN(parsed.getTime())) {
            const y = parsed.getFullYear();
            const mo = String(parsed.getMonth() + 1).padStart(2, '0');
            const d = String(parsed.getDate()).padStart(2, '0');
            return `${y}-${mo}-${d}`;
        }
        return null;
    }

    function getRowDay(row) {
        if (!row || typeof row !== 'object') return null;
        for (const k of Object.keys(row)) {
            if (!k) continue;
            const clean = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
            if (clean === 'day' || clean === 'reportingday' || clean.includes('date') || clean.includes('timestamp') || clean.includes('created')) {
                const v = row[k];
                if (v == null || v === '') continue;
                const iso = parseRowDayToIso(v);
                if (iso) return iso;
            }
        }
        return null;
    }

    function detectQuarterFromRows(rows) {
        let min = null, max = null;
        (rows || []).forEach(row => {
            const day = getRowDay(row);
            if (!day) return;
            if (!min || day < min) min = day;
            if (!max || day > max) max = day;
        });
        if (!min) return null;
        const qMin = quarterKeyFromDate(min);
        const qMax = quarterKeyFromDate(max);
        if (qMin === qMax) return qMin;
        return qMin;
    }

    function splitRowsByQuarter(rows) {
        const buckets = {};
        let undated = 0;
        (rows || []).forEach(row => {
            const day = getRowDay(row);
            const qk = day ? quarterKeyFromDate(day) : null;
            if (!qk) {
                undated += 1;
                return;
            }
            if (!buckets[qk]) buckets[qk] = [];
            buckets[qk].push(row);
        });
        return { buckets, undated };
    }

    /**
     * Split upload by row dates into quarter slots.
     * Replace: overwrites each unlocked quarter present in the file.
     * Banked quarters in the file are ignored (existing data kept).
     */
    function ingestRowsIntoBank(bank, rows, options) {
        if (!bank) throw new Error('Quarter bank not initialized.');
        const mode = options?.mode || 'replace';
        const fileName = options?.fileName || null;
        const mergeFn = options?.mergeFn || null;
        const { buckets, undated } = splitRowsByQuarter(rows);
        const quarterKeys = Object.keys(buckets).sort();
        if (!quarterKeys.length) {
            throw new Error('No rows with a recognizable date column — cannot assign to quarters.');
        }
        const applied = [];
        const skipped = [];
        quarterKeys.forEach(qk => {
            if (bank.quarters?.[qk]?.status === 'banked') {
                skipped.push({ quarterKey: qk, rowCount: buckets[qk].length, reason: 'banked' });
                return;
            }
            let finalRows = buckets[qk];
            if (mode === 'append' && mergeFn) {
                const existing = getQuarterRows(bank, qk);
                finalRows = mergeFn(existing, buckets[qk]).rows;
            }
            overwriteActiveQuarter(bank, qk, finalRows, { fileName });
            applied.push({ quarterKey: qk, rowCount: finalRows.length });
        });
        if (applied.length) {
            bank.activeQuarter = applied[applied.length - 1].quarterKey;
        }
        return { applied, skipped, undated, quarterKeys };
    }

    function createEmptyBank(artistKey) {
        return {
            artistKey: artistKey || 'unknown-artist',
            activeQuarter: null,
            quarters: {}
        };
    }

    function storageKey(artistKey) {
        return STORAGE_PREFIX + slugifyArtistKey(artistKey);
    }

    function loadBank(artistKey) {
        try {
            const raw = localStorage.getItem(storageKey(artistKey));
            if (!raw) return createEmptyBank(artistKey);
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return createEmptyBank(artistKey);
            parsed.quarters = parsed.quarters || {};
            parsed.artistKey = artistKey;
            return parsed;
        } catch (_err) {
            return createEmptyBank(artistKey);
        }
    }

    function saveBank(bank) {
        if (!bank?.artistKey) return;
        const payload = {
            artistKey: bank.artistKey,
            activeQuarter: bank.activeQuarter || null,
            quarters: {}
        };
        Object.entries(bank.quarters || {}).forEach(([qk, slot]) => {
            payload.quarters[qk] = {
                status: slot.status || 'active',
                rowCount: slot.rows ? slot.rows.length : (slot.rowCount || 0),
                bankedAt: slot.bankedAt || null,
                uploadedAt: slot.uploadedAt || null,
                fileName: slot.fileName || null,
                aggregates: slot.aggregates || null
            };
        });
        try {
            localStorage.setItem(storageKey(bank.artistKey), JSON.stringify(payload));
        } catch (_err) { /* quota — bank metadata only */ }
        bank._sessionRows = bank._sessionRows || {};
    }

    function setQuarterRows(bank, quarterKey, rows, meta) {
        if (!bank || !quarterKey) return bank;
        bank.quarters = bank.quarters || {};
        bank._sessionRows = bank._sessionRows || {};
        bank._sessionRows[quarterKey] = rows || [];
        bank.quarters[quarterKey] = {
            status: (bank.quarters[quarterKey]?.status === 'banked') ? 'banked' : 'active',
            rows: rows || [],
            rowCount: (rows || []).length,
            uploadedAt: new Date().toISOString(),
            fileName: meta?.fileName || null,
            aggregates: bank.quarters[quarterKey]?.aggregates || null
        };
        if (bank.quarters[quarterKey].status !== 'banked') {
            bank.activeQuarter = quarterKey;
            bank.quarters[quarterKey].status = 'active';
        }
        return bank;
    }

    function overwriteActiveQuarter(bank, quarterKey, rows, meta) {
        if (!bank || !quarterKey) return bank;
        bank.quarters = bank.quarters || {};
        bank._sessionRows = bank._sessionRows || {};
        if (bank.quarters[quarterKey]?.status === 'banked') {
            throw new Error(`Quarter ${quarterKey} is banked. Re-open it before overwriting.`);
        }
        bank._sessionRows[quarterKey] = rows || [];
        bank.quarters[quarterKey] = {
            status: 'active',
            rows: rows || [],
            rowCount: (rows || []).length,
            uploadedAt: new Date().toISOString(),
            fileName: meta?.fileName || null,
            aggregates: null
        };
        bank.activeQuarter = quarterKey;
        return bank;
    }

    function bankQuarter(bank, quarterKey) {
        if (!bank?.quarters?.[quarterKey]) return bank;
        bank.quarters[quarterKey].status = 'banked';
        bank.quarters[quarterKey].bankedAt = new Date().toISOString();
        if (bank.activeQuarter === quarterKey) {
            const next = Object.keys(bank.quarters).find(qk => bank.quarters[qk].status === 'active' && qk !== quarterKey);
            bank.activeQuarter = next || null;
        }
        return bank;
    }

    function reopenQuarter(bank, quarterKey) {
        if (!bank?.quarters?.[quarterKey]) return bank;
        bank.quarters[quarterKey].status = 'active';
        bank.activeQuarter = quarterKey;
        return bank;
    }

    function getQuarterRows(bank, quarterKey) {
        if (!bank) return [];
        if (bank._sessionRows?.[quarterKey]?.length) return bank._sessionRows[quarterKey];
        return bank.quarters?.[quarterKey]?.rows || [];
    }

    function getCombinedRows(bank) {
        if (!bank?.quarters) return [];
        const out = [];
        Object.keys(bank.quarters).sort().forEach(qk => {
            const slot = bank.quarters[qk];
            if (!slot || slot.status === 'empty') return;
            const rows = getQuarterRows(bank, qk);
            rows.forEach(r => out.push(r));
        });
        return out;
    }

    function listQuarterKeys(bank) {
        return Object.keys(bank?.quarters || {}).sort();
    }

    function listLocalBankArtistNames() {
        const names = new Map();
        if (typeof localStorage === 'undefined') return [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
            try {
                const parsed = JSON.parse(localStorage.getItem(key));
                const artistKey = String(parsed?.artistKey || '').trim();
                if (!artistKey) continue;
                names.set(slugifyArtistKey(artistKey), artistKey);
            } catch (_err) { /* skip corrupt entries */ }
        }
        return Array.from(names.values()).sort((a, b) => a.localeCompare(b));
    }

    function setQuarterAggregates(bank, quarterKey, aggregates) {
        if (!bank?.quarters?.[quarterKey]) return bank;
        bank.quarters[quarterKey].aggregates = aggregates;
        return bank;
    }

    function buildBankSummary(bank) {
        const keys = listQuarterKeys(bank);
        const banked = keys.filter(qk => bank.quarters[qk].status === 'banked');
        const active = keys.filter(qk => bank.quarters[qk].status === 'active');
        return {
            bankedQuarters: banked,
            activeQuarter: bank.activeQuarter || (active[0] || null),
            totalRows: getCombinedRows(bank).length
        };
    }

    function restoreSessionRows(bank, quarterKey, rows) {
        if (!bank) return bank;
        bank._sessionRows = bank._sessionRows || {};
        if (rows?.length) bank._sessionRows[quarterKey] = rows;
        if (bank.quarters?.[quarterKey]) {
            bank.quarters[quarterKey].rows = rows || bank.quarters[quarterKey].rows || [];
            bank.quarters[quarterKey].rowCount = (bank.quarters[quarterKey].rows || []).length;
        }
        return bank;
    }

    global.RepQuarterBank = {
        slugifyArtistKey,
        quarterKeyFromDate,
        quarterBounds,
        quarterLabel,
        getRowDay,
        parseRowDayToIso,
        detectQuarterFromRows,
        splitRowsByQuarter,
        ingestRowsIntoBank,
        createEmptyBank,
        loadBank,
        saveBank,
        setQuarterRows,
        overwriteActiveQuarter,
        bankQuarter,
        reopenQuarter,
        getQuarterRows,
        getCombinedRows,
        listQuarterKeys,
        listLocalBankArtistNames,
        setQuarterAggregates,
        buildBankSummary,
        restoreSessionRows,
        persistQuarterRowsLocal,
        hydrateBankRowsLocal,
        persistAllBankRowsLocal,
        countQuarterRowsLocal,
        verifyQuarterRowsLocal
    };
})(typeof window !== 'undefined' ? window : globalThis);
