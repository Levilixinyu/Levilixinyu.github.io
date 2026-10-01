# Levilixinyu.github.io

Personal homepage of **Xinyu Li (李心钰)** — Ph.D. candidate in Neuromuscular Physiology, UT Austin.

A hand-built static site with no framework and no build step:

- `index.html` — all page content
- `css/style.css` — design tokens (dark/light), layout, animation
- `js/main.js` — interactive pieces:
  - motor unit pool simulation (size principle, rate coding, fatigue, NMES) that drives the hero sEMG trace and the Lab simulator
  - simulated wearable heart-rate HUD (HR kinetics, zones, ECG) driven by page activity
  - research mini-visualizations, timeline/talk filters, gallery lightbox, 🐈 easter egg
- `img/` — web-optimized photos (originals kept in `images/`)

Preview locally: `python3 -m http.server` then open http://localhost:8000.
