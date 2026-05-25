import { useRef } from 'react';

// Stable per-page-load session UUID used to scope deletions on the server.
export default function useSession() {
  const ref = useRef();
  if (!ref.current) ref.current = crypto.randomUUID();
  return ref.current;
}
