import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import { Dataset } from 'crawlee';
import { Impit } from 'impit';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    startUrl,
    results_wanted: RESULTS_WANTED = 20,
    proxyConfiguration,
} = input;

const RESULTS_WANTED_N = Number.isFinite(+RESULTS_WANTED) ? Math.max(1, +RESULTS_WANTED) : 20;

const initial = [];
if (startUrl) initial.push(startUrl);
if (!initial.length) {
    initial.push('https://sa.aqar.fm/en/all');
}

const isApifyCloud = Actor.isAtHome();
const proxyConf = proxyConfiguration?.useApifyProxy && isApifyCloud
    ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
    : null;

const proxyUrl = proxyConf ? await proxyConf.newUrl() : undefined;

const client = new Impit({
    browser: 'chrome',
    ignoreTlsErrors: true,
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

function parseUrlMeta(rawUrl) {
    const cleaned = decodeURIComponent(rawUrl).replace('https://sa.aqar.fm', '');
    const parts = cleaned.split('/').filter(Boolean);
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
    return /-\d{4,}$/.test(url.replace(/\/$/, ''));
}

function normalizeAqarUrl(rawUrl, baseUrl = 'https://sa.aqar.fm') {
    if (!rawUrl || rawUrl.startsWith('#') || rawUrl.startsWith('mailto:') || rawUrl.startsWith('tel:')) return null;
    try {
        return new URL(rawUrl, baseUrl).toString().replace(/\/$/, '');
    } catch {
        return null;
    }
}

function enqueuePage(rawUrl, baseUrl, options = {}) {
    if (pageQueue.length + SEEN_PAGES.size >= MAX_RESULT_PAGES) return;

    const url = normalizeAqarUrl(rawUrl, baseUrl);
    if (!url || !url.startsWith('https://sa.aqar.fm/') || SEEN_PAGES.has(url) || pageQueue.includes(url)) return;
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

    const idMatch = sourceUrl.match(/-(\d{4,})$/);
    const listingId = idMatch ? idMatch[1] : null;
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
    const response = await client.fetch(url);

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    if (!html || html.length < 1000) {
        throw new Error('Empty response');
    }

    return html;
}

async function flushData(force = false) {
    if (dataBuffer.length === 0 || (!force && dataBuffer.length < BATCH_SIZE)) return;

    const batch = dataBuffer.splice(0, dataBuffer.length);
    await Dataset.pushData(batch);
    log.info(`Saved ${saved}/${RESULTS_WANTED_N} items`);
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
        log.warning(`Detail fetch failed: ${error.message}`);
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
                    log.warning(`No listing found on ${url}`);
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

            log.info(`Processed ${SEEN_PAGES.size} result pages; queue ${pageQueue.length}; saved ${saved}/${RESULTS_WANTED_N}`);
        } catch (error) {
            log.warning(`Skipped one page: ${error.message}`);
        }
    }

    await flushData(true);
}

async function main() {
    log.info(`Aqar.fm Property Scraper — ${initial.length} URL(s), ${RESULTS_WANTED_N} results max`);

    await fetchAndExtract(initial);

    log.info(`Done. ${saved} properties saved.`);
}

await main().catch(err => {
    log.error(err.message);
    process.exit(1);
});

await Actor.exit();
