import { useEffect, useState } from 'react';
import { ArrowRight, Play, ShieldCheck } from 'lucide-react';

// Mock ad queue, in playback order: Starbucks → Spotify → Nike → McDonald's →
// Apple → Tesla. The creatives live in public/ads/; if one is missing the card
// falls back to a panel painted in the ad's own theme colour.
const MOCK_ADS = [
  {
    id: 'starbucks',
    brand: 'Starbucks',
    title: 'Iced latte, spilled cold.',
    imageUrl: '/ads/starbucks%20ad.jpg',
    themeColor: '#4E8F86',
    // Fallbacks used when the canvas sample is blocked (tainted canvas / missing
    // asset). `focus` is the brightest area of the creative — the whipped cream
    // and milk splash — used only if the frame itself is dark.
    fallbackLuminance: 0.62,
    focusLuminance: 0.78,
    focus: { x: 0.5, y: 0.66 }
  },
  {
    id: 'spotify',
    brand: 'Spotify',
    title: '20 million people already love Premium.',
    imageUrl: '/ads/spotify.jpg',
    themeColor: '#E23A7F',
    // Pink frame with white type/shapes; the measured frame average sits just
    // above the brightness threshold, so it keeps its full-frame framing. The
    // fallback matches that so there is no crop flash before the sample lands.
    fallbackLuminance: 0.49,
    focusLuminance: 0.9,
    focus: { x: 0.2, y: 0.86 }
  },
  {
    id: 'nike',
    brand: 'Nike',
    title: 'They keep you alive.',
    imageUrl: '/ads/nike%20add2.jpeg',
    themeColor: '#8A93A0',
    fallbackLuminance: 0.88,
    focusLuminance: 0.94,
    focus: { x: 0.14, y: 0.12 }
  },
  {
    id: 'mcdonalds',
    brand: "McDonald's",
    title: 'Get ready to burn your tongue.',
    imageUrl: '/ads/mcd%20add2%20.jpeg',
    themeColor: '#E4002B',
    fallbackLuminance: 0.32,
    // The frame is saturated red; the lit fries carton is the only bright region.
    focusLuminance: 0.7,
    focus: { x: 0.5, y: 0.32 }
  },
  {
    id: 'apple',
    brand: 'Apple',
    title: 'Every finish. One iPhone.',
    // The file is AVIF despite the .jpeg extension; every current browser decodes
    // it, and the canvas sampler reads it like any other creative.
    imageUrl: '/ads/apple.jpeg',
    themeColor: '#B9BCC0',
    fallbackLuminance: 0.85,
    focusLuminance: 0.96,
    focus: { x: 0.5, y: 0.5 }
  },
  {
    id: 'tesla',
    brand: 'Tesla',
    title: 'Waiting for fuel? We don\u2019t do that over here.',
    imageUrl: '/ads/tesla%20ad2.jpeg',
    themeColor: '#C63A20',
    fallbackLuminance: 0.38,
    // Red frame with a white Model X at the centre.
    focusLuminance: 0.82,
    focus: { x: 0.5, y: 0.42 }
  }
];

const STATUS_DURATION = 5000;
const BRIGHT_THRESHOLD = 0.48;
// The blurred backdrop is a zoomed crop centred on the creative's brightest area
// rather than the whole frame, so a saturated ad still lights up the text column.
const BACKDROP_ZOOM = 1.8;
const BACKDROP_FOCUS = { x: 0.32, y: 0.48 };

const NAV_LINKS = [
  { label: 'Product', tab: 'product' },
  { label: 'How it works', tab: 'guide' },
  { label: 'Trust', tab: 'receipt' }
];

