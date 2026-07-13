# Aqar.fm API Discovery

## Target
`sa.aqar.fm` — Saudi Arabia real estate marketplace (Next.js SSR)

## Methods Tested

| Candidate | Profile | Status | Fields | Pagination | Decision |
|---|---|---|---:|---|---|
| `__NEXT_DATA__` | Desktop Chrome | No script tag | 0 | N/A | Rejected |
| JSON-LD `application/ld+json` | Desktop Chrome | Present but generic | 3 (name, url, image) | N/A | Rejected — no structured property data |
| RSC `text/x-component` | Desktop Chrome | Returns binary protocol | N/A | N/A | Rejected — binary, not parseable with cheerio |
| URLScan.io scan | N/A | Scanned | — | — | No hidden JSON APIs found |
| SSR HTML `a.no-underline` cards | Desktop Chrome | 200, ~300KB | 10+ (id, title, price, area, beds, baths, desc, img, location) | Client-side RSC (not server-renderable) | **Selected** |
| SSR HTML detail page | Desktop Chrome | 200, ~240KB | 15+ (all listing fields + gallery_urls[], full description, breadcrumb location) | N/A | **Selected** for automatic rich extraction |
| Linked result pages `/2`, `/3`, zone, and district pages | Desktop Chrome | 200 | 20+ per page | URL path links | **Selected** for scaling beyond first page |
| `?page=N` pagination | Desktop Chrome | 200 (same content) | — | No — server returns cached first page | Rejected |
| `?offset=N` pagination | Desktop Chrome | 200 (same content) | — | No — ignored by server | Rejected |
| `/page/N/` path | Desktop Chrome | 307 redirect | — | No — redirects to /en/all | Rejected |

## Extraction Strategy

### Primary: SSR HTML parsing (cheerio)

Aqar.fm is a Next.js site that renders all listing data server-side. Data is embedded as HTML attributes, elements, and text content — NOT in JSON scripts or API endpoints.

**Why this works:**
- Data is in the initial server-rendered HTML (no JS execution needed)
- Response is 280-330KB for listing pages, 220-250KB for detail pages
- No anti-bot protection detected (no CAPTCHA, no DataDome, no Cloudflare challenge)

### Listing card fields (cheerio selectors)
| Field | Selector |
|---|---|
| listing_id | Regex `-(\d{4,})$` from card `href` |
| title | `[class*="line-clamp-1"]` inside `a.no-underline` |
| price | `span` with `§` inside card |
| area_m2 | `li` containing `m²` inside card, strip commas |
| bedrooms | First numeric `li` text |
| bathrooms | Second numeric `li` text |
| description | `[class*="break-all"]` inside card (hidden on mobile, visible on desktop) |
| location | `p[class*="text-foreground"]` inside card |
| image_url | First `img[src*="images.aqar.fm"]` in card |
| property_type | URL path segment [1] (English: `apartment-for-rent`, Arabic: `دور-للبيع`) |
| city | URL path segment [2] (English) or [1] (Arabic) |

### Detail page fields
| Field | Selector |
|---|---|
| listing_id | Regex from URL |
| title | `h1` first element |
| price | `[class*="font-semibold"]` containing `§` |
| area_m2 | First `li` matching `m²` |
| bedrooms | First numeric-only `li` |
| bathrooms | Second numeric `li` |
| living_rooms | Third numeric `li` |
| description | `[style*="lines-count"] p` or `[class*="break-word"] p` or `[class*="line-clamp"] p` with text > 50 chars |
| gallery_urls | All `img`, `source`, `srcset`, and embedded `images.aqar.fm` URLs |
| property_type, city | URL path segments |

## Request Profile
```json
{
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
}
```

## Caveats
- Query-string pagination is not usable, but linked result-page paths such as `/2`, `/3`, city zones, and district pages are discoverable from the HTML and are used to scale runs beyond the first page.
- Arabic URLs parse differently in URL segment positions; must detect `/en/` prefix or determine Arabic/English via path.
- Detail page `li` elements include both listing spec items AND description bullet points (converted to `<li>` in description text). The first numeric values are the correct primary specs.
- `living_rooms` only available on detail pages (not listed on card view).
- `price_raw` field not included because the clean price regex is reliable enough.
