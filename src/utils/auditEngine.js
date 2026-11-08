import Fuse from 'fuse.js';
import Tesseract from 'tesseract.js';

/**
 * Tesseract invents symbol noise from photographic texture ("yp = Jd 5 ON on",
 * "[+ a 8", "4 » J"). A line only counts as language when it reads like language:
 * enough real words, no punctuation soup, and mostly letters.
 */
export function isValidHumanSentence(str) {
  const text = String(str || '').replace(/\s+/g, ' ').trim();
  if (text.length < 12) return false;
  if (/[=»«[\]{}|\\<>~_^]/.test(text)) return false;

  const realWords = text.match(/\b[a-zA-Z]{3,}\b/g) || [];
  if (realWords.length < 3) return false;

  const letters = (text.match(/[a-zA-Z]/g) || []).length;
  const nonSpace = text.replace(/\s/g, '').length;
  return nonSpace > 0 && letters / nonSpace >= 0.65;
}

const STOPWORDS = new Set([
  'with', 'from', 'that', 'this', 'have', 'were', 'will', 'your', 'theirs', 'their',
  'when', 'what', 'they', 'them', 'than', 'then', 'into', 'over', 'also', 'been',
  'being', 'more', 'most', 'such', 'each', 'both', 'which', 'while', 'after',
  'before', 'about', 'because', 'between', 'during', 'without', 'these', 'those',
  'there', 'where', 'every', 'other', 'under', 'until', 'upon', 'across', 'plus'
]);

function meaningfulWords(text) {
  return new Set(
    (String(text || '').toLowerCase().match(/\b[a-z]{4,}\b/g) || []).filter(
      (word) => !STOPWORDS.has(word)
    )
  );
}

// A contradiction is only credible when both sentences talk about the same thing.
function sharesMeaningfulWord(a, b) {
  const first = meaningfulWords(a);
  for (const word of meaningfulWords(b)) if (first.has(word)) return true;
  return false;
}

const QUANTITY_UNITS = new Set([
  'days', 'day', 'hours', 'hour', 'weeks', 'week', 'months', 'month', 'years', 'year',
  'miles', 'mile', 'km', 'oz', 'lb', 'lbs', 'g', 'kg', 'ml', 'liters', 'countries',
  'markets', 'stores', 'restaurants', 'users', 'customers', 'hospitals', 'tracks',
  'songs', 'people', 'employees', 'percent', 'stars', 'bit', 'businesses',
  'million', 'billion', 'thousand'
]);

// "5 days" or "150 hospitals" is a claim; a stray "4" out of a font size or a
// texture artifact is not.
function isMeaningfulQuantity(value, sentence) {
  const raw = String(value || '').trim();
  if (!/^\d{1,2}$/.test(raw)) return true;

  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const following = sentence.match(new RegExp(`(?:^|\\s)${escaped}\\s+([A-Za-z]{2,})`, 'i'));
  return Boolean(following && QUANTITY_UNITS.has(following[1].toLowerCase()));
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full, 16) || 0;
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

// HSL saturation of a colour: the difference between a brand hue and a grey. A
// calibration bar (#A0A0A0) and a white margin both read 0 here.
function hslSaturation({ r, g, b }) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const delta = max - min;
  if (delta === 0) return 0;
  const lightness = (max + min) / 2;
  return delta / (1 - Math.abs(2 * lightness - 1));
}

