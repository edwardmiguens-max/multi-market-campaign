/**
 * Supabase persistence for V2 quarter bank.
 * Stores CSV rows in chunked JSONB; overwrites active quarter only.
 */
(function (global) {
    'use strict';

    const CHUNK_SIZE = 1500;
    const INSERT_BATCH = 4;

    function getClient() {
        if (global.__reportSupabaseClient) return global.__reportSupabaseClient;
        if (typeof global.getSupabaseClient === 'function') return global.getSupabaseClient();
        return null;
    }

    function isMissingTableError(err) {
        const msg = String(err?.message || err?.details || err || '').toLowerCase();
        const code = String(err?.code || '');
        return code === '42P01' || code === 'PGRST205' || msg.includes('does not exist') || msg.includes('could not find the table');
    }

    async function probeTables(client) {
        if (!client) return { ok: false, reason: 'no_client' };
        const { error } = await client.from('artists').select('id').limit(1);
        if (error) {
            if (isMissingTableError(error)) return { ok: false, reason: 'tables_missing' };
            return { ok: false, reason: error.message || 'probe_failed' };
        }
        return { ok: true };
    }

    async function ensureArtist(client, artistName, recordLabel) {
        const artistKey = global.RepQuarterBank.slugifyArtistKey(artistName);
        const { data, error } = await client.from('artists').upsert({
            artist_key: artistKey,
            artist_name: artistName,
            record_label: recordLabel || null,
            updated_at: new Date().toISOString()
        }, { onConflict: 'artist_key' }).select('id, artist_key, artist_name, active_quarter').single();
        if (error) throw error;
        return data;
    }

    function mapQuartersToBank(bank, quarters) {
        (quarters || []).forEach(q => {
            bank.quarters[q.quarter_key] = {
                status: q.status || 'active',
                rowCount: q.row_count || 0,
                uploadedAt: q.uploaded_at || null,
                bankedAt: q.banked_at || null,
                fileName: q.file_name || null
            };
        });
    }

    async function loadBankFromSupabase(artistName, recordLabel) {
        const client = getClient();
        if (!client) throw new Error('Supabase client not ready.');
        const artist = await ensureArtist(client, artistName, recordLabel);
        const { data: quarters, error } = await client
            .from('artist_quarters')
            .select('quarter_key, status, row_count, file_name, uploaded_at, banked_at')
            .eq('artist_id', artist.id)
            .order('quarter_key');
        if (error) throw error;

        const bank = global.RepQuarterBank.createEmptyBank(artistName);
        bank.artistId = artist.id;
        bank.activeQuarter = artist.active_quarter || null;
        bank._supabase = true;
        bank._sessionRows = {};
        mapQuartersToBank(bank, quarters);
        return bank;
    }

    async function loadQuarterRows(client, artistId, quarterKey) {
        const { data, error } = await client
            .from('artist_quarter_chunks')
            .select('chunk_index, rows')
            .eq('artist_id', artistId)
            .eq('quarter_key', quarterKey)
            .order('chunk_index', { ascending: true });
        if (error) throw error;
        const out = [];
        (data || []).forEach(chunk => {
            if (Array.isArray(chunk.rows)) chunk.rows.forEach(r => out.push(r));
        });
        return out;
    }

    async function hydrateBankRows(bank, options) {
        if (!bank?.artistId) return bank;
        const client = getClient();
        if (!client) throw new Error('Supabase client not ready.');
        const quarterKeysOpt = options?.quarterKeys || null;
        const onlyQuarter = options?.quarterKey || null;
        const keys = quarterKeysOpt?.length
            ? quarterKeysOpt
            : onlyQuarter
                ? [onlyQuarter]
                : global.RepQuarterBank.listQuarterKeys(bank);
        bank._sessionRows = bank._sessionRows || {};
        for (const qk of keys) {
            if (bank._sessionRows[qk]?.length) continue;
            const rows = await loadQuarterRows(client, bank.artistId, qk);
            bank._sessionRows[qk] = rows;
            if (bank.quarters[qk]) {
                bank.quarters[qk].rows = rows;
                bank.quarters[qk].rowCount = rows.length;
            }
        }
        return bank;
    }

    async function saveQuarterRows(bank, quarterKey, rows, meta) {
        if (!bank?.artistId) throw new Error('Artist not synced to Supabase yet.');
        const client = getClient();
        if (!client) throw new Error('Supabase client not ready.');

        const { data: existing, error: readErr } = await client
            .from('artist_quarters')
            .select('status')
            .eq('artist_id', bank.artistId)
            .eq('quarter_key', quarterKey)
            .maybeSingle();
        if (readErr) throw readErr;
        if (existing?.status === 'banked') {
            throw new Error(`Quarter ${quarterKey} is banked in Supabase. Re-open it before overwriting.`);
        }

        const { error: delErr } = await client
            .from('artist_quarter_chunks')
            .delete()
            .eq('artist_id', bank.artistId)
            .eq('quarter_key', quarterKey);
        if (delErr) throw delErr;

        const chunks = [];
        for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
            chunks.push({
                artist_id: bank.artistId,
                quarter_key: quarterKey,
                chunk_index: Math.floor(i / CHUNK_SIZE),
                rows: rows.slice(i, i + CHUNK_SIZE)
            });
        }
        for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
            const batch = chunks.slice(i, i + INSERT_BATCH);
            const { error: insErr } = await client.from('artist_quarter_chunks').insert(batch);
            if (insErr) throw insErr;
        }

        const now = new Date().toISOString();
        const { error: qErr } = await client.from('artist_quarters').upsert({
            artist_id: bank.artistId,
            quarter_key: quarterKey,
            status: 'active',
            row_count: rows.length,
            file_name: meta?.fileName || null,
            uploaded_at: now
        }, { onConflict: 'artist_id,quarter_key' });
        if (qErr) throw qErr;

        const { error: aErr } = await client.from('artists').update({
            active_quarter: quarterKey,
            updated_at: now
        }).eq('id', bank.artistId);
        if (aErr) throw aErr;

        bank.activeQuarter = quarterKey;
        bank._sessionRows = bank._sessionRows || {};
        bank._sessionRows[quarterKey] = rows;
        bank.quarters[quarterKey] = {
            status: 'active',
            rows,
            rowCount: rows.length,
            uploadedAt: now,
            fileName: meta?.fileName || null,
            bankedAt: bank.quarters[quarterKey]?.bankedAt || null
        };
        global.RepQuarterBank.saveBank(bank);
        return bank;
    }

    async function setQuarterStatus(bank, quarterKey, status) {
        if (!bank?.artistId) throw new Error('Artist not synced to Supabase yet.');
        const client = getClient();
        if (!client) throw new Error('Supabase client not ready.');

        const updates = { status };
        if (status === 'banked') updates.banked_at = new Date().toISOString();
        if (status === 'active') updates.banked_at = null;

        const { error } = await client
            .from('artist_quarters')
            .update(updates)
            .eq('artist_id', bank.artistId)
            .eq('quarter_key', quarterKey);
        if (error) throw error;

        if (status === 'active') {
            await client.from('artists').update({
                active_quarter: quarterKey,
                updated_at: new Date().toISOString()
            }).eq('id', bank.artistId);
            bank.activeQuarter = quarterKey;
        } else if (status === 'banked' && bank.activeQuarter === quarterKey) {
            const next = global.RepQuarterBank.listQuarterKeys(bank)
                .find(qk => qk !== quarterKey && bank.quarters[qk]?.status === 'active');
            bank.activeQuarter = next || null;
            await client.from('artists').update({
                active_quarter: bank.activeQuarter,
                updated_at: new Date().toISOString()
            }).eq('id', bank.artistId);
        }

        if (bank.quarters[quarterKey]) {
            bank.quarters[quarterKey].status = status;
            if (status === 'banked') bank.quarters[quarterKey].bankedAt = updates.banked_at;
        }
        global.RepQuarterBank.saveBank(bank);
        return bank;
    }

    async function saveArtistRollup(bank, rollup) {
        if (!bank?.artistId || !rollup) return;
        const client = getClient();
        if (!client) return;
        const summary = global.RepQuarterBank.buildBankSummary(bank);
        await client.from('artist_rollups').upsert({
            artist_id: bank.artistId,
            rollup,
            banked_quarters: summary.bankedQuarters,
            active_quarter: summary.activeQuarter,
            updated_at: new Date().toISOString()
        }, { onConflict: 'artist_id' });
    }

    async function listArtists(client) {
        if (!client) return [];
        const { data, error } = await client
            .from('artists')
            .select('artist_name, artist_key, record_label, updated_at')
            .order('artist_name', { ascending: true });
        if (error) throw error;
        return data || [];
    }

    function normalizeSkuEntry(entry) {
        const sku = String(entry?.sku || '').trim();
        if (!sku) return null;
        return {
            sku,
            product_title: String(entry.product_title || '').trim(),
            variant_title: String(entry.variant_title || '').trim(),
            product_type: String(entry.product_type || '').trim() || null,
            artist_name: String(entry.artist_name || '').trim() || null,
            record_label: String(entry.record_label || '').trim() || null
        };
    }

    async function upsertProductSkus(entries) {
        const rows = (entries || []).map(normalizeSkuEntry).filter(Boolean);
        if (!rows.length) return { added: 0, seen: 0, total: null };
        const client = getClient();
        if (!client) throw new Error('Supabase client not ready.');

        const { data: rpcData, error: rpcError } = await client.rpc('upsert_product_skus', { entries: rows });
        if (!rpcError) {
            const result = rpcData && typeof rpcData === 'object' ? rpcData : {};
            return {
                added: Number(result.added) || 0,
                seen: Number(result.seen) || rows.length,
                total: result.total == null ? null : Number(result.total)
            };
        }
        if (!isMissingTableError(rpcError) && !String(rpcError.message || '').toLowerCase().includes('could not find the function')) {
            throw rpcError;
        }

        const skus = rows.map(r => r.sku);
        const { data: existingRows, error: existingErr } = await client
            .from('product_skus')
            .select('sku')
            .in('sku', skus);
        if (existingErr) throw existingErr;
        const existing = new Set((existingRows || []).map(r => r.sku));
        const { error: upsertErr } = await client.from('product_skus').upsert(rows, { onConflict: 'sku' });
        if (upsertErr) throw upsertErr;
        const added = rows.filter(r => !existing.has(r.sku)).length;
        const { count } = await client.from('product_skus').select('sku', { count: 'exact', head: true });
        return { added, seen: rows.length, total: count };
    }

    global.RepQuarterBankSupabase = {
        CHUNK_SIZE,
        getClient,
        isMissingTableError,
        probeTables,
        ensureArtist,
        listArtists,
        loadBankFromSupabase,
        loadQuarterRows,
        hydrateBankRows,
        saveQuarterRows,
        setQuarterStatus,
        saveArtistRollup,
        upsertProductSkus
    };
})(typeof window !== 'undefined' ? window : globalThis);