// Relative luminance of an image sampled on a 24x24 grid. The brightest 5x5
// neighbourhood (not a single specular pixel) wins, and its centre gives the
// point the backdrop crop should be centred on. Returns null when the canvas
// cannot be read (CORS / decode failure) so the caller can use the per-ad
// hand-tuned focus.
function sampleBackdrop(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const grid = 24;
        const canvas = document.createElement('canvas');
        canvas.width = grid;
        canvas.height = grid;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, grid, grid);
        const { data } = ctx.getImageData(0, 0, grid, grid);

        const luminance = new Float32Array(grid * grid);
        for (let i = 0; i < grid * grid; i += 1) {
          const offset = i * 4;
          if (data[offset + 3] < 8) continue;
          luminance[i] =
            (0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]) / 255;
        }

        const radius = 2;
        let best = { index: 0, value: -1 };
        for (let y = 0; y < grid; y += 1) {
          for (let x = 0; x < grid; x += 1) {
            let sum = 0;
            let count = 0;
            for (let dy = -radius; dy <= radius; dy += 1) {
              for (let dx = -radius; dx <= radius; dx += 1) {
                const yy = y + dy;
                const xx = x + dx;
                if (yy < 0 || yy >= grid || xx < 0 || xx >= grid) continue;
                sum += luminance[yy * grid + xx];
                count += 1;
              }
            }
            const value = sum / count;
            if (value > best.value) best = { index: y * grid + x, value };
          }
        }

        const average =
          luminance.reduce((total, value) => total + value, 0) / (grid * grid);

        resolve({
          average,
          focusLuminance: best.value,
          focus: {
            x: ((best.index % grid) + 0.5) / grid,
            y: (Math.floor(best.index / grid) + 0.5) / grid
          }
        });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// background-position percentages that land `focus` on the target point of the
// backdrop box. With the image sized to ZOOM × the box, moving the box by p% of
// the overflow and the image point by f × ZOOM gives:
//   p = (target - f × ZOOM) / (1 - ZOOM)
function backdropPosition(focus) {
  const axis = (target, fraction) => {
    const percent = ((target - fraction * BACKDROP_ZOOM) / (1 - BACKDROP_ZOOM)) * 100;
    return Math.min(100, Math.max(0, percent));
  };
  return { x: axis(BACKDROP_FOCUS.x, focus.x), y: axis(BACKDROP_FOCUS.y, focus.y) };
}

