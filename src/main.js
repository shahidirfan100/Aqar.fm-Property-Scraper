import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import { Dataset } from 'crawlee';
import { Impit } from 'impit';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    startUrl: rawStartUrl,
    propertyType: rawPropertyType,
    location: rawLocation,
    minPrice: rawMinPrice,
    maxPrice: rawMaxPrice,
    bedrooms: rawBedrooms,
    bathrooms: rawBathrooms,
    furnished: rawFurnished,
    family: rawFamily,
    results_wanted: rawResultsWanted,
    proxyConfiguration,
} = input;

const DEFAULT_START_URL = 'https://sa.aqar.fm/en/all';
const DEFAULT_RESULTS_WANTED = 20;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_FETCH_ATTEMPTS = 3;

// Property types verified to return listings at https://sa.aqar.fm/en/<slug>.
const SUPPORTED_PROPERTY_TYPES = new Set([
    'apartment-for-rent',
    'apartment-for-sale',
    'villa-for-rent',
    'villa-for-sale',
    'land-for-rent',
    'land-for-sale',
    'building-for-rent',
    'building-for-sale',
    'big-flat-for-rent',
    'room-for-rent',
    'office-for-rent',
    'store-for-rent',
    'store-for-sale',
    'warehouse-for-rent',
    'chalet-for-rent',
    'farm-for-sale',
]);

// Query params the site actually honors. `sort` is NOT supported server-side.
function normalizeStartUrl(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        return trimmed;
    } catch {
        return null;
    }
}

function toPositiveInt(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function slugify(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '');
}

const filterParams = [];
const minPrice = toPositiveInt(rawMinPrice);
const maxPrice = toPositiveInt(rawMaxPrice);
if (minPrice) filterParams.push(['price', `gte,${minPrice}`]);
if (maxPrice) filterParams.push(['price', `lte,${maxPrice}`]);
if (minPrice && maxPrice && maxPrice < minPrice) {
    log.warning(`maxPrice (${maxPrice}) is lower than minPrice (${minPrice}); results may be empty.`);
}
const minBedrooms = toPositiveInt(rawBedrooms);
if (minBedrooms) filterParams.push(['beds', `gte,${minBedrooms}`]);
const minBathrooms = toPositiveInt(rawBathrooms);
if (minBathrooms) filterParams.push(['wc', `gte,${minBathrooms}`]);
if (rawFurnished === true) filterParams.push(['furnished', 'eq,1']);
if (rawFamily === 'family') filterParams.push(['family', 'eq,1']);
else if (rawFamily === 'singles') filterParams.push(['family', 'eq,0']);

function buildCategoryUrl() {
    const type = slugify(rawPropertyType);
    if (!type || !SUPPORTED_PROPERTY_TYPES.has(type)) return null;
    const city = slugify(rawLocation);
    return city ? `https://sa.aqar.fm/en/${type}/${city}` : `https://sa.aqar.fm/en/${type}`;
}

let startUrl = normalizeStartUrl(rawStartUrl);
if (rawStartUrl && !startUrl) {
    log.warning(`Ignoring invalid startUrl "${String(rawStartUrl).slice(0, 120)}"; using options instead.`);
}
if (!startUrl) {
    if (rawPropertyType && !SUPPORTED_PROPERTY_TYPES.has(slugify(rawPropertyType))) {
        log.warning(`Unsupported propertyType "${rawPropertyType}"; ignoring it.`);
    }
    const builtUrl = buildCategoryUrl();
    if (builtUrl) {
        startUrl = builtUrl;
    } else {
        if (rawLocation) log.warning('A location was provided without a supported property type; location ignored.');
        startUrl = DEFAULT_START_URL;
    }
}

const resolvedUrl = new URL(startUrl);
for (const key of new Set(filterParams.map(([filterKey]) => filterKey))) {
    resolvedUrl.searchParams.delete(key);
}
for (const [key, value] of filterParams) {
    resolvedUrl.searchParams.append(key, value);
}
const ACTIVE_QUERY = resolvedUrl.searchParams.toString() ? `?${resolvedUrl.searchParams.toString()}` : '';
startUrl = resolvedUrl.toString().replace(/\/$/, '');

