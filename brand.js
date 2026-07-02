/* ═══════════════════════════════════════════════════════════════
   INK.STUDIO — Moteur d'animations (brand.js)
   Reveals au scroll + stagger + boutons magnétiques.
   Zéro dépendance. Respecte prefers-reduced-motion.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── 1. REVEALS AU SCROLL ──
     .rv / .rv-left / .rv-right / .rv-scale → gagnent .in à l'entrée.
     Parent [data-stagger] → délais en cascade sur ses enfants reveal.
     Ne rejoue pas (one-shot) : élégant, jamais fatigant. */
  var SEL = '.rv, .rv-left, .rv-right, .rv-scale';

  function prepareStagger() {
    document.querySelectorAll('[data-stagger]').forEach(function (parent) {
      var step = parseFloat(parent.getAttribute('data-stagger')) || 0.09;
      var kids = parent.querySelectorAll(SEL);
      kids.forEach(function (el, i) {
        if (!el.style.getPropertyValue('--rv-delay')) {
          el.style.setProperty('--rv-delay', (i * step).toFixed(2) + 's');
        }
      });
    });
  }

  var io = null;
  function observeAll() {
    if (reduced) {
      document.querySelectorAll(SEL).forEach(function (el) { el.classList.add('in'); });
      return;
    }
    if (!io) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    }
    document.querySelectorAll(SEL).forEach(function (el) {
      if (!el.classList.contains('in')) io.observe(el);
    });
  }

  /* ── 2. BOUTONS MAGNÉTIQUES ──
     class="magnetic" → le bouton suit légèrement le curseur (desktop). */
  function initMagnetic() {
    if (reduced || window.matchMedia('(hover: none)').matches) return;
    document.querySelectorAll('.magnetic').forEach(function (el) {
      if (el._mag) return; el._mag = true;
      var strength = 0.28;
      el.addEventListener('mousemove', function (ev) {
        var r = el.getBoundingClientRect();
        var x = (ev.clientX - r.left - r.width / 2) * strength;
        var y = (ev.clientY - r.top - r.height / 2) * strength;
        el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
      });
      el.addEventListener('mouseleave', function () {
        el.style.transition = 'transform 0.5s cubic-bezier(0.34,1.56,0.64,1)';
        el.style.transform = '';
        setTimeout(function () { el.style.transition = ''; }, 500);
      });
    });
  }

  /* ── 3. COMPTEUR ANIMÉ ── inkCountUp(el, valeurFinale) */
  window.inkCountUp = function (el, target, duration) {
    if (reduced) { el.textContent = target; return; }
    var start = null, from = parseInt(el.textContent) || 0;
    duration = duration || 800;
    function tick(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / duration, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(from + (target - from) * eased);
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  };

  /* ── 4. API publique : rescanner après injection dynamique ── */
  window.inkReveal = function () { prepareStagger(); observeAll(); initMagnetic(); };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.inkReveal);
  } else {
    window.inkReveal();
  }
})();
