# FinPoint Design Language (`design-frontend.md`)

Single source of truth for the frontend visual system. The old
aurora/glassmorphism system (orbs, frosted panels, grain, conic rings) has
been removed — do not reintroduce `backdrop-blur` panels, mesh gradients,
or translucent fills. Everything below is the current contract.

## 1. Canvas

- Pure black: `#000000` page background (`--ink-1`), no gradients or glows
  except two restrained radial washes on the login backdrop.
- App shell lives inside a rounded frame:
  `rounded-[26px] border-2 border-[#34343a]`.
- Static backdrop detail only: `.bg-grid-faint` (56px hairline grid,
  top-masked). No animated background layers.

## 2. Surfaces

| Token / usage            | Value                                              |
|--------------------------|----------------------------------------------------|
| Default panel            | `rounded-3xl border border-white/[0.07] bg-[#131316]` |
| Raised panel             | `bg-[#141416] border-white/10`                     |
| Inset / well             | `bg-black/40` or `bg-black/50`                     |
| Mini stat cell           | `rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3.5` |
| Divider                  | `border-white/[0.06]` (see `.hairline-b`)          |
| Modal                    | `rounded-3xl border-white/10 bg-[#131316]`, overlay `bg-black/70 backdrop-blur-sm` |
| Radius scale             | pills `rounded-full` · cards `rounded-2xl/3xl` · frames `rounded-[26px/28px]` |

Panels are **solid** — never translucent. Depth comes from hairlines,
a 1px top light streak
(`bg-gradient-to-r from-transparent via-white/25 to-transparent`),
and one deep shadow on overlays
(`shadow-[0_40px_100px_-24px_rgba(0,0,0,0.9)]`).

## 3. Color

| Role        | Value                                                  |
|-------------|--------------------------------------------------------|
| Text        | `white` · secondary `white/75` · muted `white/45` · faint `white/30` |
| Borders     | `white/[0.06]`–`white/[0.12]`                          |
| Mint (primary CTAs, success, brand) | `#3ef0a8` (logo `#6CF5B1`) |
| Ember (hero chart card) | gradient `#f0521f → #e84415 → #cf360b` |
| Spark (chart highlight) | `#FFE14D`                              |
| Semantic    | rose/amber/cyan/indigo tints only for status, ticks, badges |

Primary button: `bg-[#3ef0a8] hover:bg-[#63f7bb] text-black`,
inset top highlight + mint glow shadow. No gradients on buttons.

## 4. Typography

- Geist Sans + Geist Mono. Tight tracking on headings.
- Panel title: `text-[13px] font-semibold tracking-tight text-white`;
  description: `text-[11px] text-white/45`.
- Table head: `text-[10px] uppercase text-white/45`; body `text-xs`,
  numbers `tabular-nums` (see `.tabular-nums`).
- Micro label: `.eyebrow` (10px / 600 / 0.18em / uppercase).
- Numbers in hero readouts: `text-[26–30px] font-bold tracking-tight`.

## 5. Navigation

- Floating chips on black — no nav bar container.
- Brand chip: `h-11 rounded-full border-white/[0.14]` + SVG mark + wordmark.
- Nav pill: `h-11 rounded-full border-white/[0.09] bg-[#141416] p-1.5`;
  items `px-4 py-2 text-[13px]`; **active = white pill, black text**;
  inactive `text-white/65 hover:text-white`.
- Icon actions: `h-10 w-10 rounded-full border-white/[0.12]`,
  1.5px glyphs; notification = plain `#ff4d2e` dot.
- Avatar: bordered stadium holding the identity disc + chevron;
  dropdown is a solid `#141416` panel (name, email, role badge, sign out).

## 6. Data display

- Tables: no header tint; `divide-white/[0.05]`; row `hover:bg-white/[0.04]`.
- Metric minis: colored left tick (`h-9 w-[3px] rounded-full`) + label +
  value; redaction renders a bordered chip, never blank space.
- Charts (Recharts): dark tone = cyan/emerald series; ember tone
  (`tone="ember"`) = white + `#FFE14D` series for the orange hero card.
  Tooltips are solid `#0e0e10` cards with series-matched dots.
- Sparklines/gauges derive **only** from fetched data — no synthetic series.

## 7. Motion (GSAP)

- `useGSAP` with component scope; timelines with labels, never `delay`
  chains; `gsap.matchMedia` reduced-motion guard on every animation.
- Animate **transform + autoAlpha only** (`y`, `scale`, `x`); `clearProps`
  after entrances; `ScrollTrigger.batch(once: true)` for below-fold reveals.
- SVG draw-ins via measured `strokeDashoffset`; `quickTo` for pointer
  tracking (no per-event tween creation).
- Entrance vocabulary: frame → header → stagger content (`each: 0.07`).
- No layout-property animation (`width`/`height`/`top`/`left`).

## 8. Rules

1. Content, copy, routes, and data logic are never changed for styling.
2. No fake controls, placeholder data, or decorative numbers.
3. No new dependencies for visual work; pure SVG for brand/art.
4. Shared primitives (`Button`, `Badge`, `Input`, `Select`, `Modal`,
   `Card`, charts) keep stable props — restyle inside, never at call sites
   unless the page owns the markup.
5. Mobile: horizontal scroll rows/tables, stacked grids; login story panel
   hides below `lg`, the form stays complete.
