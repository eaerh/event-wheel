from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from typing import Optional
import re
import requests
from bs4 import BeautifulSoup
from dateutil import parser as dateparser


@dataclass
class ScrapedEvent:
    title: str
    source: str
    date: Optional[datetime] = None
    location: Optional[str] = None
    url: Optional[str] = None
    description: Optional[str] = None
    image_url: Optional[str] = None
    category: Optional[str] = None


class BaseScraper(ABC):
    """Base class for event scrapers. Extend this to add new sources."""

    name: str = "base"
    base_url: str = ""

    def fetch_page(self, url: str) -> BeautifulSoup:
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            )
        }
        response = requests.get(url, headers=headers, timeout=15)
        response.raise_for_status()
        # Use response.content so BeautifulSoup auto-detects charset from
        # the HTML <meta charset> tag (csid.no declares utf-8 in HTML but
        # the HTTP header incorrectly says ISO-8859-1).
        return BeautifulSoup(response.content, "lxml")

    @abstractmethod
    def scrape(self, from_date: Optional[str] = None, to_date: Optional[str] = None) -> list[ScrapedEvent]:
        """Scrape events from the source. Implement in subclass."""
        pass


class CsidScraper(BaseScraper):
    """Scrapes concerts/events in Oslo from csid.no."""

    name = "csid"
    base_url = "https://csid.no"

    def _fetch_summary(self, event_url: str) -> Optional[str]:
        """Fetch the event summary from CSID's pre-cached JSON summaries."""
        import hashlib
        if not event_url:
            return None
        try:
            h = hashlib.sha1(event_url.encode()).hexdigest()
            summary_url = f"https://csid.no/summaries/{h[:3]}/{h[3:]}-data.json"
            resp = requests.get(summary_url, timeout=5)
            if resp.status_code == 200:
                data = resp.json()
                summary = data.get("summary", "").strip()
                # Summary often starts with the event title — return the rest
                return summary[:300] if summary else None
        except Exception:
            pass
        return None

    @staticmethod
    def _parse_time_from_description(desc: str, event_date: Optional[datetime]) -> Optional[datetime]:
        """Extract event start time from CSID summary text.
        
        Prefers actual start time over door-open time:
          "Konsert starter 21:30" > "Dørene åpner 21:00"
          "Starttid: 20:00" > "Doors: 19:00"
        """
        if not desc:
            return event_date

        # Patterns ordered by priority (start time > doors)
        start_patterns = [
            r"(?:konsert|show|arrangement)\s+starter\s+(?:kl\.?\s*)?(\d{1,2})[:.:](\d{2})",
            r"starttid[:\s]+(\d{1,2})[:.:](\d{2})",
            r"start[:\s]+(\d{1,2})[:.:](\d{2})",
            # Norwegian schedule format: "26. mars 2026 20.00"
            r"\d{4}\s+(\d{1,2})[.](\d{2})\s",
        ]
        door_patterns = [
            r"d[øo]rene\s+[åa]pner\s+(?:kl\.?\s*)?(\d{1,2})[:.:](\d{2})",
            r"doors[:\s]+(\d{1,2})[:.:](\d{2})",
        ]

        hour, minute = None, None
        # Try start patterns first
        for pat in start_patterns:
            m = re.search(pat, desc, re.IGNORECASE)
            if m:
                hour, minute = int(m.group(1)), int(m.group(2))
                break
        # Fall back to door patterns
        if hour is None:
            for pat in door_patterns:
                m = re.search(pat, desc, re.IGNORECASE)
                if m:
                    hour, minute = int(m.group(1)), int(m.group(2))
                    break

        if hour is not None and 0 <= hour <= 23 and 0 <= minute <= 59:
            if event_date:
                return event_date.replace(hour=hour, minute=minute)
            return datetime(2000, 1, 1, hour, minute)

        return event_date

    @staticmethod
    def _parse_category_from_description(desc: str) -> Optional[str]:
        """Extract event type hints from CSID summary text."""
        if not desc:
            return None
        dl = desc.lower()
        # Map Norwegian/English keywords to categories
        mappings = [
            (["quiz"], "quiz"),
            (["stand-up", "standup", "komedie"], "stand-up"),
            (["teater", "theatre"], "theatre"),
            (["utstilling", "exhibition"], "exhibition"),
            (["konsert", "concert", "live"], "concert"),
            (["dj", "klubb", "club"], "nightlife"),
            (["film", "kino", "cinema"], "film"),
        ]
        for keywords, cat in mappings:
            if any(kw in dl for kw in keywords):
                return cat
        return None

    def scrape(self, from_date: Optional[str] = None, to_date: Optional[str] = None) -> list[ScrapedEvent]:
        soup = self.fetch_page(self.base_url)
        events: list[ScrapedEvent] = []
        current_date: Optional[datetime] = None

        for row in soup.select("table.events tr"):
            # Date header rows
            if "date" in row.get("class", []):
                date_text = row.get_text(strip=True)
                try:
                    current_date = dateparser.parse(date_text, fuzzy=True)
                except (ValueError, TypeError):
                    current_date = None
                continue

            # Event rows have a 'date' attribute
            date_attr = row.get("date")
            if not date_attr:
                continue

            cells = row.find_all("td")
            if len(cells) < 2:
                continue

            # Extract title and URL from first cell
            link = cells[0].find("a")
            title = link.get_text(strip=True) if link else cells[0].get_text(strip=True)
            url = link.get("href") if link else None

            if not title:
                continue

            # Venue from second cell (venue name, not city)
            venue = cells[1].get_text(strip=True) if len(cells) > 1 else None

            # Parse date from the row attribute
            event_date = None
            try:
                event_date = datetime.strptime(date_attr, "%Y-%m-%d")
            except (ValueError, TypeError):
                event_date = current_date

            # Filter by date range if specified
            if from_date and event_date:
                try:
                    fd = datetime.strptime(from_date, "%Y-%m-%d")
                    if event_date.date() < fd.date():
                        continue
                except ValueError:
                    pass
            if to_date and event_date:
                try:
                    td = datetime.strptime(to_date, "%Y-%m-%d")
                    if event_date.date() > td.date():
                        continue
                except ValueError:
                    pass

            events.append(
                ScrapedEvent(
                    title=title,
                    source=self.name,
                    date=event_date,
                    location=venue,
                    url=url,
                    category="concert",
                )
            )

        # Fetch summaries and extract time/category from description text
        for event in events[:60]:
            desc = self._fetch_summary(event.url)
            if desc:
                event.description = desc
                event.date = self._parse_time_from_description(desc, event.date)
                parsed_cat = self._parse_category_from_description(desc)
                if parsed_cat:
                    event.category = parsed_cat

        return events


