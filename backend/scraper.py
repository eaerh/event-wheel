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

    Requires Playwright with Chromium installed:
        uv run playwright install chromium
    """

    name = "visitoslo"
    base_url = "https://www.visitoslo.com/en/whats-on/events/"

    # Known visitoslo category keywords
    CATEGORIES = {
        "concert", "festival", "theatre", "exhibition", "sport",
        "annual events", "major events", "classical concerts",
        "rock/pop", "folk music", "jazz", "electronic", "hip-hop",
        "dance", "opera", "comedy", "family", "outdoor", "food",
        "market", "film", "art", "children", "nightlife",
        "show", "stand-up", "standup", "quiz", "workshop", "talk", "music",
        "guided tour", "lecture", "performance", "party",
        "musical", "english event", "sacred",
        # Genre/style categories
        "country", "ballet", "choir", "club", "hip hop",
        "hard rock/metal", "skiing", "jazz concerts",
        "r&b", "soul", "blues", "world music", "pop",
        "rock", "metal", "punk", "reggae", "latin",
    }

    # All category IDs used by visitoslo.com event calendar
    CATEGORY_IDS = (
        "505552,506042,507212,507232,505772,506922,506802,519862,"
        "506032,513572,506232,505792,500602,508172,508182,502032,"
        "507222,509172"
    )

    def _build_url(self, from_date: Optional[str] = None, to_date: Optional[str] = None) -> str:
        """Build URL with all required params (CategoryIds + offset + dates)."""
        url = self.base_url
        params = [
            f"CategoryIds={self.CATEGORY_IDS}",
            "offset=0",
        ]
        if from_date:
            params.append(f"FromDate={from_date}")
        if to_date:
            params.append(f"ToDate={to_date}")
        return url + "?" + "&".join(params)

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

    def _load_listing(self, page, target_url: str) -> str:
        """Load listing page, scroll to load all events, return HTML."""
        page.goto(target_url, wait_until="domcontentloaded", timeout=60000)

        # Dismiss cookie banner (blocks interactions if present)
        page.wait_for_timeout(2000)
        self._dismiss_cookie_banner(page)

        for _ in range(30):
            page.wait_for_timeout(1000)
            if page.locator('a[href*="/whats-on/events/?tlp="]').count() > 0:
                break

        # Scroll to load all lazy/infinite-scroll events
        prev_count = 0
        stale_rounds = 0
        for _ in range(20):
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(2000)
            for btn_text in ["Show more", "Load more", "Vis flere", "See more"]:
                btn = page.locator(f'button:has-text("{btn_text}")').first
                if btn.count() > 0 and btn.is_visible():
                    try:
                        btn.click()
                        page.wait_for_timeout(2000)
                    except Exception:
                        pass
            cur_count = page.locator('a[href*="/whats-on/events/?tlp="]').count()
            if cur_count == prev_count:
                stale_rounds += 1
                if stale_rounds >= 2:
                    break
            else:
                stale_rounds = 0
            prev_count = cur_count

        return page.content()

    def _parse_listing(self, html: str) -> list[ScrapedEvent]:
        """Parse event links from listing HTML, deduped by tlp= ID."""
        soup = BeautifulSoup(html, "lxml")

        title_el = soup.find("title")
        page_title = title_el.get_text(strip=True) if title_el else ""
        if "just a moment" in page_title.lower() or "security" in page_title.lower():
            raise RuntimeError(
                "Cloudflare challenge was not solved. "
                "Try again — the browser needs to be visible to pass the check."
            )

        links = soup.find_all(
            "a", href=lambda h: h and "/whats-on/events/?tlp=" in str(h)
        )

        # Group links by tlp= ID to dedup duplicate <a> tags for the same event
        by_tlp: dict[str, list] = {}
        for link in links:
            href = link.get("href", "")
            tlp_match = re.search(r"tlp=(\w+)", href)
            tlp_id = tlp_match.group(1) if tlp_match else href
            by_tlp.setdefault(tlp_id, []).append(link)

        events: list[ScrapedEvent] = []
        now = datetime.now()
        current_year = now.year

        for tlp_id, link_group in by_tlp.items():
            # Parse each <a> variant and pick the best one
            best = self._parse_single_link(link_group[0], now, current_year)
            for link in link_group[1:]:
                alt = self._parse_single_link(link, now, current_year)
                if alt and (not best or self._event_richness(alt) > self._event_richness(best)):
                    best = alt
            if best:
                events.append(best)

        return events

    @staticmethod
    def _event_richness(ev: ScrapedEvent) -> int:
        """Score how much data an event has (higher = richer)."""
        score = 0
        if ev.title:
            score += 3
            # Penalize category-word titles (e.g., "country", "concert")
            if ev.title.lower() in VisitOsloScraper.CATEGORIES:
                score -= 2
        if ev.date:
            score += 2
            if ev.date.hour != 0 or ev.date.minute != 0:
                score += 1
        if ev.location:
            score += 1
        if ev.description:
            score += 1
        if ev.image_url:
            score += 1
        if ev.category:
            score += 1
        return score

    def _parse_single_link(self, link, now, current_year) -> Optional[ScrapedEvent]:
        """Parse a single <a> tag into a ScrapedEvent."""
        href = link.get("href", "")
        url = f"https://www.visitoslo.com{href}" if href.startswith("/") else href

        img_tag = link.find("img")
        image_url = img_tag.get("src") if img_tag else None

        parts = [p.strip() for p in link.get_text(separator="|", strip=True).split("|")]

        offset = 0
        if parts and parts[0].lower().startswith("photo"):
            offset = 2
        elif parts and not parts[0].isdigit():
            for j, p in enumerate(parts):
                if p.isdigit():
                    offset = j
                    break

        if offset + 2 >= len(parts):
            name_match = re.search(r"name=([^&]+)", href)
            if name_match:
                return ScrapedEvent(
                    title=name_match.group(1).replace("-", " "),
                    source=self.name,
                    url=url,
                    image_url=image_url,
                )
            return None

        day_str = parts[offset]
        month_str = parts[offset + 1]

        title = None
        description = None
        event_categories: list[str] = []
        for i, part in enumerate(parts[offset + 2:], start=offset + 2):
            if part.lower() in self.CATEGORIES:
                event_categories.append(part.lower())
            else:
                title = part
                if i + 1 < len(parts):
                    description = " ".join(parts[i + 1:])
                break

        # Guard: if title ended up as a category word, prefer the URL name= param
        if title and title.lower() in self.CATEGORIES:
            event_categories.append(title.lower())
            name_match = re.search(r"name=([^&]+)", href)
            if name_match:
                title = name_match.group(1).replace("-", " ")
            # else keep the category-word title as last resort

        if not title:
            name_match = re.search(r"name=([^&]+)", href)
            title = name_match.group(1).replace("-", " ") if name_match else None

        if not title:
            return None

        # Deduplicate categories
        category_str = ", ".join(sorted(set(event_categories))) if event_categories else None

        event_date = None
        try:
            event_date = dateparser.parse(
                f"{day_str} {month_str} {current_year}", fuzzy=True
            )
            if event_date and (now - event_date).days > 60:
                event_date = event_date.replace(year=current_year + 1)
        except (ValueError, TypeError):
            pass

        return ScrapedEvent(
            title=title,
            source=self.name,
            date=event_date,
            url=url,
            description=description,
            image_url=image_url,
            category=category_str,
        )

    def _scrape_detail_page(self, page, event: ScrapedEvent, target_date: Optional[str], is_first: bool = False) -> None:
        """Visit an event's detail page and enrich it with time/description data."""
        import json as _json

        if not event.url:
            return

        try:
            page.goto(event.url, wait_until="domcontentloaded", timeout=20000)
            page.wait_for_timeout(1500)
            # Dismiss cookie banner on first detail page visit
            if is_first:
                self._dismiss_cookie_banner(page)
                page.wait_for_timeout(1000)
            html = page.content()
        except Exception:
            return

        # Extract the React ProductPresentationPage JSON
        match = re.search(r"ProductPresentationPage,\s*(\{.*?\})\)\)", html)
        if not match:
            return

        try:
            data = _json.loads(match.group(1))
        except _json.JSONDecodeError:
            return

        prod = data.get("product", data)

        # Extract description
        desc = prod.get("description", "")
        if isinstance(desc, str) and desc and not event.description:
            event.description = desc[:300]

        # Extract venue from openingLocation (actual venue name, not city)
        venue = prod.get("openingLocation", "")
        if venue:
            event.location = venue
        else:
            # Fallback: try address street
            addr = prod.get("address", {})
            if isinstance(addr, dict):
                street = addr.get("street", "")
                if street:
                    event.location = street

        # Extract image if not already set
        images = prod.get("images", [])
        if isinstance(images, list) and images and not event.image_url:
            event.image_url = images[0].get("url")

        # Extract time from eventItems matching the target date
        event_items = prod.get("eventItems", []) or []
        if not isinstance(event_items, list):
            return

        for item in event_items:
            if not isinstance(item, dict):
                continue
            from_time = item.get("fromTime")
            if not from_time:
                continue

            # If we have a target date, match only eventItems for that date
            if target_date:
                item_from = item.get("fromDate", "")
                if isinstance(item_from, str) and target_date in item_from:
                    try:
                        dt = datetime.fromisoformat(from_time.replace("Z", ""))
                        if event.date:
                            event.date = event.date.replace(hour=dt.hour, minute=dt.minute)
                        else:
                            event.date = dt
                    except (ValueError, TypeError):
                        pass
                    break
            else:
                # No target date — use the first eventItem with a time
                try:
                    dt = datetime.fromisoformat(from_time.replace("Z", ""))
                    if event.date:
                        event.date = event.date.replace(hour=dt.hour, minute=dt.minute)
                    else:
                        event.date = dt
                except (ValueError, TypeError):
                    pass
                break

    def _enrich_with_details(self, events: list[ScrapedEvent], target_date: Optional[str]) -> None:
        """Visit detail pages in a headed browser to extract times and descriptions."""
        # Detail pages need headed mode (cookie consent + JS routing)
        pw, browser, ctx = self._create_browser(headless=False)
        try:
            page = self._new_page(ctx)
            for i, event in enumerate(events):
                self._scrape_detail_page(page, event, target_date, is_first=(i == 0))
            page.close()
        finally:
            browser.close()
            pw.stop()

    def scrape(self, from_date: Optional[str] = None, to_date: Optional[str] = None) -> list[ScrapedEvent]:
        try:
            from playwright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            raise RuntimeError(
                "visitoslo scraper requires Playwright. Install with:\n"
                "  uv add playwright && uv run playwright install chromium"
            )

        from datetime import timedelta

        today = datetime.now()

        # Use headless for listing (invisible, fast)
        pw, browser, ctx = self._create_browser(headless=True)

        try:
            if from_date and to_date:
                url = self._build_url(from_date, to_date)
                page = self._new_page(ctx)
                html = self._load_listing(page, url)
                page.close()
                events = self._parse_listing(html)
                if not events:
                    raise RuntimeError(
                        f"No events found on visitoslo.com for {from_date} to {to_date}"
                    )
            else:
                # Default: load multiple windows covering ~30 days
                events = []
                seen_titles: set[str] = set()

                windows = [
                    (today.strftime("%Y-%m-%d"), (today + timedelta(days=7)).strftime("%Y-%m-%d")),
                    ((today + timedelta(days=7)).strftime("%Y-%m-%d"), (today + timedelta(days=14)).strftime("%Y-%m-%d")),
                    ((today + timedelta(days=14)).strftime("%Y-%m-%d"), (today + timedelta(days=30)).strftime("%Y-%m-%d")),
                ]

                for from_d, to_d in windows:
                    url = self._build_url(from_d, to_d)
                    try:
                        page = self._new_page(ctx)
                        html = self._load_listing(page, url)
                        page.close()
                        parsed = self._parse_listing(html)
                        for ev in parsed:
                            key = ev.title.lower().strip()
                            if key not in seen_titles:
                                seen_titles.add(key)
                                events.append(ev)
                    except Exception:
                        continue

                if not events:
                    raise RuntimeError("No events found from visitoslo.com")
        finally:
            browser.close()
            pw.stop()

        # Enrich with detail pages (separate headed browser)
        try:
            self._enrich_with_details(events, from_date)
        except Exception:
            pass  # Detail enrichment is optional; listing data is still useful

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
