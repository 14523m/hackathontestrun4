/**
 * Civic engagement API: citizen heat reports + cooling siting optimizer.
 *
 * The civic loop: walkers report heat problems -> the app corroborates each
 * report with the heat model and clusters them -> decision-makers get a
 * structured dossier; the siting optimizer (same heat raster citizens see)
 * proposes where the city should add canopy/shade/misting, and reports
 * near a site are surfaced as public corroboration.
 */

import type { RoutePoint } from './coolRoute';

const BASE: string = import.meta.env.VITE_API_BASE ?? '/api';

export interface ReportDraft {
  lat: number;
  lon: number;
  kind: ReportKind;
  severity: 1 | 2 | 3 | 4 | 5;
  note?: string;
  hour?: number;
}

export type ReportKind = 'no-shade' | 'hot-surface' | 'no-seat' | 'no-water' | 'other';

export const REPORT_KINDS: { id: ReportKind; label: string }[] = [
  { id: 'no-shade', label: 'No shade on the walk' },
  { id: 'hot-surface', label: 'Scorching pavement' },
  { id: 'no-seat', label: 'Nowhere to sit' },
  { id: 'no-water', label: 'No water fountain' },
  { id: 'other', label: 'Something else' },
];

export interface StoredReport extends ReportDraft {
  ts: string;
  place: string;
  model: { score: number | null; band: string | null };
}

export interface ReportCluster {
  lat: number;
  lon: number;
  place: string;
  n: number;
  meanSeverity: number;
  topSeverity: number;
  kinds: Record<string, number>;
}

export interface ReportSummary {
  total: number;
  byKind: Record<string, number>;
  clusters: ReportCluster[];
}

export interface Dossier {
  generatedAt: string;
  totalReports: number;
  recentReports: number;
  topLocations: ReportCluster[];
  text: string;
  disclaimer: string;
}

export interface SitingSite {
  lat: number;
  lon: number;
  heatScore: number;
  coveredHeatMass: number;
  publicReports?: number;
}

export interface SitingPlan {
  kind: string;
  radiusM: number;
  budget: number;
  sites: SitingSite[];
  method: string;
  disclaimer: string;
}

/** File a heat report. 429 = throttled (5 / 10 s per visitor). */
export function submitReport(draft: ReportDraft): Promise<StoredReport> {
  return fetch(`${BASE}/civic/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  }).then(async (r) => {
    if (!r.ok) {
      const detail = await r.json().catch(() => ({}));
      throw new Error(detail.detail ?? `HTTP ${r.status}`);
    }
    return r.json() as Promise<StoredReport>;
  });
}

export function fetchReportSummary(): Promise<ReportSummary | null> {
  return fetch(`${BASE}/civic/reports/summary`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .catch(() => null);
}

export function fetchDossier(): Promise<Dossier | null> {
  return fetch(`${BASE}/civic/reports/dossier`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .catch(() => null);
}

export function fetchSitingPlan(kind: string, budget: number): Promise<SitingPlan | null> {
  return fetch(`${BASE}/civic/siting/cooling?kind=${kind}&budget=${budget}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .catch(() => null);
}

/** Copy helper for the dossier: clipboard with textarea fallback. */
export function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => fallbackCopy(text),
    );
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

export type { RoutePoint };