const parsedResultsWanted = Number.parseInt(rawResultsWanted, 10);
const RESULTS_WANTED_N = Number.isFinite(parsedResultsWanted) && parsedResultsWanted > 0
    ? parsedResultsWanted
    : DEFAULT_RESULTS_WANTED;

const initial = [startUrl];

function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function setupProxy(rawProxyConfiguration) {
    const wantsProxy = Boolean(rawProxyConfiguration) && (
        rawProxyConfiguration.useApifyProxy === true
        || (Array.isArray(rawProxyConfiguration.proxyUrls) && rawProxyConfiguration.proxyUrls.length > 0)
    );
    if (!wantsProxy) return undefined;

    try {
        const proxyConf = await Actor.createProxyConfiguration({ ...rawProxyConfiguration });
        return proxyConf ? await proxyConf.newUrl() : undefined;
    } catch (error) {
        log.warning(`Proxy setup failed (${error.message}); continuing without proxy.`);
        return undefined;
    }
}

const proxyUrl = await setupProxy(proxyConfiguration);

const client = new Impit({
    browser: 'chrome',
    ignoreTlsErrors: true,
    timeout: REQUEST_TIMEOUT_MS,
    ...(proxyUrl && { proxyUrl }),
});

function cleanPrice(text) {
    if (!text) return null;
    return text.replace(/[^\d,.\s]/g, '').replace(/\s+/g, ' ').trim();
}

function parseArea(text) {
    if (!text) return null;
    const m = text.match(/([\d,]+)\s*[mم]/);
    return m ? m[1].replace(/,/g, '') : text;
}

function hasArea(text) {
    if (!text) return false;
    return /m²|م²|m\s*2/i.test(text);
}

function getPathname(rawUrl) {
    try {
        return new URL(rawUrl, 'https://sa.aqar.fm').pathname;
    } catch {
        return String(rawUrl).split('?')[0];
    }
}

function parseUrlMeta(rawUrl) {
    const parts = decodeURIComponent(getPathname(rawUrl)).split('/').filter(Boolean);
    if (parts[0] === 'en') {
        return { propertyType: parts[1] || null, city: parts[2] || null };
    }
    return { propertyType: parts[0] || null, city: parts[1] || null };
}

function normalizeImageUrl(rawUrl) {
    if (!rawUrl) return null;
    const cleaned = rawUrl.replace(/&amp;/g, '&').trim();
    if (!cleaned || !cleaned.includes('images.aqar.fm')) return null;
    if (cleaned.startsWith('//')) return `https:${cleaned}`;
    if (cleaned.startsWith('/')) return `https://sa.aqar.fm${cleaned}`;
    return cleaned;
}

function addImageUrl(urls, rawUrl) {
    const url = normalizeImageUrl(rawUrl);
    if (url && !urls.includes(url)) urls.push(url);
}

