# Aqar.fm Property Scraper

Extract comprehensive property listings from Aqar.fm, Saudi Arabia's leading real estate marketplace. Collect detailed property data including prices, areas, room counts, descriptions, and images at scale. Perfect for real estate market research, investment analysis, and property portfolio monitoring.

## Features

- **Full Property Details** - Extract prices in SAR, area in m2, bedrooms, bathrooms, living rooms, and descriptions
- **Multi-Property Support** - Works with apartments, villas, lands, buildings, and all property types on Aqar.fm
- **Dual Language** - Supports both English and Arabic URLs with proper field mapping
- **Rich Media** - Collects primary image URLs and gallery image URLs when available
- **Rich Records by Default** - Search pages are enriched with listing detail data before records are saved
- **Deduplication** - Built-in ID deduplication prevents duplicate listings across multiple pages
- **Proxy Support** - Compatible with Apify Proxy for reliable large-scale extraction

## Use Cases

### Real Estate Market Research
Analyze property prices, sizes, and availability across Saudi Arabian cities including Riyadh, Jeddah, Dammam, Makkah, and Madinah. Compare rental and sale listings to identify market trends.

### Investment Analysis
Track property values in specific neighborhoods and districts. Monitor listing prices and property features to identify investment opportunities across different property types.

### Competitive Intelligence
Monitor competitor listings and pricing strategies in the Saudi real estate market. Build comprehensive datasets for business intelligence and decision making.

### Property Portfolio Management
Collect and archive property listings for portfolio analysis. Track changes in listing prices, availability, and property features over time.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `startUrl` | String | No | `https://sa.aqar.fm/en/all` | Search or listing URL. Takes priority over the filters below. |
| `propertyType` | String | No | — | Property category (e.g. apartment-for-rent, villa-for-sale). Used only when no URL is provided. |
| `location` | String | No | — | City slug (riyadh, jeddah, dammam...). Requires a property type when no URL is provided. |
| `minPrice` | Integer | No | — | Minimum price in SAR. |
| `maxPrice` | Integer | No | — | Maximum price in SAR. |
| `bedrooms` | Integer | No | — | Minimum number of bedrooms. |
| `bathrooms` | Integer | No | — | Minimum number of bathrooms. |
| `furnished` | Boolean | No | `false` | Only furnished listings. |
| `family` | String | No | — | `family` or `singles`. |
| `results_wanted` | Integer | No | `20` | Maximum number of results to collect. |
| `proxyConfiguration` | Object | No | — | Apify Proxy configuration. |

> Note: Result sorting is handled client-side by Aqar.fm and is not available through the server-rendered pages, so no sort option is exposed. All filters listed above are verified to work through Aqar.fm URL query parameters.

---

## Output Data

Each item in the dataset contains:

| Field | Type | Description |
|-------|------|-------------|
| `listing_id` | String | Unique listing ID from Aqar.fm |
| `title` | String | Property listing title |
| `price` | String | Property price in SAR (numeric only) |
| `currency` | String | Currency (always SAR) |
| `area_m2` | String | Property area in square meters |
| `bedrooms` | String | Number of bedrooms (null for lands) |
| `bathrooms` | String | Number of bathrooms (null for lands) |
| `living_rooms` | String | Number of living rooms (detail pages only) |
| `description` | String | Full property description text |
| `image_url` | String | Primary property image URL |
| `gallery_urls` | Array | All gallery image URLs found for the listing |
| `property_type` | String | Type (e.g. apartment-for-rent, villa-for-sale) |
| `city` | String | City name |
| `location` | String | District/neighborhood name |
| `url` | String | Full listing URL |

---

## Usage Examples

### Basic Extraction

Extract properties from a search results page:

```json
{
    "startUrl": "https://sa.aqar.fm/en/apartment-for-rent/riyadh",
    "results_wanted": 50
}
```

### Arabic URLs

Extract rich property data from Arabic Aqar.fm URLs:

