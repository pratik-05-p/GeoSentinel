/**
 * gauge.js — GeoSentinel SVG Arc Gauge Renderer
 *
 * Renders an animated semicircular arc gauge for the hazard score.
 * Targets the SVG elements already present in dashboard.html:
 *   #gauge-arc        — the value arc path (stroke-dashoffset animated)
 *   #gauge-text       — the numeric score label
 *   #gauge-placeholder — shown before first result
 *   #gauge-result      — container that wraps the SVG (hidden until first result)
 *   #gauge-container   — aria-label updated with final score
 *
 * Public interface:
 *   GaugeRenderer.render(score, category)  — animate to score, colour by category
 *   GaugeRenderer.reset()                  — return to placeholder state
 *
 * Animation spec (design.md):
 *   - Animate from 0 to hazard_score using requestAnimationFrame
 *   - Duration: randomly sampled in [800, 1000] ms (within the spec range of 800–1200 ms)
 *   - Easing: ease-out cubic
 *   - Arc colour driven by risk_category CSS design token
 */

// ---------------------------------------------------------------------------
// Constants — must match the SVG geometry in dashboard.html
// ---------------------------------------------------------------------------

/**
 * Total arc length of the semicircular gauge path.
 * The path is: M 20 100 A 80 80 0 0 1 180 100
 * Arc radius = 80, sweep = π radians → circumference = π × 80 ≈ 251.33 px
 * The SVG uses stroke-dasharray="251.2" so we match that value exactly.
 */
const ARC_LENGTH = 251.2;

/** Animation duration range in milliseconds (design spec: 800–1200 ms). */
const ANIM_MIN_MS = 800;
const ANIM_MAX_MS = 1000;

// ---------------------------------------------------------------------------
// Risk category → CSS colour token mapping
// ---------------------------------------------------------------------------

/**
 * Maps a risk category string to the corresponding CSS custom property value.
 * These match the design tokens in styles.css exactly.
 *
 * @type {Record<string, string>}
 */
const CATEGORY_COLOURS = {
  Low:      'var(--color-risk-low)',       // #10B981 emerald
  Moderate: 'var(--color-risk-moderate)',  // #F59E0B yellow
  High:     'var(--color-risk-high)',      // #F97316 orange
  Critical: 'var(--color-risk-critical)',  // #EF4444 red
};

/**
 * Maps a risk category to the CSS class used on the badge element.
 * @type {Record<string, string>}
 */
const CATEGORY_BADGE_CLASSES = {
  Low:      'risk-low',
  Moderate: 'risk-moderate',
  High:     'risk-high',
  Critical: 'risk-critical',
};

// ---------------------------------------------------------------------------
// DOM references (resolved lazily on first use so the module is safe to
// import before DOMContentLoaded)
// ---------------------------------------------------------------------------

/** @returns {HTMLElement} */
const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Internal animation state — one active animation at a time
// ---------------------------------------------------------------------------

/** Active requestAnimationFrame handle; null if no animation running. */
let _rafHandle = null;

// ---------------------------------------------------------------------------
// Easing function
// ---------------------------------------------------------------------------

/**
 * Cubic ease-out: decelerates into the final value for a natural feel.
 * @param {number} t — normalised time [0, 1]
 * @returns {number} — eased value [0, 1]
 */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

// ---------------------------------------------------------------------------
// Arc rendering helpers
// ---------------------------------------------------------------------------

/**
 * Converts a score in [0, 100] to the corresponding stroke-dashoffset value.
 * dashoffset = ARC_LENGTH × (1 − fraction)
 *
 * When dashoffset = ARC_LENGTH the arc is invisible (0% fill).
 * When dashoffset = 0          the arc is fully drawn (100% fill).
 *
 * @param {number} score — [0, 100]
 * @returns {number}
 */
function scoreToOffset(score) {
  const fraction = Math.max(0, Math.min(100, score)) / 100;
  return ARC_LENGTH * (1 - fraction);
}

/**
 * Applies colour and offset to the arc path element.
 *
 * @param {SVGPathElement} arcEl
 * @param {number}         offset
 * @param {string}         colour  — CSS value or custom property reference
 */
function paintArc(arcEl, offset, colour) {
  arcEl.style.strokeDashoffset = String(offset);
  arcEl.setAttribute('stroke', colour);
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Animate the gauge from 0 to `score`, coloured by `category`.
 * Swaps the placeholder out and the SVG container in before animating.
 *
 * @param {number} score     — Hazard score [0, 100]
 * @param {string} category  — 'Low' | 'Moderate' | 'High' | 'Critical'
 */
function render(score, category) {
  // Clamp score defensively
  const targetScore = Math.max(0, Math.min(100, score));
  const colour = CATEGORY_COLOURS[category] ?? CATEGORY_COLOURS.High;

  // Cancel any in-progress animation
  if (_rafHandle !== null) {
    cancelAnimationFrame(_rafHandle);
    _rafHandle = null;
  }

  // Show SVG, hide placeholder
  const placeholder = el('gauge-placeholder');
  const result      = el('gauge-result');
  if (placeholder) placeholder.style.display = 'none';
  if (result)      result.style.display      = 'block';

  const arcEl  = el('gauge-arc');
  const textEl = el('gauge-text');
  const container = el('gauge-container');

  if (!arcEl || !textEl) return;

  // Reset arc to zero before animating
  paintArc(arcEl, ARC_LENGTH, colour);
  textEl.textContent = '0';

  // Randomly sample animation duration within [ANIM_MIN_MS, ANIM_MAX_MS]
  const duration = ANIM_MIN_MS + Math.random() * (ANIM_MAX_MS - ANIM_MIN_MS);

  const startTime = performance.now();

  function frame(now) {
    const elapsed  = now - startTime;
    const rawT     = Math.min(elapsed / duration, 1);
    const easedT   = easeOutCubic(rawT);
    const current  = easedT * targetScore;

    paintArc(arcEl, scoreToOffset(current), colour);
    textEl.textContent = rawT < 1 ? Math.round(current).toString() : targetScore.toString();

    if (rawT < 1) {
      _rafHandle = requestAnimationFrame(frame);
    } else {
      _rafHandle = null;
      // Final snap — ensure exact value is shown
      paintArc(arcEl, scoreToOffset(targetScore), colour);
      textEl.textContent = targetScore.toString();
      // Update accessible label
      if (container) {
        container.setAttribute(
          'aria-label',
          `Risk score gauge: ${targetScore} out of 100 — ${category} risk`
        );
      }
    }
  }

  _rafHandle = requestAnimationFrame(frame);
}

/**
 * Resets the gauge to its initial placeholder state.
 * Cancels any running animation and hides the SVG.
 */
function reset() {
  if (_rafHandle !== null) {
    cancelAnimationFrame(_rafHandle);
    _rafHandle = null;
  }

  const placeholder = el('gauge-placeholder');
  const result      = el('gauge-result');
  if (placeholder) placeholder.style.display = '';
  if (result)      result.style.display      = 'none';

  const arcEl  = el('gauge-arc');
  const textEl = el('gauge-text');
  if (arcEl)  paintArc(arcEl, ARC_LENGTH, 'var(--color-accent-cyan)');
  if (textEl) textEl.textContent = '--';

  const container = el('gauge-container');
  if (container) container.setAttribute('aria-label', 'Risk score gauge');
}

// ---------------------------------------------------------------------------
// Named export object (matches design spec: GaugeRenderer.render / .reset)
// ---------------------------------------------------------------------------

export const GaugeRenderer = { render, reset, CATEGORY_COLOURS, CATEGORY_BADGE_CLASSES };
export default GaugeRenderer;
