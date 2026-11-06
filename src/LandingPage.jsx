import { useEffect, useState } from 'react';
import { ArrowRight, Play, ShieldCheck } from 'lucide-react';

// Mock ad queue. The four creatives live in public/ads/; if one is missing the
// card falls back to a panel painted in the ad's own theme colour.
const MOCK_ADS = [
  {
    id: 'starbucks',
    brand: 'Starbucks',
    title: 'Iced latte, spilled cold.',
    imageUrl: '/ads/starbucks%20ad.jpg',
    themeColor: '#4E8F86',
    // Used when the canvas sample is blocked (tainted canvas / missing asset)
    fallbackLuminance: 0.62
  },
  {
    id: 'mcdonalds',
    brand: "McDonald's",
    title: 'Get ready to burn your tongue.',
    imageUrl: '/ads/mcd%20add2%20.jpeg',
    themeColor: '#E4002B',
    fallbackLuminance: 0.32
  },
  {
    id: 'nike',
    brand: 'Nike',
    title: 'They keep you alive.',
    imageUrl: '/ads/nike%20add2.jpeg',
    themeColor: '#8A93A0',
    fallbackLuminance: 0.88
  },
  {
    id: 'tesla',
    brand: 'Tesla',
    title: 'Waiting for fuel? We don\u2019t do that over here.',
    imageUrl: '/ads/tesla%20ad2.jpeg',
    themeColor: '#C63A20',
    fallbackLuminance: 0.38
  }
];

const STATUS_DURATION = 5000;
const BRIGHT_THRESHOLD = 0.48;

const NAV_LINKS = [
  { label: 'Product', tab: 'product' },
  { label: 'How it works', tab: 'guide' },
  { label: 'Trust', tab: 'receipt' }
];

// Average relative luminance of an image, sampled on a 16x16 canvas.
// Returns null when the canvas cannot be read (CORS / decode failure), so the
// caller can fall back to the per-ad hand-tuned value.
function sampleLuminance(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 16, 16);
        const { data } = ctx.getImageData(0, 0, 16, 16);
        let total = 0;
        let counted = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 8) continue;
          total += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
          counted += 1;
        }
        resolve(counted === 0 ? null : total / counted);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export default function LandingPage({ onEnter = () => {} }) {
  const [currentAdIndex, setCurrentAdIndex] = useState(0);
  const [failedAdId, setFailedAdId] = useState(null);
  // Sample is tied to the URL it came from so a stale reading never themes the
  // next ad while its image is still decoding.
  const [sample, setSample] = useState({ url: null, luminance: null });
  const ad = MOCK_ADS[currentAdIndex];
  const imageFailed = failedAdId === ad.id;

  // Story-style autoplay: advance every 5s and wrap back to the first ad.
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentAdIndex((index) => (index + 1) % MOCK_ADS.length);
    }, STATUS_DURATION);
    return () => clearInterval(timer);
  }, []);

  // Re-sample the active creative so the hero typography can flip contrast.
  useEffect(() => {
    let cancelled = false;
    sampleLuminance(ad.imageUrl).then((luminance) => {
      if (!cancelled) setSample({ url: ad.imageUrl, luminance });
    });
    return () => {
      cancelled = true;
    };
  }, [ad.imageUrl]);

  const sampledLuminance = sample.url === ad.imageUrl ? sample.luminance : null;
  const avgLuminance = sampledLuminance ?? ad.fallbackLuminance;
  const isBrightBackdrop = avgLuminance > BRIGHT_THRESHOLD;

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

      {/* Full-bleed blurred live ad backdrop — follows the active creative */}
      <div aria-hidden="true" className="absolute inset-0 z-0 overflow-hidden">
        <img
          src={ad.imageUrl}
          alt=""
          className="h-full w-full scale-125 object-cover blur-[75px] saturate-150 transition-all duration-1000 ease-in-out"
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
            checked before it ships. The player on the right is the live ad queue — the whole
            backdrop is that creative, blurred, so nothing leaves your machine.
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
                {ad.themeColor} · Y {avgLuminance.toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
