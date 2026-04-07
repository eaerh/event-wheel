from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, DateTime, Text, JSON
from database import Base


def _utcnow():
    return datetime.now(timezone.utc)


class Event(Base):
    __tablename__ = "events"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(500), nullable=False)
    date = Column(DateTime, nullable=True)
    location = Column(String(500), nullable=True)
    url = Column(String(1000), nullable=True)
    description = Column(Text, nullable=True)
    source = Column(String(200), nullable=False)
    image_url = Column(String(1000), nullable=True)
    category = Column(String(200), nullable=True)
    created_at = Column(DateTime, default=_utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "title": self.title,
            "date": self.date.isoformat() if self.date else None,
            "location": self.location,
            "url": self.url,
            "description": self.description,
            "source": self.source,
            "image_url": self.image_url,
            "category": self.category,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class Poll(Base):
    __tablename__ = "polls"

    id = Column(String(8), primary_key=True)
    title = Column(String(500), nullable=False)
    candidate_dates = Column(JSON, nullable=False)  # ["2026-03-20", "2026-03-21", ...]
    created_at = Column(DateTime, default=_utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "title": self.title,
            "candidate_dates": self.candidate_dates,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class PollVote(Base):
    __tablename__ = "poll_votes"

    id = Column(Integer, primary_key=True, index=True)
    poll_id = Column(String(8), nullable=False, index=True)
    voter_name = Column(String(200), nullable=False)
    available_dates = Column(JSON, nullable=False)  # ["2026-03-20", "2026-03-22"]
    tentative_dates = Column(JSON, nullable=False, default=list)  # ["2026-03-21"]
    created_at = Column(DateTime, default=_utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "poll_id": self.poll_id,
            "voter_name": self.voter_name,
            "available_dates": self.available_dates,
            "tentative_dates": self.tentative_dates or [],
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