function getLuminance({ r, g, b }) {
  const a = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

export function getContrastRatio(rgb1, rgb2) {
  const lum1 = getLuminance(rgb1);
  const lum2 = getLuminance(rgb2);
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return Number(((brightest + 0.05) / (darkest + 0.05)).toFixed(2));
}

// sRGB (D65) -> CIELAB. CIE76 ΔE is simply the Euclidean distance in this space.
function srgbToLinear(channel) {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function rgbToLab({ r, g, b }) {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);

  // sRGB -> CIE XYZ, normalised against the D65 white point
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;

  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

// True perceptual CIE76 ΔE in CIELAB space, not the Euclidean RGB distance it
// used to be. ΔE > 28 is a realistic "clearly a different brand colour" line.
export function getDeltaE(rgb1, rgb2) {
  const lab1 = rgbToLab(rgb1);
  const lab2 = rgbToLab(rgb2);
  const dL = lab1.L - lab2.L;
  const da = lab1.a - lab2.a;
  const db = lab1.b - lab2.b;
  return Number(Math.sqrt(dL * dL + da * da + db * db).toFixed(1));
}

// Luminance straight from raw RGBA bytes, so tile scanning does not allocate an
// { r, g, b } object per pixel.
function luminanceFromBytes(r, g, b) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return lin(r) * 0.2126 + lin(g) * 0.7152 + lin(b) * 0.0722;
}

/**
 * Tile contrast fallback. OCR can only report the text it can read, which makes
 * the worst offenders — near-1:1 overlay text — exactly the ones it never sees.
 * This walks the canvas in small tiles and returns regions whose two tones are
 * far enough apart to be glyphs, yet too close for WCAG AA.
 */
export function scanLowContrastTiles(imgData, width, height, minRatio = 4.5) {
  const cols = 16;
  const tileW = Math.max(12, Math.ceil(width / cols));
  const tileH = tileW;
  const stride = Math.max(1, Math.round(Math.min(tileW, tileH) / 24));
  const regions = [];

  for (let y0 = 0; y0 < height; y0 += tileH) {
    for (let x0 = 0; x0 < width; x0 += tileW) {
      const x1 = Math.min(width, x0 + tileW);
      const y1 = Math.min(height, y0 + tileH);
      const samples = [];
      let maxJump = 0;
      for (let y = y0; y < y1; y += stride) {
        let previous = null;
        for (let x = x0; x < x1; x += stride) {
          const i = (y * width + x) * 4;
          const lum = luminanceFromBytes(imgData[i], imgData[i + 1], imgData[i + 2]);
          samples.push(lum);
          if (previous !== null && Math.abs(lum - previous) > maxJump) maxJump = Math.abs(lum - previous);
          previous = lum;
        }
      }
      if (samples.length < 16) continue;

      let minLum = 1;
      let maxLum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const lum = samples[i];
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
      }

      // Flat fills have no separation at all, photos/gradients have far too much,
      // and a smooth ramp has no sharp edge — the fallback only targets faint
      // glyphs sitting near their own background.
      const span = maxLum - minLum;
      if (span < 0.02 || span > 0.4) continue;
      if (maxJump < 0.08) continue;

      const mid = (minLum + maxLum) / 2;
      let darker = 0;
      for (let i = 0; i < samples.length; i += 1) if (samples[i] < mid) darker += 1;
      const inkFraction = darker / samples.length;
      if (inkFraction < 0.06 || inkFraction > 0.94) continue;

      const contrast = Number(((maxLum + 0.05) / (minLum + 0.05)).toFixed(2));
      if (contrast >= minRatio) continue;

      regions.push({ x0, y0, x1, y1, contrast });
    }
  }

  return regions;
}

// Comparative marketing language is the same unsubstantiated claim as "#1":
// "world's best selling" needs sourcing just as much as "100%".
const SUPERLATIVE_PATTERN = new RegExp(
  // "100%" sits outside the \b group: a boundary cannot follow "%", which is
  // why the percentage escaped detection for so long.
  String.raw`\b100\s*%|\b(?:number[- ]one|guaranteed|guarantees|zero[- ]downtime|zero[- ]risk|instant(?:ly)?|miracle|unlimited|best[- ]selling|unrivall?ed|unbeatable|top[- ]rated)\b|#\s*1\b|\bworld'?s\s+(?:best|leading|number one)\b|\b(?:the\s+)?best\s+(?:in|on)\s+(?:the\s+)?(?:world|market|industry)\b`,
  'i'
);

