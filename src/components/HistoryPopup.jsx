import { useEffect, useState } from 'react';
import { API } from '../api.js';

function formatTimeAgo(isoString) {
  const date = new Date(isoString + 'Z');
  const diffSec = Math.floor((new Date() - date) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

export default function HistoryPopup({ open, onClose }) {
  const [contributions, setContributions] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setContributions(null);
    setError(false);
    (async () => {
      try {
        const { contributions } = await API.fetchContributions();
        if (!cancelled) setContributions(contributions);
      } catch (_) {
        if (!cancelled) setError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  return (
    <div id="history-overlay" className={open ? '' : 'hidden'} onClick={(e) => { if (e.currentTarget === e.target) onClose(); }}>
      <div id="history-popup">
        <div className="history-header">
          <span className="history-title">Contribution History</span>
          <button id="history-close" onClick={onClose}>&times;</button>
        </div>
        <div id="history-list">
          {error
            ? <p className="history-empty">Failed to load history.</p>
            : contributions === null
              ? <p className="history-empty">Loading...</p>
              : contributions.length === 0
                ? <p className="history-empty">No contributions with location yet.</p>
                : contributions.map((c, i) => (
                  <div key={i} className="history-entry">
                    <span className="history-location">{c.city}, {c.country}</span>
                    <span className="history-time">{formatTimeAgo(c.created_at)}</span>
                  </div>
                ))
          }
        </div>
      </div>
    </div>
  );
}