function extractImageUrls($, html) {
    const urls = [];

    $('img, source').each((_, el) => {
        for (const attr of ['src', 'data-src', 'data-original', 'data-lazy-src']) {
            addImageUrl(urls, $(el).attr(attr));
        }

        const srcset = $(el).attr('srcset') || $(el).attr('data-srcset');
        if (srcset) {
            for (const entry of srcset.split(',')) {
                addImageUrl(urls, entry.trim().split(/\s+/)[0]);
            }
        }
    });

    const imageMatches = html.match(/https?:\\?\/\\?\/images\.aqar\.fm[^"'\\\s)]+/g) || [];
    for (const match of imageMatches) {
        addImageUrl(urls, match.replace(/\\\//g, '/'));
    }

    return urls;
}

const SEEN_IDS = new Set();
const SEEN_PAGES = new Set();
const pageQueue = [];
const dataBuffer = [];
let saved = 0;
const BATCH_SIZE = 25;
const DETAIL_CONCURRENCY = 5;
const MAX_RESULT_PAGES = Math.max(10, Math.ceil(RESULTS_WANTED_N / 10) * 3);

function isDetailUrl(url) {
    return /-\d{4,}$/.test(getPathname(url).replace(/\/$/, ''));
}

function getListingId(url) {
    const match = getPathname(url).match(/-(\d{4,})\/?$/);
    return match ? match[1] : null;
}

function normalizeAqarUrl(rawUrl, baseUrl = 'https://sa.aqar.fm') {
    if (!rawUrl || rawUrl.startsWith('#') || rawUrl.startsWith('mailto:') || rawUrl.startsWith('tel:')) return null;
    try {
        return new URL(rawUrl, baseUrl).toString().replace(/\/$/, '');
    } catch {
        return null;
    }
}

function applyActiveFilters(url) {
    if (!ACTIVE_QUERY) return url;
    const parsed = new URL(url);
    parsed.search = ACTIVE_QUERY;
    return parsed.toString();
}

function enqueuePage(rawUrl, baseUrl, options = {}) {
    if (pageQueue.length + SEEN_PAGES.size >= MAX_RESULT_PAGES) return;

    let url = normalizeAqarUrl(rawUrl, baseUrl);
    if (!url || !url.startsWith('https://sa.aqar.fm/')) return;
    if (!isDetailUrl(url) && ACTIVE_QUERY) url = applyActiveFilters(url);
    if (SEEN_PAGES.has(url) || pageQueue.includes(url)) return;
    if (isDetailUrl(url) && !options.allowDetail) return;

    pageQueue.push(url);
}

function enqueueParentSearchPages(listingUrl) {
    const url = normalizeAqarUrl(listingUrl);
    if (!url) return;

    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 4) return;

    parts.pop();
    enqueuePage(`${parsed.origin}/${parts.join('/')}`, url);

    if (parts.length > 3) {
        parts.pop();
        enqueuePage(`${parsed.origin}/${parts.join('/')}`, url);
    }
}

function enqueueDiscoveredPages(html, sourceUrl) {
    const $ = cheerio.load(html);
    $('a[href]').each((_index, el) => {
        const href = $(el).attr('href');
        const url = normalizeAqarUrl(href, sourceUrl);
        if (!url) return undefined;

        if (url.includes('/api/') || url.includes('/auth/')) return undefined;
        enqueuePage(url, sourceUrl);
        return undefined;
    });
}

function extractDetailListing(html, sourceUrl) {
    const $ = cheerio.load(html);

    const listingId = getListingId(sourceUrl);
    if (!listingId) return null;

    const title = $('h1').first().text().trim() || null;

    const priceEl = $('[class*="font-semibold"]').filter((_, el) => $(el).text().includes('§')).first();
    const price = priceEl.length ? cleanPrice(priceEl.text()) : null;

    const infoTexts = [];
    $('li').each((_, el) => {
        const t = $(el).text().trim();
        if (t) infoTexts.push(t);
    });

    let area = null, bedrooms = null, bathrooms = null, livingRooms = null;
    for (const t of infoTexts) {
        if (hasArea(t)) { area = parseArea(t); continue; }
        if (/^\d+$/.test(t)) {
            if (bedrooms === null) bedrooms = t;
            else if (bathrooms === null) bathrooms = t;
            else if (livingRooms === null) livingRooms = t;
        }
    }

    let description = null;
    const descriptionSelector = '[style*="lines-count"] p, [class*="description"] p, [class*="line-clamp"] p, [class*="break-word"] p';
    $(descriptionSelector).each((_index, el) => {
        const txt = $(el).text().trim();
        if (txt.length > 50) { description = txt; return false; }
        return undefined;
    });

    const imgs = extractImageUrls($, html);

    const bcItems = [];
    $('[class*="breadcrumb"] a, [class*="breadcrumb_item"] a').each((_index, el) => {
        const t = $(el).text().trim();
        if (t && t !== 'Home' && t !== 'الرئيسية') bcItems.push(t);
        return undefined;
    });

    const { propertyType, city } = parseUrlMeta(sourceUrl);

    return {
        listing_id: listingId,
        title,
        price,
        currency: 'SAR',
        area_m2: area,
        bedrooms,
        bathrooms,
        living_rooms: livingRooms,
        description,
        gallery_urls: imgs.length > 0 ? imgs : null,
        image_url: imgs[0] || null,
        property_type: propertyType,
        city,
        district: bcItems.length > 0 ? bcItems.join(', ') : null,
        url: sourceUrl,
    };
}

function extractListingCards(html, limit) {
    const $ = cheerio.load(html);
    const results = [];
    const cards = $('a.no-underline');
    if (!cards.length) return results;

    cards.each((_cardIndex, card) => {
        if (results.length >= limit) return false;

        const href = $(card).attr('href');
        if (!href) return undefined;
        const url = href.startsWith('http') ? href : `https://sa.aqar.fm${href}`;
        const idMatch = url.match(/-(\d{4,})$/);
        const listingId = idMatch ? idMatch[1] : null;
        if (!listingId) return undefined;

        const title = $(card).find('[class*="line-clamp-1"]').first().text().trim() || null;

        let price = null;
        $(card).find('span').each((_spanIndex, el) => {
            const txt = $(el).text();
            if (txt.includes('§') || /\d[\d,]*\s*(§|SAR|ريال)/.test(txt)) {
                price = cleanPrice(txt);
                return false;
            }
            return undefined;
        });

        let area = null, bedrooms = null, bathrooms = null, livingRooms = null;
        $(card).find('li').each((_liIndex, el) => {
            const t = $(el).text().trim();
            if (hasArea(t)) { area = parseArea(t); return undefined; }
            if (/^\d+$/.test(t)) {
                if (bedrooms === null) bedrooms = t;
                else if (bathrooms === null) bathrooms = t;
                else if (livingRooms === null) livingRooms = t;
            }
            return undefined;
        });

        let description = null;
        $(card).find('[class*="break-all"]').each((_descriptionIndex, el) => {
            const txt = $(el).text().trim();
            if (txt.length > 30) { description = txt; return false; }
            return undefined;
        });

        let location = null;
        $(card).find('p').each((_paragraphIndex, el) => {
            const txt = $(el).text().trim();
            const cls = $(el).attr('class') || '';
            if (cls.includes('text-foreground')) {
                location = txt;
                return false;
            }
            return undefined;
        });

        const cardImages = extractImageUrls($, $.html(card));
        const imageUrl = cardImages[0] || null;

        const { propertyType, city } = parseUrlMeta(url);

        results.push({
            listing_id: listingId,
            title,
            price,
            currency: 'SAR',
            area_m2: area,
            bedrooms,
            bathrooms,
            living_rooms: livingRooms,
            description,
            gallery_urls: cardImages.length > 0 ? cardImages : null,
            image_url: imageUrl,
            property_type: propertyType,
            city,
            location,
            url,
        });
        return undefined;
    });

    return results;
}

async function fetchHtml(url) {
    let lastError;

    for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
        try {
            const response = await client.fetch(url, { timeout: REQUEST_TIMEOUT_MS });
            const { status } = response;

            if (!response.ok) {
                throw new Error(`HTTP ${status}`);
            }

            const html = await response.text();
            if (!html || html.length < 1000) {
                throw new Error('Empty response');
            }

            return html;
        } catch (error) {
            lastError = error;
            const isRetryableClientError = /HTTP 4\d\d/.test(error.message) && !/HTTP 429/.test(error.message);
            if (isRetryableClientError || attempt >= MAX_FETCH_ATTEMPTS) throw error;
            await sleep(500 * 2 ** (attempt - 1));
        }
    }

    throw lastError ?? new Error('Fetch failed');
}

async function flushData(force = false) {
    if (dataBuffer.length === 0 || (!force && dataBuffer.length < BATCH_SIZE)) return;

    const batch = dataBuffer.splice(0, dataBuffer.length);
    try {
        await Dataset.pushData(batch);
    } catch (error) {
        dataBuffer.unshift(...batch);
        log.warning(`Failed to save batch (${error.message}); will retry.`);
        return;
    }
    log.debug(`Saved ${saved}/${RESULTS_WANTED_N} items`);
}

async function saveItem(item) {
    if (!item?.listing_id || SEEN_IDS.has(item.listing_id) || saved >= RESULTS_WANTED_N) return false;

    SEEN_IDS.add(item.listing_id);
    dataBuffer.push(item);
    saved++;
    await flushData();
    return true;
}

async function enrichListing(cardItem) {
    try {
        const html = await fetchHtml(cardItem.url);
        const detailItem = extractDetailListing(html, cardItem.url);
        if (!detailItem) return cardItem;

        return {
            ...cardItem,
            ...detailItem,
            location: cardItem.location ?? detailItem.district ?? null,
            image_url: detailItem.image_url ?? cardItem.image_url ?? null,
            gallery_urls: detailItem.gallery_urls ?? cardItem.gallery_urls ?? null,
        };
    } catch (error) {
        log.debug(`Detail fetch failed: ${error.message}`);
        return cardItem;
    }
}

async function fetchAndExtract(urls) {
    for (const url of urls) enqueuePage(url, undefined, { allowDetail: true });

    while (pageQueue.length > 0) {
        if (saved >= RESULTS_WANTED_N) break;
        const url = pageQueue.shift();
        if (!url || SEEN_PAGES.has(url)) continue;
        SEEN_PAGES.add(url);

        try {
            const html = await fetchHtml(url);

            if (isDetailUrl(url)) {
                const detailItem = extractDetailListing(html, url);
                if (!await saveItem(detailItem)) {
                    log.debug(`No listing found on ${url}`);
                }
                continue;
            }

            enqueueDiscoveredPages(html, url);

            const listings = extractListingCards(html, RESULTS_WANTED_N - saved);
            if (listings.length === 0) {
                continue;
            }

            for (const listing of listings) enqueueParentSearchPages(listing.url);

            const candidates = listings
                .filter(listing => listing?.listing_id && !SEEN_IDS.has(listing.listing_id))
                .slice(0, RESULTS_WANTED_N - saved);

            for (let index = 0; index < candidates.length; index += DETAIL_CONCURRENCY) {
                const chunk = candidates.slice(index, index + DETAIL_CONCURRENCY);
                const items = await Promise.all(chunk.map(listing => enrichListing(listing)));

                for (const item of items) {
                    await saveItem(item);
                    if (saved >= RESULTS_WANTED_N) break;
                }

                if (saved >= RESULTS_WANTED_N) break;
            }
        } catch (error) {
            log.warning(`Skipped one page: ${error.message}`);
        }
    }

    await flushData(true);
}

async function flushWithRetry(attempts = 3) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (dataBuffer.length === 0) return;
        await flushData(true);
        if (dataBuffer.length === 0) return;
        if (attempt < attempts) await sleep(1000 * attempt);
    }
    if (dataBuffer.length > 0) {
        log.error(`Could not save ${dataBuffer.length} buffered items after retries.`);
    }
}

async function main() {
    log.info(`Aqar.fm Property Scraper — start: ${startUrl}`);
    log.info(`Requested results: ${RESULTS_WANTED_N}${proxyUrl ? ' (proxy enabled)' : ''}`);

    await fetchAndExtract(initial);
    await flushWithRetry();

    log.info(`Done. ${saved} properties saved.`);
}

try {
    await main();
    if (saved === 0) {
        log.warning('No properties were extracted. Verify the start URL is a valid Aqar.fm listing or search page.');
    }
    await Actor.exit();
} catch (error) {
    log.error(`Actor failed: ${error.message}`);
    await Actor.fail(`Actor failed: ${error.message}`);
}
