module.exports = {
  detectClientType(text) {
    const t = (text || '').toLowerCase();
    if (/\b(existing|already a client|my attorney|current client)\b/.test(t)) return 'existing';
    if (/\b(accident|crash|injur|collision|new case|hurt|fell|fall)\b/.test(t)) return 'new';
    return null;
  },
  normalizeName(text) {
    if (!text) return null;
    const lower = text.toLowerCase().trim();
    const intent = lower.match(/\b(my name is|this is|i am|i'm)\s+([a-z][-a-z']+\s+[a-z][-a-z']+(?:\s+[a-z][-a-z']+)?)\b/i);
    if (intent) return capWords(intent[2]);
    const tokens = lower.replace(/[^a-z' -]/g, ' ').split(/\s+/).filter(Boolean);
    const blacklist = new Set([
      'it','happened','about','week','ago','accident','crash','phone','number','email','date','location','yesterday','today',
      'when','where','what','happened?','happened.'
    ]);
    if (tokens.length === 2 &&
        tokens.every(t => /^[a-z][a-z'-]{1,}$/i.test(t)) &&
        tokens.every(t => !blacklist.has(t))) {
      return capWords(tokens.join(' '));
    }
    return null;
    function capWords(s){ return s.replace(/\b[a-z]/g, c => c.toUpperCase()); }
  },
  normalizePhone(text) {
    if (!text) return null;
    const digits = (text.match(/\d/g) || []).join('');
    // allow 10 or 11 digits (with leading 1)
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return null;
  },
  normalizeEmail(text) {
    if (!text) return null;
    // accept spoken "john dot doe at mail dot com"
    const spoken = text.toLowerCase()
      .replace(/\s+at\s+/g, '@')
      .replace(/\s+dot\s+/g, '.')
      .replace(/\s+/g, '');
    const email = spoken.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    return email ? email[0] : null;
  },
  normalizeDate(text) {
    if (!text) return null;
    const t = text.toLowerCase().trim();
    if (/\btoday\b/.test(t)) return 'today';
    if (/\byesterday\b/.test(t)) return 'yesterday';
    const mdy = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
    if (mdy) {
      const [ , m, d, y ] = mdy;
      const year = y.length === 2 ? `20${y}` : y;
      return `${m.padStart(2,'0')}/${d.padStart(2,'0')}/${year}`;
    }
    // e.g., "June 5 2025"
    const mon = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
    if (mon) {
      const monthMap = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',sept:'09',oct:'10',nov:'11',dec:'12'};
      const M = monthMap[mon[1].toLowerCase()];
      const D = `${mon[2]}`.padStart(2,'0');
      const Y = mon[3] || '2025';
      return `${M}/${D}/${Y}`;
    }
    return null;
  },
  normalizeLocation(text) {
    if (!text) return null;
    // Prefer format "City, ST"
    const comma = text.match(/\b([A-Za-z .'-]+),\s*([A-Za-z]{2})\b/);
    if (comma) {
      return `${cap(comma[1])}, ${comma[2].toUpperCase()}`;
    }
    // Fallback: last two tokens as City State
    const parts = text.trim().split(/\s+/);
    if (parts.length >= 2) {
      const st = parts.pop();
      const city = parts.join(' ');
      if (/^[A-Za-z]{2}$/.test(st)) return `${cap(city)}, ${st.toUpperCase()}`;
    }
    return null;
    function cap(s){ return s.replace(/\b[a-z]/g, c => c.toUpperCase()); }
  },
  isAffirmative(text) {
    return /\b(yes|correct|that'?s right|sounds good|yep|uh huh|affirmative|ok|okay|sure)\b/i.test(text || '');
  },
  isNegative(text) {
    return /\b(no|not|incorrect|that'?s wrong|nah|nope)\b/i.test(text || '');
  }
};
