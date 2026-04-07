import csv
import io
import json
import os
import random
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from rapidfuzz import fuzz
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel

from database import engine, get_db, Base
from models import Event, Poll, PollVote
from scraper import get_scraper, list_scrapers

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Event Wheel API", version="3.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

FUZZY_THRESHOLD = 80


def _normalize_title(title: str) -> str:
    """Normalize title for comparison: lowercase, strip venue/date suffixes, normalize unicode."""
    import unicodedata
    t = title.lower().strip()
    # Strip "UTSOLGT!" / "Sold out!" / "Avlyst!" prefixes
    t = re.sub(r"^(utsolgt!?\s*|sold\s*out!?\s*|avlyst!?\s*)", "", t, flags=re.IGNORECASE)
    # Strip venue suffixes: "// VenueName", "@ VenueName", "| VenueName"
    t = re.sub(r"\s*[/|@]{1,2}\s*[A-ZÆØÅ][^/|@]*$", "", t)
    # Also strip "// whatever" style suffixes more broadly
    t = re.sub(r"\s*//.*$", "", t)
    # Strip trailing country codes like "(SE)", "(NO)", "(UK)", "(DK)", "(US)" etc.
    t = re.sub(r"\s*\([a-z]{2,3}\)\s*$", "", t)
    # Normalize unicode (ø→o, å→a, etc.) for cross-source comparison
    t_ascii = unicodedata.normalize("NFKD", t).encode("ascii", "ignore").decode()
    # Remove common suffixes like "- Oslo", "- Norway"
    t_ascii = re.sub(r"\s*[-–]\s*(oslo|norway)$", "", t_ascii, flags=re.IGNORECASE)
    return t_ascii.strip()


def _normalize_venue(venue: str) -> str:
    """Normalize venue name for comparison."""
    import unicodedata
    v = venue.lower().strip()
    v = unicodedata.normalize("NFKD", v).encode("ascii", "ignore").decode()
    return v


class ScrapeRequest(BaseModel):
    source: str
    from_date: Optional[str] = None
    to_date: Optional[str] = None


class EventResponse(BaseModel):
    id: int
    title: str
    date: str | None
    location: str | None
    url: str | None
    description: str | None
    source: str
    image_url: str | None
    category: str | None
    created_at: str | None

    model_config = {"from_attributes": True}


def _build_event_query(
    db: Session,
    source: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    search: Optional[str] = None,
    venue: Optional[str] = None,
    category: Optional[str] = None,
):
    """Build a filtered query for events."""
    query = db.query(Event)

    if source:
        query = query.filter(Event.source == source)
    if from_date:
        try:
            dt = datetime.fromisoformat(from_date)
            query = query.filter(Event.date >= dt)
        except ValueError:
            pass
    if to_date:
        try:
            dt = datetime.fromisoformat(to_date)
            # If to_date is date-only (no time), include the entire day
            if dt.hour == 0 and dt.minute == 0 and dt.second == 0:
                dt = dt.replace(hour=23, minute=59, second=59)
            query = query.filter(Event.date <= dt)
        except ValueError:
            pass
    if search:
        query = query.filter(Event.title.ilike(f"%{search}%"))
    if venue:
        query = query.filter(Event.location.ilike(f"%{venue}%"))
    if category:
        query = query.filter(Event.category.ilike(f"%{category}%"))

    return query


