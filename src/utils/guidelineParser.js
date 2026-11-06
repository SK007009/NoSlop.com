import nlp from 'compromise';
// Legacy build: the modern one calls Uint8Array.prototype.toHex, which only exists
// in Chromium 140+. Older browsers throw "hashOriginal.toHex is not a function" on
// every PDF, so the legacy bundle (which ships its own polyfills) is required.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import Tesseract from 'tesseract.js';

// Configure PDF.js worker using Vite's local bundler with CDN fallback
try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString();
} catch {
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/legacy/build/pdf.worker.min.mjs`;
}

const MAX_PDF_PAGES = 6;
const PDF_RENDER_SCALE = 1.5;
// A page with less than this much selectable text is treated as scanned artwork
const SPARSE_PAGE_TEXT = 60;
const MAX_CANVAS_EDGE = 2600;

function channelHex(value) {
  return Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, '0');
}

function rgbToHex(r, g, b) {
  return `#${channelHex(r)}${channelHex(g)}${channelHex(b)}`.toUpperCase();
}

// Readable swatch names, so a sampled palette is not four rows of "Custom Color"
function describeHex(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2 / 255;

  if (max - min < 18) {
    if (lightness > 0.72) return 'Soft Neutral';
    if (lightness > 0.4) return 'Stone Grey';
    return 'Charcoal';
  }

  const delta = max - min;
  let hue;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  if (hue < 0) hue += 360;

  const family =
    hue < 15 || hue >= 345
      ? 'Red'
      : hue < 45
        ? 'Amber'
        : hue < 70
          ? 'Lime'
          : hue < 165
            ? 'Green'
            : hue < 195
              ? 'Teal'
              : hue < 255
                ? 'Blue'
                : hue < 300
                  ? 'Violet'
                  : 'Magenta';
  const tone = lightness > 0.72 ? 'Light' : lightness > 0.42 ? 'Mid' : 'Deep';
  return `${tone} ${family}`;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image could not be decoded'));
    img.src = src;
  });
}

// One throwaway worker per OCR pass: terminating keeps a WASM worker from being
// held open for the rest of the session after a single scanned page.
async function runOcr(source) {
  let worker = null;
  try {
    worker = await Tesseract.createWorker('eng');
    const { data } = await worker.recognize(source);
    return (data?.text || '').trim();
  } catch (err) {
    console.warn('Guideline OCR warning:', err);
    return '';
  } finally {
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        /* worker already released */
      }
    }
  }
}

/**
 * Dominant brand colours straight off a rendered canvas. Transparent pixels and
 * near-white / near-black page backgrounds are skipped — a deck is mostly page
 * and margin, so counting those would drown the actual brand accents.
 */
