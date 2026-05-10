import { useState, useEffect, useCallback, useRef } from 'react';
import { Routes, Route, useNavigate, useParams, useLocation } from 'react-router-dom';
import {
  Event, Filters, fetchEvents, fetchScrapers, fetchCategories,
  scrapeEvents, deleteEvent, enrichEvents, getExportUrl, getExportText,
} from './api';
import { SpinWheel, WeightedEvent } from './components/SpinWheel';
import { WinnerModal } from './components/WinnerModal';
import { DatePoll } from './components/DatePoll';
import { ToastContainer, Toast, createToast } from './components/Toast';
import { BouncingHeads } from './components/Friendship';
import './App.css';

// ── Helpers ──
function todayStr() { return new Date().toISOString().slice(0, 10); }
function formatHour(h: number): string { return `${h.toString().padStart(2, '0')}:00`; }

function getEventHour(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const h = d.getHours();
  if (h === 0 && d.getMinutes() === 0) return null;
  return h;
}

type Stage = 'pick' | 'events' | 'spin';

function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const isPoll = location.pathname.startsWith('/poll');
  // Direct poll link (no organizer state) = voter-only view (hide full app chrome)
  const isDirectPollLink = isPoll
    && /^\/poll\/[^/]+$/.test(location.pathname)
    && !(location.state as { organizer?: boolean })?.organizer;

  // ── Stage ──
  const [stage, setStage] = useState<Stage>('pick');

  // ── Stage 1: Pick ──
  const [selectedDate, setSelectedDate] = useState(todayStr());
  const [scrapers, setScrapers] = useState<string[]>([]);
  const [enabledSources, setEnabledSources] = useState<Set<string>>(new Set());

  // ── Stage 2: Events ──
  const [events, setEvents] = useState<Event[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [scraping, setScraping] = useState(false);
  const [scrapeProgress, setScrapeProgress] = useState('');
  const [enriching, setEnriching] = useState(false);
  const [enrichProgress, setEnrichProgress] = useState('');
  const [excludedIds, setExcludedIds] = useState<Set<number>>(new Set());
  const [weights, setWeights] = useState<Record<number, number>>({});
  const [activeCategories, setActiveCategories] = useState<Set<string>>(new Set());
  const [timeMin, setTimeMin] = useState(0);
  const [timeMax, setTimeMax] = useState(24);
  const [hideUnknownTime, setHideUnknownTime] = useState(false);

  // ── Stage 3: Spin ──
  const [winner, setWinner] = useState<Event | null>(null);

  // ── UI ──
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [copyText, setCopyText] = useState<string | null>(null);
  const eventsRef = useRef<HTMLDivElement>(null);

  const addToast = useCallback((msg: string, type: Toast['type'] = 'info') => {
    setToasts(prev => [...prev, createToast(msg, type)]);
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // ── Load scrapers on mount ──
  useEffect(() => {
    (async () => {
      try {
        const sc = await fetchScrapers();
        setScrapers(sc);
        setEnabledSources(new Set(sc.filter(s => s !== 'demo')));
      } catch {
        addToast('Cannot connect to backend — is it running on :8000?', 'error');
      }
    })();
  }, [addToast]);

  // ── Find Events (scrape + enrich) ──
  const handleFindEvents = async () => {
    if (!selectedDate) return;
    setScraping(true);
    setScrapeProgress('');
    setStage('events');
    setEvents([]);
    setExcludedIds(new Set());
    setActiveCategories(new Set());
    setTimeMin(0);
    setTimeMax(24);

    // Scrape sources sequentially: visitoslo first (primary), then csid (supplement)
    const sourceOrder = ['visitoslo', 'csid'].filter(s => enabledSources.has(s));
    let totalAdded = 0;

    try {
      for (const source of sourceOrder) {
        const label = source === 'visitoslo' ? '🏙️ visitoslo' : '🎵 csid';
        const role = source === sourceOrder[0] ? 'Searching' : 'Checking for extras on';
        setScrapeProgress(`${role} ${label}…`);

        try {
          const result = await scrapeEvents(source, selectedDate, selectedDate);
          totalAdded += result.added;
          if (source === sourceOrder[0]) {
            setScrapeProgress(`Found ${result.total_scraped} events on ${label}`);
          } else {
            setScrapeProgress(
              result.added > 0
                ? `Added ${result.added} extra events from ${label}`
                : `No new events from ${label}`
            );
          }
          // Brief pause so user can see the progress message
          await new Promise(r => setTimeout(r, 600));
        } catch (err) {
          addToast(`${source}: ${err instanceof Error ? err.message : 'failed'}`, 'error');
        }
      }

      if (totalAdded === 0 && sourceOrder.length > 0) {
        addToast('No new events found', 'info');
      } else {
        addToast(`Added ${totalAdded} events total`, 'success');
      }

      // Fetch the events for this date from DB
      const filters: Filters = { from: selectedDate, to: selectedDate };
      const ev = await fetchEvents(filters);
      setEvents(ev);

      // Auto-enrich with LLM
      if (ev.length > 0) {
        setEnriching(true);
        setEnrichProgress('Enriching events with AI…');
        try {
          const enrichResult = await enrichEvents();
          if (enrichResult.enriched > 0) {
            addToast(`🧠 AI categorized ${enrichResult.enriched} events`, 'success');
            const enriched = await fetchEvents(filters);
            setEvents(enriched);
          }
        } catch {
          // Ollama might not be running — that's fine
        } finally {
          setEnriching(false);
          setEnrichProgress('');
        }
      }

      // Fetch categories
      const cats = await fetchCategories();
      setCategories(cats);
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Scraping failed', 'error');
    } finally {
      setScraping(false);
      setScrapeProgress('');
    }
  };

  // ── Source toggle ──
  const toggleSource = (source: string) => {
    setEnabledSources(prev => {
      const n = new Set(prev);
      if (n.has(source)) n.delete(source); else n.add(source);
      return n;
    });
  };

  // ── Category toggle ──
  const toggleCategory = (cat: string) => {
    setActiveCategories(prev => {
      const n = new Set(prev);
      if (n.has(cat)) n.delete(cat); else n.add(cat);
      return n;
    });
  };

  // ── Exclude/include ──
  const toggleExclude = (id: number) => {
    setExcludedIds(prev => {
      const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n;
    });
  };

  const setWeight = (id: number, w: number) => {
    setWeights(prev => ({ ...prev, [id]: w }));
  };

  const handleDelete = async (id: number) => {
    try { await deleteEvent(id); setEvents(prev => prev.filter(e => e.id !== id)); }
    catch { addToast('Failed to delete', 'error'); }
  };

  // ── Export ──
  const handleCopyList = async () => {
    try {
      const text = await getExportText({ from: selectedDate, to: selectedDate });
      // Try modern clipboard API
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch { /* not available */ }
      // Fallback: execCommand
      if (!copied) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        document.body.removeChild(ta);
      }
      if (copied) {
        addToast('📋 Event list copied!', 'success');
      } else {
        // Clipboard unavailable — show text for manual copy
        setCopyText(text);
      }
    } catch {
      addToast('Failed to fetch event list', 'error');
    }
  };

  const handleDownloadCsv = () => {
    window.open(getExportUrl({ from: selectedDate, to: selectedDate }, 'csv'), '_blank');
  };

  const handlePollDateSelect = (date: string) => {
    setSelectedDate(date);
    setStage('pick');
    navigate('/');
  };

  // ── Derived data ──
  const getInfoScore = (e: Event): number => {
    let s = 0;
    if (e.date) {
      s += 2;
      const d = new Date(e.date);
      if (d.getHours() !== 0 || d.getMinutes() !== 0) s += 2; // has time
    }
    if (e.location) s += 1;
    if (e.description) s += 1;
    if (e.image_url) s += 1;
    if (e.category) s += 1;
    return s;
  };

  const visibleEvents = events.filter(e => {
    if (!enabledSources.has(e.source)) return false;
    if (activeCategories.size > 0) {
      const cats = (e.category || '').split(',').map(c => c.trim().toLowerCase());
      if (!cats.some(c => activeCategories.has(c))) return false;
    }
    if (timeMin > 0 || timeMax < 24) {
      const hour = getEventHour(e.date);
      if (hour === null) {
        if (hideUnknownTime) return false;
      } else if (hour < timeMin || hour >= timeMax) {
        return false;
      }
    }
    return true;
  }).sort((a, b) => {
    // Sort by info richness (most data first), then alphabetically
    const diff = getInfoScore(b) - getInfoScore(a);
    if (diff !== 0) return diff;
    return a.title.localeCompare(b.title);
  });

  const includedEvents: WeightedEvent[] = visibleEvents
    .filter(e => !excludedIds.has(e.id))
    .map(e => ({ ...e, weight: weights[e.id] || 3 }));

  const formatDate = (d: string | null) => {
    if (!d) return 'TBD';
    const date = new Date(d);
    const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0;
    if (hasTime) {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    }
    return '—';
  };

  // ── Category colors ──
  const catColors: Record<string, string> = {
    concert: '#818cf8', theatre: '#f472b6', exhibition: '#34d399',
    festival: '#fbbf24', sport: '#fb923c', dance: '#c084fc',
    opera: '#f87171', comedy: '#22d3ee', film: '#a78bfa',
    jazz: '#facc15', 'rock/pop': '#38bdf8', art: '#2dd4bf',
    food: '#fb7185', nightlife: '#60a5fa', family: '#4ade80',
    show: '#e879f9', standup: '#fb923c', 'stand-up': '#fb923c',
    quiz: '#22d3ee', workshop: '#a3e635', talk: '#94a3b8',
    music: '#818cf8', performance: '#c084fc', party: '#f472b6',
    musical: '#e879f9', other: '#94a3b8',
  };
  const getCatColor = (cat: string) => catColors[cat.toLowerCase()] || '#94a3b8';

  // ── Format selected date for display ──
  const displayDate = new Date(selectedDate + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  return (
    <div className="app">
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      {/* ── Header + Nav (hidden for voter-only view) ── */}
      {!isDirectPollLink && (
        <header>
          <h1>🎡 Event Wheel</h1>
          <BouncingHeads />
          <nav className="app-nav">
            <button
              className={`nav-tab ${!isPoll ? 'active' : ''}`}
              onClick={() => navigate('/')}
            >🎯 Find Events</button>
            <button
              className={`nav-tab ${isPoll ? 'active' : ''}`}
              onClick={() => navigate('/poll')}
            >📅 Plan a Date</button>
          </nav>
        </header>
      )}
      {isDirectPollLink && (
        <header>
          <h1>📅 Date Poll</h1>
        </header>
      )}

      {isPoll ? (
        <Routes>
          <Route path="/poll/:pollId" element={<PollRoute onSelectDate={handlePollDateSelect} />} />
          <Route path="/poll" element={<DatePoll onSelectDate={handlePollDateSelect} />} />
        </Routes>
      ) : (
        <>

      {/* ═══ STAGE 1: Pick Your Night ═══ */}
      <section className={`stage stage-pick ${stage === 'pick' ? 'active' : 'compact'}`}>
        <div className="stage-header">
          <span className="stage-num">1</span>
          <h2>Pick Your Night</h2>
          {stage !== 'pick' && (
            <button className="stage-edit" onClick={() => setStage('pick')}>Change</button>
          )}
        </div>

        {stage === 'pick' ? (
          <div className="pick-content">
            <div className="pick-date-row">
              <input
                type="date"
                className="pick-date-input"
                value={selectedDate}
                onChange={e => setSelectedDate(e.target.value)}
                min={todayStr()}
              />
              <span className="pick-date-display">{displayDate}</span>
            </div>

            <div className="pick-sources">
              {scrapers.filter(s => s !== 'demo').map(s => (
                <label key={s} className={`source-toggle ${enabledSources.has(s) ? 'on' : 'off'}`}>
                  <input
                    type="checkbox"
                    checked={enabledSources.has(s)}
                    onChange={() => toggleSource(s)}
                  />
                  <span className="toggle-track"><span className="toggle-thumb" /></span>
                  <span className="toggle-label">
                    {s === 'csid' ? '🎵' : '🏙️'} {s}
                  </span>
                </label>
              ))}
            </div>

            <button
              className="find-btn"
              onClick={handleFindEvents}
              disabled={scraping || enabledSources.size === 0}
            >
              {scraping ? (
                <><span className="dot-pulse" /> Finding events…</>
              ) : (
                '🔍 Find Events'
              )}
            </button>
          </div>
        ) : (
          <div className="pick-summary">
            📅 {displayDate} · {Array.from(enabledSources).join(' + ')}
          </div>
        )}
      </section>

      {/* ═══ STAGE 2: Your Events ═══ */}
      {(stage === 'events' || stage === 'spin') && (
        <section className={`stage stage-events ${stage === 'events' ? 'active' : 'compact'}`} ref={eventsRef}>
          <div className="stage-header">
            <span className="stage-num">2</span>
            <h2>Your Events</h2>
            <span className="stage-count">{includedEvents.length} of {visibleEvents.length} selected</span>
            {stage !== 'events' && (
              <button className="stage-edit" onClick={() => setStage('events')}>Edit</button>
            )}
          </div>

          {scraping ? (
            <div className="loading-state"><div className="spinner" /><p>{scrapeProgress || 'Scraping events…'}</p></div>
          ) : enriching ? (
            <div className="loading-state"><div className="spinner" /><p>{enrichProgress}</p></div>
          ) : events.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">🔍</div>
              <h2>No events found</h2>
              <p>Try a different date or enable more sources</p>
            </div>
          ) : stage === 'events' ? (
            <>
              {/* Filters */}
              <div className="event-filters">
                {/* Time slider */}
                <div className="filter-row">
                  <span className="filter-label">⏰ Time</span>
                  <div className="time-slider-wrap">
                    <span className="time-slider-label">{formatHour(timeMin)}</span>
                    <input type="range" min={0} max={24} value={timeMin}
                      onChange={e => setTimeMin(Math.min(Number(e.target.value), timeMax - 1))}
                      className="time-slider" />
                    <input type="range" min={0} max={24} value={timeMax}
                      onChange={e => setTimeMax(Math.max(Number(e.target.value), timeMin + 1))}
                      className="time-slider" />
                    <span className="time-slider-label">{formatHour(timeMax)}</span>
                  </div>
                  {(timeMin > 0 || timeMax < 24) && (
                    <button className="chip-reset" onClick={() => { setTimeMin(0); setTimeMax(24); setHideUnknownTime(false); }}>✕</button>
                  )}
                </div>
                {(timeMin > 0 || timeMax < 24) && (() => {
                  const withTime = events.filter(e => getEventHour(e.date) !== null).length;
                  const noTime = events.length - withTime;
                  return noTime > 0 ? (
                    <div className="filter-row filter-note">
                      <label className="unknown-time-toggle">
                        <input type="checkbox" checked={!hideUnknownTime}
                          onChange={e => setHideUnknownTime(!e.target.checked)} />
                        <span>Include {noTime} event{noTime !== 1 ? 's' : ''} without time info</span>
                      </label>
                      {withTime > 0 && <span className="time-hint-note">({withTime} event{withTime !== 1 ? 's have' : ' has'} time data from AI enrichment)</span>}
                    </div>
                  ) : null;
                })()}

                {/* Category chips */}
                {categories.length > 0 && (
                  <div className="filter-row">
                    <span className="filter-label">🏷️ Type</span>
                    <div className="cat-chips">
                      {categories.map(cat => (
                        <button
                          key={cat}
                          className={`chip cat-chip ${activeCategories.has(cat) ? 'active' : ''}`}
                          style={activeCategories.has(cat) ? { background: getCatColor(cat), borderColor: getCatColor(cat), color: '#fff' } : {}}
                          onClick={() => toggleCategory(cat)}
                        >
                          {cat}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Toolbar */}
                <div className="filter-row filter-toolbar">
                  <div className="toolbar-actions">
                    <button className="pill-btn" onClick={() => setExcludedIds(new Set())}>Select all</button>
                    <button className="pill-btn" onClick={() => setExcludedIds(new Set(visibleEvents.map(e => e.id)))}>Deselect all</button>
                  </div>
                  <div className="toolbar-actions">
                    <button className="pill-btn" onClick={handleCopyList}>📋 Copy</button>
                    <button className="pill-btn" onClick={handleDownloadCsv}>⬇ CSV</button>
                  </div>
                </div>
              </div>

              {/* Event cards */}
              <div className="event-grid">
                {visibleEvents.map((event, i) => {
                  const included = !excludedIds.has(event.id);
                  const w = weights[event.id] || 3;
                  return (
                    <div
                      key={event.id}
                      className={`ev-card-v2 ${included ? 'sel' : 'excluded'}`}
                      style={{ animationDelay: `${Math.min(i * 15, 200)}ms` }}
                      onClick={() => toggleExclude(event.id)}
                    >
                      {/* Image */}
                      {event.image_url && (
                        <div className="ev-img">
                          <img src={event.image_url} alt="" loading="lazy" />
                        </div>
                      )}

                      <div className="ev-body">
                        <div className="ev-top-row">
                          <div className={`ev-checkbox ${included ? 'checked' : ''}`} />
                          <div className="ev-title">{event.title}</div>
                        </div>

                        <div className="ev-info-row">
                          <span className={`ev-time ${formatDate(event.date) !== '—' && formatDate(event.date) !== 'TBD' ? 'has-time' : ''}`}>
                            {formatDate(event.date) !== '—' ? `🕐 ${formatDate(event.date)}` : ''}
                          </span>
                          {event.location && <span className="ev-venue">📍 {event.location}</span>}
                          <span className="ev-source-badge">{event.source}</span>
                        </div>

                        {event.description && <div className="ev-desc">{event.description}</div>}

                        {event.category && (
                          <div className="ev-category-row">
                            {event.category.split(',').map(c => (
                              <span key={c.trim()} className="ev-cat" style={{ background: getCatColor(c.trim()), color: '#fff' }}>
                                {c.trim()}
                              </span>
                            ))}
                          </div>
                        )}

                        <div className="ev-bottom-row" onClick={e => e.stopPropagation()}>
                          <div className="weight-stars">
                            {[1, 2, 3, 4, 5].map(s => (
                              <button
                                key={s}
                                className={`star ${s <= w ? 'filled' : ''}`}
                                onClick={() => setWeight(event.id, s === w ? 3 : s)}
                              >★</button>
                            ))}
                          </div>
                          <div className="ev-actions">
                            {event.url && <a href={event.url} target="_blank" rel="noopener noreferrer">Open ↗</a>}
                            <button className="ev-del" onClick={() => handleDelete(event.id)}>✕</button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Proceed to spin */}
              {includedEvents.length > 0 && (
                <button className="proceed-btn" onClick={() => setStage('spin')}>
                  🎡 Spin the Wheel ({includedEvents.length} events)
                </button>
              )}
            </>
          ) : (
            /* Compact view when in spin stage */
            <div className="events-compact">
              {includedEvents.length} events ready · {categories.length > 0 && `${new Set(includedEvents.flatMap(e => (e.category || '').split(',').map(c => c.trim())).filter(Boolean)).size} categories`}
            </div>
          )}
        </section>
      )}

      {/* ═══ STAGE 3: Spin! ═══ */}
      {stage === 'spin' && includedEvents.length > 0 && (
        <section className="stage stage-spin active">
          <div className="stage-header">
            <span className="stage-num">3</span>
            <h2>Spin!</h2>
          </div>
          <div className="wheel-section">
            <SpinWheel events={includedEvents} onResult={e => setWinner(e)} />
          </div>
        </section>
      )}

      {winner && <WinnerModal event={winner} onClose={() => setWinner(null)} />}

      {/* Copy-text modal (fallback when clipboard API unavailable) */}
      {copyText && (
        <div className="modal-overlay" onClick={() => setCopyText(null)}>
          <div className="copy-modal" onClick={e => e.stopPropagation()}>
            <h3>📋 Event List</h3>
            <p className="copy-hint">Select all and copy (⌘+A then ⌘+C)</p>
            <textarea
              readOnly
              value={copyText}
              rows={16}
              onFocus={e => e.target.select()}
              autoFocus
            />
            <button className="pill-btn" onClick={() => setCopyText(null)}>Close</button>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}

function PollRoute({ onSelectDate }: { onSelectDate: (d: string) => void }) {
  const { pollId } = useParams();
  const location = useLocation();
  const isOrganizer = !!(location.state as { organizer?: boolean })?.organizer;
  return <DatePoll pollId={pollId} onSelectDate={onSelectDate} voterOnly={!isOrganizer} />;
}

export default App;
