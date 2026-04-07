# Event Wheel 🎡

A system that scrapes event websites, stores relevant events, and features a random wheel picker to choose your next adventure!

## Features

- **Event Scraping**: Configurable scrapers to pull events from various sources
- **Event Storage**: SQLite database to store and manage events
- **Spin Wheel**: Fun animated wheel to randomly pick an event
- **Event List**: Browse all events with details

## Built-in Scrapers

| Source | Website | Method | Notes |
|--------|---------|--------|-------|
| `csid` | [csid.no](https://csid.no) | BeautifulSoup | Concerts & events in Oslo. Works out of the box |
| `visitoslo` | [visitoslo.com](https://www.visitoslo.com/en/whats-on/events/) | Playwright | Broader Oslo events. Requires Playwright (Cloudflare-protected) |
| `demo` | — | Static data | Sample events for testing |

## Quick Start

### Prerequisites

- Python 3.10+
- Node.js 18+ (for frontend)

### Backend Setup

```bash
cd backend

# Install dependencies (uses uv)
uv sync

# Install browser for visitoslo.com scraper
uv run playwright install chromium

# Run the server
uv run python main.py
```

The API will be available at http://localhost:8000

### Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Run development server
npm run dev
```

The app will be available at http://localhost:5173

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/events` | List all events |
| GET | `/events/random` | Get a random event |
| DELETE | `/events/{id}` | Delete an event |
| DELETE | `/events` | Delete all events |
| GET | `/scrapers` | List available scrapers |
| POST | `/scrape` | Scrape events from a source |

## Adding Custom Scrapers

Create a new scraper in `backend/scraper.py`:

```python
class MyScraper(BaseScraper):
    name = "my-source"
    base_url = "https://example.com/events"

    def scrape(self) -> list[ScrapedEvent]:
        soup = self.fetch_page(self.base_url)
        events = []
        
        for item in soup.select('.event-item'):
            events.append(ScrapedEvent(
                title=item.select_one('.title').text,
                source=self.name,
                date=parse_date(item.select_one('.date').text),
                location=item.select_one('.location').text,
                url=item.select_one('a')['href'],
            ))
        
        return events

# Register it
SCRAPERS["my-source"] = MyScraper
```

## Project Structure

```
event-wheel/
├── backend/
│   ├── main.py          # FastAPI application
│   ├── models.py        # Database models
│   ├── database.py      # Database connection
│   ├── scraper.py       # Scraper framework
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.tsx      # Main application
│   │   ├── api.ts       # API client
│   │   └── components/  # React components
│   └── package.json
└── README.md
```

## Tech Stack

- **Backend**: Python, FastAPI, SQLAlchemy, BeautifulSoup
- **Frontend**: React, TypeScript, Vite
- **Database**: SQLite
