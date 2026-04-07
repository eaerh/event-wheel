import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { PollData, PollSummary, createPoll, getPoll, listPolls, submitVote, deletePoll, getPublicUrl } from '../api';

function todayStr() { return new Date().toISOString().slice(0, 10); }

function formatDateShort(d: string): string {
  const date = new Date(d + 'T12:00:00');
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatDateFull(d: string): string {
  const date = new Date(d + 'T12:00:00');
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function getDayName(d: string): string {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
}

function getDayNum(d: string): string {
  return new Date(d + 'T12:00:00').getDate().toString();
}

function getMonthName(d: string): string {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short' });
}

function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const current = new Date(from + 'T12:00:00');
  const end = new Date(to + 'T12:00:00');
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// Three-state cycle: none → available → tentative → none
type VoteState = 'none' | 'available' | 'tentative';

function cycleVoteState(current: VoteState): VoteState {
  if (current === 'none') return 'available';
  if (current === 'available') return 'tentative';
  return 'none';
}

interface Props {
  pollId?: string;
  onSelectDate?: (date: string) => void;
  voterOnly?: boolean;
}

export function DatePoll({ pollId: initialPollId, onSelectDate, voterOnly }: Props) {
  const navigate = useNavigate();

  // List mode
  const [existingPolls, setExistingPolls] = useState<PollSummary[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  // Create mode
  const [title, setTitle] = useState('');
  const [fromDate, setFromDate] = useState(todayStr());
  const [toDate, setToDate] = useState('');
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set());
  const [pickMode, setPickMode] = useState<'range' | 'individual'>('range');

  // Poll mode
  const [pollId, setPollId] = useState<string | null>(initialPollId || null);
  const [poll, setPoll] = useState<PollData | null>(null);
  const [voterName, setVoterName] = useState('');
  const [voteDateStates, setVoteDateStates] = useState<Record<string, VoteState>>({});
  const [voted, setVoted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [shareMsg, setShareMsg] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [publicUrl, setPublicUrl] = useState('');

  useEffect(() => { getPublicUrl().then(setPublicUrl); }, []);

  useEffect(() => {
    if (!initialPollId) {
      listPolls().then(setExistingPolls);
    }
  }, [initialPollId]);

  const loadPoll = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const data = await getPoll(id);
      setPoll(data);
      setPollId(id);
    } catch {
      setPoll(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialPollId) loadPoll(initialPollId);
  }, [initialPollId, loadPoll]);

  const [rangeDates, setRangeDates] = useState<string[]>([]);

  useEffect(() => {
    if (pickMode === 'range' && fromDate && toDate && toDate >= fromDate) {
      const range = dateRange(fromDate, toDate);
      setRangeDates(range);
      setSelectedDates(new Set());
    }
  }, [fromDate, toDate, pickMode]);

  const handleCreate = async () => {
    if (!title.trim() || selectedDates.size === 0) return;
    setLoading(true);
    try {
      const data = await createPoll(title.trim(), Array.from(selectedDates).sort());
      navigate(`/poll/${data.id}`, { state: { organizer: true } });
      await loadPoll(data.id);
    } finally {
      setLoading(false);
    }
  };

  const handleVote = async () => {
    if (!pollId || !voterName.trim()) return;
    setLoading(true);
    try {
      const available = Object.entries(voteDateStates).filter(([, s]) => s === 'available').map(([d]) => d);
      const tentative = Object.entries(voteDateStates).filter(([, s]) => s === 'tentative').map(([d]) => d);
      await submitVote(pollId, voterName.trim(), available, tentative);
      setVoted(true);
      await loadPoll(pollId);
    } finally {
      setLoading(false);
    }
  };

  const toggleDate = (d: string) => {
    setSelectedDates(prev => {
      const n = new Set(prev);
      if (n.has(d)) n.delete(d); else n.add(d);
      return n;
    });
  };

  const toggleVoteDate = (d: string) => {
    setVoteDateStates(prev => {
      const current: VoteState = prev[d] || 'none';
      const next = cycleVoteState(current);
      return { ...prev, [d]: next };
    });
  };

  const shareBase = publicUrl || window.location.origin;
  const shareLink = pollId ? `${shareBase}/poll/${pollId}` : '';

  const handleShare = async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setShareMsg('Link copied!');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = shareLink;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      setShareMsg(ok ? 'Link copied!' : shareLink);
    }
    setTimeout(() => setShareMsg(''), 3000);
  };

  const handleDeletePoll = async () => {
    if (!pollId) return;
    try {
      await deletePoll(pollId);
      setPollId(null);
      setPoll(null);
      setConfirmDelete(false);
      navigate('/poll');
      listPolls().then(setExistingPolls);
    } catch {
      // ignore
    }
  };

  const availCount = Object.values(voteDateStates).filter(s => s === 'available').length;
  const tentCount = Object.values(voteDateStates).filter(s => s === 'tentative').length;

  // ── HOME VIEW (list + create) ──
  if (!pollId) {
    const previewDates = Array.from(selectedDates).sort();
    return (
      <div className="poll-page">
        {existingPolls.length > 0 && !showCreate && (
          <div className="poll-card">
            <h2>📅 Your Polls</h2>
            <div className="poll-list">
              {existingPolls.map(p => {
                const dr = p.candidate_dates.length > 1
                  ? `${formatDateShort(p.candidate_dates[0])} – ${formatDateShort(p.candidate_dates[p.candidate_dates.length - 1])}`
                  : formatDateShort(p.candidate_dates[0]);
                return (
                  <button
                    key={p.id}
                    className="poll-list-item"
                    onClick={() => navigate(`/poll/${p.id}`, { state: { organizer: true } })}
                  >
                    <div className="pli-title">{p.title}</div>
                    <div className="pli-meta">
                      <span>📅 {dr}</span>
                      <span>🗳️ {p.total_voters} vote{p.total_voters !== 1 ? 's' : ''}</span>
                    </div>
                  </button>
                );
              })}
            </div>
            <button className="find-btn" style={{ marginTop: 16 }} onClick={() => setShowCreate(true)}>
              ➕ Create new poll
            </button>
          </div>
        )}

        {(showCreate || existingPolls.length === 0) && (
          <div className="poll-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <h2>📅 {existingPolls.length > 0 ? 'New Poll' : 'Plan a Date'}</h2>
              {existingPolls.length > 0 && (
                <button className="pill-btn" onClick={() => setShowCreate(false)}>← Back</button>
              )}
            </div>
            <p className="poll-subtitle">Pick candidate dates, share the link, let everyone vote</p>

            <div className="poll-field">
              <label>Event title</label>
              <input
                type="text"
                placeholder="e.g. April event night"
                value={title}
                onChange={e => setTitle(e.target.value)}
                className="poll-input"
              />
            </div>

            <div className="poll-field">
              <label>Pick dates</label>
              <div className="poll-pick-mode">
                <button
                  className={`pill-btn ${pickMode === 'range' ? 'active' : ''}`}
                  onClick={() => setPickMode('range')}
                >Date range</button>
                <button
                  className={`pill-btn ${pickMode === 'individual' ? 'active' : ''}`}
                  onClick={() => setPickMode('individual')}
                >Pick individually</button>
              </div>
            </div>

            {pickMode === 'range' ? (
              <div className="poll-date-range">
                <input type="date" value={fromDate} min={todayStr()} onChange={e => setFromDate(e.target.value)} />
                <span>to</span>
                <input type="date" value={toDate} min={fromDate} onChange={e => setToDate(e.target.value)} />
              </div>
            ) : (
              <div className="poll-field">
                <input
                  type="date"
                  min={todayStr()}
                  onChange={e => {
                    if (e.target.value) {
                      setSelectedDates(prev => new Set([...prev, e.target.value]));
                      e.target.value = '';
                    }
                  }}
                />
              </div>
            )}

            {pickMode === 'range' && rangeDates.length > 0 && (
              <>
                <p className="poll-hint">Tap the dates you're available:</p>
                <div className="poll-vote-dates">
                  {rangeDates.map(d => (
                    <button
                      key={d}
                      className={`poll-vote-date ${selectedDates.has(d) ? 'selected' : ''}`}
                      onClick={() => toggleDate(d)}
                    >
                      <span className="pvd-day">{getDayName(d)}</span>
                      <span className="pvd-num">{getDayNum(d)}</span>
                      <span className="pvd-month">{getMonthName(d)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {pickMode === 'individual' && previewDates.length > 0 && (
              <div className="poll-date-preview">
                {previewDates.map(d => (
                  <span key={d} className="poll-date-chip" onClick={() => toggleDate(d)}>
                    {formatDateShort(d)}
                    <span className="chip-x">✕</span>
                  </span>
                ))}
              </div>
            )}

            <button
              className="find-btn"
              onClick={handleCreate}
              disabled={loading || !title.trim() || selectedDates.size === 0}
            >
              {loading ? 'Creating…' : `🗳️ Create Poll (${selectedDates.size} dates)`}
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── LOADING ──
  if (loading && !poll) {
    return (
      <div className="poll-page">
        <div className="poll-card"><div className="spinner" /><p>Loading poll…</p></div>
      </div>
    );
  }

  if (!poll) {
    return (
      <div className="poll-page">
        <div className="poll-card"><h2>Poll not found</h2></div>
      </div>
    );
  }

  // ── POLL VIEW (vote + results) ──
  const maxScore = Math.max(...Object.values(poll.date_scores), 1);

  return (
    <div className="poll-page">
      <div className="poll-card">
        <h2>📅 {poll.title}</h2>

        {!voterOnly && (
          <div className="poll-share-row">
            <input className="poll-share-link" readOnly value={shareLink} onFocus={e => e.target.select()} />
            <button className="pill-btn" onClick={handleShare}>📋 Copy link</button>
            {shareMsg && <span className="poll-share-msg">{shareMsg}</span>}
          </div>
        )}

        {!voterOnly && (
          <div className="poll-organizer-row">
            {!confirmDelete ? (
              <button className="pill-btn danger" onClick={() => setConfirmDelete(true)}>🗑️ Delete poll</button>
            ) : (
              <span className="confirm-delete">
                Delete this poll?
                <button className="pill-btn danger" onClick={handleDeletePoll}>Yes, delete</button>
                <button className="pill-btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
              </span>
            )}
          </div>
        )}

        {/* Results grid */}
        <div className="poll-results">
          <h3>Availability ({poll.total_voters} voter{poll.total_voters !== 1 ? 's' : ''})</h3>
          <div className="poll-grid">
            <div className="poll-grid-header">
              <div className="poll-grid-label" />
              {poll.candidate_dates.map(d => (
                <div
                  key={d}
                  className={`poll-grid-date ${poll.best_dates.includes(d) ? 'best' : ''}`}
                >
                  <span className="pgd-day">{getDayName(d)}</span>
                  <span className="pgd-num">{getDayNum(d)}</span>
                  <span className="pgd-month">{getMonthName(d)}</span>
                </div>
              ))}
            </div>

            {poll.votes.map(v => (
              <div key={v.voter_name} className="poll-grid-row">
                <div className="poll-grid-label">{v.voter_name}</div>
                {poll.candidate_dates.map(d => {
                  const isAvail = v.available_dates.includes(d);
                  const isTent = (v.tentative_dates || []).includes(d);
                  return (
                    <div
                      key={d}
                      className={`poll-grid-cell ${isAvail ? 'available' : isTent ? 'tentative' : 'unavailable'}`}
                    >
                      {isAvail ? '✓' : isTent ? '~' : '—'}
                    </div>
                  );
                })}
              </div>
            ))}

            {/* Totals row */}
            <div className="poll-grid-row totals">
              <div className="poll-grid-label">Score</div>
              {poll.candidate_dates.map(d => {
                const score = poll.date_scores[d] || 0;
                const pct = score / maxScore;
                const yes = poll.date_counts[d] || 0;
                const maybe = poll.tentative_counts[d] || 0;
                return (
                  <div
                    key={d}
                    className={`poll-grid-cell total-cell ${poll.best_dates.includes(d) ? 'best' : ''}`}
                    style={{ '--fill': pct } as React.CSSProperties}
                    title={`${yes} yes${maybe > 0 ? `, ${maybe} maybe` : ''}`}
                  >
                    {yes}{maybe > 0 && <span className="tent-count">+{maybe}</span>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Legend */}
          <div className="poll-legend">
            <span className="legend-item"><span className="legend-dot available" />Yes</span>
            <span className="legend-item"><span className="legend-dot tentative" />Maybe</span>
            <span className="legend-item"><span className="legend-dot unavailable" />No</span>
          </div>

          {poll.best_dates.length > 0 && poll.total_voters > 0 && (
            <div className="poll-best">
              🏆 Best date{poll.best_dates.length > 1 ? 's' : ''}:{' '}
              {poll.best_dates.map((d, i) => (
                <span key={d}>
                  <strong>{formatDateFull(d)}</strong>
                  {i < poll.best_dates.length - 1 && ', '}
                </span>
              ))}
              <span className="poll-best-count">
                ({poll.date_counts[poll.best_dates[0]]} yes
                {(poll.tentative_counts[poll.best_dates[0]] || 0) > 0 &&
                  `, ${poll.tentative_counts[poll.best_dates[0]]} maybe`})
              </span>
            </div>
          )}

          {onSelectDate && !voterOnly && poll.best_dates.length > 0 && (
            <div className="poll-action-row">
              {poll.best_dates.map(d => (
                <button key={d} className="find-btn" onClick={() => onSelectDate(d)}>
                  🎡 Find events for {formatDateShort(d)}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Vote form */}
        {!voted ? (
          <div className="poll-vote-section">
            <h3>Cast your vote</h3>
            <div className="poll-field">
              <label>Your name</label>
              <input
                type="text"
                placeholder="e.g. Erik"
                value={voterName}
                onChange={e => setVoterName(e.target.value)}
                className="poll-input"
              />
            </div>
            <p className="poll-hint">Tap once for ✓ yes, twice for ~ maybe, three times to clear:</p>
            <div className="poll-vote-dates">
              {poll.candidate_dates.map(d => {
                const state = voteDateStates[d] || 'none';
                return (
                  <button
                    key={d}
                    className={`poll-vote-date ${state}`}
                    onClick={() => toggleVoteDate(d)}
                  >
                    <span className="pvd-day">{getDayName(d)}</span>
                    <span className="pvd-num">{getDayNum(d)}</span>
                    <span className="pvd-month">{getMonthName(d)}</span>
                    {state === 'available' && <span className="pvd-badge yes">✓</span>}
                    {state === 'tentative' && <span className="pvd-badge maybe">~</span>}
                  </button>
                );
              })}
            </div>
            <button
              className="find-btn"
              onClick={handleVote}
              disabled={loading || !voterName.trim()}
            >
              {loading ? 'Submitting…' : `✅ Submit (${availCount} yes${tentCount > 0 ? `, ${tentCount} maybe` : ''})`}
            </button>
          </div>
        ) : (
          <div className="poll-voted">
            <p>✅ Thanks, <strong>{voterName}</strong>! Your vote has been recorded.</p>
            <button className="pill-btn" onClick={() => { setVoted(false); setVoterName(''); setVoteDateStates({}); }}>
              Vote as someone else
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