export function extractColorsFromCanvas(canvas, maxColors = 4, sourceLabel = 'Visual Asset Sampling') {
  if (!canvas || !canvas.width || !canvas.height) return [];

  let ctx;
  try {
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  } catch {
    return [];
  }
  if (!ctx) return [];

  let pixels;
  try {
    pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch (err) {
    // Tainted canvas (remote asset without CORS headers) — caller keeps going
    console.warn('Canvas colour sampling blocked:', err);
    return [];
  }

  const buckets = new Map();
  const totalPixels = pixels.length / 4;
  // Cap the scan so a 4000px slide does not walk 16M pixels
  const stride = Math.max(1, Math.floor(totalPixels / 240000));

  for (let index = 0; index < totalPixels; index += stride) {
    const i = index * 4;
    if (pixels[i + 3] < 8) continue;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    if (r > 240 && g > 240 && b > 240) continue;
    if (r < 18 && g < 18 && b < 18) continue;

    const qr = Math.min(255, Math.round(r / 16) * 16);
    const qg = Math.min(255, Math.round(g / 16) * 16);
    const qb = Math.min(255, Math.round(b / 16) * 16);
    const key = `${qr},${qg},${qb}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.count += 1;
    else buckets.set(key, { r: qr, g: qg, b: qb, count: 1 });
  }

  return [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, maxColors)
    .map((bucket, idx) => {
      const hex = rgbToHex(bucket.r, bucket.g, bucket.b);
      return {
        id: `CLR-V${idx + 1}`,
        name: describeHex(hex),
        hex,
        source: sourceLabel
      };
    });
}

export async function extractTextFromPDF(file, onProgress = () => {}) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);

  let fullText = '';
  const visualColors = [];
  const seenHex = new Set();

  for (let i = 1; i <= pageCount; i += 1) {
    onProgress(Math.round(((i - 1) / pageCount) * 55), `Rendering page ${i} of ${pageCount}…`);

    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => (typeof item.str === 'string' ? item.str : ''))
      .join(' ')
      .trim();

    // Fresh canvas per page: reusing one would paint page 2 over page 1's artwork
    // and sample a blend of both.
    const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

    extractColorsFromCanvas(canvas, 3, `${file.name} (Page ${i} Visual Palette)`).forEach((color) => {
      if (seenHex.has(color.hex)) return;
      seenHex.add(color.hex);
      visualColors.push(color);
    });

    let text = pageText;
    if (pageText.length < SPARSE_PAGE_TEXT) {
      onProgress(
        Math.round(55 + (i / pageCount) * 40),
        `Scanning page ${i} of ${pageCount} — no selectable text, running OCR…`
      );
      const ocrText = await runOcr(canvas);
      if (ocrText) text = `${pageText} ${ocrText}`.trim();
    }

    fullText += `\n[Page ${i}] ${text}`;
    onProgress(Math.round((i / pageCount) * 100), `Parsed page ${i} of ${pageCount}…`);
  }

  return { text: fullText.trim(), visualColors };
}

export async function extractGuidelinesFromImage(file, onProgress = () => {}) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    onProgress(15, 'Rendering guideline image onto canvas…');

    const naturalWidth = img.naturalWidth || img.width;
    const naturalHeight = img.naturalHeight || img.height;
    // Keep a huge poster inside canvas limits; colour sampling is scale-invariant
    const scale = Math.min(1, MAX_CANVAS_EDGE / Math.max(naturalWidth, naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(naturalHeight * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    onProgress(40, 'Sampling dominant brand swatches…');
    const visualColors = extractColorsFromCanvas(
      canvas,
      4,
      `${file.name} (Visual Swatch Extraction)`
    );

    onProgress(60, 'Reading printed brand rules with OCR…');
    const text = await runOcr(canvas);

    onProgress(100, 'Image ingestion complete');
    return { text, visualColors };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function parseRawGuidelines(rawText, sourceName = 'Uploaded Brand Guideline', visualColors = []) {
  const lines = rawText
    .split(/(?:\r?\n|(?<=[.!?])\s+)/)
    .map((l) => l.trim())
    .filter((l) => l.length > 3);

  // 1. Merge written #HEX codes with colours sampled from PDF/image artwork.
  // Written codes keep their order, sampled ones fill in behind them, and duplicate
  // hex values collapse so the palette never shows the same swatch twice.
  const hexMatches = [...new Set((rawText.match(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g) || []).map((hex) => hex.toUpperCase()))];
  const writtenColors = hexMatches.map((hex, idx) => ({
    name: `Brand Palette ${idx + 1}`,
    hex,
    source: `${sourceName} (Auto-mined Hex)`
  }));

  const mergedSwatches = [];
  const seenHex = new Set();
  [...writtenColors, ...visualColors].forEach((swatch) => {
    const hex = (swatch?.hex || '').toUpperCase();
    if (!hex || seenHex.has(hex)) return;
    seenHex.add(hex);
    mergedSwatches.push({
      hex,
      name: swatch.name || describeHex(hex),
      source: swatch.source || sourceName
    });
  });

  const colors = mergedSwatches.map((swatch, idx) => ({
    id: `CLR-${idx + 1}`,
    ...swatch
  }));

  const bannedTerms = [];
  const facts = [];
  let currentPage = 'Doc';

  lines.forEach((line, idx) => {
    const pageTag = line.match(/\[Page (\d+)\]/);
    if (pageTag) currentPage = `Page ${pageTag[1]}`;
    const cleanLine = line.replace(/\[Page \d+\]\s*/, '').trim();
    if (!cleanLine) return;

    // 2. Detect "Instead of X, use Y" or "Replace X with Y"
    const swapRegex = /(?:instead of|replace|rather than|do not use|never use|avoid)\s+["'“”]?([^"'“”,.;]+)["'“”]?\s*(?:,\s*)?(?:use|say|write|with|prefer)\s+["'“”]?([^"'“”,.;]+)["'“”]?/i;
    const swapMatch = cleanLine.match(swapRegex);
    if (swapMatch) {
      bannedTerms.push({
        id: `RULE-T${bannedTerms.length + 1}`,
        term: swapMatch[1].trim().toLowerCase(),
        replacement: swapMatch[2].trim(),
        reason: 'Explicit replacement directive in brand guidelines',
        citation: `${sourceName} (${currentPage}): "${cleanLine.slice(0, 95)}"`
      });
    }

    // 3. Detect Prohibited Words (Quoted or Colon-Listed)
    const isProhibitive = /\b(never|avoid|banned|prohibited|forbidden|do not|don't|must not|off-brand|stop using)\b/i.test(cleanLine);
    if (isProhibitive && !swapMatch) {
      const quotedWords = [...cleanLine.matchAll(/["'“”]([^"'“”]{2,35})["'“”]/g)].map((m) => m[1]);
      quotedWords.forEach((word) => {
        bannedTerms.push({
          id: `RULE-T${bannedTerms.length + 1}`,
          term: word.trim().toLowerCase(),            replacement: null,
          reason: 'Prohibited term specified in uploaded guidelines',
          citation: `${sourceName} (${currentPage}): "${cleanLine.slice(0, 95)}"`
        });
      });

      const colonList = cleanLine.match(/(?:words|terms|phrases|avoid|banned|prohibited)\s*:\s*([^.]+)/i);
      if (colonList) {
        colonList[1].split(/,|;/).forEach((item) => {
          const cleaned = item.replace(/["'“”]/g, '').trim().toLowerCase();
          if (cleaned.length >= 2 && cleaned.length <= 30) {
            bannedTerms.push({
              id: `RULE-T${bannedTerms.length + 1}`,
              term: cleaned,
              replacement: null,
              reason: 'Listed under prohibited terminology',
              citation: `${sourceName} (${currentPage}): "${cleanLine.slice(0, 95)}"`
            });
          }
        });
      }
    }

    // 4. Detect Quantitative Facts, SLAs & Official Metrics
    const hasNumberOrMetric = /\b\d+(?:\.\d+)?(?:\s*%|\s*x|\s*bit|\s*ms|\s*sec|\s*hours|\s*days|\s*years|\s*stars|\s*users|\s*hospitals|\s*countries|\s*million|\s*billion|\+)?\b/i.test(cleanLine);
    if (hasNumberOrMetric && !isProhibitive) {
      const doc = nlp(cleanLine);
      const nouns = doc.nouns().out('array');
      const numbers = cleanLine.match(/\b\d+(?:\.\d+)?(?:\s*%|\+|\s*x|-bit)?\b/g) || [];
      facts.push({
        id: `FACT-${facts.length + 1}`,
        statement: cleanLine,
        numbers: numbers.map((n) => n.trim()),
        keywords: `${nouns.join(' ')} ${cleanLine}`.toLowerCase(),
        citation: `${sourceName} (${currentPage}, Line ${idx + 1})`
      });
    }
  });

  // 5. Universal Anti-Slop Baseline
  const defaultSlop = [
    { id: 'SLOP-01', term: 'delve', replacement: 'explore', reason: 'Generic AI-slop verb', citation: 'Universal Anti-Slop Standard' },
    { id: 'SLOP-02', term: 'testament to', replacement: 'proof of', reason: 'Overused LLM filler phrase', citation: 'Universal Anti-Slop Standard' },
    { id: 'SLOP-03', term: 'game-changing', replacement: 'high-impact', reason: 'Unverified promotional buzzword', citation: 'Universal Anti-Slop Standard' },
    { id: 'SLOP-04', term: 'tapestry', replacement: 'ecosystem', reason: 'AI-generated filler metaphor', citation: 'Universal Anti-Slop Standard' }
  ];

  return {
    sourceName,
    rawText,
    colors: colors.length > 0 ? colors : [
      { id: 'CLR-1', name: 'Primary Brand Blue', hex: '#2563EB', source: 'Default Palette (Add #HEX in guideline)' },
      { id: 'CLR-2', name: 'Brand Emerald', hex: '#10B981', source: 'Default Palette (Add #HEX in guideline)' }
    ],
    bannedTerms: [...bannedTerms, ...defaultSlop],
    facts,
    minContrastRatio: 4.5
  };
}