def _is_fuzzy_duplicate(item, existing_events: list[Event]) -> bool:
    """Check if a scraped event is a fuzzy duplicate of any existing event."""
    item_norm = _normalize_title(item.title)
    item_venue = _normalize_venue(item.location) if item.location else ""

    for existing in existing_events:
        existing_norm = _normalize_title(existing.title)

        # Try both token_sort (reordering) and token_set (subset matching)
        sort_score = fuzz.token_sort_ratio(item_norm, existing_norm)
        set_score = fuzz.token_set_ratio(item_norm, existing_norm)
        score = max(sort_score, set_score)

        # Venue-aware matching: if both have a venue and they match,
        # lower the title threshold (same venue + similar name = likely same event)
        threshold = FUZZY_THRESHOLD
        if item_venue and existing.location:
            existing_venue = _normalize_venue(existing.location)
            venue_score = fuzz.token_set_ratio(item_venue, existing_venue)
            if venue_score >= 80:
                threshold = 65

        if score >= threshold:
            # If both have dates, also check date proximity
            if item.date and existing.date:
                delta = abs((item.date - existing.date).days)
                if delta <= 1:
                    return True
            elif score >= 90:
                # Without date comparison, require higher similarity
                return True
            elif score >= threshold and not item.date and not existing.date:
                # Neither has a date — use the threshold
                return True
    return False


def _update_event_fields(existing_event: Event, new_item) -> None:
    """Update an existing event with richer data from a new scrape."""
    CITY_LEVEL = {"oslo", "oslo øst", "oslo sentrum", "oslo vest"}

    if new_item.category and not existing_event.category:
        existing_event.category = new_item.category
    # Update title if existing is a category word and new one is a real title
    if existing_event.title and existing_event.title.lower() in {
        "concert", "festival", "theatre", "exhibition", "sport", "dance",
        "opera", "comedy", "ballet", "show", "jazz", "film", "art",
        "music", "nightlife", "rock/pop", "country", "folk music",
    }:
        if new_item.title and new_item.title.lower() not in {
            "concert", "festival", "theatre", "exhibition", "sport", "dance",
            "opera", "comedy", "ballet", "show", "jazz", "film", "art",
            "music", "nightlife", "rock/pop", "country", "folk music",
        }:
            existing_event.title = new_item.title
    # Update date/time if new scrape has time but existing doesn't
    if new_item.date and existing_event.date:
        if (new_item.date.hour != 0 or new_item.date.minute != 0) and existing_event.date.hour == 0 and existing_event.date.minute == 0:
            existing_event.date = new_item.date
    elif new_item.date and not existing_event.date:
        existing_event.date = new_item.date
    # Update location — prefer venue-level over city-level
    if new_item.location:
        existing_is_city = (existing_event.location or "").lower().strip() in CITY_LEVEL
        new_is_city = new_item.location.lower().strip() in CITY_LEVEL
        if not existing_event.location or (existing_is_city and not new_is_city):
            existing_event.location = new_item.location
    # Update description if new scrape has it but existing doesn't
    if new_item.description and not existing_event.description:
        existing_event.description = new_item.description
    # Update image if new scrape has it but existing doesn't
    if new_item.image_url and not existing_event.image_url:
        existing_event.image_url = new_item.image_url


def _insert_events(db: Session, scraped, source_name: str) -> tuple[int, int]:
    """Insert scraped events with fuzzy dedup. Returns (total_scraped, added)."""
    from datetime import timedelta

    # Build a URL lookup for targeted exact matching (avoids full-table scan)
    scraped_urls = {item.url for item in scraped if item.url}
    url_existing: dict[str, Event] = {}
    if scraped_urls:
        for e in db.query(Event).filter(Event.url.in_(scraped_urls)).all():
            if e.url:
                url_existing[e.url] = e

    # Scope the fuzzy-dedup pool to the date window of incoming events.
    # This avoids loading the entire table; events outside the window are
    # almost certainly not the same event.
    dated = [item.date for item in scraped if item.date]
    if dated:
        min_date = min(dated) - timedelta(days=1)
        max_date = max(dated) + timedelta(days=1)
        existing: list[Event] = db.query(Event).filter(
            (Event.date.is_(None)) |
            ((Event.date >= min_date) & (Event.date <= max_date))
        ).all()
    else:
        # No dates in batch — fall back to full scan (uncommon)
        existing = db.query(Event).all()

    added = 0
    for item in scraped:
        # 1. URL-based match (strongest signal — same page = same event)
        if item.url and item.url in url_existing:
            _update_event_fields(url_existing[item.url], item)
            continue

        # 2. Exact title+source match — update fields if new data is richer
        exact = next(
            (e for e in existing if e.title == item.title and e.source == item.source),
            None,
        )
        if exact:
            _update_event_fields(exact, item)
            continue

        # 3. Fuzzy cross-source dedup
        if _is_fuzzy_duplicate(item, existing):
            continue

        event = Event(
            title=item.title,
            date=item.date,
            location=item.location,
            url=item.url,
            description=item.description,
            source=item.source,
            image_url=item.image_url,
            category=item.category,
        )
        db.add(event)
        existing.append(event)  # Track for subsequent dedup within batch
        if item.url:
            url_existing[item.url] = event
        added += 1

    db.commit()
    return len(scraped), added