export default function LandingPage({ onEnter = () => {} }) {
  const [currentAdIndex, setCurrentAdIndex] = useState(0);
  const [failedAdId, setFailedAdId] = useState(null);
  // Sample is tied to the URL it came from so a stale reading never themes the
  // next ad while its image is still decoding.
  const [sample, setSample] = useState({ url: null, data: null });
  const ad = MOCK_ADS[currentAdIndex];
  const imageFailed = failedAdId === ad.id;

  // Story-style autoplay: advance every 5s and wrap back to the first ad.
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentAdIndex((index) => (index + 1) % MOCK_ADS.length);
    }, STATUS_DURATION);
    return () => clearInterval(timer);
  }, []);

  // Re-sample the active creative so the backdrop follows its brightest region
  // and the hero typography can flip contrast.
  useEffect(() => {
    let cancelled = false;
    sampleBackdrop(ad.imageUrl).then((data) => {
      if (!cancelled) setSample({ url: ad.imageUrl, data });
    });
    return () => {
      cancelled = true;
    };
  }, [ad.imageUrl]);

  const sampled = sample.url === ad.imageUrl ? sample.data : null;
  const frameLuminance = sampled?.average ?? ad.fallbackLuminance;
  // Only a dark frame needs the bright-region crop; a creative that is already
  // light keeps its original full-frame framing (that is the Starbucks look).
  const cropToBrightRegion = frameLuminance <= BRIGHT_THRESHOLD;
  const backdropLuminance = cropToBrightRegion
    ? (sampled?.focusLuminance ?? ad.focusLuminance)
    : frameLuminance;
  const focus = sampled?.focus ?? ad.focus;
  const isBrightBackdrop = backdropLuminance > BRIGHT_THRESHOLD;
  const position = backdropPosition(focus);

  const ink = isBrightBackdrop ? '#111510' : '#FFFFFF';
  const inkSoft = isBrightBackdrop ? '#2B3129' : 'rgba(255,255,255,0.82)';
  const pillSurface = isBrightBackdrop
    ? 'bg-black/10 border-black/15'
    : 'bg-white/10 border-white/15';
  const secondaryBorder = isBrightBackdrop ? 'border-black/25' : 'border-white/25';

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-[#0b0f0c] text-slate-100">
      <style>{`
        @keyframes heroStatusFill { from { width: 0%; } to { width: 100%; } }
        @keyframes heroAdFade { from { opacity: 0; transform: scale(1.02); } to { opacity: 1; transform: scale(1); } }
      `}</style>

      {/* Full-bleed blurred live ad backdrop — follows the active creative. A dark
          frame is cropped onto its brightest region so the headline never sits on
          a black corner of a saturated ad; a light frame keeps its framing. */}
      <div aria-hidden="true" className="absolute inset-0 z-0 overflow-hidden">
        <div
          className="absolute -inset-[12%] transition-all duration-1000 ease-in-out"
          style={{
            backgroundImage: `url("${ad.imageUrl}")`,
            backgroundSize: cropToBrightRegion ? `${BACKDROP_ZOOM * 100}% ${BACKDROP_ZOOM * 100}%` : 'cover',
            backgroundPosition: cropToBrightRegion ? `${position.x}% ${position.y}%` : '50% 50%',
            backgroundRepeat: 'no-repeat',
            filter: 'blur(75px) saturate(150%)'
          }}
        />
        <div
          className="absolute inset-0 transition-colors duration-1000"
          style={{ backgroundColor: `${ad.themeColor}22` }}
        />
      </div>

      {/* Adaptive scrim so the left text column clears WCAG AAA on any backdrop */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[1] transition-opacity duration-1000"
        style={{
          background: isBrightBackdrop
            ? 'linear-gradient(90deg, rgba(255,255,255,0.94) 0%, rgba(255,255,255,0.78) 42%, rgba(255,255,255,0) 78%)'
            : 'linear-gradient(90deg, rgba(8,13,10,0.92) 0%, rgba(8,13,10,0.7) 42%, rgba(8,13,10,0) 78%)'
        }}
      />

      {/* Glassmorphic pill navigation */}
      <nav
        className={`absolute left-1/2 top-6 z-20 flex w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 items-center justify-between gap-1 rounded-full border px-2 py-2 backdrop-blur-md transition-colors duration-1000 sm:w-auto sm:justify-start ${pillSurface}`}
        style={{ color: ink }}
      >
        <button
          onClick={() => onEnter('landing')}
          className="flex items-center gap-2 pl-2 pr-3 text-sm font-semibold tracking-tight cursor-pointer"
          title="Back to the landing page"
        >
          <ShieldCheck className="h-4 w-4" />
          NoSlop
        </button>
        <span
          className="hidden h-5 w-px sm:block"
          style={{ backgroundColor: isBrightBackdrop ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.15)' }}
        />
        <div className="hidden items-center gap-1 sm:flex">
          {NAV_LINKS.map((link) => (
            <button
              key={link.label}
              onClick={() => onEnter(link.tab)}
              className="rounded-full px-3 py-1.5 text-xs font-medium transition-colors hover:bg-black/5 cursor-pointer"
              style={{ color: inkSoft }}
            >
              {link.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => onEnter('compiler')}
          className="ml-1 rounded-full px-4 py-1.5 text-xs font-semibold transition-colors duration-1000 cursor-pointer"
          style={{
            backgroundColor: isBrightBackdrop ? '#111510' : '#FFFFFF',
            color: isBrightBackdrop ? '#D8FF4B' : '#111510'
          }}
        >
          Get started
        </button>
      </nav>

      <main className="relative z-10 mx-auto flex min-h-screen w-full max-w-7xl flex-col justify-center gap-12 px-6 pb-16 pt-32 lg:flex-row lg:items-center lg:gap-16">
        {/* Left: headline + CTAs */}
        <div className="w-full transition-colors duration-1000 lg:w-1/2">
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] transition-colors duration-1000 ${pillSurface}`}
            style={{ color: inkSoft }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: isBrightBackdrop ? '#111510' : '#D8FF4B' }} />
            100% client-side · no cloud LLM
          </span>
          <h1
            className="mt-6 text-5xl font-bold leading-[0.95] tracking-tighter transition-colors duration-1000 sm:text-6xl lg:text-7xl"
            style={{ color: ink }}
          >
            Brand rules that answer first.
          </h1>
          <p
            className="mt-5 max-w-xl text-sm leading-relaxed transition-colors duration-1000 sm:text-base"
            style={{ color: inkSoft }}
          >
            Paste a brand book, drop in an ad, and every claim, hex colour and banned term gets
            checked before it ships.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              onClick={() => onEnter('compiler')}
              className="inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-colors duration-1000 cursor-pointer"
              style={{
                backgroundColor: isBrightBackdrop ? '#111510' : '#FFFFFF',
                color: isBrightBackdrop ? '#D8FF4B' : '#111510'
              }}
            >
              Start an audit
              <ArrowRight className="h-4 w-4" />
            </button>
            <button
              onClick={() => onEnter('guide')}
              className={`inline-flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-semibold transition-colors duration-1000 hover:bg-black/5 cursor-pointer ${secondaryBorder}`}
              style={{ color: ink }}
            >
              <Play className="h-4 w-4" />
              See the workflow
            </button>
          </div>
        </div>

        {/* Right: WhatsApp-style status ad player */}
        <div className="w-full max-w-sm lg:w-1/2 lg:justify-self-end">
          <div className="rounded-2xl border border-white/15 bg-[#121411]/80 p-3 shadow-2xl shadow-black/40 backdrop-blur-xl">
            <div className="flex gap-1.5">
              {MOCK_ADS.map((item, index) => (
                <div key={item.id} className="h-1 flex-1 overflow-hidden rounded-full bg-white/20">
                  <div
                    key={`${currentAdIndex}-${item.id}`}
                    className="h-full rounded-full bg-white"
                    style={
                      index < currentAdIndex
                        ? { width: '100%' }
                        : index > currentAdIndex
                          ? { width: '0%' }
                          : { animation: `heroStatusFill ${STATUS_DURATION}ms linear forwards` }
                    }
                  />
                </div>
              ))}
            </div>

            <div className="relative mt-3 aspect-[4/5] overflow-hidden rounded-xl bg-slate-950">
              <div key={ad.id} className="absolute inset-0" style={{ animation: 'heroAdFade 700ms ease-out' }}>
                {imageFailed ? (
                  <div
                    className="flex h-full w-full flex-col justify-end p-6"
                    style={{ backgroundImage: `linear-gradient(155deg, ${ad.themeColor} 0%, #0f172a 100%)` }}
                  >
                    <p className="text-[10px] uppercase tracking-[0.28em] text-white/70">{ad.brand}</p>
                    <h2 className="mt-2 text-2xl font-bold leading-tight tracking-tight text-white">
                      {ad.title}
                    </h2>
                  </div>
                ) : (
                  <img
                    src={ad.imageUrl}
                    alt={`${ad.brand} ad creative`}
                    onError={() => setFailedAdId(ad.id)}
                    className="h-full w-full object-cover"
                  />
                )}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent p-4">
                  <p className="text-[10px] uppercase tracking-[0.22em] text-white/70">{ad.brand}</p>
                  <p className="mt-1 text-sm font-semibold text-white">{ad.title}</p>
                </div>
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between px-1 pb-1">
              <span className="text-[11px] text-slate-400">
                Ad {currentAdIndex + 1} of {MOCK_ADS.length}
              </span>
              <span className="flex items-center gap-1.5 text-[11px] text-slate-400">
                <span
                  className="h-2.5 w-2.5 rounded-full transition-colors duration-1000"
                  style={{ backgroundColor: ad.themeColor }}
                />
                {ad.themeColor} · Y {backdropLuminance.toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
