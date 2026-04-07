// Use relative URLs in production (served by backend), absolute in dev
const API_BASE = import.meta.env.DEV ? 'http://localhost:8000' : '';

export async function getPublicUrl(): Promise<string> {
  try {
    const res = await fetch(`${API_BASE}/public-url`);
    if (!res.ok) return '';
    const data = await res.json();
    return data.url || '';
  } catch {
    return '';
  }
}

export interface Event {
  id: number;
  title: string;
  date: string | null;
  location: string | null;
  url: string | null;
  description: string | null;
  source: string;
  image_url: string | null;
  category: string | null;
  created_at: string | null;
}

export interface Filters {
  source?: string;
  from?: string;
  to?: string;
  search?: string;
  venue?: string;
  category?: string;
}

export async function fetchEvents(filters?: Filters): Promise<Event[]> {
  const params = new URLSearchParams();
  if (filters?.source) params.set('source', filters.source);
  if (filters?.from) params.set('from', filters.from);
  if (filters?.to) params.set('to', filters.to);
  if (filters?.search) params.set('search', filters.search);
  if (filters?.venue) params.set('venue', filters.venue);
  if (filters?.category) params.set('category', filters.category);

  const qs = params.toString();
  const res = await fetch(`${API_BASE}/events${qs ? '?' + qs : ''}`);
  if (!res.ok) throw new Error('Failed to fetch events');
  return res.json();
}

export async function fetchVenues(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/events/venues`);
  if (!res.ok) throw new Error('Failed to fetch venues');
  const data = await res.json();
  return data.venues;
}

export async function fetchCategories(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/events/categories`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.categories;
}

export async function deleteEvent(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/events/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete event');
}

export async function deleteAllEvents(): Promise<void> {
  const res = await fetch(`${API_BASE}/events`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete events');
}

export async function fetchScrapers(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/scrapers`);
  if (!res.ok) throw new Error('Failed to fetch scrapers');
  const data = await res.json();
  return data.scrapers;
}

export interface ScrapeResult {
  message: string;
  total_scraped: number;
  added: number;
  source?: string;
  results?: { source: string; scraped: number; added: number }[];
  errors?: { source: string; error: string }[];
}

export async function scrapeEvents(source: string, fromDate?: string, toDate?: string): Promise<ScrapeResult> {
  const body: Record<string, unknown> = { source };
  if (fromDate) body.from_date = fromDate;
  if (toDate) body.to_date = toDate;
  const res = await fetch(`${API_BASE}/scrape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Scraping failed' }));
    throw new Error(err.detail || 'Scraping failed');
  }
  return res.json();
}

export async function scrapeAll(fromDate?: string, toDate?: string, sources?: string[]): Promise<ScrapeResult> {
  const body: Record<string, unknown> = {};
  if (fromDate) body.from_date = fromDate;
  if (toDate) body.to_date = toDate;
  if (sources && sources.length > 0) body.sources = sources;
  const res = await fetch(`${API_BASE}/scrape-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Scraping failed' }));
    throw new Error(err.detail || 'Scraping failed');
  }
  return res.json();
}

export async function enrichEvents(): Promise<{ enriched: number }> {
  const res = await fetch(`${API_BASE}/events/enrich`, { method: 'POST' });
  if (!res.ok) return { enriched: 0 };
  return res.json();
}

export function getExportUrl(filters: Filters, format: 'csv' | 'text' = 'csv'): string {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.search) params.set('search', filters.search);
  if (filters.venue) params.set('venue', filters.venue);
  if (filters.category) params.set('category', filters.category);
  params.set('format', format);
  return `${API_BASE}/events/export?${params.toString()}`;
}

export async function getExportText(filters: Filters): Promise<string> {
  const url = getExportUrl(filters, 'text');
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to export');
  return res.text();
}

// ── Poll API ──

export interface PollData {
  id: string;
  title: string;
  candidate_dates: string[];
  created_at: string | null;
  votes: PollVoteData[];
  date_counts: Record<string, number>;
  tentative_counts: Record<string, number>;
  date_scores: Record<string, number>;
  best_dates: string[];
  total_voters: number;
}

export interface PollVoteData {
  id: number;
  poll_id: string;
  voter_name: string;
  available_dates: string[];
  tentative_dates: string[];
  created_at: string | null;
}

export interface PollSummary {
  id: string;
  title: string;
  candidate_dates: string[];
  created_at: string | null;
  total_voters: number;
}

export async function listPolls(): Promise<PollSummary[]> {
  const res = await fetch(`${API_BASE}/polls`);
  if (!res.ok) return [];
  return res.json();
}

export async function createPoll(title: string, candidateDates: string[]): Promise<PollData> {
  const res = await fetch(`${API_BASE}/polls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, candidate_dates: candidateDates }),
  });
  if (!res.ok) throw new Error('Failed to create poll');
  return res.json();
}

export async function getPoll(pollId: string): Promise<PollData> {
  const res = await fetch(`${API_BASE}/polls/${pollId}`);
  if (!res.ok) throw new Error('Poll not found');
  return res.json();
}

export async function submitVote(pollId: string, voterName: string, availableDates: string[], tentativeDates: string[] = []): Promise<void> {
  const res = await fetch(`${API_BASE}/polls/${pollId}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voter_name: voterName, available_dates: availableDates, tentative_dates: tentativeDates }),
  });
  if (!res.ok) throw new Error('Failed to submit vote');
}

export async function deletePoll(pollId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/polls/${pollId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete poll');
}

export async function deleteVote(pollId: string, voterName: string): Promise<void> {
  const res = await fetch(`${API_BASE}/polls/${pollId}/vote/${encodeURIComponent(voterName)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete vote');
}
