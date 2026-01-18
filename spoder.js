/*
  Spoder - Console (formatted)
  - All text messages are collected in MSG at the top for easy editing
  - Usage: paste into the console on https://open.spotify.com and it runs automatically
  - Exposes window.SpoderConsole with methods: runNow(), diag(), stop()
*/

(function () {
    'use strict';

    // -----------------------
    // Config & messages (edit here) 📝
    // -----------------------
    const CONFIG = {
        CSV_URL: 'https://raw.githubusercontent.com/cor-bee/spoder/refs/heads/main/SpotifyRussianArtists.csv',
        MAX_BATCH: 20,
        MAX_RETRIES: 2,
        BACKOFF_MS: 500,
        POLL_MS: 2000,
        POLL_MAX: 15
    };

    const MSG = {
        LOADED: '✂️ Spoder запущено!',
        CSV_LOADING: '🔄 Spoder: завантажую CSV...',
        CSV_LOAD_ERROR: '❌ Spoder: не вдалося завантажити CSV',
        CSV_LOADED: n => `✅ Spoder: завантажено ${n} артистів`,
        TOKEN_FOUND_LOCAL: '🔐 Spoder: дані клієнта узято з localStorage',
        TOKEN_CAPTURED_FETCH: '🛰️ Spoder: дані клієнта отримано (fetch)',
        TOKEN_CAPTURED_XHR: '🛰️ Spoder: дані клієнта отримано (XHR)',
        POLL_START: '🔎 Spoder: отримання даних клієнта...',
        POLL_NOT_FOUND: '❌ Spoder: не вдалося отримати дані клієнта',
        TOKEN_FOUND_AND_RUN: '🚀 Spoder: дані клієнта отримано! Початок роботи...',
        NO_TOKEN_OR_USER: '⚠️ Spoder: немає даних клієнта або користувача',
        BLOCKING_PROGRESS: (pct, _done, _total) => `📊 Spoder: поступ ${pct}%`,
        ALL_BLOCKED: '✅ Spoder: усі артисти зі списку вже заблоковані! ✅',
        SUCCESS_SUMMARY: n => `🎉 Spoder: успішно заблоковано ${n} артистів. ✅`,
        FINISH_NO_NEW: 'ℹ️ Spoder: завершено, нічого нового не було заблоковано',
        MAIN_ERROR: '❌ Spoder: помилка в основному процесі',
        STOPPED: '⏹️ Spoder: зупинено'
    };

    console.info(MSG.LOADED);

    // -----------------------
    // Internal state
    // -----------------------
    const S = {
        hasRun: false,
        auth: null, // Bearer token / client data
        pollAttempts: 0,
        pollId: null,
        blocked: new Set()
    };

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // -----------------------
    // CSV utils
    // -----------------------
    async function fetchWithRetries(url, retries = CONFIG.MAX_RETRIES) {
        let attempt = 0;
        while (attempt <= retries) {
            try {
                const res = await fetch(url, { cache: 'no-cache' });
                if (res.ok) return res;
                throw new Error('Статус ' + res.status);
            } catch (err) {
                attempt++;
                const back = CONFIG.BACKOFF_MS * Math.pow(2, attempt - 1);
                console.warn('⚠️ Spoder: помилка завантаження (' + attempt + ')', err.message);
                if (attempt > retries) throw err;
                await sleep(back + Math.random() * 200);
            }
        }
    }

    async function fetchArtists() {
        console.info(MSG.CSV_LOADING);
        try {
            const res = await fetchWithRetries(CONFIG.CSV_URL);
            const text = await res.text();
            const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            if (!lines.length) return [];
            // detect header
            let dataLines = lines;
            const first = lines[0].toLowerCase();
            if (first.includes('artist') || first.includes('spotify_id') || first.includes('name') || first.includes('id')) {
                dataLines = lines.slice(1);
            }
            const out = [];
            for (const l of dataLines) {
                const m = l.replace(/\uFEFF/g, '').trim();
                const idx = m.lastIndexOf(',');
                if (idx < 0) continue;
                const name = m.slice(0, idx).replace(/^"|"$/g, '').trim();
                const id = m.slice(idx + 1).replace(/^"|"$/g, '').trim();
                if (name && id) out.push({ name, id });
            }
            console.info(MSG.CSV_LOADED(out.length));
            return out;
        } catch (_e) {
            console.error(MSG.CSV_LOAD_ERROR, _e);
            return [];
        }
    }

    // -----------------------
    // Local storage (blocked list)
    // -----------------------
    function loadBlocked() {
        try {
            const arr = JSON.parse(localStorage.getItem('spoderBlockedArtists') || '[]');
            arr.forEach(id => S.blocked.add(id));
            return arr;
        } catch (_e) {
            console.warn('⚠️ Spoder: не вдалося прочитати список блокованих', _e);
            return [];
        }
    }

    function saveBlocked() {
        try {
            localStorage.setItem('spoderBlockedArtists', JSON.stringify([...S.blocked]));
        } catch (_e) {
            console.warn('⚠️ Spoder: не вдалося зберегти список', _e);
        }
    }

    // -----------------------
    // Helpers
    // -----------------------
    function getUser() {
        try {
            return Object.keys(localStorage).find(k => k.includes(':') && !k.startsWith('anonymous:'))?.split(':')[0] || null;
        } catch (_e) {
            return null;
        }
    }

    // -----------------------
    // Blocking logic
    // -----------------------
    async function blockBatch(ids) {
        const user = getUser();
        if (!S.auth || !user) {
            console.warn(MSG.NO_TOKEN_OR_USER);
            return false;
        }
        for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
            try {
                const res = await fetch('https://spclient.wg.spotify.com/collection/v2/write?market=from_token', {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'authorization': S.auth
                    },
                    body: JSON.stringify({ username: user, set: 'artistban', items: ids.map(id => ({ uri: `spotify:artist:${id}` })) })
                });
                if (res.ok) return true;
                if (res.status === 401) {
                    console.warn('⚠️ Spoder: 401 — очищую дані клієнта');
                    localStorage.removeItem('spotifyAccessToken');
                    S.auth = null;
                    return false;
                }
                throw new Error('Статус ' + res.status);
            } catch (_e) {
                console.warn('⚠️ Spoder: помилка при блокуванні (' + (attempt + 1) + ')', _e.message);
                if (attempt === CONFIG.MAX_RETRIES) return false;
                const back = CONFIG.BACKOFF_MS * Math.pow(2, attempt);
                await sleep(back + Math.random() * 200);
            }
        }
        return false;
    }

    async function runMain() {
        try {
            if (S.hasRun) return; // silence repeated runs
            S.hasRun = true;

            const artists = await fetchArtists();
            if (!artists.length) return;

            loadBlocked();
            const todo = artists.filter(a => !S.blocked.has(a.id));
            console.info(`🔧 Spoder: ${artists.length} загалом; ${todo.length} для блокування`);

            if (!todo.length) {
                console.info(MSG.ALL_BLOCKED);
                return;
            }

            let done = 0;
            const total = todo.length;
            const thresholds = [1, 5, 10, 20, 50, 90];
            const reported = new Set();

            for (let i = 0; i < todo.length; i += CONFIG.MAX_BATCH) {
                const ids = todo.slice(i, i + CONFIG.MAX_BATCH).map(x => x.id);
                const ok = await blockBatch(ids);
                if (ok) {
                    ids.forEach(id => S.blocked.add(id));
                    done += ids.length;
                    saveBlocked();

                    const pct = Math.floor((done * 100) / total);
                    for (const t of thresholds) {
                        if (pct >= t && !reported.has(t)) {
                            console.info(MSG.BLOCKING_PROGRESS(t, done, total));
                            reported.add(t);
                        }
                    }
                } else {
                    console.warn('⚠️ Spoder: не вдалося заблокувати пакет', ids);
                }
                await sleep(300 + Math.random() * 300);
            }

            if (done) {
                console.info(MSG.SUCCESS_SUMMARY(done));
            } else console.info(MSG.FINISH_NO_NEW);
        } catch (_e) {
            console.error(MSG.MAIN_ERROR, _e);
        }
    }

    // -----------------------
    // Client data capture & receiving
    // -----------------------
    function tryLocal() {
        try {
            const t = localStorage.getItem('spotifyAccessToken');
            if (t) {
                if (!S.auth) console.info(MSG.TOKEN_FOUND_LOCAL);
                S.auth = t.startsWith('Bearer') ? t : `Bearer ${t}`;
                return true;
            }
            return false;
        } catch (_e) {
            console.warn('⚠️ Spoder: помилка читання даних клієнта', _e);
            return false;
        }
    }

    function wrapFetch() {
        try {
            const original = window.fetch;
            window.fetch = function (...args) {
                try {
                    const [input, init] = args;
                    let found = null;
                    if (init && init.headers && init.headers.authorization) found = init.headers.authorization;
                    else if (input && input.headers && typeof input.headers.get === 'function') {
                        const h = input.headers.get('authorization');
                        if (h) found = h;
                    }
                    if (found && !S.auth) {
                        S.auth = found;
                        console.info(MSG.TOKEN_CAPTURED_FETCH);
                        stopPoll();
                        runMain();
                    }
                } catch (_e) {
                    /* ignore */
                }
                return original.apply(this, args);
            };
        } catch (_e) {
            console.warn('⚠️ Spoder: не вдалося обгорнути fetch', _e);
        }
    }

    function wrapXHR() {
        try {
            const orig = XMLHttpRequest.prototype.setRequestHeader;
            XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
                try {
                    if (name && name.toLowerCase() === 'authorization' && !S.auth) {
                        S.auth = value;
                        console.info(MSG.TOKEN_CAPTURED_XHR);
                        stopPoll();
                        runMain();
                    }
                } catch (_e) {
                    /* ignore */
                }
                return orig.apply(this, arguments);
            };
        } catch (_e) {
            console.warn('⚠️ Spoder: не вдалося обгорнути XHR', _e);
        }
    }

    function startPoll() {
        if (S.pollId) return;
        console.info(MSG.POLL_START);
        S.pollId = setInterval(() => {
            S.pollAttempts++;
            if (S.auth || tryLocal() || S.pollAttempts >= CONFIG.POLL_MAX) {
                clearInterval(S.pollId);
                S.pollId = null;
                if (S.auth || tryLocal()) {
                    console.info(MSG.TOKEN_FOUND_AND_RUN);
                    runMain();
                } else {
                    console.info(MSG.POLL_NOT_FOUND);
                }
            }
        }, CONFIG.POLL_MS);
    }

    function stopPoll() {
        if (S.pollId) {
            clearInterval(S.pollId);
            S.pollId = null;
        }
    }

    // -----------------------
    // Public API & auto-start
    // -----------------------
    const API = {
        runNow: runMain,
        diag: () => ({ auth: !!S.auth, hasRun: S.hasRun, blocked: S.blocked.size, pollAttempts: S.pollAttempts }),
        stop: () => { stopPoll(); console.info(MSG.STOPPED); }
    };

    window.SpoderConsole = API;

    // initialize
    wrapFetch();
    wrapXHR();
    if (tryLocal()) runMain(); else startPoll();

})();
