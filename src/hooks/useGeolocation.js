import { useEffect, useState } from 'react';

// IP-based geolocation via ipapi.co — no browser permission prompt, works on
// all devices. Cached in localStorage so the first paint already has it.
export default function useGeolocation() {
  const [location, setLocation] = useState(() => {
    const cached = localStorage.getItem('ensemble_location');
    return cached ? JSON.parse(cached) : { city: null, country: null };
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('https://ipapi.co/json/');
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const parts = [data.city, data.region, data.country_name].filter(Boolean);
        const next = {
          city: parts.slice(0, -1).join(', ') || null,
          country: data.country_name || null,
        };
        localStorage.setItem('ensemble_location', JSON.stringify(next));
        if (!cancelled) setLocation(next);
      } catch (_) {}
    })();
    return () => { cancelled = true; };
  }, []);

  return location;
}