// Words a brand's own fact ledger uses that carry no identity signal. They are too
// common to prove an ad belongs to a brand, so they never count as a marker.
const IDENTITY_STOPWORDS = new Set([
  'about', 'after', 'also', 'been', 'before', 'being', 'between', 'brand', 'brands',
  'could', 'every', 'first', 'found', 'from', 'have', 'into', 'more', 'most', 'other',
  'over', 'shall', 'should', 'since', 'some', 'such', 'than', 'that', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'until',
  'upon', 'very', 'what', 'when', 'where', 'which', 'while', 'will', 'with', 'within',
  'without', 'would', 'your', 'years', 'guideline', 'guidelines', 'branding'
]);

/**
 * The vocabulary that proves an ad belongs to this brand: its name, the words of
 * its name, and the distinctive nouns its own guidelines repeat ("coffee",
 * "espresso", "Angus"). A Nike headline has none of these.
 */
function brandIdentityMarkers(brandVault) {
  const markers = new Set();
  const add = (value) => {
    const term = String(value || '').toLowerCase().replace(/[’‘]/g, "'").trim();
    if (term.length >= 3) markers.add(term);
  };

  add(brandVault.brandName);
  String(brandVault.brandName || '')
    .split(/\s+/)
    .forEach(add);
  (brandVault.facts || []).forEach((fact) => {
    (String(fact.statement || '').toLowerCase().match(/\b[a-z][a-z'’-]{3,}\b/g) || []).forEach(
      (word) => {
        if (!IDENTITY_STOPWORDS.has(word)) add(word);
      }
    );
  });
  return markers;
}

// A cross-brand creative is the failure a colour check cannot catch: the poster is
// beautifully made, but nothing on it belongs to the brand whose rules are loaded.
function auditBrandIdentity(text, brandVault, { label = 'Ad copy', verb = 'contains' } = {}) {
  const brandName = String(brandVault?.brandName || '').trim();
  // Normalised but not lowercased: the offender is quoted back as the designer
  // typed it ("YOU CAN'T WIN."), while matching still ignores case.
  const normalized = String(text || '')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  const haystack = normalized.toLowerCase();
  if (!brandName || !haystack) return null;

  for (const marker of brandIdentityMarkers(brandVault)) {
    if (haystack.includes(marker)) return null;
  }

  const excerpt = normalized.slice(0, 80);
  return {
    id: 'ISS-BRAND-1',
    ruleId: 'BRAND-IDENTITY',
    category: 'Cross-Brand / Brand Identity',
    severity: 'High',
    offendingText: excerpt,
    explanation: `${label} ('${excerpt}') ${verb} zero required ${brandName} brand identity markers or lockups.`,
    citation: `${brandVault.sourceName}: Brand Identity & Lockup Requirements`,
    suggestedFix: `Show the ${brandName} wordmark or an approved ${brandName} brand line, and remove other brands' campaign language.`
  };
}

export function auditAdText(adText, brandVault, { label = 'Ad copy', verb = 'contains' } = {}) {
  const issues = [];
  if (!adText || !adText.trim()) return issues;

  // 1. Banned Terms & AI-Slop Check
  brandVault.bannedTerms.forEach((rule) => {
    if (!rule.term) return;
    // A term may itself start or end with punctuation ("% off"), so the word
    // boundaries are added only where a word character actually sits. Apostrophes
    // match either glyph: a guideline's "can't" has to catch an ad's "CAN’T".
    const escaped = rule.term
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/'/g, "['’]");
    const lead = /^[a-z0-9]/i.test(rule.term) ? '\\b' : '';
    const trail = /[a-z0-9]$/i.test(rule.term) ? '\\b' : '';
    const regex = new RegExp(`${lead}${escaped}${trail}`, 'gi');
    let match;
    while ((match = regex.exec(adText)) !== null) {
      issues.push({
        id: `ISS-T-${issues.length + 1}`,
        ruleId: rule.id,
        category: rule.id.startsWith('SLOP') ? 'AI Slop / Tone' : 'Terminology Violation',
        severity: 'Medium',
        offendingText: match[0],
        explanation: `${rule.reason}. Flagged term "${match[0]}".`,
        citation: rule.citation,
        suggestedFix: rule.replacement
      });
    }
  });

  // 2. Quantitative Fact & Promotional Claim Verification
  const sentences = adText.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  const fuse = new Fuse(brandVault.facts, {
    keys: ['statement', 'keywords'],
    // 0.40 keeps a match to genuinely similar wording; 0.60 pulled in unrelated
    // facts and produced nonsense contradictions.
    threshold: 0.4,
    includeScore: true
  });

  sentences.forEach((sentence) => {
    // Skip "#1" style rankings: those are superlatives handled below, not quantities
    const adNumbers = sentence.match(/(?<!#)\b\d[\d,]*(?:\.\d+)?(?:\s*%|\+|\s*x|-bit)?\b/g);
    const hasSuperlative = SUPERLATIVE_PATTERN.test(sentence);

    const sentenceIsHuman = isValidHumanSentence(sentence);

    if (adNumbers && brandVault.facts.length > 0 && sentenceIsHuman) {
      const searchResults = fuse.search(sentence);
      // 0.40 similarity keeps fuzzy matches honest. When nothing is close enough,
      // fall back to the fact sharing the most meaningful nouns with the claim —
      // the same credibility test, without loosening the threshold.
      const comparableFact = (() => {
        const wanted = meaningfulWords(sentence);
        let best = null;
        let bestScore = 0;
        brandVault.facts.forEach((fact) => {
          let score = 0;
          meaningfulWords(fact.statement).forEach((word) => {
            if (wanted.has(word)) score += 1;
          });
          if (score > bestScore) {
            bestScore = score;
            best = fact;
          }
        });
        return best;
      })();
      // A weak Fuse hit that shares no real noun must not shadow a closer fact:
      // "...90,000 restaurants" fuzzily matched a beef sentence and lost the
      // restaurant fact that actually contradicted it.
      const fuseFact = searchResults.find((hit) =>
        sharesMeaningfulWord(sentence, hit.item.statement)
      )?.item;
      const bestFact = fuseFact || comparableFact;
      if (bestFact && sharesMeaningfulWord(sentence, bestFact.statement)) {
        // Strip thousands separators before comparing, so "40,000" and "40000"
        // are the same claim instead of two different ones.
        const normalized = (value) => value.replace(/[\s,]/g, '');
        const numberMatches = adNumbers.some((num) =>
          bestFact.numbers.some((fNum) => normalized(fNum) === normalized(num))
        );
        if (!numberMatches && bestFact.numbers.length > 0) {
          // Cite the ad figure that is comparable to this fact: in "500 miles ...
          // and a 15-year warranty" the 15 is what contradicts an 8-year warranty,
          // not the 500. Nearest-value matching also skips "#1" style superlatives.
          const toNumber = (value) => Number(String(value).replace(/[^\d.]/g, '')) || 0;
          const distanceToFact = (value) =>
            Math.min(...bestFact.numbers.map((fNum) => Math.abs(toNumber(value) - toNumber(fNum))));
          const wrongNum = adNumbers.reduce(
            (closest, candidate) => (distanceToFact(candidate) < distanceToFact(closest) ? candidate : closest),
            adNumbers[0]
          );
          const rightNum = bestFact.numbers.reduce(
            (closest, candidate) =>
              Math.abs(toNumber(candidate) - toNumber(wrongNum)) < Math.abs(toNumber(closest) - toNumber(wrongNum))
                ? candidate
                : closest,
            bestFact.numbers[0]
          );
          // A bare stray digit is OCR texture, not a claim; only flag it when it is
          // attached to a unit or noun phrase ("5 days", "150 hospitals").
          if (!isMeaningfulQuantity(wrongNum, sentence)) return;
          issues.push({
            id: `ISS-F-${issues.length + 1}`,
            ruleId: bestFact.id,
            category: 'Contradictory Fact / Claim',
            severity: 'High',
            offendingText: sentence,
            explanation: `Draft claims "${wrongNum}", contradicting the verified metric (${rightNum}) in your guidelines.`,
            citation: `${bestFact.citation}: "${bestFact.statement}"`,
            suggestedFix: sentence.replace(wrongNum, rightNum)
          });
        }
      } else if (hasSuperlative && sentenceIsHuman) {
        issues.push({
          id: `ISS-C-${issues.length + 1}`,
          ruleId: 'CLAIM-UNVERIFIED',
          category: 'Unsupported Promotional Claim',
          severity: 'High',
          offendingText: sentence,
          explanation: 'Quantitative or superlative promotional claim has no backing in the uploaded Fact Ledger.',
          citation: `Unverified Claim Policy (${brandVault.sourceName})`,
          suggestedFix: sentence
            .replace(/\b100%\b/gi, 'high-reliability')
            .replace(/\bguaranteed\b/gi, 'engineered for')
            .replace(/\b#1\b/gi, 'a leading')
        });
      }
    } else if (hasSuperlative && sentenceIsHuman) {
      issues.push({
        id: `ISS-S-${issues.length + 1}`,
        ruleId: 'CLAIM-ABSOLUTE',
        category: 'Unsupported Promotional Claim',
        severity: 'High',
        offendingText: sentence,
        explanation: 'Absolute/superlative promotional claim lacks substantiated evidence in brand guidelines.',
        citation: `FTC / Brand Substantiation Standard (${brandVault.sourceName})`,
        suggestedFix: sentence
          .replace(/\bguaranteed\b/gi, 'designed to deliver')
          .replace(/\b100%\b/gi, 'consistent')
          .replace(/\bzero-downtime\b/gi, 'high-availability')
          .replace(/\binstant\b/gi, 'rapid')
      });
    }

    // 3. Aggressive ALL-CAPS Tone Check
    const shouting = sentence.match(/\b[A-Z]{5,}\b/g);
    if (shouting && shouting.length >= 2) {
      issues.push({
        id: `ISS-TONE-${issues.length + 1}`,
        ruleId: 'TONE-CAPS',
        category: 'Tone & Accessibility',
        severity: 'Low',
        offendingText: sentence,
        explanation: `Excessive ALL-CAPS (${shouting.join(', ')}) reads aggressively and hinders screen-reader accessibility.`,
        citation: 'Brand Voice & Readability Standard',
        suggestedFix: sentence.replace(/\b([A-Z])([A-Z]{4,})\b/g, (_, f, r) => f + r.toLowerCase())
      });
    }
  });

  const identityIssue = auditBrandIdentity(adText, brandVault, { label, verb });
  if (identityIssue) {
    issues.push({ ...identityIssue, id: `ISS-BRAND-${issues.length + 1}` });
  }

  return issues;
}

// Curly apostrophes/quotes and ®, & and decimal inches are ordinary brand copy; a
// word pattern that rejects them silently deleted "CAN’T" and "Starbucks®".
const OCR_WORD_PATTERN = /^[a-zA-Z0-9%$.,'’‘"“”&®-]{2,}$/;

function cleanOcrWord(text) {
  return String(text || '')
    .trim()
    .replace(/^[^a-zA-Z0-9.]+/, '')
    .replace(/[^a-zA-Z0-9%$.,'’‘"“”&®-]+$/, '');
}

// Tesseract often emits the apostrophe of "CAN’T" as its own token, or splits the
// final T off after it. Re-joining them is the difference between reading CAN’T and
// silently dropping the word the poster turns on.
function joinApostropheWords(words) {
  const joined = [];
  for (const word of words) {
    const text = String(word.text || '').trim();
    const previous = joined[joined.length - 1];
    if (previous && /^['’‘`´]+$/.test(text) && /[A-Za-z]$/.test(previous.text)) {
      previous.text += text;
      continue;
    }
    if (previous && /['’‘`´]$/.test(previous.text) && /^[A-Za-z]$/.test(text)) {
      previous.text += text;
      continue;
    }
    joined.push({ ...word, text });
  }
  return joined;
}

// A poster headline is allowed to be short ("SO WIN.", "JUST DO IT."), so the
// banner gate asks only that the line reads as words rather than symbol soup.
function isAdBannerLine(text) {
  const line = String(text || '').trim();
  if (!/[a-zA-Z]{2,}/.test(line)) return false;
  const compact = line.replace(/\s+/g, '');
  if (compact.length < 2) return false;
  const alphanumeric = (compact.match(/[A-Za-z0-9]/g) || []).length;
  return alphanumeric / compact.length >= 0.55;
}

// Darkest pixel approximates the glyph, lightest its background: a single centre
// pixel lands between glyphs and reports false 1:1 failures.
function wordContrast(ctx, canvas, bbox) {
  const { x0, y0, x1, y1 } = bbox;
  const px0 = Math.max(0, Math.floor(x0));
  const py0 = Math.max(0, Math.floor(y0));
  const pw = Math.max(1, Math.min(canvas.width - px0, Math.ceil(x1 - x0)));
  const ph = Math.max(1, Math.min(canvas.height - py0, Math.ceil(y1 - y0)));
  const region = ctx.getImageData(px0, py0, pw, ph).data;

  let fgRgb = { r: 0, g: 0, b: 0 };
  let bgRgb = { r: 255, g: 255, b: 255 };
  let minLum = Infinity;
  let maxLum = -Infinity;
  for (let p = 0; p < region.length; p += 4) {
    const rgb = { r: region[p], g: region[p + 1], b: region[p + 2] };
    const lum = getLuminance(rgb);
    if (lum < minLum) {
      minLum = lum;
      fgRgb = rgb;
    }
    if (lum > maxLum) {
      maxLum = lum;
      bgRgb = rgb;
    }
  }
  return getContrastRatio(fgRgb, bgRgb);
}

export async function auditAdImage(imageSrc, brandVault, onProgress = () => {}) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = async () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);

      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const colorBuckets = {};
      const step = Math.max(4, Math.floor(imgData.length / 4 / 1500) * 4);

      for (let i = 0; i < imgData.length; i += step) {
        const r = Math.round(imgData[i] / 24) * 24;
        const g = Math.round(imgData[i + 1] / 24) * 24;
        const b = Math.round(imgData[i + 2] / 24) * 24;
        const key = `${r},${g},${b}`;
        colorBuckets[key] = (colorBuckets[key] || 0) + 1;
      }

      const topRgb = Object.entries(colorBuckets)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k]) => {
          const [r, g, b] = k.split(',').map(Number);
          return {
            r, g, b,
            hex: '#' + [r, g, b].map((x) => Math.min(255, x).toString(16).padStart(2, '0')).join('').toUpperCase()
          };
        });

      const visualIssues = [];

      // 1. Dominant Color vs Brand Hex Palette
      if (brandVault.colors.length > 0 && topRgb.length > 0) {
        const primarySample = topRgb[0];
        const nearest = brandVault.colors
          .map((bc) => ({ ...bc, deltaE: getDeltaE(primarySample, hexToRgb(bc.hex)) }))
          .sort((a, b) => a.deltaE - b.deltaE)[0];

        if (nearest.deltaE > 28) {
          visualIssues.push({
            id: 'VIS-CLR-1',
            ruleId: nearest.id,
            category: 'Visual Brand Consistency',
            severity: 'Medium',
            offendingText: `Banner Dominant Hex ${primarySample.hex}`,
            explanation: `Primary image color (${primarySample.hex}) sits ΔE₇₆=${nearest.deltaE} from the nearest approved palette color (${nearest.hex}) in CIELAB space, beyond the 28 perceptual tolerance.`,
            citation: nearest.source,
            suggestedFix: `Recolor banner background/accent to ${nearest.hex}`
          });
        }
      }

      // 1b. Signature chromatic palette. White and black are neutrals every poster
      // uses, so a #FFFFFF match proves nothing. A brand with a chromatic signature
      // colour (Starbucks green) needs at least one chromatic ad colour near it.
      const brandChromatic = brandVault.colors.filter(
        (color) =>
          !['#FFFFFF', '#000000'].includes(String(color.hex || '').toUpperCase()) &&
          hslSaturation(hexToRgb(color.hex)) >= 0.18
      );
      const adChromatic = topRgb.filter((color) => hslSaturation(color) >= 0.18);

      if (brandChromatic.length > 0 && adChromatic.length > 0) {
        const matches = adChromatic.map((sample) => {
          const nearest = brandChromatic
            .map((brandColor) => ({ ...brandColor, deltaE: getDeltaE(sample, hexToRgb(brandColor.hex)) }))
            .sort((a, b) => a.deltaE - b.deltaE)[0];
          return { sample, nearest };
        });
        const closest = [...matches].sort((a, b) => a.nearest.deltaE - b.nearest.deltaE)[0];
        const strictPalette = /no other colou?rs? may be substituted/i.test(brandVault.rawText || '');
        const hasPaletteMatch = matches.some((match) => match.nearest.deltaE <= 38);
        // A guideline that forbids substitution is absolute: one stray hue is a
        // violation even when another colour in the same banner does match.
        const strictViolation = strictPalette && matches.some((match) => match.nearest.deltaE > 40);
        const worst = [...matches].sort((a, b) => b.nearest.deltaE - a.nearest.deltaE)[0];
        const offender = !hasPaletteMatch ? closest : worst;
        // Suggest the brand's strongest hue rather than whichever palette row a
        // washed-out sample happened to pair with.
        const signature = [...brandChromatic]
          .sort((a, b) => hslSaturation(hexToRgb(b.hex)) - hslSaturation(hexToRgb(a.hex)))[0];

        if (!hasPaletteMatch || strictViolation) {
          visualIssues.push({
            id: 'VIS-PALETTE-1',
            ruleId: closest.nearest.id,
            category: 'Visual Brand Consistency',
            severity: 'High',
            offendingText: `Off-Brand Visual Palette — banner hue ${offender.sample.hex}`,
            explanation: hasPaletteMatch
              ? `Banner hue ${offender.sample.hex} sits ΔE₇₆=${offender.nearest.deltaE} from the nearest brand colour, ${offender.nearest.name} (${offender.nearest.hex}). The guidelines state no other colours may be substituted, so a hue this far outside the palette reads as another brand's campaign.`
              : `No chromatic colour in the banner is within ΔE₇₆=38 of the brand's signature palette. The closest is ${offender.sample.hex} at ΔE₇₆=${offender.nearest.deltaE} from ${offender.nearest.name} (${offender.nearest.hex}). These hues read as another brand's campaign.`,
            citation: `${brandVault.sourceName}: Signature Brand Palette`,
            suggestedFix: `Recolour the banner with the brand's chromatic palette (e.g. ${signature.hex})`
          });
        }
      }

      // 2. Tesseract.js OCR + per-line WCAG contrast audit
      let ocrText = '';
      let ocrWordCount = 0;
      let wcagFailCount = 0;
      let lowContrastRegions = [];
      const boundingBoxes = [];
      const failingLines = [];
      const contrastTarget = brandVault.minContrastRatio || 4.5;
      let ocrWorker = null;
      try {
        // tesseract.js v5+ moved word geometry under `blocks`, which is disabled by
        // default. Requesting it keeps boundingBoxes (and WCAG) populated.
        ocrWorker = await Tesseract.createWorker('eng', 1, {
          logger: (m) => {
            if (m.status === 'recognizing text') onProgress(Math.round(m.progress * 100));
          }
        });
        const result = await ocrWorker.recognize(imageSrc, {}, { blocks: true, text: true });
        const lines = (result.data.blocks || []).flatMap((block) =>
          (block.paragraphs || []).flatMap((paragraph) => paragraph.lines || [])
        );

        const keptLines = [];
        for (const line of lines) {
          if (keptLines.length >= 12) break;

          // 55 clears the noise floor without dropping clean display type; short
          // headlines are kept by isAdBannerLine rather than by sentence length.
          const words = joinApostropheWords(line.words || [])
            .map((word) => ({ ...word, cleanText: cleanOcrWord(word.text) }))
            .filter((word) => word.confidence >= 55 && OCR_WORD_PATTERN.test(word.cleanText));
          if (!words.length) continue;

          const lineText = words.map((word) => word.cleanText).join(' ');
          const avgConfidence = words.reduce((sum, word) => sum + word.confidence, 0) / words.length;
          if (avgConfidence < 55) continue;
          if (!isAdBannerLine(lineText)) continue;

          keptLines.push(lineText);
          ocrWordCount += words.length;

          const scored = words.map((word) => {
            const contrast = wordContrast(ctx, canvas, word.bbox);
            return { text: word.cleanText, contrast, failsContrast: contrast < contrastTarget, box: word.bbox };
          });

          scored.forEach((word) => {
            boundingBoxes.push({
              ...word.box,
              text: word.text,
              contrast: word.contrast,
              failsContrast: word.failsContrast
            });
          });

          const failing = scored.filter((word) => word.failsContrast);
          if (failing.length) {
            failingLines.push({
              text: lineText,
              failingText: failing.map((word) => word.text).join(' '),
              contrast: Number(
                (failing.reduce((sum, word) => sum + word.contrast, 0) / failing.length).toFixed(2)
              )
            });
          }
        }

        ocrText = keptLines.join('\n');

        // One card per text line, not per word: a low-contrast headline used to
        // produce a separate card for every word in it.
        failingLines.slice(0, 3).forEach((line) => {
          wcagFailCount += 1;
          visualIssues.push({
            id: `VIS-WCAG-${wcagFailCount}`,
            ruleId: 'WCAG-AA',
            category: 'Accessibility (WCAG 2.1)',
            severity: 'High',
            offendingText: `Flagged Banner Text: "${line.text}"`,
            explanation: `Average contrast across "${line.failingText}" is ${line.contrast}:1, below the ${contrastTarget}:1 WCAG AA minimum.`,
            citation: 'WCAG 2.1 AA Accessibility Standard',
            suggestedFix: 'Increase text overlay contrast above 4.5:1'
          });
        });
      } catch (err) {
        console.warn('OCR warning:', err);
      } finally {
        if (ocrWorker) {
          try {
            await ocrWorker.terminate();
          } catch {
            /* worker already released */
          }
        }
      }

      // 2b. Tile fallback: OCR is blind to near-1:1 text, so when it reads almost
      // nothing (or what it read has almost no separation) scan the pixels instead.
      const minRatio = brandVault.minContrastRatio || 4.5;
      const worstOcrContrast = boundingBoxes.reduce((min, box) => Math.min(min, box.contrast), Infinity);
      if (ocrWordCount < 2 || worstOcrContrast < 1.6) {
        lowContrastRegions = scanLowContrastTiles(imgData, canvas.width, canvas.height, minRatio);
        if (lowContrastRegions.length > 0 && wcagFailCount === 0) {
          const worstTile = lowContrastRegions.reduce((min, r) => Math.min(min, r.contrast), Infinity);
          visualIssues.push({
            id: 'VIS-WCAG-TILE-1',
            ruleId: 'WCAG-AA',
            category: 'Accessibility (WCAG 2.1)',
            severity: 'High',
            offendingText: `Low-contrast banner region (${lowContrastRegions.length} tile${lowContrastRegions.length > 1 ? 's' : ''})`,
            explanation: `OCR only resolved ${ocrWordCount} word(s) in this banner, and a tile scan found ${lowContrastRegions.length} region(s) whose text-to-background contrast tops out at ${worstTile}:1. Near-1:1 text is illegible to readers and invisible to OCR, so it is measured from pixels instead.`,
            citation: 'WCAG 2.1 AA Accessibility Standard',
            suggestedFix: 'Darken the overlay text or lighten its banner background until contrast exceeds 4.5:1'
          });
        }
      }

      // 3. Run Full Text Audit on Text Extracted from Inside the Banner Image
      const ocrIssues = auditAdText(ocrText, brandVault, {
        label: 'Ad creative and OCR text',
        verb: 'contain'
      }).map((iss) => ({
        ...iss,
        id: `OCR-${iss.id}`,
        category: `Image OCR: ${iss.category}`,
        explanation: `[Found in Banner Graphic] ${iss.explanation}`
      }));

      resolve({
        dominantColors: topRgb,
        ocrText,
        boundingBoxes,
        lowContrastRegions,
        issues: [...visualIssues, ...ocrIssues]
      });
    };
    img.src = imageSrc;
  });
}