class VisitOsloScraper(BaseScraper):
    """
    Scrapes events from visitoslo.com.

    The events grid is a Craft CMS Sprig (htmx) component paginated 12/page.
    Cloudflare blocks pagination XHRs from headless browsers, so this runs
    headed. URL params for date/category are ignored server-side — the
    scraper walks pages until it passes the requested to_date, then filters
    client-side.

    Requires Playwright with Chromium installed:
        uv run playwright install chromium
    """

    name = "visitoslo"
    base_url = "https://www.visitoslo.com/en/whats-on/events/"

    # Month abbreviations from the date wedge — visitoslo uses English on /en/
    # but includes Norwegian variants (mai/okt/des) as a safety net.
    MONTH_ABBR = {
        "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
        "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
        "mai": 5, "okt": 10, "des": 12,
    }

    # Safety cap so we can't loop forever if pagination breaks
    MAX_PAGES = 60
    # Cap detail-page enrichment to keep scrape latency bounded
    MAX_DETAIL_ENRICH = 40

    def _create_browser(self, headless: bool = True):
        """Create a Playwright browser + context configured to bypass Cloudflare."""
        from playwright.sync_api import sync_playwright

        pw = sync_playwright().start()
        args = [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
        ]
        if headless:
            args.append("--headless=new")
        browser = pw.chromium.launch(headless=headless, args=args)
        ctx = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/122.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 900},
            locale="en-US",
        )
        return pw, browser, ctx

    def _new_page(self, ctx):
        """Create a new page with webdriver property removed."""
        page = ctx.new_page()
        page.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )
        return page

    def _dismiss_cookie_banner(self, page) -> None:
        """Dismiss the cookie consent banner if present."""
        for label in ["Accept all", "Godta alle", "OK", "Accept"]:
            try:
                btn = page.locator(f'button:has-text("{label}")').first
                if btn.count() > 0 and btn.is_visible():
                    btn.click(timeout=3000)
                    page.wait_for_timeout(500)
                    return
            except Exception:
                pass
        # Fallback: try to remove the banner via JS
        try:
            page.evaluate("""
                const el = document.getElementById('cookie-information-template-wrapper');
                if (el) el.remove();
            """)
        except Exception:
            pass

    def _load_first_page(self, page) -> None:
        """Load the events listing base URL and wait for cards to render."""
        page.goto(self.base_url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(3000)
        self._dismiss_cookie_banner(page)
        try:
            page.wait_for_selector(
                "article.content-card[data-variant='event']", timeout=15000
            )
        except Exception:
            pass

    def _first_card_title(self, page) -> str:
        try:
            first = page.locator("article.content-card[data-variant='event'] h3").first
            if first.count() > 0:
                return first.inner_text(timeout=1000).strip()
        except Exception:
            pass
        return ""

    def _click_next_page(self, page, target_page: int) -> bool:
        """Trigger htmx navigation to `target_page`. Returns True if the DOM swapped."""
        before = self._first_card_title(page)

        # Find and click the pagination anchor whose data-hx-vals references page=N.
        # Using htmx.trigger ensures the swap happens (a bare click bubbles through
        # the parent's hx-trigger="refresh" without hitting the intended handler).
        script = (
            "() => {"
            "  const marker = '\"page\":\"' + %d + '\"';"
            "  const a = Array.from(document.querySelectorAll('a[data-hx-vals]'))"
            "    .find(el => (el.getAttribute('data-hx-vals')||'').includes(marker));"
            "  if (!a) return 'not-found';"
            "  if (typeof htmx !== 'undefined' && htmx.trigger) {"
            "    htmx.trigger(a, 'click');"
            "    return 'triggered';"
            "  }"
            "  a.click();"
            "  return 'clicked';"
            "}"
        ) % target_page
        result = page.evaluate(script)
        if result == "not-found":
            return False

        # Wait for the swap: the first card's title changes.
        for _ in range(20):
            page.wait_for_timeout(300)
            now_title = self._first_card_title(page)
            if now_title and now_title != before:
                page.wait_for_timeout(500)  # settle
                return True
        return False

    def _parse_month_day(self, day_str: str, month_str: str) -> Optional[datetime]:
        """Turn '17' + 'aug' into a datetime, guessing the year."""
        day_digits = re.sub(r"\D", "", day_str or "")
        try:
            day = int(day_digits)
        except ValueError:
            return None
        month = self.MONTH_ABBR.get((month_str or "").strip().lower()[:3])
        if not month:
            return None
        now = datetime.now()
        try:
            candidate = datetime(now.year, month, day)
        except ValueError:
            return None
        # Wrap to next year if the wedge points to a clearly-past date
        if (now - candidate).days > 60:
            try:
                candidate = datetime(now.year + 1, month, day)
            except ValueError:
                return None
        return candidate

    def _parse_page(self, html: str) -> list[ScrapedEvent]:
        """Parse all event cards on the current listing page."""
        soup = BeautifulSoup(html, "lxml")

        page_title = soup.title.get_text(strip=True) if soup.title else ""
        if "just a moment" in page_title.lower() or "security" in page_title.lower():
            raise RuntimeError(
                "Cloudflare challenge was not solved. "
                "The browser must be visible to pass the check."
            )

        events: list[ScrapedEvent] = []
        for card in soup.select("article.content-card[data-variant='event']"):
            ev = self._parse_card(card)
            if ev:
                events.append(ev)
        return events

    def _parse_card(self, card) -> Optional[ScrapedEvent]:
        """Parse a single content-card article into a ScrapedEvent."""
        # URL — first <a> pointing at /event/<slug>
        link = card.find(
            "a", href=lambda h: h and "visitoslo.com/event/" in str(h)
        )
        url = link.get("href") if link else None

        # Title — <h3> inside the card body
        h3 = card.find("h3")
        title = h3.get_text(strip=True) if h3 else None
        if not title:
            return None

        # Date wedge — <p class="font-heading"> with day & month spans
        event_date = None
        wedge = card.select_one("p.font-heading")
        if wedge:
            spans = wedge.find_all("span")
            if len(spans) >= 2:
                event_date = self._parse_month_day(
                    spans[0].get_text(strip=True),
                    spans[1].get_text(strip=True),
                )

        # Category pills. First pill == 'Ad' marks a sponsored slot; skip it.
        pills: list[str] = []
        for pill in card.select("span.content-card__pill span.caption"):
            txt = pill.get_text(strip=True)
            if txt:
                pills.append(txt)
        if pills and pills[0].lower() == "ad":
            return None
        category_str = ", ".join(pills) if pills else None

        # Icon rows for time & location. Icon <img src> tells them apart.
        time_str = None
        location = None
        for li in card.select("ul li"):
            img = li.find("img")
            src = (img.get("src", "") if img else "").lower()
            span = li.select_one("span.caption")
            text = span.get_text(strip=True) if span else ""
            if not text:
                continue
            if "time" in src:
                time_str = text
            elif "location" in src:
                location = text

        if event_date and time_str:
            m = re.match(r"^(\d{1,2})[:.](\d{2})", time_str)
            if m:
                event_date = event_date.replace(
                    hour=int(m.group(1)), minute=int(m.group(2))
                )

        # Image — first <img> in the card, but ignore the icon svgs
        image_url = None
        media_img = card.select_one(".content-card__media img")
        if media_img:
            image_url = media_img.get("src")

        return ScrapedEvent(
            title=title,
            source=self.name,
            date=event_date,
            location=location,
            url=url,
            image_url=image_url,
            category=category_str,
        )

    def _scrape_detail_page(self, page, event: ScrapedEvent) -> None:
        """Enrich a ScrapedEvent from its detail page (description only)."""
        if not event.url or event.description:
            return
        try:
            page.goto(event.url, wait_until="domcontentloaded", timeout=20000)
            page.wait_for_timeout(800)
            html = page.content()
        except Exception:
            return
        soup = BeautifulSoup(html, "lxml")
        meta = soup.find("meta", attrs={"name": "description"})
        if meta and meta.get("content"):
            desc = meta["content"].strip()
            if desc:
                event.description = desc[:300]

    def scrape(self, from_date: Optional[str] = None, to_date: Optional[str] = None) -> list[ScrapedEvent]:
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            raise RuntimeError(
                "visitoslo scraper requires Playwright. Install with:\n"
                "  uv add playwright && uv run playwright install chromium"
            )

        from datetime import timedelta

        today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)

        fd_date = None
        td_date = None
        if from_date:
            try:
                fd_date = datetime.fromisoformat(from_date).date()
            except (ValueError, TypeError):
                fd_date = None
        if to_date:
            try:
                td_date = datetime.fromisoformat(to_date).date()
            except (ValueError, TypeError):
                td_date = None
        if not td_date:
            td_date = (today + timedelta(days=30)).date()

        # Cloudflare blocks the paginated Sprig XHR from headless browsers,
        # so this scraper runs headed for the whole session.
        pw, browser, ctx = self._create_browser(headless=False)
        events: list[ScrapedEvent] = []
        seen_keys: set[str] = set()

        try:
            page = self._new_page(ctx)
            self._load_first_page(page)

            passed_end_date = False
            current_page = 1
            for _ in range(self.MAX_PAGES):
                page_events = self._parse_page(page.content())
                if not page_events:
                    break

                for ev in page_events:
                    key = ev.url or ev.title.lower().strip()
                    if key in seen_keys:
                        continue
                    seen_keys.add(key)

                    if ev.date:
                        d = ev.date.date()
                        if fd_date and d < fd_date:
                            continue
                        if td_date and d > td_date:
                            passed_end_date = True
                            continue
                    events.append(ev)

                if passed_end_date:
                    break

                current_page += 1
                if not self._click_next_page(page, current_page):
                    break

            # Best-effort detail enrichment (description only)
            for ev in events[: self.MAX_DETAIL_ENRICH]:
                try:
                    self._scrape_detail_page(page, ev)
                except Exception:
                    continue

            page.close()
        finally:
            browser.close()
            pw.stop()

        if not events:
            raise RuntimeError(
                "No events found on visitoslo.com. "
                "The site structure may have changed again."
            )
        return events


