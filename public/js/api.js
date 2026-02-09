// =========================================================================
// Ensemble — API Client
// =========================================================================

export const API = {
  /** Fetch the full score (metadata + instruments + notes) */
  async fetchScore() {
    const res = await fetch('/api/score');
    if (!res.ok) throw new Error('Failed to fetch score');
    return res.json();
  },

  /** Add a new note */
  async addNote(noteData) {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(noteData),
    });
    if (!res.ok) throw new Error('Failed to add note');
    return res.json();
  },

  /** Update an existing note */
  async updateNote(noteId, noteData) {
    const res = await fetch(`/api/notes/${noteId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(noteData),
    });
    if (!res.ok) throw new Error('Failed to update note');
    return res.json();
  },

  /** Delete a note (session-scoped) */
  async deleteNote(noteId, sessionId) {
    const res = await fetch(`/api/notes/${noteId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
    if (!res.ok) throw new Error('Failed to delete note');
    return res.json();
  },

  /** Fetch notes added since a given timestamp */
  async fetchNotesSince(timestamp) {
    const res = await fetch(`/api/notes/since/${encodeURIComponent(timestamp)}`);
    if (!res.ok) throw new Error('Failed to fetch new notes');
    return res.json();
  },

  /** Set key/time signature/tempo for a specific measure */
  async setMeasureSignature(measure, { key_signature, time_signature, tempo }) {
    const res = await fetch(`/api/measure-signature/${measure}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key_signature, time_signature, tempo }),
    });
    if (!res.ok) throw new Error('Failed to set measure signature');
    return res.json();
  },

  /** Delete a measure signature override */
  async deleteMeasureSignature(measure) {
    const res = await fetch(`/api/measure-signature/${measure}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete measure signature');
    return res.json();
  },

  /** Fetch total note count */
  async fetchNoteCount() {
    const res = await fetch('/api/notes/count');
    if (!res.ok) throw new Error('Failed to fetch count');
    return res.json();
  },

  /** Fetch recent contributions with location */
  async fetchContributions() {
    const res = await fetch('/api/contributions');
    if (!res.ok) throw new Error('Failed to fetch contributions');
    return res.json();
  },
};
