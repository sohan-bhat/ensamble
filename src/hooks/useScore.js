import { useEffect, useState, useCallback } from 'react';
import { API } from '../api.js';

// Fetches the score once on mount and keeps it in sync via the /api/events SSE
// stream. EventSource auto-reconnects on transient drops; on each (re)open
// after the first we refetch the full score so we never stay out of sync.
export default function useScore() {
  const [scoreData, setScoreData] = useState(null);
  const [error, setError] = useState(null);
  const [noteCount, setNoteCount] = useState(0);

  const refreshCount = useCallback(async () => {
    try {
      const { count } = await API.fetchNoteCount();
      setNoteCount(count);
    } catch (_) {}
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const data = await API.fetchScore();
        if (!cancelled) setScoreData(data);
      } catch (err) {
        if (!cancelled) setError(err);
      }
    })();
    refreshCount();

    const es = new EventSource('/api/events');
    let firstOpen = true;

    es.addEventListener('open', async () => {
      // Skip the initial open — we already fetched above.
      if (firstOpen) { firstOpen = false; return; }
      try {
        const data = await API.fetchScore();
        if (!cancelled) {
          setScoreData(data);
          refreshCount();
        }
      } catch (_) {}
    });

    es.addEventListener('note-added', (e) => {
      const note = JSON.parse(e.data);
      // Our own POST already pushed this note locally before the broadcast loops back — skip duplicates.
      setScoreData(prev => {
        if (!prev || prev.notes.some(n => n.id === note.id)) return prev;
        return { ...prev, notes: [...prev.notes, note] };
      });
      refreshCount();
    });

    es.addEventListener('note-updated', (e) => {
      const note = JSON.parse(e.data);
      setScoreData(prev => {
        if (!prev) return prev;
        const idx = prev.notes.findIndex(n => n.id === note.id);
        const notes = idx === -1 ? [...prev.notes, note] : prev.notes.map((n, i) => i === idx ? note : n);
        return { ...prev, notes };
      });
    });

    es.addEventListener('note-deleted', (e) => {
      const { id } = JSON.parse(e.data);
      setScoreData(prev => {
        if (!prev) return prev;
        const notes = prev.notes.filter(n => n.id !== id);
        return notes.length === prev.notes.length ? prev : { ...prev, notes };
      });
      refreshCount();
    });

    es.addEventListener('measure-signature', (e) => {
      const sig = JSON.parse(e.data);
      setScoreData(prev => {
        if (!prev) return prev;
        const sigs = prev.measureSignatures || [];
        const idx = sigs.findIndex(s => s.measure === sig.measure);
        const next = idx === -1
          ? [...sigs, sig].sort((a, b) => a.measure - b.measure)
          : sigs.map((s, i) => i === idx ? sig : s);
        return { ...prev, measureSignatures: next };
      });
    });

    es.addEventListener('measure-signature-deleted', (e) => {
      const { measure } = JSON.parse(e.data);
      setScoreData(prev => {
        if (!prev?.measureSignatures) return prev;
        const next = prev.measureSignatures.filter(s => s.measure !== measure);
        return next.length === prev.measureSignatures.length ? prev : { ...prev, measureSignatures: next };
      });
    });

    return () => {
      cancelled = true;
      es.close();
    };
  }, [refreshCount]);

  return { scoreData, setScoreData, error, noteCount, refreshCount };
}