@app.get("/api-info")
def api_info():
    return {"message": "Event Wheel API", "docs": "/docs"}


@app.get("/public-url")
def get_public_url():
    """Return the public URL for share links.

    Checks in order:
      1. PUBLIC_URL — manually set (tunnel or custom domain)
      2. RENDER_EXTERNAL_URL — set automatically by Render on every deploy
    """
    url = os.environ.get("PUBLIC_URL") or os.environ.get("RENDER_EXTERNAL_URL", "")
    return {"url": url}


@app.get("/events", response_model=list[EventResponse])
def get_events(
    source: Optional[str] = Query(None),
    from_date: Optional[str] = Query(None, alias="from"),
    to_date: Optional[str] = Query(None, alias="to"),
    search: Optional[str] = Query(None),
    venue: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """Get events with optional filters."""
    query = _build_event_query(db, source, from_date, to_date, search, venue, category)
    events = query.order_by(Event.date).all()
    return [e.to_dict() for e in events]


@app.get("/events/venues")
def get_venues(db: Session = Depends(get_db)):
    """Get distinct venue/location names."""
    venues = (
        db.query(Event.location)
        .filter(Event.location.isnot(None), Event.location != "")
        .distinct()
        .order_by(Event.location)
        .all()
    )
    return {"venues": [v[0] for v in venues]}


@app.get("/events/categories")
def get_categories(db: Session = Depends(get_db)):
    """Get distinct categories across all events."""
    rows = (
        db.query(Event.category)
        .filter(Event.category.isnot(None), Event.category != "")
        .distinct()
        .all()
    )
    # Categories can be comma-separated, so flatten
    cats: set[str] = set()
    for (raw,) in rows:
        for c in raw.split(","):
            c = c.strip()
            if c:
                cats.add(c)
    return {"categories": sorted(cats)}


@app.get("/events/random", response_model=EventResponse)
def get_random_event(db: Session = Depends(get_db)):
    """Get a random event."""
    events = db.query(Event).all()
    if not events:
        raise HTTPException(status_code=404, detail="No events available")
    return random.choice(events).to_dict()


@app.delete("/events/{event_id}")
def delete_event(event_id: int, db: Session = Depends(get_db)):
    """Delete an event by ID."""
    event = db.query(Event).filter(Event.id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    db.delete(event)
    db.commit()
    return {"message": "Event deleted", "id": event_id}


@app.delete("/events")
def delete_all_events(db: Session = Depends(get_db)):
    """Delete all events."""
    count = db.query(Event).delete()
    db.commit()
    return {"message": f"Deleted {count} events"}


@app.get("/scrapers")
def get_scrapers():
    """List available scrapers."""
    return {"scrapers": list_scrapers()}


@app.post("/scrape")
def scrape_events(request: ScrapeRequest, db: Session = Depends(get_db)):
    """Scrape events from a single source with fuzzy dedup.
    
    When a date range is specified, removes old events from this source+date
    before inserting fresh data (prevents stale duplicates from prior scrapes).
    """
    try:
        scraper = get_scraper(request.source)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Clear stale events for this source + date range before re-scraping
    if request.from_date and request.to_date:
        try:
            fd = datetime.fromisoformat(request.from_date)
            td = datetime.fromisoformat(request.to_date).replace(hour=23, minute=59, second=59)
            db.query(Event).filter(
                Event.source == request.source,
                Event.date >= fd,
                Event.date <= td,
            ).delete()
            db.commit()
        except ValueError:
            pass

    try:
        scraped = scraper.scrape(
            from_date=request.from_date,
            to_date=request.to_date,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Scraping '{request.source}' failed: {str(e)}",
        )

    total, added = _insert_events(db, scraped, request.source)
    return {
        "message": f"Scraped {total} events, added {added} new",
        "total_scraped": total,
        "added": added,
        "source": request.source,
    }


class ScrapeAllRequest(BaseModel):
    from_date: Optional[str] = None
    to_date: Optional[str] = None
    sources: Optional[list[str]] = None


@app.post("/scrape-all")
def scrape_all(
    request: Optional[ScrapeAllRequest] = None,
    db: Session = Depends(get_db),
):
    """Scrape selected sources. VisitOslo first (primary), then CSID (supplement).
    
    Cross-source fuzzy dedup ensures CSID events already on VisitOslo
    are not duplicated.
    """
    from_date = request.from_date if request else None
    to_date = request.to_date if request else None
    requested_sources = request.sources if request and request.sources else None

    results = []
    total_added = 0
    total_scraped = 0
    errors = []

    # Scrape visitoslo first (primary source with richer data),
    # then csid as supplement for events not listed on visitoslo.
    source_order = ["visitoslo", "csid"]
    available = set(list_scrapers())

    for source_name in source_order:
        if source_name not in available:
            continue
        if requested_sources and source_name not in requested_sources:
            continue
        try:
            scraper = get_scraper(source_name)
            scraped = scraper.scrape(from_date=from_date, to_date=to_date)
            t, a = _insert_events(db, scraped, source_name)
            total_scraped += t
            total_added += a
            results.append({"source": source_name, "scraped": t, "added": a})
        except Exception as e:
            errors.append({"source": source_name, "error": str(e)})

    return {
        "message": f"Scraped {total_scraped} events total, added {total_added} new",
        "total_scraped": total_scraped,
        "added": total_added,
        "results": results,
        "errors": errors,
    }


@app.post("/events/enrich")
def enrich_events(db: Session = Depends(get_db)):
    """Use local Ollama LLM to enrich events with category/time info."""
    import httpx

    # Find events missing category
    events = db.query(Event).filter(
        (Event.category.is_(None)) | (Event.category == "")
    ).limit(50).all()

    if not events:
        return {"message": "No events need enrichment", "enriched": 0}

    # Map time-of-day hints to approximate hours
    TIME_HINT_HOURS = {
        "morning": 10,
        "afternoon": 14,
        "evening": 19,
        "night": 22,
    }

    enriched = 0
    for event in events:
        prompt = (
            "You are classifying an event. Given the title and description, "
            "return ONLY a JSON object with these fields:\n"
            '- "category": one of: concert, theatre, exhibition, festival, sport, '
            'dance, opera, comedy, film, jazz, art, food, nightlife, family, outdoor, '
            'market, show, stand-up, quiz, workshop, talk, music, performance, party, '
            'guided tour, lecture, other\n'
            '- "time_hint": your best guess for time of day — "morning", "afternoon", '
            '"evening", or "night". Use "evening" if unsure.\n\n'
            f"Title: {event.title}\n"
            f"Description: {event.description or 'N/A'}\n"
            f"Venue: {event.location or 'N/A'}\n\n"
            "Respond with ONLY the JSON object, no markdown, no explanation."
        )

        try:
            resp = httpx.post(
                "http://localhost:11434/api/generate",
                json={"model": "llama3", "prompt": prompt, "stream": False},
                timeout=30,
            )
            if resp.status_code != 200:
                continue

            text = resp.json().get("response", "").strip()
            # Extract JSON from response (handle markdown wrapping)
            if "```" in text:
                text = text.split("```")[1]
                if text.startswith("json"):
                    text = text[4:]
            parsed = json.loads(text)
            cat = parsed.get("category", "").lower().strip()
            if cat:
                event.category = cat
                enriched += 1

            # Apply time hint as approximate event time (if event has date but no time)
            time_hint = parsed.get("time_hint", "").lower().strip()
            if time_hint in TIME_HINT_HOURS and event.date:
                # Only set time if event currently has midnight (no real time)
                if event.date.hour == 0 and event.date.minute == 0:
                    event.date = event.date.replace(hour=TIME_HINT_HOURS[time_hint])
        except Exception:
            continue

    db.commit()
    return {"message": f"Enriched {enriched} events", "enriched": enriched}


@app.get("/events/export")
def export_events(
    source: Optional[str] = Query(None),
    from_date: Optional[str] = Query(None, alias="from"),
    to_date: Optional[str] = Query(None, alias="to"),
    search: Optional[str] = Query(None),
    venue: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    format: str = Query("csv"),
    db: Session = Depends(get_db),
):
    """Export events as CSV or formatted text."""
    query = _build_event_query(db, source, from_date, to_date, search, venue, category)
    events = query.order_by(Event.date).all()

    if format == "text":
        lines = ["🎯 Event Wheel — Event List", ""]
        for e in events:
            date_str = e.date.strftime("%a %b %d, %H:%M") if e.date else "TBD"
            lines.append(f"• {e.title}")
            lines.append(f"  📅 {date_str}")
            if e.location:
                lines.append(f"  📍 {e.location}")
            if e.category:
                lines.append(f"  🏷️ {e.category}")
            if e.url:
                lines.append(f"  🔗 {e.url}")
            lines.append("")
        lines.append(f"Total: {len(events)} events")
        content = "\n".join(lines)
        return StreamingResponse(
            io.StringIO(content),
            media_type="text/plain",
            headers={"Content-Disposition": "attachment; filename=events.txt"},
        )

    # CSV format
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Date", "Time", "Title", "Venue", "Category", "Source", "URL"])
    for e in events:
        date_str = e.date.strftime("%Y-%m-%d") if e.date else ""
        time_str = e.date.strftime("%H:%M") if e.date else ""
        writer.writerow([
            date_str, time_str, e.title,
            e.location or "", e.category or "",
            e.source, e.url or "",
        ])
    output.seek(0)
    return StreamingResponse(
        output,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=events.csv"},
    )


# ═══════════════════════════════════════════
# Poll endpoints — group date scheduling
# ═══════════════════════════════════════════

class CreatePollRequest(BaseModel):
    title: str
    candidate_dates: list[str]  # ["2026-03-20", "2026-03-21", ...]


class VoteRequest(BaseModel):
    voter_name: str
    available_dates: list[str]
    tentative_dates: list[str] = []


def _generate_poll_id() -> str:
    """Generate a short, URL-friendly poll ID."""
    import secrets
    return secrets.token_urlsafe(6)[:8]


@app.post("/polls")
def create_poll(request: CreatePollRequest, db: Session = Depends(get_db)):
    """Create a new date poll."""
    if not request.candidate_dates:
        raise HTTPException(status_code=400, detail="At least one candidate date required")
    if not request.title.strip():
        raise HTTPException(status_code=400, detail="Title is required")

    poll = Poll(
        id=_generate_poll_id(),
        title=request.title.strip(),
        candidate_dates=sorted(set(request.candidate_dates)),
    )
    db.add(poll)
    db.commit()
    db.refresh(poll)
    return poll.to_dict()


@app.get("/polls")
def list_polls(db: Session = Depends(get_db)):
    """List all polls, newest first, with vote counts."""
    polls = db.query(Poll).order_by(Poll.created_at.desc()).all()
    result = []
    for poll in polls:
        vote_count = db.query(PollVote).filter(PollVote.poll_id == poll.id).count()
        result.append({**poll.to_dict(), "total_voters": vote_count})
    return result


@app.get("/polls/{poll_id}")
def get_poll(poll_id: str, db: Session = Depends(get_db)):
    """Get a poll with all votes and computed results."""
    poll = db.query(Poll).filter(Poll.id == poll_id).first()
    if not poll:
        raise HTTPException(status_code=404, detail="Poll not found")

    votes = db.query(PollVote).filter(PollVote.poll_id == poll_id).all()

    # Compute vote counts per date (tentative counts as 0.5)
    date_counts: dict[str, int] = {d: 0 for d in poll.candidate_dates}
    tentative_counts: dict[str, int] = {d: 0 for d in poll.candidate_dates}
    date_scores: dict[str, float] = {d: 0.0 for d in poll.candidate_dates}
    for vote in votes:
        for d in vote.available_dates:
            if d in date_counts:
                date_counts[d] += 1
                date_scores[d] += 1.0
        for d in (vote.tentative_dates or []):
            if d in tentative_counts:
                tentative_counts[d] += 1
                date_scores[d] += 0.5

    best_score = max(date_scores.values()) if date_scores else 0
    best_dates = [d for d, s in date_scores.items() if s == best_score and s > 0]

    return {
        **poll.to_dict(),
        "votes": [v.to_dict() for v in votes],
        "date_counts": date_counts,
        "tentative_counts": tentative_counts,
        "date_scores": date_scores,
        "best_dates": best_dates,
        "total_voters": len(votes),
    }


@app.post("/polls/{poll_id}/vote")
def submit_vote(poll_id: str, request: VoteRequest, db: Session = Depends(get_db)):
    """Submit or update a vote on a poll."""
    poll = db.query(Poll).filter(Poll.id == poll_id).first()
    if not poll:
        raise HTTPException(status_code=404, detail="Poll not found")
    if not request.voter_name.strip():
        raise HTTPException(status_code=400, detail="Name is required")

    name = request.voter_name.strip()
    # Filter to only valid candidate dates
    valid_dates = [d for d in request.available_dates if d in poll.candidate_dates]
    valid_tentative = [d for d in request.tentative_dates if d in poll.candidate_dates and d not in valid_dates]

    # Update existing vote or create new
    existing = db.query(PollVote).filter(
        PollVote.poll_id == poll_id,
        PollVote.voter_name == name,
    ).first()

    if existing:
        existing.available_dates = valid_dates
        existing.tentative_dates = valid_tentative
    else:
        vote = PollVote(
            poll_id=poll_id,
            voter_name=name,
            available_dates=valid_dates,
            tentative_dates=valid_tentative,
        )
        db.add(vote)

    db.commit()
    return {"message": f"Vote recorded for {name}", "voter_name": name, "available_dates": valid_dates, "tentative_dates": valid_tentative}


@app.delete("/polls/{poll_id}")
def delete_poll(poll_id: str, db: Session = Depends(get_db)):
    """Delete a poll and all its votes."""
    poll = db.query(Poll).filter(Poll.id == poll_id).first()
    if not poll:
        raise HTTPException(status_code=404, detail="Poll not found")
    db.query(PollVote).filter(PollVote.poll_id == poll_id).delete()
    db.delete(poll)
    db.commit()
    return {"message": f"Poll '{poll.title}' deleted"}


@app.delete("/polls/{poll_id}/vote/{voter_name}")
def delete_vote(poll_id: str, voter_name: str, db: Session = Depends(get_db)):
    """Remove a vote from a poll."""
    vote = db.query(PollVote).filter(
        PollVote.poll_id == poll_id,
        PollVote.voter_name == voter_name,
    ).first()
    if not vote:
        raise HTTPException(status_code=404, detail="Vote not found")
    db.delete(vote)
    db.commit()
    return {"message": f"Vote removed for {voter_name}"}


# ---------- Serve frontend static files (for tunnel/production) ----------
_frontend_dist = Path(__file__).resolve().parent.parent / "frontend" / "dist"

if _frontend_dist.is_dir():
    # Serve SPA catch-all: any non-API path returns index.html
    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        file_path = _frontend_dist / full_path
        if full_path and file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(_frontend_dist / "index.html")
else:
    print(f"⚠️  Frontend dist not found at {_frontend_dist}. Run `npm run build` in frontend/")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
