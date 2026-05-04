import { useEffect, useState } from 'react';
import { Event, getEventIcsUrl, getEventIcsShareUrl, getGoogleCalendarUrl } from '../api';

interface WinnerModalProps {
  event: Event;
  onClose: () => void;
}

export function WinnerModal({ event, onClose }: WinnerModalProps) {
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const formatDate = (d: string | null) => {
    if (!d) return null;
    const date = new Date(d);
    const dateStr = date.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
    });
    const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0;
    if (hasTime) {
      return dateStr + ' at ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }
    return dateStr;
  };

  const handleCopyInviteLink = async () => {
    try {
      await navigator.clipboard.writeText(getEventIcsShareUrl(event.id));
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  const handleShare = async () => {
    const parts = [`🎯 We're going to: ${event.title}!`];
    if (event.date) parts.push(`📅 ${formatDate(event.date)}`);
    if (event.location) parts.push(`📍 ${event.location}`);
    if (event.category) parts.push(`🏷️ ${event.category}`);
    if (event.url) parts.push(`🔗 ${event.url}`);
    parts.push('', '— picked by Event Wheel 🎡');

    const text = parts.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  return (
    <>
      <Confetti />
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-card" onClick={(e) => e.stopPropagation()}>
          <div className="modal-label">🎉 You're going to…</div>

          {/* Event image */}
          {event.image_url && (
            <div className="modal-image">
              <img src={event.image_url} alt={event.title} />
            </div>
          )}

          <div className="modal-title">{event.title}</div>

          {event.date && <div className="modal-detail">📅 {formatDate(event.date)}</div>}
          {event.location && <div className="modal-detail">📍 {event.location}</div>}
          {event.category && (
            <div className="modal-detail">
              🏷️ {event.category}
            </div>
          )}
          {event.description && <div className="modal-desc">{event.description}</div>}

          <div className="modal-actions">
            {event.url && (
              <a href={event.url} target="_blank" rel="noopener noreferrer" className="modal-btn-primary">
                View Event ↗
              </a>
            )}
            <button onClick={handleShare} className="modal-btn-share">
              {copied ? '✓ Copied!' : '📤 Share'}
            </button>
            <button onClick={onClose} className="modal-btn-ghost">Spin Again</button>
          </div>

          <div className="modal-calendar">
            <span className="modal-calendar-label">Add to calendar</span>
            <div className="modal-calendar-actions">
              <a href={getEventIcsUrl(event.id)} download className="modal-btn-ghost">
                📅 Download .ics
              </a>
              <a href={getGoogleCalendarUrl(event)} target="_blank" rel="noopener noreferrer" className="modal-btn-ghost">
                Google Calendar ↗
              </a>
              <button onClick={handleCopyInviteLink} className="modal-btn-ghost">
                {linkCopied ? '✓ Link copied!' : '🔗 Copy invite link'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Confetti() {
  const colors = ['#818cf8', '#34d399', '#fbbf24', '#f87171', '#38bdf8', '#fb923c', '#f472b6', '#c084fc', '#22d3ee'];
  const pieces = Array.from({ length: 80 }, (_, i) => (
    <div
      key={i}
      className="confetti-piece"
      style={{
        left: `${Math.random() * 100}%`,
        animationDelay: `${Math.random() * 0.8}s`,
        animationDuration: `${2 + Math.random() * 2}s`,
        backgroundColor: colors[i % colors.length],
        borderRadius: Math.random() > 0.5 ? '50%' : '2px',
        width: `${6 + Math.random() * 6}px`,
        height: `${6 + Math.random() * 6}px`,
      }}
    />
  ));
  return <div className="confetti-container">{pieces}</div>;
}
