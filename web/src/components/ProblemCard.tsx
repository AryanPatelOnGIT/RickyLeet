import { ExternalLink, BookmarkPlus, Clock3, Target, Info } from 'lucide-react';
import type { Recommendation } from '../../../shared/types';
export function ProblemCard({ item, onFeedback, onSave, busy }: { item: Recommendation; onFeedback: (slug: string, action: string) => void; onSave: (slug: string) => void; busy: boolean }) {
  const p = item.problem;
  return <article className="problem-card">
    <div className="card-top"><div className="card-title"><span className="problem-id">#{p.id}</span><h3>{p.title}</h3><span className={`badge ${p.difficulty.toLowerCase()}`}>{p.difficulty}</span>{p.paid && <span className="badge premium">Premium</span>}{item.review && <span className="badge review">Review due</span>}</div><button className="icon-button" title="Save to list" aria-label={`Save ${p.title} to list`} onClick={() => onSave(p.slug)}><BookmarkPlus size={18}/></button></div>
    <div className="tag-row">{p.tags.slice(0, 5).map(t => <span className="tag" key={t}>{t}</span>)}</div>
    <div className="metrics"><span><Target size={15}/> {Math.round(item.probability * 100)}% solve chance</span><span><Clock3 size={15}/> ~{item.estimatedMinutes} min</span><span>{Math.round(p.acceptance)}% accepted</span></div>
    <div className="reason"><Info size={15}/><span>{item.reason}</span></div>
    <div className="card-actions"><a className="primary small" href={`https://leetcode.com/problems/${p.slug}/`} target="_blank" rel="noopener noreferrer">Open on LeetCode <ExternalLink size={15}/></a><div className="feedback-actions">{[['solved','Solved'],['attempted','Attempted'],['skipped','Skipped'],['too-easy','Too easy'],['too-hard','Too hard']].map(([action,label]) => <button key={action} disabled={busy} onClick={() => onFeedback(p.slug, action)}>{label}</button>)}</div></div>
  </article>;
}
