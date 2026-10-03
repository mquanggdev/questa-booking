// Slide deck runtime. Opened directly in a browser, the deck shows every slide
// stacked (add ?slide=N to see one). make_video.py waits for
// window.slidesReady, then calls window.showSlide(i) and screenshots each one.
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  securityLevel: 'strict',
  themeVariables: {
    fontFamily: 'Segoe UI, sans-serif',
    fontSize: '22px',
    primaryColor: '#eef2ff',
    primaryBorderColor: '#4f46e5',
    lineColor: '#6b7280',
  },
  sequence: { actorFontSize: 22, messageFontSize: 20, noteFontSize: 20 },
});

const slides = [...document.querySelectorAll('.slide')];
const footer = document.body.dataset.footer ?? '';
slides.forEach((s, i) => s.setAttribute('data-footer', `${footer}  ·  ${i + 1}/${slides.length}`));

window.showSlide = (index) => {
  document.body.classList.remove('preview');
  slides.forEach((s, i) => s.classList.toggle('active', i === index));
};

// Diagrams must be laid out while visible, so render with every slide shown.
document.body.classList.add('preview');
await mermaid.run({ querySelector: '.mermaid' });

const only = new URLSearchParams(location.search).get('slide');
if (only !== null) window.showSlide(Number(only));
window.slidesReady = true;
