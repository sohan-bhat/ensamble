export const API = {
  async fetchScore() {
    const res = await fetch('/api/score');
    if (!res.ok) throw new Error('Failed to fetch score');
    return res.json();
  },

  async addNote(noteData) {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(noteData),
    });
    if (!res.ok) throw new Error('Failed to add note');
    return res.json();
  },

  async updateNote(noteId, noteData) {
    const res = await fetch(`/api/notes/${noteId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(noteData),
    });
    if (!res.ok) throw new Error('Failed to update note');
    return res.json();
  },

  async deleteNote(noteId, sessionId) {
    const res = await fetch(`/api/notes/${noteId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
    if (!res.ok) throw new Error('Failed to delete note');
    return res.json();
  },

  async setMeasureSignature(measure, { key_signature, time_signature, tempo }) {
    const res = await fetch(`/api/measure-signature/${measure}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key_signature, time_signature, tempo }),
    });
    if (!res.ok) throw new Error('Failed to set measure signature');
    return res.json();
  },

  async deleteMeasureSignature(measure) {
    const res = await fetch(`/api/measure-signature/${measure}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete measure signature');
    return res.json();
  },

  async fetchNoteCount() {
    const res = await fetch('/api/notes/count');
    if (!res.ok) throw new Error('Failed to fetch count');
    return res.json();
  },

  async fetchContributions() {
    const res = await fetch('/api/contributions');
    if (!res.ok) throw new Error('Failed to fetch contributions');
    return res.json();
  },
};
