import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ExternalLink, RefreshCw, Search, Settings2, X } from 'lucide-react';
import type { Difficulty, SearchFilters, SearchResponse, Settings } from '../../shared/types';
import { api, bootstrap, saveSettings, search, searchCached, type Bootstrap } from './api';
import './style.css';

function parseImport(content: string, name: string): string[] {
  if (name.toLowerCase().endsWith('.json')) {
    const value = JSON.parse(content);
    const rows = Array.isArray(value) ? value : value.slugs ?? value.submissions ?? [];
    return rows.map((row: unknown) => typeof row === 'string' ? row : typeof row === 'object' && row !== null && 'slug' in row ? String(row.slug) : '').filter(Boolean);
  }
  const lines = content.trim().split(/\r?\n/);
  const columns = lines[0]?.split(',').map(value => value.trim().toLowerCase()) ?? [];
  const index = columns.indexOf('slug');
  return lines.slice(index < 0 ? 0 : 1).map(line => line.split(',')[Math.max(0, index)]?.trim()).filter(Boolean);
}

function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [filters, setFilters] = useState<SearchFilters>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [session, setSession] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [catalogStatus, setCatalogStatus] = useState('');

  const load = useCallback(async (next: SearchFilters, remote = false) => {
    setBusy(remote);
    try {
      const value = await (remote ? search(next) : searchCached(next));
      setResults(value);
      setData(current => current ? { ...current, profile: value.profile, model: value.model, syncStatus: value.syncStatus, catalogCount: value.catalogCount } : current);
      if (value.syncError) setNotice(`LeetCode sync failed. Using saved data: ${value.syncError}`);
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { void (async () => {
    try {
      const initial = await bootstrap(); setData(initial); setDraft(initial.settings);
      await load({}, false); await load({}, true);
    } catch (error) { setNotice(String(error)); }
  })(); }, [load]);

  const sync = async () => {
    setBusy(true);
    try {
      const status = await api<{ newSolves: number; error: string }>('/sync', 'POST');
      await load(filters);
      setNotice(status.error ? `Saved data retained: ${status.error}` : `Sync complete. ${status.newSolves} new verified solves.`);
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  };
  const feedback = async (slug: string, action: 'solved' | 'skipped') => {
    try { await api('/feedback', 'POST', { slug, action }); await load(filters); setNotice(action === 'solved' ? 'Solve saved locally.' : 'Skipped for 30 days.'); }
    catch (error) { setNotice(String(error)); }
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const value = await saveSettings(draft); setDraft(value);
      const fresh = await bootstrap(); setData(fresh);
      await load(filters); setSettingsOpen(false);
      setNotice('Profile settings saved.');
    } catch (error) { setNotice(String(error)); }
    finally { setBusy(false); }
  };
  const refreshCatalog = async () => {
    try {
      await api('/catalog/refresh', 'POST'); setCatalogStatus('Catalog refresh running…');
      const poll = window.setInterval(async () => {
        try {
          const job = await api<Bootstrap['catalogJob']>('/catalog/status');
          setCatalogStatus(job.running ? `Loading ${job.loaded} problems…` : job.error || `Catalog updated: ${job.loaded} problems`);
          if (!job.running) { window.clearInterval(poll); const fresh = await bootstrap(); setData(fresh); await load(filters); }
        } catch { window.clearInterval(poll); setCatalogStatus('Catalog refresh failed. Saved catalog is available.'); }
      }, 2000);
    } catch (error) { setCatalogStatus(String(error)); }
  };
  const importFile = async (file: File) => {
    try { const slugs = parseImport(await file.text(), file.name); const result = await api<{ imported: number; ignored: number }>('/import', 'POST', { slugs }); await load(filters); setNotice(`Imported ${result.imported} solves; ${result.ignored} entries ignored.`); }
    catch (error) { setNotice(String(error)); }
  };
  if (!data) return <div className="loading" role="status">Loading RickyLeet… {notice}</div>;
  const profile = results?.profile ?? data.profile;
  const status = results?.syncStatus ?? data.syncStatus;
  const recommendations = results?.recommendations ?? [];
  const incomplete = status.reportedSolved > status.verifiedSolved;
  const practiceRange = [...new Set(recommendations.slice(0, 10).map(item => item.problem.difficulty))].sort((a, b) => ['Easy', 'Medium', 'Hard'].indexOf(a) - ['Easy', 'Medium', 'Hard'].indexOf(b)).join('–') || 'Building model';
  return <div className="app">
    <header className="header"><div><h1>RickyLeet</h1><p>Choose the next problem with purpose.</p></div><div className="header-actions"><button className="button subtle" onClick={() => void sync()} disabled={busy || !data.settings.username}><RefreshCw size={16}/> Sync</button><button className="button subtle" onClick={() => setSettingsOpen(true)}><Settings2 size={16}/> Settings</button></div></header>
    <main className="workspace">
      {notice && <div className="notice" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss"><X size={15}/></button></div>}
      <section className="summary" aria-label="Profile summary"><div><span className="label">PROFILE</span><strong>{profile.username || 'Add a username in Settings'}</strong></div><div><span className="label">VERIFIED SOLVES</span><strong>{status.verifiedSolved}</strong></div><div><span className="label">PRACTICE RANGE</span><strong>{practiceRange}</strong></div><div><span className="label">LAST SYNC</span><strong>{status.lastSync ? new Date(status.lastSync).toLocaleString() : 'Not yet synced'}</strong></div></section>
      {incomplete && <p className="coverage" role="note">LeetCode reports {status.reportedSolved} solves; RickyLeet has identifiers for {status.verifiedSolved}. Public history may be incomplete. Add a session cookie or import solved slugs to improve exclusion.</p>}
      <section className="discovery"><div className="section-head"><div><span className="label">YOUR NEXT STEP</span><h2>Recommended problems</h2></div><button className="button primary" disabled={busy} onClick={() => void load(filters, true)}>{busy ? 'Updating…' : 'Refresh recommendations'}</button></div>
        <div className="controls"><label className="search-field"><Search size={17}/><input aria-label="Search problems" placeholder="Search title, ID, or topic" value={filters.query ?? ''} onChange={e => setFilters({ ...filters, query: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') void load(filters); }}/></label><select aria-label="Topic filter" value={filters.tags?.[0] ?? ''} onChange={e => { const next = { ...filters, tags: e.target.value ? [e.target.value] : [] }; setFilters(next); void load(next); }}><option value="">All topics</option>{data.tags.map(tag => <option key={tag} value={tag}>{tag}</option>)}</select><select aria-label="Difficulty filter" value={filters.difficulties?.[0] ?? ''} onChange={e => { const next = { ...filters, difficulties: e.target.value ? [e.target.value as Difficulty] : [] }; setFilters(next); void load(next); }}><option value="">All difficulties</option>{(['Easy','Medium','Hard'] as Difficulty[]).map(difficulty => <option key={difficulty}>{difficulty}</option>)}</select><button className="button subtle" onClick={() => void load(filters)}>Apply</button></div>
        <div className="list-meta">{recommendations.length} unsolved suggestions from {data.catalogCount.toLocaleString()} cached problems</div>
        <div className="problem-list">{recommendations.map(item => <article className="problem-row" key={item.problem.slug}><div className="problem-main"><div className="problem-heading"><span className="problem-id">#{item.problem.id}</span><h3>{item.problem.title}</h3><span className={`difficulty ${item.problem.difficulty.toLowerCase()}`}>{item.problem.difficulty}</span></div><div className="tags">{item.problem.tags.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}</div><p>{item.reason}</p></div><div className="row-actions"><a href={`https://leetcode.com/problems/${item.problem.slug}/`} target="_blank" rel="noopener noreferrer" aria-label={`Open ${item.problem.title} on LeetCode`}><ExternalLink size={16}/> Open</a><button onClick={() => void feedback(item.problem.slug, 'solved')}>Solved</button><button onClick={() => void feedback(item.problem.slug, 'skipped')}>Skip</button></div></article>)}</div>
        {!recommendations.length && <div className="empty">{data.catalogCount ? 'No unsolved problems match these filters.' : 'Refresh the catalog in Settings to load problems.'}</div>}
      </section>
    </main>
    {settingsOpen && draft && <div className="dialog-backdrop" onClick={() => setSettingsOpen(false)}><section className="settings-dialog" role="dialog" aria-modal="true" aria-label="Settings" onClick={e => e.stopPropagation()}><div className="dialog-head"><h2>Settings</h2><button className="icon-button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}><X size={19}/></button></div><label>LeetCode username<input value={draft.username} onChange={e => setDraft({ ...draft, username: e.target.value })} placeholder="your-username"/></label><div className="setting-actions"><button className="button primary" disabled={busy} onClick={() => void save()}>Save profile</button><button className="button subtle" disabled={busy || !draft.username} onClick={() => void sync()}>Sync now</button></div><hr/><h3>Problem catalog</h3><p>Metadata is cached locally. A refresh may take several minutes.</p><button className="button subtle" onClick={() => void refreshCatalog()}>Refresh catalog</button><span className="setting-note">{catalogStatus}</span><hr/><h3>Complete solved history</h3><p>Public LeetCode data usually gives recent accepted submissions, not a complete solved list. You can import slugs or provide a session cookie.</p><label className="upload button subtle">Import solved JSON or CSV<input type="file" accept=".json,.csv,.txt" onChange={e => { const file = e.target.files?.[0]; if (file) void importFile(file); e.target.value = ''; }}/></label><p className="warning">Security: a LEETCODE_SESSION cookie grants account access. It is sent to this local server once, encrypted on disk, and sent only to LeetCode. Revoke it by logging out of LeetCode.</p><label>Session cookie<input type="password" autoComplete="off" value={session} onChange={e => setSession(e.target.value)} placeholder={draft.hasSession ? 'Saved locally' : 'Optional'}/></label><div className="setting-actions"><button className="button subtle" disabled={!session} onClick={() => void api('/session', 'POST', { session }).then(() => { setSession(''); setNotice('Session saved locally.'); })}>Save cookie</button><button className="button subtle" onClick={() => void api('/session', 'POST', { session: '' }).then(() => setNotice('Saved session cleared.'))}>Clear</button><a className="button subtle" href="/api/export" download>Export data</a></div></section></div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