class DemoScraper(BaseScraper):
    """Demo scraper that returns sample events for testing."""

    name = "demo"
    base_url = "https://example.com/events"

    def scrape(self, from_date: Optional[str] = None, to_date: Optional[str] = None) -> list[ScrapedEvent]:
        return [
            ScrapedEvent(
                title="Tech Meetup: AI & Machine Learning",
                source=self.name,
                date=datetime(2026, 4, 15, 18, 0),
                location="Innovation Hub, Downtown",
                url="https://example.com/events/tech-meetup",
                description="Join us for an evening of talks about the latest in AI.",
            ),
            ScrapedEvent(
                title="Local Music Festival",
                source=self.name,
                date=datetime(2026, 4, 20, 14, 0),
                location="Central Park",
                url="https://example.com/events/music-fest",
                description="Live music from local bands all afternoon.",
            ),
            ScrapedEvent(
                title="Cooking Workshop: Italian Cuisine",
                source=self.name,
                date=datetime(2026, 4, 22, 10, 0),
                location="Community Kitchen",
                url="https://example.com/events/cooking",
                description="Learn to make authentic pasta from scratch.",
            ),
            ScrapedEvent(
                title="Outdoor Movie Night",
                source=self.name,
                date=datetime(2026, 5, 1, 20, 0),
                location="Riverside Amphitheater",
                url="https://example.com/events/movie-night",
                description="Classic films under the stars.",
            ),
            ScrapedEvent(
                title="Art Gallery Opening",
                source=self.name,
                date=datetime(2026, 5, 5, 19, 0),
                location="Modern Art Museum",
                url="https://example.com/events/gallery",
                description="New exhibition featuring local artists.",
            ),
        ]


# Registry of available scrapers
SCRAPERS: dict[str, type[BaseScraper]] = {
    "csid": CsidScraper,
    "visitoslo": VisitOsloScraper,
    "demo": DemoScraper,
}


def get_scraper(name: str) -> BaseScraper:
    if name not in SCRAPERS:
        raise ValueError(f"Unknown scraper: {name}. Available: {list(SCRAPERS.keys())}")
    return SCRAPERS[name]()


def list_scrapers() -> list[str]:
    return list(SCRAPERS.keys())
