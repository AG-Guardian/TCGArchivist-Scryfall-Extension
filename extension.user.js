// ==UserScript==
// @name         TCGArchivist Scryfall Collection Filter
// @namespace    https://github.com/AG-Guardian/TCGArchivist-Scryfall-Extension
// @version      1.0.0
// @description  Filter Scryfall search results to cards in your TCGArchivist collection CSV
// @author       AG-Guardian
// @match        https://scryfall.com/search*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=scryfall.com
// @homepage     https://github.com/AG-Guardian/TCGArchivist-Scryfall-Extension
// @supportURL   https://github.com/AG-Guardian/TCGArchivist-Scryfall-Extension/issues
// @updateURL    https://github.com/AG-Guardian/TCGArchivist-Scryfall-Extension/raw/main/extension.user.js
// @downloadURL  https://github.com/AG-Guardian/TCGArchivist-Scryfall-Extension/raw/main/extension.user.js
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_FILTER = 'tcgarchivist_filter_enabled';
    const STORAGE_COLLECTION = 'tcgarchivist_collection_v2';

    const PARSE_BUDGET_MS = 12;
    const DEBUG = false;

    const CARD_SELECTORS = [
        '.card-grid-item[data-card-id]',
        '.checklist-item[data-card-id]',
        '.card-text-list-item[data-card-id]',
    ].join(', ');

    /** @type {Map<string, object>|null} */
    let collectionByName = null;
    /** @type {Set<string>|null} */
    let collectionIdSet = null;
    let filterObserver = null;
    let importInProgress = false;
    let filterDebounceTimer = null;
    let detachedContainer = null;
    let debugPhase = '';
    let debugT0 = 0;

    const FULL_FILTER_PAGE_SIZE = 60;
    const API_REQUEST_DELAY_MS = 75;
    const SCORGFALL_SEARCH_API = 'https://api.scryfall.com/cards/search';

    let fullFilterActive = false;
    let fullFilterInProgress = false;
    let filterApplyInProgress = false;
    /** @type {{ cacheKey: string, printsMode: boolean, items: object[], scryfallTotal: number } | null} */
    let fullFilterCache = null;
    let fullFilterFetchId = 0;
    let paginationSnapshotStored = false;

    const yieldToMain = () => new Promise((resolve) => setTimeout(resolve, 0));

    function debugStart(phase, details) {
        debugPhase = phase;
        debugT0 = performance.now();
        if (!DEBUG) {
            return;
        }
        const extra = details ? ` ${JSON.stringify(details)}` : '';
        console.log(`[TCGArchivist] ▶ ${phase} — START${extra}`);
    }

    function debugLog(step, details) {
        if (!DEBUG) {
            return;
        }
        const elapsed = (performance.now() - debugT0).toFixed(1);
        const extra = details ? ` ${JSON.stringify(details)}` : '';
        console.log(`[TCGArchivist]   ${debugPhase} +${elapsed}ms — ${step}${extra}`);
    }

    function debugEnd(phase, details) {
        if (!DEBUG) {
            return;
        }
        const elapsed = (performance.now() - debugT0).toFixed(1);
        const extra = details ? ` ${JSON.stringify(details)}` : '';
        console.log(`[TCGArchivist] ✓ ${phase || debugPhase} — DONE in ${elapsed}ms${extra}`);
    }

    function readStoredCollection() {
        return GM_getValue(STORAGE_COLLECTION, null);
    }

    function writeStoredCollection(payload) {
        debugLog('writeStoredCollection: before', { payloadChars: payload.length });
        const t0 = performance.now();
        GM_setValue(STORAGE_COLLECTION, payload);
        debugLog('writeStoredCollection: after', {
            durationMs: (performance.now() - t0).toFixed(1),
        });
    }

    function readFilterEnabled() {
        const value = GM_getValue(STORAGE_FILTER, false);
        return value === true || value === 'true';
    }

    function isFilterEnabled() {
        return readFilterEnabled();
    }

    function writeFilterEnabled(enabled) {
        GM_setValue(STORAGE_FILTER, enabled);
    }

    function setFilterEnabled(enabled) {
        writeFilterEnabled(enabled);
    }

    function normalizeName(name) {
        return name
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/[''']/g, "'");
    }

    function slugifyCardName(name) {
        const front = name.split('//')[0].trim();
        return front
            .toLowerCase()
            .normalize('NFD')
            .replace(/\p{M}/gu, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    function imageUrlForScryfallId(scryfallId) {
        const id = scryfallId.toLowerCase();
        if (!id || id.length < 2) {
            return null;
        }
        return `https://cards.scryfall.io/normal/front/${id[0]}/${id[1]}/${id}.jpg`;
    }

    function cardUrlForEntry(entry) {
        const slug = slugifyCardName(entry.n);
        return `https://scryfall.com/card/${entry.s}/${entry.c}/${slug}`;
    }

    function formatPrintingLabel(entry) {
        const set = (entry.s || '').toUpperCase();
        const num = entry.c || '?';
        return `${set} #${num}`;
    }

    function isUniquePrintsSearch() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('unique') === 'prints') {
            return true;
        }

        const uniqueSelect = document.querySelector('select[name="unique"]');
        if (uniqueSelect && uniqueSelect.value === 'prints') {
            return true;
        }

        const qField =
            document.getElementById('header-search-field') || document.getElementById('q');
        const query = qField ? qField.value : '';
        return /\bunique:prints\b/i.test(query);
    }

    function rebuildCollectionIdSet() {
        collectionIdSet = new Set();
        if (!collectionByName) {
            return collectionIdSet;
        }
        for (const entry of collectionByName.values()) {
            collectionIdSet.add(entry.i);
            if (entry.alt) {
                for (const alt of entry.alt) {
                    collectionIdSet.add(alt.i);
                }
            }
        }
        return collectionIdSet;
    }

    function getCollectionIdSet() {
        if (!collectionIdSet) {
            rebuildCollectionIdSet();
        }
        return collectionIdSet;
    }

    function formatCollectionPrintingsBadgeTitle(entry) {
        const parts = getPrintingsForEntry(entry).map((printing) => {
            let label = formatPrintingLabel(printing);
            if (printing.f && printing.f !== 'normal') {
                label += ` (${printing.f})`;
            }
            return label;
        });
        return `In collection: ${parts.join(', ')}`;
    }

    function formatCollectionPrintingsBadge(entry) {
        const printings = getPrintingsForEntry(entry);
        if (printings.length > 1) {
            return `${printings.length} printings in collection`;
        }
        const printing = printings[0];
        let label = formatPrintingLabel(printing);
        if (printing.f && printing.f !== 'normal') {
            label += ` (${printing.f})`;
        }
        return `In collection: ${label}`;
    }

    function removeCollectionBadge(item) {
        const badge = item.querySelector('.tcga-print-badge');
        if (badge) {
            badge.remove();
        }
    }

    function ensureCollectionBadge(item, entry) {
        let badge = item.querySelector('.tcga-print-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'tcga-print-badge';
            item.appendChild(badge);
        }
        badge.textContent = formatCollectionPrintingsBadge(entry);
        badge.title = formatCollectionPrintingsBadgeTitle(entry);
    }

    function collectionFromPayload(payload) {
        const data = JSON.parse(payload);
        const map = new Map();
        if (!Array.isArray(data)) {
            return map;
        }
        for (const entry of data) {
            if (!entry || !entry.n) {
                continue;
            }
            map.set(normalizeName(entry.n), entry);
        }
        return map;
    }

    function collectionToPayload(map) {
        return JSON.stringify(Array.from(map.values()));
    }

    function parseCsvToCollection(text, onProgress) {
        return new Promise((resolve, reject) => {
            const byName = new Map();
            let nameIndex = -1;
            let setIndex = -1;
            let collectorIndex = -1;
            let finishIndex = -1;
            let idIndex = -1;
            let row = [];
            let field = '';
            let i = 0;
            let inQuotes = false;
            let rowCount = 0;
            let dataRowCount = 0;
            const estimatedRows = Math.max(1, (text.match(/\n/g) || []).length);

            const finishRow = () => {
                if (rowCount === 0) {
                    const header = row.map((h) => h.trim().toLowerCase());
                    nameIndex = header.indexOf('name');
                    setIndex = header.indexOf('set code');
                    collectorIndex = header.indexOf('collector number');
                    finishIndex = header.indexOf('finish');
                    idIndex = header.indexOf('scryfall id');
                    if (nameIndex === -1 || idIndex === -1) {
                        reject(new Error('CSV missing "Name" or "Scryfall ID" column'));
                        return false;
                    }
                } else {
                    const name = (row[nameIndex] || '').trim();
                    const scryfallId = (row[idIndex] || '').trim().toLowerCase();
                    if (!name || !scryfallId) {
                        rowCount += 1;
                        row = [];
                        return true;
                    }

                    const key = normalizeName(name);
                    const entry = {
                        n: name,
                        i: scryfallId,
                        s: (row[setIndex] || '').trim().toLowerCase(),
                        c: (row[collectorIndex] || '').trim(),
                        f: (row[finishIndex] || '').trim().toLowerCase(),
                    };

                    const existing = byName.get(key);
                    if (!existing) {
                        entry.alt = [];
                        byName.set(key, entry);
                    } else {
                        if (!existing.alt) {
                            existing.alt = [
                                {
                                    i: existing.i,
                                    s: existing.s,
                                    c: existing.c,
                                    f: existing.f,
                                },
                            ];
                        }
                        existing.alt.push({
                            i: entry.i,
                            s: entry.s,
                            c: entry.c,
                            f: entry.f,
                        });
                    }

                    dataRowCount += 1;
                }

                rowCount += 1;
                row = [];
                return true;
            };

            const reportProgress = () => {
                onProgress({
                    percent: Math.min(92, Math.round((dataRowCount / estimatedRows) * 92)),
                    rows: dataRowCount,
                    names: byName.size,
                });
            };

            const processChunk = () => {
                try {
                    const deadline = performance.now() + PARSE_BUDGET_MS;

                    while (i < text.length && performance.now() < deadline) {
                        const ch = text[i];

                        if (inQuotes) {
                            if (ch === '"') {
                                if (text[i + 1] === '"') {
                                    field += '"';
                                    i += 2;
                                    continue;
                                }
                                inQuotes = false;
                                i += 1;
                                continue;
                            }
                            field += ch;
                            i += 1;
                            continue;
                        }

                        if (ch === '"') {
                            inQuotes = true;
                            i += 1;
                            continue;
                        }
                        if (ch === ',') {
                            row.push(field);
                            field = '';
                            i += 1;
                            continue;
                        }
                        if (ch === '\r') {
                            i += 1;
                            continue;
                        }
                        if (ch === '\n') {
                            row.push(field);
                            field = '';
                            i += 1;
                            if (row.some((cell) => cell.length > 0)) {
                                if (!finishRow()) {
                                    return;
                                }
                            }
                            continue;
                        }

                        field += ch;
                        i += 1;
                    }

                    if (i < text.length) {
                        reportProgress();
                        requestAnimationFrame(processChunk);
                        return;
                    }

                    if (field.length > 0 || row.length > 0) {
                        row.push(field);
                        if (row.some((cell) => cell.length > 0)) {
                            if (!finishRow()) {
                                return;
                            }
                        }
                    }

                    onProgress({ percent: 100, rows: dataRowCount, names: byName.size });
                    resolve(byName);
                } catch (err) {
                    reject(err);
                }
            };

            processChunk();
        });
    }

    async function saveCollection(map) {
        collectionByName = map;
        invalidateFullFilterCache();
        rebuildCollectionIdSet();
        await yieldToMain();
        const payload = collectionToPayload(map);
        await yieldToMain();
        try {
            writeStoredCollection(payload);
        } catch (err) {
            const quota =
                err &&
                (err.name === 'QuotaExceededError' ||
                    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
                    err.code === 22);
            if (quota) {
                throw new Error(
                    'Storage is full. Clear Tampermonkey storage for this script, then import again.'
                );
            }
            throw err;
        }
    }

    async function loadCollection() {
        if (collectionByName) {
            return collectionByName;
        }

        const raw = readStoredCollection();
        if (raw) {
            try {
                collectionByName = collectionFromPayload(raw);
                rebuildCollectionIdSet();
                return collectionByName;
            } catch (err) {
                console.warn('[TCGArchivist] Could not parse stored collection:', err);
            }
        }

        collectionByName = new Map();
        return collectionByName;
    }

    function getResultItems() {
        return document.querySelectorAll(CARD_SELECTORS);
    }

    function getDetachedContainer() {
        if (!detachedContainer) {
            detachedContainer = document.createElement('div');
            detachedContainer.id = 'tcga-detached-cards';
            detachedContainer.hidden = true;
            document.body.appendChild(detachedContainer);
        }
        return detachedContainer;
    }

    function getGridItems() {
        return document.querySelectorAll(
            '.card-grid-inner .card-grid-item[data-card-id]:not([data-tcga-injected="true"])'
        );
    }

    function getPrintingsForEntry(entry) {
        const printings = [{ n: entry.n, i: entry.i, s: entry.s, c: entry.c, f: entry.f }];
        if (entry.alt) {
            for (const alt of entry.alt) {
                printings.push({ n: entry.n, i: alt.i, s: alt.s, c: alt.c, f: alt.f });
            }
        }
        return printings;
    }

    function clearInjectedItems() {
        document.querySelectorAll('[data-tcga-injected="true"]').forEach((item) => {
            item.remove();
        });
    }

    function getItemCardName(item) {
        const label = item.querySelector(
            '.card-grid-item-invisible-label, .checklist-item-invisible-label'
        );
        if (label && label.textContent) {
            return label.textContent.trim();
        }

        const link = item.querySelector('a[href*="/card/"]');
        if (link) {
            const img = link.querySelector('img');
            if (img && img.alt) {
                const match = img.alt.match(/^(.+?)\s*\(/);
                if (match) {
                    return match[1].trim();
                }
            }
        }

        return '';
    }

    function storeOriginals(item, link, img) {
        if (!item.dataset.tcgaOrigHref && link) {
            item.dataset.tcgaOrigHref = link.getAttribute('href') || link.href;
        }
        if (!item.dataset.tcgaOrigCardId) {
            item.dataset.tcgaOrigCardId = item.getAttribute('data-card-id') || '';
        }
        if (img && !item.dataset.tcgaOrigImg && img.getAttribute('src')) {
            item.dataset.tcgaOrigImg = img.getAttribute('src');
        }
        if (img && !item.dataset.tcgaOrigTitle && img.getAttribute('title')) {
            item.dataset.tcgaOrigTitle = img.getAttribute('title');
        }
        if (img && !item.dataset.tcgaOrigAlt && img.getAttribute('alt')) {
            item.dataset.tcgaOrigAlt = img.getAttribute('alt');
        }
    }

    function restoreItemContent(item) {
        const link = item.querySelector('a[href*="/card/"]');
        const img = item.querySelector('img');

        if (link && item.dataset.tcgaOrigHref) {
            link.setAttribute('href', item.dataset.tcgaOrigHref);
        }
        if (item.dataset.tcgaOrigCardId) {
            item.setAttribute('data-card-id', item.dataset.tcgaOrigCardId);
        }
        if (img && item.dataset.tcgaOrigImg) {
            img.setAttribute('src', item.dataset.tcgaOrigImg);
        }
        if (img && item.dataset.tcgaOrigTitle) {
            img.setAttribute('title', item.dataset.tcgaOrigTitle);
        }
        if (img && item.dataset.tcgaOrigAlt) {
            img.setAttribute('alt', item.dataset.tcgaOrigAlt);
        }

        removeCollectionBadge(item);
    }

    function hideItem(item) {
        item.classList.add('tcga-hidden');
        const container = getDetachedContainer();
        if (item.parentNode && item.parentNode !== container) {
            container.appendChild(item);
        }
    }

    function showItemInGrid(item, gridInner) {
        restoreItemContent(item);
        item.classList.remove('tcga-hidden');
        if (gridInner && item.parentNode !== gridInner) {
            gridInner.appendChild(item);
        }
    }

    function restoreAllToGrid() {
        const gridInner = document.querySelector('.card-grid-inner');
        const container = getDetachedContainer();
        if (!gridInner) {
            return;
        }

        while (container.firstChild) {
            gridInner.appendChild(container.firstChild);
        }

        gridInner
            .querySelectorAll('.card-grid-item[data-card-id]:not([data-tcga-injected="true"])')
            .forEach((item) => {
                restoreItemContent(item);
                item.classList.remove('tcga-hidden');
            });
    }

    function configureItemForPrinting(item, printing) {
        const link = item.querySelector('a[href*="/card/"]');
        const img = item.querySelector('img');
        const label = item.querySelector(
            '.card-grid-item-invisible-label, .checklist-item-invisible-label'
        );

        storeOriginals(item, link, img);

        item.setAttribute('data-card-id', printing.i);
        if (link) {
            link.setAttribute('href', cardUrlForEntry(printing));
        }

        const imageUrl = imageUrlForScryfallId(printing.i);
        const title = `${printing.n} (${formatPrintingLabel(printing)})`;
        if (img && imageUrl) {
            img.setAttribute('src', imageUrl);
            img.setAttribute('title', title);
            img.setAttribute('alt', title);
        }
        if (label) {
            label.textContent = printing.n;
        }

        item.classList.remove('tcga-hidden');
    }

    function invalidateFullFilterCache() {
        fullFilterCache = null;
    }

    function getSearchContext() {
        const params = new URLSearchParams(window.location.search);
        const qField = document.getElementById('header-search-field') || document.getElementById('q');
        let q = params.get('q') || '';
        if (!q && qField) {
            q = qField.value;
        }

        let unique = params.get('unique');
        if (!unique) {
            const uniqueSelect = document.querySelector('select[name="unique"]');
            if (uniqueSelect) {
                unique = uniqueSelect.value;
            }
        }
        if (!unique) {
            if (/\bunique:prints\b/i.test(q)) {
                unique = 'prints';
            } else if (/\bunique:art\b/i.test(q)) {
                unique = 'art';
            } else {
                unique = 'cards';
            }
        }

        return {
            q: q.trim(),
            unique: unique || 'cards',
            order: params.get('order') || '',
            dir: params.get('dir') || '',
            as: params.get('as') || 'grid',
            page: Math.max(1, parseInt(params.get('page') || '1', 10) || 1),
        };
    }

    function getFullFilterCacheKey(ctx) {
        const collectionSize = collectionByName ? collectionByName.size : 0;
        return [ctx.q, ctx.unique, ctx.order, ctx.dir, collectionSize].join('\0');
    }

    function buildSearchUrl(ctx) {
        const params = new URLSearchParams();
        if (ctx.q) {
            params.set('q', ctx.q);
        }
        if (ctx.as && ctx.as !== 'grid') {
            params.set('as', ctx.as);
        }
        if (ctx.order) {
            params.set('order', ctx.order);
        }
        if (ctx.dir) {
            params.set('dir', ctx.dir);
        }
        if (ctx.unique && ctx.unique !== 'cards') {
            params.set('unique', ctx.unique);
        }
        if (ctx.page > 1) {
            params.set('page', String(ctx.page));
        }
        return `/search?${params.toString()}`;
    }

    function buildScryfallApiUrl(page, ctx) {
        const params = new URLSearchParams();
        params.set('q', ctx.q);
        if (ctx.unique) {
            params.set('unique', ctx.unique);
        }
        if (ctx.order) {
            params.set('order', ctx.order);
        }
        if (ctx.dir) {
            params.set('dir', ctx.dir);
        }
        params.set('page', String(page));
        return `${SCORGFALL_SEARCH_API}?${params.toString()}`;
    }

    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function scryfallFetch(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: { Accept: 'application/json' },
                onload(resp) {
                    if (resp.status >= 200 && resp.status < 300) {
                        try {
                            resolve(JSON.parse(resp.responseText));
                        } catch (err) {
                            reject(new Error('Invalid Scryfall API response'));
                        }
                        return;
                    }
                    if (resp.status === 404) {
                        resolve({ object: 'list', data: [], total_cards: 0, has_more: false });
                        return;
                    }
                    reject(new Error(`Scryfall API error (${resp.status})`));
                },
                onerror: () => reject(new Error('Could not reach Scryfall API')),
                ontimeout: () => reject(new Error('Scryfall API request timed out')),
            });
        });
    }

    async function fetchAllScryfallResults(ctx, fetchId, onProgress) {
        const allCards = [];
        let apiPage = 1;
        let scryfallTotal = 0;
        let hasMore = true;

        while (hasMore) {
            if (fetchId !== fullFilterFetchId) {
                return null;
            }

            const url = buildScryfallApiUrl(apiPage, ctx);
            const body = await scryfallFetch(url);

            if (fetchId !== fullFilterFetchId) {
                return null;
            }

            if (body.object === 'error') {
                throw new Error(body.details || 'Scryfall search failed');
            }

            if (Array.isArray(body.data)) {
                allCards.push(...body.data);
            }

            scryfallTotal = body.total_cards ?? allCards.length;
            hasMore = Boolean(body.has_more);
            apiPage += 1;

            if (onProgress) {
                const fetched = allCards.length;
                const pct =
                    scryfallTotal > 0
                        ? Math.min(95, Math.round((fetched / scryfallTotal) * 95))
                        : Math.min(95, apiPage * 10);
                onProgress({
                    percent: pct,
                    fetched,
                    total: scryfallTotal,
                    apiPage,
                });
            }

            if (hasMore) {
                await delay(API_REQUEST_DELAY_MS);
            }
        }

        return { cards: allCards, scryfallTotal };
    }

    function getApiCardImageUrl(card) {
        if (card.image_uris && card.image_uris.normal) {
            return card.image_uris.normal;
        }
        if (card.card_faces && card.card_faces[0] && card.card_faces[0].image_uris) {
            return card.card_faces[0].image_uris.normal;
        }
        return imageUrlForScryfallId(card.id);
    }

    function apiCardHref(card) {
        const slug = slugifyCardName(card.name);
        return `https://scryfall.com/card/${card.set}/${card.collector_number}/${slug}`;
    }

    function filterApiCards(cards, printsMode, collection) {
        if (printsMode) {
            const idSet = getCollectionIdSet();
            return cards
                .filter((card) => idSet.has((card.id || '').toLowerCase()))
                .map((card) => renderModelFromApiCard(card, null, false));
        }

        const items = [];
        const seen = new Set();
        for (const card of cards) {
            const key = normalizeName(card.name);
            if (!key || seen.has(key) || !collection.has(key)) {
                continue;
            }
            seen.add(key);
            const entry = collection.get(key);
            items.push(renderModelFromApiCard(card, entry, true));
        }
        return items;
    }

    function renderModelFromApiCard(card, entry, showBadge) {
        if (showBadge && entry) {
            const primary = getPrintingsForEntry(entry)[0];
            const title = `${entry.n} (${formatPrintingLabel(primary)})`;
            return {
                id: primary.i,
                name: entry.n,
                href: cardUrlForEntry(primary),
                imageUrl: imageUrlForScryfallId(primary.i),
                title,
                alt: title,
                entry,
                showBadge: true,
            };
        }

        const setName = card.set_name || card.set || '';
        const title = `${card.name} (${setName} #${card.collector_number})`;
        return {
            id: (card.id || '').toLowerCase(),
            name: card.name,
            href: apiCardHref(card),
            imageUrl: getApiCardImageUrl(card),
            title,
            alt: title,
            entry: null,
            showBadge: false,
        };
    }

    function parkNativeGridItems(gridInner) {
        const container = getDetachedContainer();
        const items = gridInner.querySelectorAll(
            '.card-grid-item[data-card-id]:not([data-tcga-injected="true"])'
        );
        items.forEach((item) => {
            if (item.parentNode !== container) {
                container.appendChild(item);
            }
        });
    }

    function buildGridItem(model) {
        const el = document.createElement('div');
        el.className = 'card-grid-item';
        el.setAttribute('data-card-id', model.id);
        el.setAttribute('data-tcga-injected', 'true');

        const link = document.createElement('a');
        link.className = 'card-grid-item-card';
        link.href = model.href;

        const label = document.createElement('span');
        label.className = 'card-grid-item-invisible-label';
        label.setAttribute('aria-hidden', 'true');
        label.textContent = model.name;

        const faces = document.createElement('div');
        faces.className = 'card-grid-item-card-faces';

        const front = document.createElement('div');
        front.className = 'card-grid-item-card-front';

        const img = document.createElement('img');
        img.className = 'card';
        if (model.imageUrl) {
            img.src = model.imageUrl;
        }
        img.title = model.title;
        img.alt = model.alt;
        img.loading = 'lazy';

        front.appendChild(img);
        faces.appendChild(front);
        link.appendChild(label);
        link.appendChild(faces);
        el.appendChild(link);

        if (model.showBadge && model.entry) {
            ensureCollectionBadge(el, model.entry);
        }

        return el;
    }

    function storePaginationSnapshot() {
        if (paginationSnapshotStored) {
            return;
        }
        document.querySelectorAll('.search-controls-pagination').forEach((el, index) => {
            el.dataset.tcgaOrigHtml = el.innerHTML;
            el.dataset.tcgaPaginationIndex = String(index);
        });
        document.querySelectorAll('.search-info strong').forEach((el, index) => {
            el.dataset.tcgaOrigHtml = el.innerHTML;
            el.dataset.tcgaSearchInfoIndex = String(index);
        });
        paginationSnapshotStored = true;
    }

    function restorePaginationSnapshot() {
        document.querySelectorAll('.search-controls-pagination').forEach((el) => {
            if (el.dataset.tcgaOrigHtml) {
                el.innerHTML = el.dataset.tcgaOrigHtml;
                delete el.dataset.tcgaOrigHtml;
            }
        });
        document.querySelectorAll('.search-info strong').forEach((el) => {
            if (el.dataset.tcgaOrigHtml) {
                el.innerHTML = el.dataset.tcgaOrigHtml;
                delete el.dataset.tcgaOrigHtml;
            }
        });
        paginationSnapshotStored = false;
    }

    const PAGINATION_PREV_SVG =
        '<svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path d="M20.625 3l-12.625 12 12.563 12 1.437-1.406-11.094-10.594 11.094-10.562z"/></svg>';
    const PAGINATION_NEXT_SVG =
        '<svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path d="M9.375 3l12.625 12-12.562 12-1.438-1.406 11.094-10.594-11.094-10.562z"/></svg>';
    const PAGINATION_FIRST_SVG =
        '<svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path d="M18 4.438l-1.375-1.438-12.625 12 12.563 12 1.437-1.406-11.094-10.594 11.094-10.562zm12 0l-1.375-1.438-12.625 12 12.563 12 1.437-1.406-11.094-10.594 11.094-10.562zM2 3h-1.66v24h1.66z"/></svg>';
    const PAGINATION_LAST_SVG =
        '<svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><path d="M12 4.438l1.375-1.438 12.625 12-12.563 12-1.437-1.406 11.094-10.594-11.094-10.562zm-12 0l1.375-1.438 12.625 12-12.563 12-1.437-1.406 11.094-10.594-11.094-10.562zM28 3h1.66v24h-1.66z"/></svg>';

    function paginationControl(kind, label, page, enabled) {
        if (!enabled) {
            const span = document.createElement('span');
            span.setAttribute('aria-hidden', 'true');
            span.className = `button-n disabled${kind === 'first' || kind === 'last' ? ' icon-only' : ''}`;
            span.innerHTML = `${kind === 'first' ? PAGINATION_FIRST_SVG : kind === 'last' ? PAGINATION_LAST_SVG : kind === 'prev' ? PAGINATION_PREV_SVG : PAGINATION_NEXT_SVG}<b class="${kind === 'first' || kind === 'last' ? 'vh' : ''}">${label}</b>`;
            return span;
        }

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `button-n${kind === 'first' || kind === 'last' ? ' icon-only' : ''}`;
        btn.dataset.tcgaPage = String(page);
        btn.innerHTML = `${kind === 'first' ? PAGINATION_FIRST_SVG : kind === 'last' ? PAGINATION_LAST_SVG : kind === 'prev' ? PAGINATION_PREV_SVG : PAGINATION_NEXT_SVG}<b class="${kind === 'first' || kind === 'last' ? 'vh' : ''}">${label}</b>`;
        return btn;
    }

    function bindPaginationContainer(container, ctx, totalPages) {
        const shuffle = container.querySelector('#shuffle-button');
        container.replaceChildren();

        const currentPage = ctx.page;
        const onFirst = currentPage <= 1;
        const onLast = currentPage >= totalPages;

        container.appendChild(paginationControl('first', 'First Page', 1, !onFirst));
        container.appendChild(paginationControl('prev', 'Previous', currentPage - 1, !onFirst));

        if (shuffle) {
            container.appendChild(shuffle);
        }

        if (!onLast) {
            const nextLabel = `Next ${FULL_FILTER_PAGE_SIZE}`;
            container.appendChild(paginationControl('next', nextLabel, currentPage + 1, true));
            container.appendChild(paginationControl('last', 'Last Page', totalPages, true));
        } else {
            container.appendChild(paginationControl('next', `Next ${FULL_FILTER_PAGE_SIZE}`, 0, false));
            container.appendChild(paginationControl('last', 'Last Page', 0, false));
        }

        container.querySelectorAll('button[data-tcga-page]').forEach((btn) => {
            btn.addEventListener('click', (event) => {
                event.preventDefault();
                const page = parseInt(btn.dataset.tcgaPage || '1', 10);
                goToFullFilterPage(page);
            });
        });
    }

    function updateFullFilterPagination(ctx, filteredTotal) {
        const totalPages = Math.max(1, Math.ceil(filteredTotal / FULL_FILTER_PAGE_SIZE));
        const safePage = Math.min(ctx.page, totalPages);
        if (safePage !== ctx.page) {
            ctx.page = safePage;
        }

        storePaginationSnapshot();

        document.querySelectorAll('.search-controls-pagination').forEach((container) => {
            bindPaginationContainer(container, ctx, totalPages, filteredTotal);
        });

        const start = filteredTotal === 0 ? 0 : (ctx.page - 1) * FULL_FILTER_PAGE_SIZE + 1;
        const end = Math.min(ctx.page * FULL_FILTER_PAGE_SIZE, filteredTotal);
        const unit = fullFilterCache && fullFilterCache.printsMode ? 'printings' : 'cards';
        const rangeText =
            filteredTotal === 0
                ? `0 <i>of</i> 0 ${unit}`
                : `${start} – ${end} <i>of</i> ${filteredTotal.toLocaleString()} ${unit}`;

        document.querySelectorAll('.search-info strong').forEach((el) => {
            el.innerHTML = rangeText;
        });
    }

    function goToFullFilterPage(page) {
        if (!fullFilterCache) {
            return;
        }
        const ctx = getSearchContext();
        ctx.page = page;
        history.replaceState(null, '', buildSearchUrl(ctx));
        renderFullFilterPage(ctx);
        updateFullFilterPagination(ctx, fullFilterCache.items.length);
        updateFullFilterStatus();
        const grid = document.querySelector('.card-grid');
        if (grid) {
            grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function renderFullFilterPage(ctx) {
        const gridInner = document.querySelector('.card-grid-inner');
        if (!gridInner || !fullFilterCache) {
            return;
        }

        clearInjectedItems();
        parkNativeGridItems(gridInner);

        const start = (ctx.page - 1) * FULL_FILTER_PAGE_SIZE;
        const slice = fullFilterCache.items.slice(start, start + FULL_FILTER_PAGE_SIZE);

        for (const model of slice) {
            gridInner.appendChild(buildGridItem(model));
        }
    }

    function disableFullFilterMode() {
        fullFilterFetchId += 1;
        fullFilterActive = false;
        fullFilterInProgress = false;
        invalidateFullFilterCache();
        clearInjectedItems();
        restoreAllToGrid();
        restorePaginationSnapshot();
        restoreSearchSummary();
        setSearchLoading(false, '', 0);
        setResultsHidden(false);
        updateCollectionFilterControlState();
    }

    function setResultsHidden(hidden) {
        const grid = document.querySelector('.card-grid');
        if (grid) {
            grid.classList.toggle('tcga-results-hidden', hidden);
        }
    }

    function formatFilterStatus(total) {
        return `Filtering ${total.toLocaleString()} total results`;
    }

    function getSearchSummaryElements() {
        return document.querySelectorAll('.search-summary-english');
    }

    function storeSearchSummaryOriginal(el) {
        if (!el.dataset.tcgaOrigSummary) {
            el.dataset.tcgaOrigSummary = el.textContent;
        }
    }

    function appendSearchSummaryStatus(suffix) {
        getSearchSummaryElements().forEach((el) => {
            storeSearchSummaryOriginal(el);
            const base = el.dataset.tcgaOrigSummary || '';
            if (!suffix) {
                el.textContent = base;
                delete el.dataset.tcgaFilterSuffix;
                return;
            }
            el.dataset.tcgaFilterSuffix = suffix;
            el.textContent = base ? `${base} · ${suffix}` : suffix;
        });
    }

    function restoreSearchSummary() {
        getSearchSummaryElements().forEach((el) => {
            if (el.dataset.tcgaOrigSummary) {
                el.textContent = el.dataset.tcgaOrigSummary;
                delete el.dataset.tcgaFilterSuffix;
            }
        });
    }

    function getCollectionFilterSelect() {
        return document.getElementById('tcga-collection-filter');
    }

    function syncCollectionFilterSelect() {
        const select = getCollectionFilterSelect();
        if (select) {
            select.value = isFilterEnabled() ? 'on' : 'off';
        }
    }

    function updateCollectionFilterControlState() {
        const select = getCollectionFilterSelect();
        if (!select) {
            return;
        }
        syncCollectionFilterSelect();
        const count = collectionByName ? collectionByName.size : 0;
        select.disabled =
            importInProgress ||
            fullFilterInProgress ||
            filterApplyInProgress ||
            count === 0;
    }

    function updateFullFilterStatus() {
        if (!fullFilterCache) {
            return;
        }

        appendSearchSummaryStatus(formatFilterStatus(fullFilterCache.scryfallTotal));
        updateCollectionFilterControlState();
    }

    async function applyFullFilter() {
        if (fullFilterInProgress) {
            return;
        }

        fullFilterInProgress = true;
        updateCollectionFilterControlState();
        try {
            await applyFullFilterInner();
        } finally {
            fullFilterInProgress = false;
            updateCollectionFilterControlState();
        }
    }

    async function applyFullFilterInner() {
        const collection = collectionByName ?? new Map();
        const gridInner = document.querySelector('.card-grid-inner');
        if (!gridInner || collection.size === 0) {
            return;
        }

        const ctx = getSearchContext();
        if (!ctx.q) {
            return;
        }

        const printsMode = ctx.unique === 'prints';
        const cacheKey = getFullFilterCacheKey(ctx);
        const fetchId = ++fullFilterFetchId;

        if (!fullFilterCache || fullFilterCache.cacheKey !== cacheKey) {
            setResultsHidden(true);
            clearInjectedItems();
            parkNativeGridItems(gridInner);
            setSearchLoading(true, 'Loading full search from Scryfall…', 5);

            try {
                const result = await fetchAllScryfallResults(ctx, fetchId, (progress) => {
                    setSearchLoading(
                        true,
                        `Loading search results… ${progress.fetched.toLocaleString()} / ${progress.total.toLocaleString()}`,
                        progress.percent
                    );
                });

                if (fetchId !== fullFilterFetchId) {
                    setResultsHidden(false);
                    return;
                }

                if (!result) {
                    setResultsHidden(false);
                    return;
                }

                setSearchLoading(true, 'Filtering to your collection…', 96);
                await yieldToMain();

                const items = filterApiCards(result.cards, printsMode, collection);
                fullFilterCache = {
                    cacheKey,
                    printsMode,
                    items,
                    scryfallTotal: result.scryfallTotal,
                };
            } catch (err) {
                console.error('[TCGArchivist] Full search failed:', err);
                setSearchLoading(false, '', 0);
                setResultsHidden(false);
                appendSearchSummaryStatus('Could not load full search — try again');
                return;
            } finally {
                setSearchLoading(false, '', 0);
            }
        }

        if (fetchId !== fullFilterFetchId) {
            setResultsHidden(false);
            return;
        }

        const totalPages = Math.max(
            1,
            Math.ceil(fullFilterCache.items.length / FULL_FILTER_PAGE_SIZE)
        );
        if (ctx.page > totalPages) {
            ctx.page = totalPages;
            history.replaceState(null, '', buildSearchUrl(ctx));
        }

        fullFilterActive = true;
        renderFullFilterPage(ctx);
        updateFullFilterPagination(ctx, fullFilterCache.items.length);
        setResultsHidden(false);
        updateFullFilterStatus();
    }

    function applyFilterByPrints(collection, gridInner) {
        const idSet = getCollectionIdSet();
        const gridItems = Array.from(getGridItems());
        let visible = 0;

        for (const item of gridItems) {
            const cardId = (item.getAttribute('data-card-id') || '').toLowerCase();
            if (idSet.has(cardId)) {
                restoreItemContent(item);
                item.classList.remove('tcga-hidden');
                if (item.parentNode !== gridInner) {
                    gridInner.appendChild(item);
                }
                visible += 1;
            } else {
                hideItem(item);
            }
        }

        return { total: gridItems.length, visible, printsMode: true };
    }

    function applyFilterByName(collection, gridInner) {
        const gridItems = Array.from(getGridItems());
        gridItems.forEach((item) => restoreItemContent(item));

        const groups = new Map();
        for (const item of gridItems) {
            const key = normalizeName(getItemCardName(item));
            if (!key) {
                hideItem(item);
                continue;
            }
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key).push(item);
        }

        let visible = 0;

        for (const [key, group] of groups) {
            const entry = collection.get(key);

            if (!entry) {
                for (const item of group) {
                    hideItem(item);
                }
                continue;
            }

            const primary = getPrintingsForEntry(entry)[0];
            const shown = group[0];

            configureItemForPrinting(shown, primary);
            ensureCollectionBadge(shown, entry);
            if (shown.parentNode !== gridInner) {
                gridInner.appendChild(shown);
            }
            visible += 1;

            for (let i = 1; i < group.length; i += 1) {
                hideItem(group[i]);
            }
        }

        return { total: gridItems.length, visible, printsMode: false };
    }

    async function applyFilter() {
        if (filterApplyInProgress || fullFilterInProgress) {
            return;
        }

        filterApplyInProgress = true;
        pauseFilterObserver();
        updateCollectionFilterControlState();
        try {
            await applyFilterInner();
        } finally {
            filterApplyInProgress = false;
            resumeFilterObserver();
            updateCollectionFilterControlState();
        }
    }

    function pauseFilterObserver() {
        if (filterObserver) {
            filterObserver.disconnect();
        }
    }

    function resumeFilterObserver() {
        if (importInProgress || !document.getElementById('main')) {
            return;
        }
        observeResults();
    }

    async function applyFilterInner() {
        const enabled = isFilterEnabled();
        const collection = collectionByName ?? new Map();
        const gridInner = document.querySelector('.card-grid-inner');
        const printsMode = isUniquePrintsSearch();

        if (!enabled) {
            if (fullFilterActive) {
                disableFullFilterMode();
            } else {
                clearInjectedItems();
                restoreAllToGrid();
            }
            restoreSearchSummary();
            const totalOnPage = gridInner
                ? gridInner.querySelectorAll(
                      '.card-grid-item[data-card-id]:not([data-tcga-injected="true"])'
                  ).length
                : 0;
            updateStatus(totalOnPage, totalOnPage, enabled, printsMode);
            return;
        }

        if (!gridInner || collection.size === 0) {
            updateStatus(0, 0, enabled, printsMode);
            return;
        }

        const ctx = getSearchContext();
        if (ctx.as === 'grid') {
            await applyFullFilter();
            return;
        }

        clearInjectedItems();
        restoreAllToGrid();
        const result = printsMode
            ? applyFilterByPrints(collection, gridInner)
            : applyFilterByName(collection, gridInner);
        updateStatus(result.total, result.visible, enabled, printsMode);
    }

    function updateStatus(total, visible, enabled, printsMode) {
        const count = collectionByName ? collectionByName.size : 0;
        if (importInProgress) {
            return;
        }
        if (count === 0) {
            appendSearchSummaryStatus('No collection loaded — import a TCGArchivist CSV');
        } else if (!enabled) {
            restoreSearchSummary();
        } else if (total === 0) {
            appendSearchSummaryStatus(formatFilterStatus(0));
        } else {
            appendSearchSummaryStatus(formatFilterStatus(total));
        }

        updateCollectionFilterControlState();
    }

    function setControlsDisabled(disabled) {
        const importBtn = document.getElementById('tcga-import-btn');
        const select = getCollectionFilterSelect();
        const count = collectionByName ? collectionByName.size : 0;
        if (select) {
            select.disabled = disabled || count === 0;
        }
        if (importBtn) {
            importBtn.disabled = disabled;
        }
    }

    function formatProgress(label, progress) {
        if (!progress || progress.names == null) {
            return label;
        }
        return `${label} (${progress.names.toLocaleString()} unique names)`;
    }

    function setProgressPanel(panelId, labelId, barId, active, label, percent) {
        const panel = document.getElementById(panelId);
        const bar = document.getElementById(barId);
        const text = document.getElementById(labelId);
        if (!panel || !bar || !text) {
            return;
        }

        panel.hidden = !active;
        text.textContent = label || '';
        const value = Math.max(0, Math.min(100, percent ?? 0));
        bar.value = value;
        panel.setAttribute('aria-valuenow', String(value));
    }

    function setImportLoading(active, label, percent) {
        setProgressPanel('tcga-import-loading', 'tcga-import-loading-label', 'tcga-import-loading-bar', active, label, percent);
    }

    function ensureSearchLoadingPanel() {
        if (document.getElementById('tcga-search-loading')) {
            return;
        }

        const searchInfo = document.querySelector('.search-info');
        if (!searchInfo) {
            return;
        }

        const panel = document.createElement('div');
        panel.id = 'tcga-search-loading';
        panel.className = 'tcga-search-loading';
        panel.hidden = true;
        panel.setAttribute('role', 'progressbar');
        panel.setAttribute('aria-valuemin', '0');
        panel.setAttribute('aria-valuemax', '100');
        panel.setAttribute('aria-valuenow', '0');
        panel.innerHTML = `
            <span id="tcga-search-loading-label" class="tcga-loading-label"></span>
            <progress id="tcga-search-loading-bar" class="tcga-loading-bar" max="100" value="0"></progress>
        `;
        searchInfo.appendChild(panel);
    }

    function setSearchLoading(active, label, percent) {
        ensureSearchLoadingPanel();
        setProgressPanel('tcga-search-loading', 'tcga-search-loading-label', 'tcga-search-loading-bar', active, label, percent);
    }

    function showImportSuccess(nameCount) {
        importInProgress = false;

        setImportLoading(true, 'Import complete', 100);
        setControlsDisabled(false);

        requestAnimationFrame(() => {
            setTimeout(() => setImportLoading(false, '', 0), 500);
        });
    }

    function scheduleApplyFilter() {
        if (
            importInProgress ||
            filterApplyInProgress ||
            fullFilterInProgress ||
            fullFilterActive
        ) {
            return;
        }
        if (filterDebounceTimer) {
            clearTimeout(filterDebounceTimer);
        }
        filterDebounceTimer = setTimeout(() => {
            filterDebounceTimer = null;
            applyFilter();
        }, 150);
    }

    function observeResults() {
        if (filterObserver) {
            filterObserver.disconnect();
        }

        const main = document.getElementById('main');
        if (!main) {
            return;
        }

        filterObserver = new MutationObserver(() => {
            scheduleApplyFilter();
        });

        filterObserver.observe(main, { childList: true, subtree: true });
    }

    function readFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Could not read the CSV file.'));
            reader.readAsText(file);
        });
    }

    async function importCsvFile(file) {
        if (importInProgress) {
            return;
        }

        debugStart('import', { fileName: file.name, fileSize: file.size });

        importInProgress = true;
        setControlsDisabled(true);
        setImportLoading(true, 'Reading file…', 3);

        if (filterObserver) {
            filterObserver.disconnect();
        }

        try {
            const text = await readFile(file);

            setImportLoading(true, 'Parsing collection…', 8);
            const map = await parseCsvToCollection(text, (progress) => {
                setImportLoading(
                    true,
                    formatProgress('Parsing collection…', progress),
                    progress.percent
                );
            });

            collectionByName = map;
            setImportLoading(true, formatProgress('Saving collection…', { names: map.size }), 94);
            await yieldToMain();
            await saveCollection(map);

            await applyFilter();
            showImportSuccess(map.size);
            debugEnd('import', { nameCount: map.size });
        } catch (err) {
            console.error('[TCGArchivist] Import failed:', err);
            alert(err.message || 'Import failed.');
            importInProgress = false;
            setControlsDisabled(false);
            setImportLoading(false, '', 0);
        } finally {
            observeResults();
            scheduleApplyFilter();
        }
    }

    function injectStyles() {
        if (window.__tcgaStylesInjected) {
            return;
        }

        const css = `
            .search-controls-inner {
                position: relative;
            }
            .tcga-collection-controls {
                display: contents;
            }
            .tcga-collection-controls > label[for="tcga-collection-filter"] {
                margin-left: 0.75rem;
                padding-left: 0.75rem;
                border-left: 1px solid rgba(0, 0, 0, 0.15);
            }
            #tcga-import-btn {
                margin-right: 0.75rem;
            }
            #tcga-import-btn:disabled {
                opacity: 0.6;
                cursor: wait;
            }
            #tcga-import-loading {
                position: absolute;
                top: 0;
                right: 0;
                z-index: 2;
                width: 16rem;
                max-width: calc(100% - 1rem);
            }
            .tcga-import-loading[hidden],
            .tcga-search-loading[hidden] {
                display: none !important;
            }
            .tcga-search-loading {
                display: block;
                margin-top: 0.5rem;
                max-width: 28rem;
                margin-left: auto;
                margin-right: auto;
            }
            .tcga-search-loading .tcga-loading-label {
                text-align: center;
            }
            .tcga-loading-label {
                display: block;
                font-size: 0.8em;
                opacity: 0.85;
                margin-bottom: 0.2rem;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            progress.tcga-loading-bar {
                display: block;
                width: 100%;
                height: 0.35rem;
                border: none;
                border-radius: 0.2rem;
                overflow: hidden;
                background: rgba(0, 0, 0, 0.1);
            }
            progress.tcga-loading-bar::-webkit-progress-bar {
                background: rgba(0, 0, 0, 0.1);
                border-radius: 0.2rem;
            }
            progress.tcga-loading-bar::-webkit-progress-value {
                background: #5a3e8a;
                border-radius: 0.2rem;
            }
            progress.tcga-loading-bar::-moz-progress-bar {
                background: #5a3e8a;
                border-radius: 0.2rem;
            }
            .card-grid.tcga-results-hidden {
                display: none !important;
            }
            .tcga-hidden {
                display: none !important;
            }
            .card-grid-item,
            .checklist-item {
                position: relative;
            }
            .tcga-print-badge {
                position: absolute;
                left: 4px;
                right: 4px;
                bottom: 4px;
                z-index: 3;
                padding: 3px 6px;
                font-size: 10px;
                line-height: 1.3;
                font-weight: 600;
                color: #fff;
                background: rgba(90, 62, 138, 0.92);
                border-radius: 3px;
                pointer-events: none;
                text-align: center;
                white-space: normal;
            }
            @media (max-width: 768px) {
                .tcga-collection-controls > label[for="tcga-collection-filter"] {
                    margin-left: 0;
                    padding-left: 0;
                    border-left: none;
                }
                #tcga-import-loading {
                    position: static;
                    width: 100%;
                    max-width: none;
                    margin-top: 0.35rem;
                }
            }
        `;

        if (typeof GM_addStyle === 'function') {
            GM_addStyle(css, 'tcga-styles');
        }

        window.__tcgaStylesInjected = true;
    }

    function buildControls() {
        if (document.getElementById('tcga-collection-controls')) {
            return;
        }

        const anchor = document.querySelector('.search-controls-display-options');
        if (!anchor) {
            return;
        }

        injectStyles();

        const wrap = document.createElement('div');
        wrap.id = 'tcga-collection-controls';
        wrap.className = 'tcga-collection-controls';
        wrap.innerHTML = `
            <label for="tcga-collection-filter">collection</label>
            <select id="tcga-collection-filter" class="select-n" title="Filter search results to your TCGArchivist collection">
                <option value="off">All results</option>
                <option value="on">My collection only</option>
            </select>
            <button type="button" class="button-n" id="tcga-import-btn" title="Import TCGArchivist collection CSV">Import CSV</button>
            <input type="file" id="tcga-file-input" accept=".csv,text/csv" hidden />
        `;

        anchor.appendChild(wrap);

        const controlsInner = anchor.closest('.search-controls-inner');
        if (controlsInner && !document.getElementById('tcga-import-loading')) {
            const importLoading = document.createElement('div');
            importLoading.id = 'tcga-import-loading';
            importLoading.className = 'tcga-import-loading';
            importLoading.hidden = true;
            importLoading.setAttribute('role', 'progressbar');
            importLoading.setAttribute('aria-valuemin', '0');
            importLoading.setAttribute('aria-valuemax', '100');
            importLoading.setAttribute('aria-valuenow', '0');
            importLoading.innerHTML = `
                <span id="tcga-import-loading-label" class="tcga-loading-label"></span>
                <progress id="tcga-import-loading-bar" class="tcga-loading-bar" max="100" value="0"></progress>
            `;
            controlsInner.appendChild(importLoading);
        }

        const filterSelect = getCollectionFilterSelect();
        const fileInput = document.getElementById('tcga-file-input');
        const importBtn = document.getElementById('tcga-import-btn');

        filterSelect.addEventListener('change', () => {
            const enabled = filterSelect.value === 'on';
            setFilterEnabled(enabled);
            if (enabled) {
                invalidateFullFilterCache();
            }
            applyFilter();
        });

        importBtn.addEventListener('click', () => {
            fileInput.click();
        });

        fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (file) {
                importCsvFile(file);
            }
            fileInput.value = '';
        });
    }

    async function init() {
        debugStart('init');
        buildControls();
        ensureSearchLoadingPanel();

        try {
            await loadCollection();
        } catch (err) {
            console.error('[TCGArchivist]', err);
            appendSearchSummaryStatus('Could not load collection — re-import your CSV');
        }

        updateCollectionFilterControlState();
        await applyFilter();
        observeResults();
        debugEnd('init', {
            collectionSize: collectionByName ? collectionByName.size : 0,
            filterEnabled: isFilterEnabled(),
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