```json
{
    "startUrl": "https://sa.aqar.fm/%D8%B9%D9%82%D8%A7%D8%B1%D8%A7%D8%AA",
    "results_wanted": 100
}
```

### Different City or Property Type

Scrape a different city or property type by changing `startUrl`:

```json
{
    "startUrl": "https://sa.aqar.fm/en/villa-for-sale/jeddah",
    "results_wanted": 200
}
```

---

## Sample Output

```json
{
    "listing_id": "6728031",
    "title": "Villa for Sale in Riyadh Ar Rabwah",
    "price": "4,100,000",
    "currency": "SAR",
    "area_m2": "424",
    "bedrooms": "5",
    "bathrooms": "5",
    "living_rooms": null,
    "description": "a villa and two luxury apartments for sale (suitable for residential use, investment, or housing children in independent apartments)",
    "image_url": "https://images.aqar.fm/webp/750x0/props/000847509_1781132103799.jpg",
    "gallery_urls": [
        "https://images.aqar.fm/webp/750x0/props/000847509_1781132103799.jpg",
        "https://images.aqar.fm/webp/750x0/props/000847509_1781132103800.jpg"
    ],
    "property_type": "villa-for-sale",
    "city": "riyadh",
    "location": "Ar Rabwah, Riyadh",
    "url": "https://sa.aqar.fm/en/villa-for-sale/riyadh/center-of-riyadh/ar-rabwah/villa-for-sale-6728031"
}
```

---

## Tips for Best Results

### Choose Working URLs
- Start with popular search pages like `/en/apartment-for-rent/riyadh` or `/en/villa-for-sale/jeddah`
- Verify URLs are accessible in a browser before scraping
- Use city-level pages for broader results, neighborhood pages for targeted data

### Optimize Collection Size
- Start small for testing (10-20 results) to verify data quality
- Increase to 100-500 results for production runs
- The actor automatically follows related result pages to reach higher result limits

### Plan for Rich Records
- Each search result is enriched from its detail page before saving
- Use smaller test runs (10-20 results) when checking new URL patterns
- Larger runs take longer because every saved listing is enriched with detail-page data

### Mix Property Types
- Run separate scrapes for rentals vs sales to keep data organized
- Scrape different cities in parallel for market-wide analysis
- Use both English and Arabic URLs for complete coverage

---

## Integrations

Connect your data with:

- **Google Sheets** - Export for market analysis and reporting
- **Airtable** - Build searchable property databases
- **Slack** - Get notifications on new listings
- **Make** - Create automated workflows and alerts
- **Zapier** - Trigger actions based on scraping results

### Export Formats

- **JSON** - For developers and API integrations
- **CSV** - For spreadsheet analysis
- **Excel** - For business reporting
- **XML** - For system integrations

---

## Frequently Asked Questions

### How many properties can I collect?
You can request hundreds of properties from a city-level search URL. The actor follows related result pages until it reaches `results_wanted` or no more unique listings are available.

### Can I scrape both English and Arabic listings?
Yes. The actor automatically detects whether the URL uses English (`/en/`) or Arabic paths and maps property types and cities correctly.

### What if bedrooms or bathrooms are null?
Some property types like lands and warehouses do not have bedroom or bathroom counts. These fields will be null in the output.

### Does it work with direct detail page URLs?
Yes. You can pass any Aqar.fm listing URL directly. The actor detects detail pages and extracts richer data including all images.

### Can I scrape all of Saudi Arabia?
Scrape different city pages (`/en/apartment-for-rent/riyadh`, `/en/apartment-for-rent/jeddah`, etc.) and combine the results for national coverage.

---

## Support

For issues or feature requests, contact support through the Apify Console.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [API Reference](https://docs.apify.com/api/v2)
- [Scheduling Runs](https://docs.apify.com/schedules)

---

## Legal Notice

This actor is designed for legitimate data collection purposes. Users are responsible for ensuring compliance with website terms of service and applicable laws. Use data responsibly and respect rate limits.
