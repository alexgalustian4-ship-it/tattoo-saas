'use strict';

const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { execFile } = require('child_process');
const rateLimit = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);   // Railway est derrière un proxy → IP réelle via X-Forwarded-For

// ── Rate limiting (anti-martelage / anti-abus) ──
// Clé sur la VRAIE IP client (1er élément de X-Forwarded-For), car derrière le
// proxy Railway req.ip = IP de l'edge (variable) → sinon le compteur ne tient pas.
const clientKey = (req) => {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : req.ip) || 'unknown';
};
const mkLimiter = (windowMs, limit, message) => rateLimit({
  windowMs, limit, standardHeaders: true, legacyHeaders: false,
  keyGenerator: clientKey, validate: false, message,
});
const genLimiter      = mkLimiter(15 * 60 * 1000, 40,  { error: 'too_many_requests' });
const authLimiter     = mkLimiter(15 * 60 * 1000, 25,  { error: 'too_many_requests' });
const registerLimiter = mkLimiter(60 * 60 * 1000, 8,   { error: 'too_many_accounts' });
const downloadLimiter = mkLimiter(15 * 60 * 1000, 150, undefined);
const chatLimiter     = mkLimiter(15 * 60 * 1000, 30,  { error: 'too_many_requests' });

// Bloque les URL internes/privées (anti-SSRF) pour le proxy /download
function isBlockedUrl(u){
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return true;
    const h = url.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1)/.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    return false;
  } catch { return true; }
}

// ═══════════════════════════════════════════════════
// BASE DE DONNÉES (Postgres) — inerte si DATABASE_URL absent
// ═══════════════════════════════════════════════════
// Crédits par plan (1 génération = 10 crédits → gros chiffres, même rentabilité)
const PLAN_CREDITS = { free: 30, starter: 150, pro: 400, studio: 1500, studioplus: 4000, atelier: 10000 };
// Coût en crédits par action (minimum 10 par outil)
const CREDIT_COST = { design: 10, body: 15, place: 15, stencil: 10, merge: 15, pet: 10, rework: 10, lettering: 10, coverup: 15 };
const OWNER_EMAIL = 'alexgalustian4@gmail.com';
// ⚠️ MODE DÉMO : false = génération SANS compte (pas de login, pas de débit).
// Remettre à true pour réactiver la protection (compte requis + crédits).
const REQUIRE_LOGIN = true;
let db = null;
try {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    db = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    });
    db.on('error', e => console.warn('⚠ DB pool error:', e.message));
  }
} catch (e) { console.warn('⚠ pg init failed:', e.message); }

async function initDb() {
  if (!db) { console.warn('⚠ DATABASE_URL non défini — base de données désactivée'); return; }
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id               BIGSERIAL PRIMARY KEY,
        email            TEXT UNIQUE NOT NULL,
        google_id        TEXT UNIQUE,
        name             TEXT,
        avatar_url       TEXT,
        plan             TEXT NOT NULL DEFAULT 'free',
        credits_remaining INTEGER NOT NULL DEFAULT 5,
        credits_reset_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
        stripe_customer_id TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS generations (
        id          BIGSERIAL PRIMARY KEY,
        user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
        type        TEXT NOT NULL DEFAULT 'design',
        image_url   TEXT NOT NULL,
        params      JSONB,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_generations_user ON generations(user_id, created_at DESC);`);
    // Auth email/mot de passe (ajout rétro-compatible)
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;`);
    await db.query(`ALTER TABLE users ALTER COLUMN google_id DROP NOT NULL;`).catch(() => {});
    // Vérification email (anti-farming) — comptes existants = vérifiés (grandfathering)
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT true;`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token TEXT;`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT;`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_expires TIMESTAMPTZ;`);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INT NOT NULL DEFAULT 0;`);
    console.log('✓ Base de données prête (tables users, generations)');
  } catch (e) {
    console.error('❌ initDb failed:', e.message);
  }
}
initDb();

// ── Higgsfield token refresh state ──
let _refreshInProgress = null;

// ── Stockage persistant des credentials ──
// Sur Railway, RAILWAY_VOLUME_MOUNT_PATH pointe vers un volume qui survit aux
// redémarrages. Sinon on retombe sur le HOME (ex: en local). On force HOME vers
// ce répertoire pour que le binaire CLI lise/écrive le MÊME fichier que nous.
const PERSIST_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || os.homedir();
process.env.HOME = PERSIST_DIR; // le CLI utilise ~/.config/higgsfield/credentials.json

function credFilePath() {
  return path.join(PERSIST_DIR, '.config', 'higgsfield', 'credentials.json');
}

function writeCredentials(access, refresh) {
  const credFile = credFilePath();
  fs.mkdirSync(path.dirname(credFile), { recursive: true });
  fs.writeFileSync(credFile, JSON.stringify({ access_token: access, refresh_token: refresh || '' }));
  return credFile;
}

function readPersistedCredentials() {
  try {
    const creds = JSON.parse(fs.readFileSync(credFilePath(), 'utf8'));
    if (creds.access_token) return creds;
  } catch {}
  return null;
}

async function bootstrapHiggsfieldAuth() {
  // Ordre de priorité :
  //  - Si les variables d'env contiennent un token DIFFÉRENT du fichier persistant,
  //    c'est que l'opérateur vient de faire une rotation manuelle (token frais) →
  //    il GAGNE et on réécrit le fichier persistant. (Corrige le cas où le token du
  //    volume est expiré/mort : on n'est plus coincé dessus.)
  //  - Sinon, on charge le fichier persistant (token déjà rafraîchi auparavant).
  //  - Sinon, on seed depuis les env vars (tout premier démarrage).
  const persisted = readPersistedCredentials();
  const envAccess  = process.env.HIGGSFIELD_API_KEY;
  const envRefresh = process.env.HIGGSFIELD_REFRESH_TOKEN || '';

  if (envAccess && (!persisted || persisted.access_token !== envAccess)) {
    writeCredentials(envAccess, envRefresh);
    console.log('✓ Credentials (re)seedés depuis les env vars (rotation opérateur), prefix =', envAccess.slice(0, 8));
  } else if (persisted) {
    process.env.HIGGSFIELD_API_KEY = persisted.access_token;
    if (persisted.refresh_token) process.env.HIGGSFIELD_REFRESH_TOKEN = persisted.refresh_token;
    console.log('✓ Credentials chargés depuis le volume persistant, prefix =', persisted.access_token.slice(0, 8));
  } else {
    console.warn('⚠ HIGGSFIELD_API_KEY not set — generation will fail');
    return;
  }

  // 3) Rafraîchit immédiatement au démarrage via le CLI binaire
  try {
    await refreshHiggsfieldToken();
  } catch (e) {
    console.warn('⚠ Startup token refresh failed:', e.message);
  }
}

bootstrapHiggsfieldAuth();

// Refresh proactif toutes les 45 min pour ne jamais expirer
setInterval(() => {
  refreshHiggsfieldToken().catch(e => console.warn('⚠ Periodic token refresh failed:', e.message));
}, 45 * 60 * 1000);

// ─────────────────────────────────────────────────
// Prompt système designer — base de toute génération de design
// ─────────────────────────────────────────────────
const DESIGN_SYSTEM_PROMPT =
  `You are an expert tattoo designer specialized in creating original, high-quality tattoo concepts. ` +
  `Transform the idea into a visually balanced tattoo composition, not a random illustration. ` +
  `Always prioritize composition, readability, body flow, and long-term tattoo quality. ` +
  `Create a unique composition with one dominant focal point. Avoid clutter, duplicated objects, repetitive patterns and random decorative elements. ` +
  `Every element must have a purpose. Balance negative space and detailed areas. Keep proportions realistic and the design tattooable by a professional artist. ` +
  `Build with a main subject, supporting elements, background only when it improves the composition, depth through layering, natural visual flow, balanced spacing, strong silhouette. ` +
  `The design must remain readable from a distance, have clean shapes, logical lighting, preserve important details and avoid muddy areas. ` +
  `Only use the explicitly requested style. Never create generic AI-looking artwork — every composition must feel intentional, premium and unique.`;

// ─────────────────────────────────────────────────
// Prompt Stencil (photo → stencil pro Spirit) pour gpt-image-1
// ─────────────────────────────────────────────────
const STENCIL_PROMPT =
  `Convert this photograph into a maximum fidelity technical tattoo tracing. I want an exact linear outline, with the figure perfectly adapted to the original reference, respecting the scale, tilt, perspective, and placement of every element. ` +
  `Result style: fine, uniform red line; clean white background; no shading; no solid black masses; no halftones; no grays; no skin texture or photographic texture; no artistic reinterpretation. ` +
  `Must include: overall contour of the silhouette; exact facial features and expression; important wrinkles and folds of the face and neck; ears, earrings, accessories; hands with clear anatomical structure; clothing with essential folds; main objects complete and clearly defined; useful internal details for tattooing, simplified only if they create visual noise. ` +
  `Must exclude or minimize: full background; blur; atmosphere; stains; noise; microtextures; excessive irrelevant detail. ` +
  `Shadow elements: work on the shadows in the face. Mark four shadow values — areas of solid black, dark tones, light tones, and highlight zones — all using the same red line but with a dashed line. Do not add any labels or indication of which shadow value is which; only outline the area that belongs to each shadow zone. ` +
  `The final image should look like a clean, precise, readable stencil/tracing, ready to use as a tattoo base.`;

// ─────────────────────────────────────────────────
// Recettes de style — prompts officiels (gpt-image-1)
// ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════
// STYLE ENGINE — source unique de vérité par style
// recipe = description complète · keyMarkers = ancrage visuel (placé EN PREMIER)
// defaultFormat = format si pas de zone · colorByDefault = couleur par défaut
// ═══════════════════════════════════════════════════
const STYLES = {
  concept: {
    label: 'Concept',
    defaultFormat: 'portrait',
    colorByDefault: false,
    keyMarkers: 'symbolic black & grey concept composition, one strong central subject, fine drafting lines, sacred-geometry construction, generous negative space, premium editorial layout',
    // Template figé (prompt validé par le client sur ChatGPT). ${SUBJECT} = idée du client,
    // injectée telle quelle → le prompt qui atteint gpt-image-1 reste identique au prompt qui marche.
    template:
      `A heroic classical white marble sculpture of ${'${SUBJECT}'}, Greco-Roman, carved with the polished realism of a Michelangelo museum statue, in a dynamic powerful pose with strong dimensional anatomy. Fine-art classical sculpture. ` +
      `Rendered as ultra-smooth polished marble: seamless soft gradients, glossy highlights, razor-sharp carved detail, strong three-dimensional volume, bright clean whites and deep grey shadows, smooth continuous tone with no grain, no stippling and no sketchy pencil strokes. ` +
      `Behind the subject, a radiant halo of fine thin sun rays and faint concentric sacred-geometry construction circles with golden-ratio arcs; a bold white starburst sunburst as a focal accent; soft pale grey smoke clouds drifting at the base; small technical dot-grid annotations in the corners, kept light and elegant. ` +
      `Pure solid white background, perfectly centered, symmetrical editorial composition, generous negative space. Premium black and grey tattoo concept design, high contrast, no color, flat 2D, no skin, no mockup, no frame, ready to tattoo.`,
    recipe:
      `Create the tattoo in the studio's signature Concept style: reimagine the subject as a heroic classical white marble sculpture, Greco-Roman, with the polished realism of a Michelangelo statue (even animals or objects are carved marble). ` +
      `Rendering: ultra-smooth polished marble — seamless soft gradients, glossy highlights, razor-sharp carved detail, strong three-dimensional volume, high contrast with bright clean whites and deep grey shadows. Smooth continuous tone, never grainy or sketchy. ` +
      `Behind and around the subject, build the signature concept collage: a radiant halo of fine thin rays, faint concentric sacred-geometry construction circles and golden-ratio arcs, a bold white starburst/sunburst as a focal accent, soft pale grey smoke clouds drifting at the base, and small technical dot-grid annotations in the corners. These stay light and elegant, never cluttered. ` +
      `Composition: one dominant central marble subject, symmetrical editorial layout, generous white negative space, every element connected and intentional, clear hierarchy with detail concentrated on the subject and fading outward. ` +
      `The final result should look like a high-end conceptual marble-and-sacred-geometry tattoo design — premium, museum-grade, clean, instantly recognizable, never a generic AI illustration.`,
  },

  baroque: {
    label: 'Baroque',
    defaultFormat: 'portrait',
    colorByDefault: false,
    keyMarkers: 'dramatic black & grey baroque composition, marble sculpture realism, ornate scrollwork and Corinthian columns, cathedral architecture, deep chiaroscuro, regal and luxurious',
    recipe:
      `Create the tattoo in a Baroque style. This style is inspired by the grandeur of Baroque and Renaissance art, combining dramatic realism, ornate architecture and rich decorative details. The composition should feel luxurious, timeless and sculptural. ` +
      `Visual Identity: dramatic and elegant composition; rich ornamental details; classical European architecture; sculptural realism; strong contrasts between light and shadow; sophisticated decorative framing. ` +
      `Composition layered with: a central focal subject; ornate architectural structures; decorative Baroque frames and flourishes; sculptures, statues or classical figures when relevant; columns, arches, domes or cathedral details; elegant symmetry or controlled asymmetry; soft atmospheric depth. ` +
      `Architecture: incorporate authentic Baroque/Renaissance influences when appropriate — ornamental scrollwork, Corinthian columns, cathedral windows, domes, marble sculptures, decorative moldings, royal emblems, arches, classical reliefs, stone textures; architecture frames the artwork naturally. ` +
      `Any human or angelic figures are fully clothed in flowing robes and drapery — no nudity, no bare skin, modest and reverent. ` +
      `Lighting inspired by classical paintings: strong highlights, deep shadows, powerful contrast emphasizing volume and architectural depth. Intricate detail in carvings, marble, drapery and flourishes, fading toward the edges for readability. ` +
      `The final result should resemble a masterpiece carved from marble surrounded by magnificent Baroque architecture — regal, timeless, sophisticated, worthy of a luxury custom tattoo, never a generic AI illustration.`,
  },

  japonais: {
    label: 'Japanese',
    defaultFormat: 'portrait',
    colorByDefault: false,
    keyMarkers: 'Japanese irezumi composition, bold confident outlines, flowing waves/clouds/wind, dynamic movement, traditional symbolism, balanced negative space',
    recipe:
      `Create the tattoo in a Japanese (Irezumi) style. Inspired by traditional Japanese tattooing with modern interpretation; the composition must feel harmonious, powerful, symbolic and fluid, following the body's anatomy. ` +
      `Visual Identity: bold dynamic composition; strong visual flow; rich symbolism; balanced negative space; elegant movement; powerful storytelling; organic integration with the body. ` +
      `Composition: one dominant central subject; supporting symbolic elements; natural environmental elements; flowing background textures; continuous movement throughout. Every element connects naturally; avoid isolated or randomly placed objects. ` +
      `Traditional elements when relevant: dragons, koi, tigers, phoenix, samurai, oni/hannya masks, snakes, cranes, cherry blossoms, peonies, chrysanthemums, maple leaves, bamboo, waves, wind bars, clouds, smoke, waterfalls, moon, sun — only elements that strengthen the concept. ` +
      `Artistic direction: think like a master Irezumi artist; subjects emerge from waves, clouds, wind or smoke rather than floating; strong energy and direction. Intricate detail in scales, fur, feathers, armor, fabric folds, flowers, waves and clouds; focal point detailed while secondary elements breathe. ` +
      `Color: if requested use a traditional Japanese palette (deep black, crimson, vermilion, indigo, emerald, muted gold, ivory); otherwise a powerful black and grey composition. ` +
      `The final result should feel like an authentic high-end Irezumi masterpiece — dynamic, symbolic, timeless, balanced and visually powerful.`,
  },

  geometrique: {
    label: 'Geometric',
    defaultFormat: 'portrait',
    colorByDefault: false,
    keyMarkers: 'precise black & grey geometric design, sacred geometry, fine dotwork, perfectly clean straight lines and circles, mathematical symmetry, blueprint construction lines',
    recipe:
      `Create the tattoo in a Geometric style. Based on precision, balance, symmetry and mathematical harmony; every line, shape and proportion must feel intentional and perfectly constructed. Geometry enhances the subject, never overpowers it. ` +
      `Visual Identity: clean geometric composition; perfect symmetry when appropriate; mathematical precision; minimal but powerful design; modern aesthetic; strong visual balance; elegant use of negative space. ` +
      `Composition: one dominant central subject; geometric structures supporting the composition; balanced spacing; controlled repetition; layered geometric depth; clear focal point. Avoid random decorative geometry. ` +
      `Geometric elements when appropriate: sacred geometry, Metatron's Cube, Flower of Life, golden ratio, Fibonacci spiral, platonic solids, hexagons, triangles, circles, concentric circles, mandalas, polygonal structures, radial patterns, blueprint construction lines, fine dotwork — only elements that support the concept. ` +
      `Line work: perfectly straight lines, smooth curves, consistent line weight, crisp intersections, clean circles, accurate angles; no shaky or unnecessary lines. Detail through dotwork, repeating patterns, geometric textures and subtle construction lines. ` +
      `The final result should resemble a premium geometric tattoo designed with architectural precision — balanced, intelligent, elegant, timeless, visually striking and technically tattooable.`,
  },

  realisme: {
    label: 'Realism',
    defaultFormat: 'portrait',
    colorByDefault: false,
    keyMarkers: 'hyper-realistic black & grey realism, smooth photoreal shading, deep contrast, ultra-fine detail, lifelike textures, dramatic lighting',
    recipe:
      `Create the tattoo in a Realism style — smooth, photorealistic black & grey, like a real healed black-and-grey realism tattoo or a high-end black-and-white photograph. Premium black & grey unless color is explicitly requested. ` +
      `CRITICAL render quality: ultra-smooth, seamless value gradients with soft tonal transitions; deep rich true blacks; bright glossy specular highlights; strong three-dimensional volume and depth. ` +
      `Absolutely AVOID a pencil-sketch, drawing, charcoal, engraving, etching, woodcut, cross-hatching, line-hatching, stippling or dotwork look — no visible pencil strokes, no sketchy lines, no grainy stipple shading. Shading must read as continuous photographic tone, not hand-drawn marks. ` +
      `Visual Identity: photorealistic appearance; natural anatomy; accurate proportions; high depth perception; strong focal point; clean visual hierarchy. ` +
      `Composition: one dominant realistic subject, isolated cleanly on pure white; supporting elements only when they truly strengthen the story; balanced negative space; strong depth and perspective. No ground, no rocks, no scenery, no scattered debris, no decorative filler unless explicitly requested. ` +
      `Realism principles: realistic anatomy, authentic proportions, natural perspective, believable expression, realistic textures, correct directional lighting and physical depth. Never stylized or cartoon-like. ` +
      `Lighting: realistic directional light, smooth value transitions, deep shadows, bright highlights, natural contrast defining volume. Authentic surface textures (skin, scales, metal, fabric, fur, hair, water) that stay smooth and never become noisy or grainy. ` +
      `Exceptional smooth detail at the focal point (eyes, face, key textures), gently fading outward. Depth via subtle atmospheric perspective. Prioritize tattoo longevity. ` +
      `The final result should resemble a world-class smooth black & grey realism tattoo by an elite artist — authentic, dimensional, glossy, technically flawless, never a pencil drawing, sketch or AI-looking illustration.`,
  },
};

function getStyle(key) { return STYLES[key] || STYLES.concept; }

// Compat : certains endroits lisent encore une recette par clé
const STYLE_RECIPES = Object.fromEntries(Object.entries(STYLES).map(([k, v]) => [k, v.recipe]));

// ─────────────────────────────────────────────────
// Modificateurs d'ambiance
// ─────────────────────────────────────────────────
const AMBIANCE_MODIFIERS = {
  sombre:
    `Atmosphere: dark and brooding. Heavy blacks, deep shadows, ominous gothic mood.`,
  epique:
    `Atmosphere: epic and grand. Heroic scale, powerful composition, cinematic grandeur.`,
  religieux:
    `Atmosphere: sacred and divine. Celestial light rays, spiritual symbolism, transcendent reverence.`,
  doux:
    `Atmosphere: soft and delicate. Gentle gradients, flowing elegant lines, serene and peaceful.`,
  mystique:
    `Atmosphere: mysterious and esoteric. Occult symbolism, ancient mysticism, enigmatic and otherworldly.`,
  guerrier:
    `Atmosphere: fierce warrior spirit. Battle-ready energy, dynamic power, aggressive and commanding.`,
};

const TECHNICAL_REQUIREMENTS =
  `TECHNICAL REQUIREMENTS: flat digital artwork, perfectly centered, filling the full frame, ` +
  `pure solid white background (#FFFFFF), no paper texture, no paper shadows, no drop shadows, ` +
  `no perspective tilt, no photographic effect, no mockup, no surface, no desk, ` +
  `not a photograph of paper, strictly 2D flat composition.`;

// ─────────────────────────────────────────────────
// Format/composition par zone — étape 1
// ─────────────────────────────────────────────────
const ZONE_COMPOSITION = {
  'avant-bras':
    `Canvas format: tall narrow vertical composition (approximately 1:3 width-to-height ratio), ` +
    `designed to run from wrist to elbow along the forearm.`,

  'bras-complet':
    `Canvas format: long full-sleeve vertical composition (approximately 1:5 width-to-height ratio), ` +
    `continuous flow from shoulder down to wrist.`,

  'epaule':
    `Canvas format: compact rounded composition centered on the deltoid shoulder, ` +
    `bold central motif with semi-circular or shield-shaped framing.`,

  'dos':
    `Canvas format: large wide vertical composition filling the entire back canvas, ` +
    `bold and imposing, centered on a vertical spine axis spreading across both shoulder blades.`,

  'pectoral':
    `Canvas format: horizontal medium-format composition (wider than tall), ` +
    `following the natural arc of the chest muscle.`,

  'cuisse':
    `Canvas format: tall vertical composition (approximately 1:2.5 width-to-height ratio), ` +
    `designed to run along the outer thigh from above the knee toward the hip.`,

  'mollet':
    `Canvas format: compact vertical composition (approximately 1:2 width-to-height ratio), ` +
    `centered on the calf muscle from ankle to back of knee.`,

  'main':
    `Canvas format: small compact square-ish composition adapted for the hand, ` +
    `bold simple shapes with minimal fine detail to remain legible at small scale.`,
};

function buildPrompt({ sujet, style = 'concept', ambiance = 'epique', mot = '', elements = '', zone = '', withReference = false }) {
  const recipe   = STYLE_RECIPES[style]        || STYLE_RECIPES.concept;
  const mood     = AMBIANCE_MODIFIERS[ambiance] || AMBIANCE_MODIFIERS.epique;
  const zonePart = ZONE_COMPOSITION[zone]       || '';
  const refPart  = withReference
    ? `Draw strong inspiration from the provided reference image for the overall composition and visual approach, while keeping the subject, chosen style, and atmosphere described below.`
    : '';
  const motPart =
    mot.trim()
      ? `The word or text "${mot.trim()}" must be elegantly integrated as tattoo lettering into the composition.`
      : '';
  const elementsPart =
    elements.trim()
      ? `Additional elements to include in the design: ${elements.trim()}.`
      : '';

  return [
    DESIGN_SYSTEM_PROMPT,
    `Strictly safe for work, fully clothed figures only, no nudity, no bare skin, non-violent.`,
    refPart,
    `Subject (the central focal point of the tattoo): ${sujet}.`,
    recipe,
    mood,
    zonePart,
    motPart,
    elementsPart,
    TECHNICAL_REQUIREMENTS,
  ].filter(Boolean).join(' ');
}

// ─────────────────────────────────────────────────
// Instructions de placement par zone corporelle — étape 2
// ─────────────────────────────────────────────────
const ZONE_PROMPTS = {
  'avant-bras':
    `Body zone: FOREARM. ` +
    `Place the tattoo on the forearm visible in the photo, oriented vertically. ` +
    `The design should run from wrist to elbow, sized to fill the forearm naturally. ` +
    `Wrap the design around the cylindrical shape of the forearm, following its curvature.`,

  'bras-complet':
    `Body zone: FULL ARM SLEEVE. ` +
    `The tattoo covers the entire arm from shoulder to wrist as a full sleeve. ` +
    `Scale the design to span the complete arm length, flowing across the deltoid, bicep, ` +
    `forearm, and down to the wrist, wrapping naturally around the arm's cylindrical shape.`,

  'dos':
    `Body zone: UPPER BACK. ` +
    `Place the tattoo centered on the upper and middle back, with the spine as the central vertical axis ` +
    `and the composition spread across both shoulder blades. ` +
    `Keep a clear margin of bare skin on all sides: the design must stop well ABOVE the waistband and shorts, ` +
    `never reaching the lower back or hips. Do not fill the entire back edge to edge. ` +
    `Proportional, bold, but contained within the bare skin of the upper back only.`,

  'pectoral':
    `Body zone: CHEST / PECTORAL. ` +
    `Place the tattoo on the pectoral area of the chest visible in the photo. ` +
    `Medium format, following the natural curve of the chest muscle. ` +
    `The design should be centered on the pectoral, respecting its rounded shape.`,

  'epaule':
    `Body zone: SHOULDER. ` +
    `Place the tattoo centered on the deltoid shoulder muscle visible in the photo. ` +
    `Compact rounded format, following the curved shape of the shoulder cap. ` +
    `The design wraps slightly around the deltoid, respecting its rounded form.`,

  'cuisse':
    `Body zone: THIGH. ` +
    `Place the tattoo on the outer thigh visible in the photo. ` +
    `Vertical format, running from above the knee up toward the hip. ` +
    `The design follows the cylindrical and muscular shape of the thigh.`,

  'mollet':
    `Body zone: CALF. ` +
    `Place the tattoo centered on the calf muscle visible in the photo. ` +
    `Vertical compact format, sized to fit the calf from ankle to back of knee. ` +
    `Wrap naturally around the rounded calf muscle shape.`,

  'main':
    `Body zone: HAND. ` +
    `Place the tattoo on the back of the hand or fingers visible in the photo. ` +
    `Small compact format, bold and simple shapes, adapted to the limited skin surface. ` +
    `Follow the natural contours of the hand bones and joints.`,
};

// Modèles disponibles pour l'étape 2 (pose sur le corps)
const BODY_MODELS = {
  nano_banana_pro:  { apiModel: 'gpt_image_2', extras: { resolution: '2k' }, label: 'Standard' },
};
const DEFAULT_BODY_MODEL = 'nano_banana_pro';

// ─────────────────────────────────────────────────
// Utilitaires image
// ─────────────────────────────────────────────────

function fileToBase64(filePath) {
  return `data:image/jpeg;base64,${fs.readFileSync(filePath).toString('base64')}`;
}

async function urlToBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Impossible de télécharger l'image : HTTP ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

// ─────────────────────────────────────────────────
// Higgsfield via CLI (plus fiable que l'API REST)
// ─────────────────────────────────────────────────

const MODEL_MAP = {
  'image_auto':                 'gpt_image_2',
  'gpt_image_2':                'gpt_image_2',
  'nano_banana_2':              'nano_banana_2',
  'nano_banana_2_skin_enhancer':'nano_banana_2',
  'cinematic_studio_video_3_5': 'seedance_2_0',
};

const HF_API = 'https://fnf.higgsfield.ai';

// Upload an image buffer to Higgsfield media — returns {id, url}
async function uploadImageToHiggsfield(buffer, mimeType = 'image/jpeg', retry = true) {
  const apiKey = process.env.HIGGSFIELD_API_KEY || '';

  // Build multipart body manually for maximum compatibility
  const boundary = '----HFBoundary' + Date.now().toString(16);
  const ext = mimeType.includes('png') ? 'png' : 'jpg';
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body   = Buffer.concat([header, buffer, footer]);

  // Step 1: get presigned S3 URL
  const initRes = await fetch(`${HF_API}/agents/uploads?type=image`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (initRes.status === 401 && retry) {
    console.log('🔄 Upload 401 — refreshing token and retrying...');
    await refreshHiggsfieldToken();
    return uploadImageToHiggsfield(buffer, mimeType, false);
  }

  const initText = await initRes.text();
  if (!initRes.ok) throw new Error('Upload init failed: ' + initText.slice(0, 200));
  const { id, url, upload_url } = JSON.parse(initText);

  // Step 2: PUT actual bytes to S3 presigned URL
  const s3Res = await fetch(upload_url, {
    method:  'PUT',
    headers: { 'Content-Type': mimeType },
    body:    buffer,
  });
  if (!s3Res.ok) throw new Error('S3 upload failed: ' + s3Res.status);

  console.log('✓ Higgsfield media uploaded:', id);
  return { id, url };
}

// Appel REST direct — utilisé quand le CLI ne supporte pas l'option (ex: gpt_image_2 + image)
async function fetchHiggsFieldREST(payload, timeoutMs = 270_000) {
  // Read token dynamically so refresh within this call is picked up
  const apiKey = () => process.env.HIGGSFIELD_API_KEY || '';
  const { model, prompt, resolution, images } = payload;

  let input_images;
  if (Array.isArray(images) && images.length) {
    // Upload each image to Higgsfield and get media UUIDs
    input_images = await Promise.all(images.map(async (b64) => {
      const data   = b64.replace(/^data:image\/\w+;base64,/, '');
      const mime   = (b64.match(/^data:(image\/\w+);/) || [])[1] || 'image/jpeg';
      const buffer = Buffer.from(data, 'base64');
      const { id, url } = await uploadImageToHiggsfield(buffer, mime);
      return { id, url, type: 'media_input' };
    }));
  }

  const params = { prompt };
  if (resolution) params.resolution = resolution;
  if (input_images) {
    if (model === 'gpt_image_2') params.medias = input_images.map(img => ({ data: img, role: 'image' }));
    else params.input_images = input_images;
  }

  const body = { job_set_type: model, params };

  // Soumettre le job
  let submitRes = await fetch(`${HF_API}/agents/jobs`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (submitRes.status === 401) {
    console.log('🔄 Submit 401 — refreshing token and retrying...');
    await refreshHiggsfieldToken();
    submitRes = await fetch(`${HF_API}/agents/jobs`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${process.env.HIGGSFIELD_API_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  }

  const submitted = await submitRes.json();
  console.log('REST submit:', JSON.stringify(submitted).slice(0, 300));
  // API returns either ["jobId"] or {id: "jobId"}
  const jobId = Array.isArray(submitted) ? submitted[0] : submitted.id;
  if (!submitRes.ok || !jobId) throw new Error('REST submit failed: ' + JSON.stringify(submitted).slice(0, 200));
  const deadline = Date.now() + timeoutMs;

  // Poll jusqu'au résultat
  let lastStatus = 'queued';
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2500));
    let pollRes = await fetch(`${HF_API}/agents/jobs/${jobId}`, {
      headers: { 'Authorization': `Bearer ${apiKey()}` },
    });
    // Token expiré pendant le polling : on rafraîchit et on continue (pas un échec)
    if (pollRes.status === 401) {
      console.log('🔄 Poll 401 — refreshing token mid-poll...');
      await refreshHiggsfieldToken().catch(() => {});
      continue;
    }
    const job = await pollRes.json();
    lastStatus = job.status || lastStatus;
    const url = job.result_url || (job.results && job.results[0] && job.results[0].url);
    console.log('REST poll:', job.status, url || '');
    if (job.status === 'completed' && url) return { imageUrl: url, jobId };
    // Statuts terminaux d'échec — on échoue tout de suite, sans attendre le timeout
    if (job.status === 'nsfw') throw new Error('NSFW_BLOCKED');
    if (job.status === 'failed' || job.status === 'canceled') throw new Error('Job failed: ' + JSON.stringify(job).slice(0, 200));
  }
  throw new Error('Timeout waiting for REST job (last status: ' + lastStatus + ')');
}

async function fetchHiggsfield(payload, nsfwMsg, timeoutMs = 270_000) {
  const model = MODEL_MAP[payload.model] || payload.model || 'nano_banana_2';
  return fetchHiggsFieldREST({ ...payload, model }, timeoutMs);
}

function runCLI(args, timeoutMs, retry = true) {
  return new Promise((resolve, reject) => {
    // Appel direct au binaire hf (bypass du wrapper Node qui re-spawn sans nos env vars)
    const binName   = process.platform === 'win32' ? 'hf.exe' : 'hf';
    const vendorBin = path.join(__dirname, 'node_modules', '@higgsfield', 'cli', 'vendor', binName);
    const bin       = fs.existsSync(vendorBin) ? vendorBin : binName;

    // Passe le token en variable d'environnement au CLI
    const env = {
      ...process.env,
      HIGGSFIELD_API_KEY:       process.env.HIGGSFIELD_API_KEY || '',
      HIGGSFIELD_REFRESH_TOKEN: process.env.HIGGSFIELD_REFRESH_TOKEN || '',
      HOME: PERSIST_DIR,
    };

    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, env }, async (err, stdout, stderr) => {
      // Log complet pour diagnostic
      if (stdout) console.log('CLI stdout:', stdout.slice(0, 500));
      if (stderr) console.log('CLI stderr:', stderr.slice(0, 500));
      if (err)    console.log('CLI err.message:', err.message?.slice(0, 300));

      if (err) {
        const detail = (stderr || err.message || '').slice(0, 500);
        console.error('❌ CLI failed. Full detail:', detail);
        if (retry && /session expired/i.test(detail)) {
          console.log('🔄 Session expired — refreshing token and retrying...');
          refreshHiggsfieldToken()
            .then(() => runCLI(args, timeoutMs, false).then(resolve).catch(reject))
            .catch(e => reject(new Error('Token refresh failed: ' + e.message)));
          return;
        }
        return reject(new Error('Generation failed: ' + detail));
      }
      const url = stdout.trim().split('\n').map(l => {
        const m = l.match(/https?:\/\/\S+/);
        return m ? m[0] : null;
      }).filter(Boolean).pop();
      if (!url) {
        console.error('❌ No URL in CLI output:', stdout.slice(0, 300));
        return reject(new Error('Generation failed. Please try again.'));
      }
      resolve(url);
    });
  });
}

function refreshHiggsfieldToken() {
  // Deduplicate concurrent refresh calls
  if (_refreshInProgress) return _refreshInProgress;

  _refreshInProgress = new Promise((resolve, reject) => {
    const binName   = process.platform === 'win32' ? 'hf.exe' : 'hf';
    const vendorBin = path.join(__dirname, 'node_modules', '@higgsfield', 'cli', 'vendor', binName);
    const bin       = fs.existsSync(vendorBin) ? vendorBin : binName;

    // IMPORTANT : `auth token` n'affiche que le token stocké sans le rafraîchir.
    // Pour forcer un VRAI refresh, on lance un appel API authentifié léger
    // (`account status`). Si le token est expiré, le CLI le rafraîchit
    // automatiquement et réécrit credentials.json avec un token neuf.
    // HOME pointe vers PERSIST_DIR : le CLI lit/écrit le fichier persistant.
    execFile(bin, ['account', 'status'], { timeout: 30_000, env: { ...process.env, HOME: PERSIST_DIR } }, (err, stdout, stderr) => {
      _refreshInProgress = null;
      if (err) return reject(new Error('CLI account status failed: ' + (stderr || err.message).slice(0, 200)));

      // Le CLI a (potentiellement) réécrit credentials.json avec un token neuf : on le relit
      const creds = readPersistedCredentials();
      if (!creds || !creds.access_token) return reject(new Error('No credentials after refresh'));

      process.env.HIGGSFIELD_API_KEY = creds.access_token;
      if (creds.refresh_token) process.env.HIGGSFIELD_REFRESH_TOKEN = creds.refresh_token;
      console.log('✓ Higgsfield token refreshed via CLI (account status), new prefix =', creds.access_token.slice(0, 8));
      resolve();
    });
  });

  return _refreshInProgress;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Retourne un message d'erreur safe pour le client (jamais de détails techniques)
function clientError(err) {
  const msg = err.message || '';
  if (msg === 'NSFW_BLOCKED' || /nsfw|safety system|content[_ ]?policy|moderation/i.test(msg)) {
    return 'Your description was blocked by the AI content filter. ' +
           'Rephrase it avoiding: nudity, bare bodies, shirtless figures, violence, realistic weapons, blood or highly sensitive symbols. ' +
           'Describe a clothed figure instead — armor or covering drapery works great.';
  }
  if (/timeout/i.test(msg)) {
    return 'Generation took too long. Please try again in a moment.';
  }
  return msg || 'Generation failed. Please try again in a moment.';
}

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024, files: 4 },   // 10 Mo max, 4 fichiers max
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|gif|heic|heif)$/i.test(file.mimetype)) cb(null, true);
    else cb(null, false);   // rejette silencieusement les non-images
  },
});
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// ─────────────────────────────────────────────────
// OpenAI image generation
// Modèle configurable via env IMAGE_MODEL (défaut gpt-image-2, plus récent).
// Pour revenir en arrière : IMAGE_MODEL=gpt-image-1 dans Railway.
// ─────────────────────────────────────────────────
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gpt-image-2';
// Taille par format
function sizeForFormat(format) {
  return format === 'portrait' ? '1024x1536'
       : format === 'landscape' ? '1536x1024'
       : '1024x1024';
}
// Choisit le format gpt-image-1 selon la zone du corps
function openAISizeForZone(zone) {
  const tall = ['avant-bras', 'bras-complet', 'cuisse', 'mollet', 'dos'];
  if (tall.includes(zone)) return '1024x1536';   // portrait
  return '1024x1024';                              // carré (poitrine, épaule, main, défaut)
}

// Wrapper de rendu "flash de tatouage premium" (réutilisable)
// Habillage de rendu NEUTRE : ne force aucun style. L'identité visuelle vient
// entièrement du prompt enrichi (issu de la recette du style choisi). On ajoute
// seulement les contraintes techniques (fond blanc, N&B, tattouable).
function buildRenderWrapper(designPrompt, { bw = true } = {}) {
  const colorRule = bw
    ? `Rendered in pure black and grey only — rich blacks, smooth grey shading, deep contrast, no color, no warm tones.`
    : `Clean, well-controlled colors exactly as described.`;
  return (
    `Premium professional tattoo design, flat 2D artwork on a pure solid white background #FFFFFF. ` +
    `${designPrompt} ` +
    `${colorRule} ` +
    `Rendering finish (CRITICAL): ultra-smooth, polished, high-fidelity digital rendering — soft continuous tonal gradients, airbrushed seamless shading, glossy specular highlights, rich deep blacks, strong three-dimensional volume and depth, crisp clean edges, premium gallery-quality finish. ` +
    `Surfaces look smooth and sculpted (like polished stone or a refined 3D render), never textured with marks. ` +
    `High dynamic range and strong contrast: bright clean white highlights and deep rich true blacks across the full tonal range, razor-sharp crisp detail, pristine pure white background — punchy and high-definition, never flat, hazy, washed-out or muddy. ` +
    `Do NOT make it look like a pencil sketch, charcoal, engraving, etching, woodcut, cross-hatching, stippling or grainy dotted shading — no visible strokes, no grain, no noise, no scratchy or sketchy texture; all shading reads as perfectly smooth continuous tone. ` +
    `One dominant focal point, generous negative space, clean tattooable linework and shading. ` +
    `Centered, full design visible, no mockup, no skin, no paper texture, no drop shadow, no frame. Ready to tattoo.`
  );
}

// Détecte si l'utilisateur demande explicitement de la couleur
function wantsColor(text) {
  return /\b(couleur|en couleur|color|colour|colored|coloured|colorful|colourful|vibrant colou?rs?|full colou?r)\b/i.test(text || '');
}

// Finition "studio" : contraste renforcé + netteté (+ noir & blanc si demandé)
async function finishImage(dataUrl, { grayscale = true } = {}) {
  try {
    const sharp = require('sharp');
    const b64 = (dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
    if (!b64) return dataUrl;
    const buf = Buffer.from(b64, 'base64');
    let img = sharp(buf);
    if (grayscale) img = img.grayscale();
    // Finition studio : étire la plage tonale (blancs purs + noirs profonds),
    // léger surcroît de contraste, puis netteté → look premium contrasté.
    // Quasi rien : le rendu vient du prompt. PAS de sharpen (ça accentue le grain).
    // Juste un soupçon de contraste pour des blancs propres.
    img = img.linear(1.04, -4);
    const out = await img.png().toBuffer();
    return 'data:image/png;base64,' + out.toString('base64');
  } catch (e) {
    console.warn('⚠ finishImage failed:', e.message);
    return dataUrl; // fallback : image telle quelle
  }
}

// ─────────────────────────────────────────────────
// Filigrane discret "INK.STUDIO" (plan FREE uniquement — jamais payants/owner/démo)
// ─────────────────────────────────────────────────
async function applyWatermark(dataUrl) {
  try {
    const sharp = require('sharp');
    const b64 = (dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
    if (!b64 || !(dataUrl || '').startsWith('data:image')) return dataUrl;
    const buf  = Buffer.from(b64, 'base64');
    const meta = await sharp(buf).metadata();
    const w = meta.width || 1024, h = meta.height || 1024;
    const fSize = Math.round(Math.max(16, w * 0.022));
    const pad   = Math.round(w * 0.026);
    const svg = Buffer.from(
      `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
      `<text x="${w - pad}" y="${h - pad}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" ` +
      `font-size="${fSize}" font-weight="600" letter-spacing="${Math.max(1, fSize * 0.14)}" ` +
      `fill="rgba(255,255,255,0.34)" stroke="rgba(0,0,0,0.22)" stroke-width="0.6">INK.STUDIO</text></svg>`
    );
    const out = await sharp(buf).composite([{ input: svg }]).png().toBuffer();
    return 'data:image/png;base64,' + out.toString('base64');
  } catch (e) {
    console.warn('⚠ watermark failed:', e.message);
    return dataUrl;
  }
}

// Filigrane seulement si l'utilisateur est en plan FREE (ni payant, ni owner, ni démo)
async function brandIfFree(gate, dataUrl) {
  const u = gate && gate.user;
  if (!u) return dataUrl;
  if (u.email === OWNER_EMAIL) return dataUrl;
  if ((u.plan || 'free') !== 'free') return dataUrl;
  return applyWatermark(dataUrl);
}

// ─────────────────────────────────────────────────
// Enrichit l'idée de l'utilisateur en un prompt détaillé DANS LE STYLE CHOISI
// (gpt-4o). Le style provient des recettes officielles (STYLES) — pas de style
// "maison" imposé. Renvoie null si indisponible → fallback sur le prompt brut.
async function enhancePrompt(userIdea, styleKey, extras = {}) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey || !userIdea) return null;
  const style  = getStyle(styleKey);
  const mood   = AMBIANCE_MODIFIERS[extras.ambiance] || '';
  const zone   = ZONE_COMPOSITION[extras.zone] || '';
  const sys =
    `You are an elite tattoo concept artist and prompt engineer. For EACH request you design a bespoke, one-of-a-kind composition for THIS specific client — never a recycled template. ` +
    `Make deliberate creative choices that vary from piece to piece: camera angle and viewpoint, the subject's exact pose and gesture, framing and crop, the specific supporting symbols, the asymmetry of the layout, and where the negative space falls. Two clients asking for the same subject must get visibly different concepts. ` +
    DESIGN_SYSTEM_PROMPT + ' ' +
    `The user has explicitly chosen the "${style.label}" style. Apply ONLY this style as defined below; do not borrow motifs from any other style. ` +
    style.recipe + ' ' +
    (mood ? mood + ' ' : '') +
    (zone ? zone + ' ' : '') +
    `Now invent ONE distinctive composition and write it as a single image-generation prompt for gpt-image-1, optimised for a beautiful, high-fidelity render. Be concretely visual and specific — cover, in flowing prose (not a list): ` +
    `(1) the exact subject, its pose/expression/angle as the dominant focal point; ` +
    `(2) the rendering technique of THIS style — line weight, shading method, contrast, level of realism; ` +
    `(3) light direction and how it sculpts volume; ` +
    `(4) key textures and where fine detail concentrates vs. fades; ` +
    `(5) the supporting/background elements that genuinely belong to this style and how they connect to the subject; ` +
    `(6) where the generous negative space sits. ` +
    `Pure black and grey unless the user explicitly asks for color. Fully clothed figures, no nudity, no gore. ` +
    `Output ONLY the final image prompt in English, 100-150 words, no preamble, no bullet points, no headings, no style name.`;
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userIdea },
        ],
        temperature: 0.95, max_tokens: 500,
      }),
    });
    const data = await resp.json();
    const out = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return out ? out.trim() : null;
  } catch (e) {
    console.warn('⚠ enhancePrompt failed:', e.message);
    return null;
  }
}

// Extrait UNIQUEMENT le sujet (traduit/condensé en anglais) pour l'injecter dans
// un template figé. Pas de mots de style/rendu → le template garde le contrôle du look.
async function enhanceSubject(userIdea, extras = {}) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey || !userIdea) return null;
  const sys =
    `Translate and condense the user's tattoo idea into a short, vivid ENGLISH subject phrase for an image prompt. ` +
    `Describe ONLY the subject, its pose/gesture and any key objects it holds or interacts with — 8 to 25 words. ` +
    `Do NOT mention any art style, rendering, material, lighting, background, color or composition. No preamble, output only the phrase.`;
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: userIdea }],
        temperature: 0.85, max_tokens: 80,
      }),
    });
    const data = await resp.json();
    const out = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return out ? out.trim().replace(/^["']|["']$/g, '') : null;
  } catch (e) {
    console.warn('⚠ enhanceSubject failed:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────
// QUALITY CHECKER — vérifie le rendu (vision gpt-4o). Fail-open : en cas d'erreur, on valide.
async function qualityCheck(dataUrl, { bw = true } = {}) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey || !dataUrl || !dataUrl.startsWith('data:')) return { pass: true, reason: '' };
  try {
    const checklist =
      `You are a strict QA reviewer for a premium tattoo design generator. Judge if this image is a VALID, clean, high-quality tattoo flash design. ` +
      `It MUST: be a flat tattoo design only (NOT a photo of skin/body, NOT a mockup, NOT a framed picture), sit on a pure WHITE background, ` +
      (bw ? `be pure black & grey with NO color and NO sepia/warm/cream tint, ` : `have clean, well-controlled colors, `) +
      `show a clear readable subject, and look tattooable and professional. ` +
      `Reply with STRICT JSON only: {"pass": true|false, "reason": "<short>"}. Set pass=false ONLY if it clearly violates one of the must-haves.`;
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [ { role: 'user', content: [
          { type: 'text', text: checklist },
          { type: 'image_url', image_url: { url: dataUrl } },
        ] } ],
        temperature: 0, max_tokens: 80,
        response_format: { type: 'json_object' },
      }),
    });
    const data = await resp.json();
    const txt = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '{}';
    const parsed = JSON.parse(txt);
    return { pass: parsed.pass !== false, reason: parsed.reason || '' };
  } catch (e) {
    console.warn('⚠ qualityCheck failed:', e.message);
    return { pass: true, reason: '' }; // fail-open : ne jamais bloquer une image valide
  }
}

async function generateWithOpenAI(prompt, referenceImagePath = null, size = '1024x1024') {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) throw new Error('OPENAI_API_KEY not set.');

  if (referenceImagePath) {
    // With reference: use edits endpoint
    const fd = new FormData();
    fd.append('model', IMAGE_MODEL);
    fd.append('prompt', prompt);
    fd.append('n', '1');
    fd.append('size', size);
    fd.append('quality', 'high');
    fd.append('moderation', 'low');   // filtre artistique allégé (sculptures classiques)
    const refIsPng = referenceImagePath.toLowerCase().endsWith('.png');
    fd.append('image[]', new File([fs.readFileSync(referenceImagePath)], `reference.${refIsPng ? 'png' : 'jpg'}`, { type: refIsPng ? 'image/png' : 'image/jpeg' }));

    const resp = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: fd,
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error('OpenAI edits error: ' + JSON.stringify(data).slice(0, 300));
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error('No image returned from OpenAI edits');
    return `data:image/png;base64,${b64}`;

  } else {
    // Text-only: use generations endpoint
    const resp = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, n: 1, size, quality: 'high', moderation: 'low' }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error('OpenAI generations error: ' + JSON.stringify(data).slice(0, 300));
    const b64 = data.data?.[0]?.b64_json;
    const url  = data.data?.[0]?.url;
    if (b64) return `data:image/png;base64,${b64}`;
    if (url) return url;
    throw new Error('No image returned from OpenAI generations');
  }
}

// Édition gpt-image-2 avec PLUSIEURS images d'entrée (ex: photo du corps + design).
// quality: 'high' par défaut ; 'medium' pour les tâches lourdes (merge multi-images) = bien plus rapide.
// timeoutMs: coupe proprement si OpenAI traîne (évite la requête qui tourne sans fin).
async function openAIEditMulti(prompt, imagePaths = [], size = 'auto', quality = 'high', timeoutMs = 240_000) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) throw new Error('OPENAI_API_KEY not set.');

  const fd = new FormData();
  fd.append('model', IMAGE_MODEL);
  fd.append('prompt', prompt);
  fd.append('n', '1');
  fd.append('size', size);
  fd.append('quality', quality);
  fd.append('moderation', 'low');
  imagePaths.forEach((p, i) => {
    const isPng = p.toLowerCase().endsWith('.png');
    fd.append('image[]', new File([fs.readFileSync(p)], `img${i}.${isPng ? 'png' : 'jpg'}`, { type: isPng ? 'image/png' : 'image/jpeg' }));
  });

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: fd,
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Generation took too long. Try again with fewer or smaller images.');
    throw e;
  } finally {
    clearTimeout(t);
  }
  const data = await resp.json();
  if (!resp.ok) throw new Error('OpenAI edits error: ' + JSON.stringify(data).slice(0, 300));
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('No image returned from OpenAI edits');
  return `data:image/png;base64,${b64}`;
}

// ─────────────────────────────────────────────────
// POST /rework — Inpainting précis via OpenAI gpt-image-1
// ─────────────────────────────────────────────────
app.post('/rework', genLimiter, upload.fields([{ name: 'image' }, { name: 'mask' }, { name: 'fusion' }]), async (req, res) => {
  const prompt    = (req.body.prompt    || '').trim();
  const zoneDesc  = (req.body.zoneDesc  || '').trim();
  const imageFile = req.files?.image?.[0];
  const maskFile  = req.files?.mask?.[0];
  const fusionFile = req.files?.fusion?.[0];

  if (!prompt || !imageFile) {
    return res.status(400).json({ error: 'Missing prompt or image.' });
  }

  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) return res.status(500).json({ error: 'OpenAI API key not configured.' });

  let gate = null;
  try {
    gate = await checkCredits(req, res, 'rework');
    if (!gate) return;
    const fusionNote = fusionFile ? ' Fuse the style and elements of the reference fusion image with the original design.' : '';
    const fullPrompt = `Tattoo design. ${zoneDesc ? zoneDesc + ' ' : ''}${prompt}.${fusionNote} Keep the same artistic style, line weight and composition for all areas outside the mask. Professional tattoo flash art, white background, high resolution.`;
    console.log('\n🎨 Rework via OpenAI inpainting');
    console.log('   Prompt:', fullPrompt.slice(0, 120));

    const fd = new FormData();
    fd.append('model', IMAGE_MODEL);
    fd.append('prompt', fullPrompt);
    fd.append('size', '1024x1024');
    fd.append('quality', 'high');
    fd.append('moderation', 'low');
    fd.append('n', '1');

    const imgBuffer = fs.readFileSync(imageFile.path);
    fd.append('image[]', new File([imgBuffer], 'design.png', { type: 'image/png' }));
    if (fusionFile) {
      const fusionBuffer = fs.readFileSync(fusionFile.path);
      fd.append('image[]', new File([fusionBuffer], 'fusion.png', { type: 'image/png' }));
    }

    if (maskFile) {
      const maskBuffer = fs.readFileSync(maskFile.path);
      fd.append('mask', new File([maskBuffer], 'mask.png', { type: 'image/png' }));
    }

    const response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: fd,
    });

    const data = await response.json();
    console.log('OpenAI response status:', response.status);

    // OpenAI a échoué (billing, quota, modération…) → message propre (pas de fallback)
    if (!response.ok) {
      console.warn('⚠️ OpenAI rework failed:', data.error?.message);
      throw new Error('The generation service is temporarily unavailable. Try again in a moment.');
    }

    const b64 = data.data?.[0]?.b64_json;
    const url  = data.data?.[0]?.url;
    if (!b64 && !url) throw new Error('No image in OpenAI response');

    let imageUrl = url;
    if (b64 && !url) {
      const branded = await brandIfFree(gate, 'data:image/png;base64,' + b64);
      const outPath = path.join(os.tmpdir(), `rework-${Date.now()}.png`);
      fs.writeFileSync(outPath, Buffer.from(branded.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
      imageUrl = `/rework-result/${path.basename(outPath)}`;
      setTimeout(() => { try { fs.unlinkSync(outPath); } catch {} }, 10 * 60 * 1000);
      app._reworkTmp = app._reworkTmp || {};
      app._reworkTmp[path.basename(outPath)] = outPath;
    }

    const credits = await chargeAfter(gate);
    try { if (gate.user) await saveGeneration(gate.user.id, 'rework', imageUrl, { prompt }); } catch {}
    res.json({ imageUrl, credits });
  } catch (err) {
    await refundCredits(gate);
    console.error('❌ /rework:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (imageFile  && fs.existsSync(imageFile.path))  try { fs.unlinkSync(imageFile.path);  } catch {}
    if (maskFile   && fs.existsSync(maskFile.path))   try { fs.unlinkSync(maskFile.path);   } catch {}
    if (fusionFile && fs.existsSync(fusionFile.path)) try { fs.unlinkSync(fusionFile.path); } catch {}
  }
});

// Sert les résultats rework temporaires (base64 → fichier local)
app.get('/rework-result/:filename', (req, res) => {
  const p = (app._reworkTmp || {})[req.params.filename];
  if (!p || !fs.existsSync(p)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'image/png');
  res.send(fs.readFileSync(p));
});

// ─────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────
// En-têtes de sécurité standards (posés sur TOUTES les réponses, y compris le static)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');            // pas de sniffing MIME
  res.setHeader('X-Frame-Options', 'DENY');                       // anti-clickjacking
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=()'); // micro autorisé (dictée vocale)
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(express.static(path.join(__dirname)));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);   // requêtes same-origin / outils serveur
    const ok = /\.railway\.app$/.test(origin) || /^https?:\/\/(www\.)?inkhay\.com$/.test(origin) || /^https?:\/\/localhost(:\d+)?$/.test(origin);
    cb(null, ok);
  },
  credentials: true,
}));
// Le webhook Stripe a besoin du body BRUT pour vérifier la signature → on
// applique express.json() partout SAUF sur /webhook.
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') return next();
  express.json({ limit: '2mb' })(req, res, next);
});

// ═══════════════════════════════════════════════════
// AUTH — Google vérifié serveur + session cookie + comptes DB
// ═══════════════════════════════════════════════════
const jwt = require('jsonwebtoken');
const GOOGLE_CLIENT_ID = '1055204918844-a5kshvsbciibcak84plhf007trpc0k59.apps.googleusercontent.com';
const SESSION_SECRET = process.env.SESSION_SECRET || 'ink-studio-dev-secret-change-me';
const SESSION_COOKIE = 'ink_sid';

function setSession(res, userId, sessionVersion = 0) {
  // v = version de session : incrémentée au reset de mot de passe → toutes les anciennes sessions meurent.
  const token = jwt.sign({ uid: userId, v: sessionVersion || 0 }, SESSION_SECRET, { expiresIn: '30d' });
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function getSessionUser(req) {
  if (!db) return null;
  const tok = getCookie(req, SESSION_COOKIE);
  if (!tok) return null;
  try {
    const payload = jwt.verify(tok, SESSION_SECRET);
    const r = await db.query('SELECT * FROM users WHERE id=$1', [payload.uid]);
    const u = r.rows[0] || null;
    // Session invalidée si le mot de passe a été réinitialisé depuis (version différente)
    if (u && (payload.v || 0) !== (u.session_version || 0)) return null;
    return u;
  } catch { return null; }
}
function publicUser(u) {
  if (!u) return u;
  const isOwner = u.email === OWNER_EMAIL;
  return {
    email: u.email, name: u.name, avatar: u.avatar_url,
    plan: u.plan,
    credits: isOwner ? '∞' : u.credits_remaining,
    creditsMax: isOwner ? '∞' : (PLAN_CREDITS[u.plan] || PLAN_CREDITS.free),
    unlimited: isOwner,
    emailVerified: u.email_verified !== false,
    creditsResetAt: u.credits_reset_at,
  };
}

// Recharge mensuelle automatique des crédits selon le plan
async function applyMonthlyReset(user) {
  if (!db || !user) return user;
  if (new Date(user.credits_reset_at) > new Date()) return user;
  // Plan payant : on AJOUTE les crédits du mois (ils s'accumulent, jamais perdus).
  // Plan free : on n'accumule pas (anti-farming) — on prolonge juste la période, le solde est conservé.
  if (user.plan && user.plan !== 'free') {
    const amount = PLAN_CREDITS[user.plan] || 0;
    const r = await db.query(
      `UPDATE users SET credits_remaining = credits_remaining + $1, credits_reset_at = now() + interval '30 days' WHERE id=$2 RETURNING *`,
      [amount, user.id]
    );
    return r.rows[0];
  }
  const r = await db.query(
    `UPDATE users SET credits_reset_at = now() + interval '30 days' WHERE id=$1 RETURNING *`,
    [user.id]
  );
  return r.rows[0];
}

// Débite des crédits ; renvoie le solde restant
async function chargeCredits(userId, cost) {
  const r = await db.query(
    `UPDATE users SET credits_remaining = GREATEST(credits_remaining - $1, 0) WHERE id=$2 RETURNING credits_remaining`,
    [cost, userId]
  );
  return r.rows[0] ? r.rows[0].credits_remaining : null;
}

// ── Garde-fou crédits avant une génération payante ──
// RÉSERVE (débite) les crédits de façon ATOMIQUE avant la génération → empêche la
// faille de course (2 requêtes simultanées qui passeraient la vérif toutes les deux).
// En cas de refus, répond directement (401/402) et renvoie null → `if (!gate) return;`.
// Si la génération échoue ensuite, l'appelant doit appeler refundCredits(gate).
async function checkCredits(req, res, costType) {
  const cost = CREDIT_COST[costType] != null ? CREDIT_COST[costType] : 10;
  if (!db) return { user: null, isOwner: false, cost, charged: false };
  // On récupère TOUJOURS l'utilisateur (pour sauvegarder l'historique), même en démo.
  let user = await getSessionUser(req);
  if (!REQUIRE_LOGIN) {
    // Mode démo : ni login obligatoire ni débit, mais on garde l'user pour l'historique.
    const isOwner = !!user && user.email === OWNER_EMAIL;
    return { user, isOwner, cost, demo: true, charged: false };
  }
  if (!user) { res.status(401).json({ error: 'login_required' }); return null; }
  // Email non vérifié → pas de génération (anti-farming). Owner exempté.
  if (user.email !== OWNER_EMAIL && user.email_verified === false) {
    res.status(403).json({ error: 'email_not_verified' });
    return null;
  }
  user = await applyMonthlyReset(user);
  if (user.email === OWNER_EMAIL) return { user, isOwner: true, cost, charged: false };
  // Débit ATOMIQUE conditionnel : ne réussit QUE si le solde est suffisant.
  // Deux requêtes simultanées ne peuvent pas réussir toutes les deux.
  const r = await db.query(
    'UPDATE users SET credits_remaining = credits_remaining - $1 WHERE id=$2 AND credits_remaining >= $1 RETURNING credits_remaining',
    [cost, user.id]
  );
  if (!r.rows[0]) {
    res.status(402).json({ error: 'no_credits', credits: user.credits_remaining });
    return null;
  }
  return { user, isOwner: false, cost, creditsLeft: r.rows[0].credits_remaining, charged: true };
}

// Renvoie le solde restant après réservation (déjà débité). null si owner / démo / DB inactive.
async function chargeAfter(gate) {
  return gate && gate.creditsLeft != null ? gate.creditsLeft : null;
}

// Rembourse les crédits réservés si la génération échoue.
async function refundCredits(gate) {
  if (!gate || !gate.charged || !gate.user || !db) return;
  try {
    await db.query('UPDATE users SET credits_remaining = credits_remaining + $1 WHERE id=$2', [gate.cost, gate.user.id]);
  } catch {}
}

// Dossier persistant des images générées (volume Railway)
const GENS_DIR = path.join(PERSIST_DIR, 'gens');
try { fs.mkdirSync(GENS_DIR, { recursive: true }); } catch {}

// Sauvegarde une génération : écrit l'image sur le volume + ligne en DB. Renvoie l'URL fichier.
async function saveGeneration(userId, type, dataUrl, params) {
  if (!db || !userId || !dataUrl || !dataUrl.startsWith('data:')) return null;
  try {
    const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const name = Date.now() + '-' + Math.random().toString(16).slice(2, 8) + '.png';
    fs.writeFileSync(path.join(GENS_DIR, name), Buffer.from(b64, 'base64'));
    const url = '/gens/' + name;
    await db.query(
      `INSERT INTO generations (user_id, type, image_url, params) VALUES ($1,$2,$3,$4)`,
      [userId, type, url, params ? JSON.stringify(params) : null]
    );
    return url;
  } catch (e) {
    console.warn('⚠ saveGeneration failed:', e.message);
    return null;
  }
}

// Marqueur de version (diagnostic déploiement)
app.get('/version', (req, res) => {
  res.json({ build: 'security-v2', imageModel: IMAGE_MODEL, rateLimit: true, moderation: 'low', stripe: !!stripe });
});

// Connexion via Google (le front envoie le credential GSI)
// ── Vérification email (Resend) ──
const crypto = require('crypto');
function newVerifyToken() { return crypto.randomBytes(24).toString('hex'); }

async function sendVerificationEmail(email, token, req) {
  if (!process.env.RESEND_API_KEY) { console.warn('⚠ RESEND_API_KEY absent — email de vérif non envoyé'); return; }
  const link = `${baseUrl(req)}/verify?token=${encodeURIComponent(token)}`;
  // Template premium DA noir & argent — tables + styles inline (compatibilité Gmail/Outlook/Apple Mail)
  const html = `<!doctype html><html><body style="margin:0;padding:0;background-color:#0a0a0c;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0c;padding:36px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
        <!-- Wordmark -->
        <tr><td align="center" style="padding-bottom:26px;">
          <div style="font-family:Arial,Helvetica,sans-serif;font-weight:800;font-size:19px;letter-spacing:3px;color:#f6f6f9;">INK<span style="color:#7a7e8c;">.</span>STUDIO</div>
        </td></tr>
        <!-- Carte -->
        <tr><td style="background-color:#111114;border:1px solid #232329;border-radius:18px;padding:42px 36px;" align="center">
          <div style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:30px;color:#ffffff;line-height:1.25;padding-bottom:6px;">Welcome to the studio.</div>
          <div style="width:52px;height:1px;background-color:#3a3d48;margin:16px auto 20px;"></div>
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#b8bac4;line-height:1.75;padding-bottom:8px;">
            One last step — confirm your email to activate your account<br>and unlock your <span style="color:#ffffff;font-weight:bold;">30 free credits</span>.
          </div>
          <!-- Bouton -->
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px auto 6px;"><tr>
            <td style="background-color:#ffffff;border-radius:12px;">
              <a href="${link}" style="display:inline-block;padding:15px 38px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#0a0a0e;text-decoration:none;">Confirm my email</a>
            </td>
          </tr></table>
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#6a6e7e;padding-top:18px;">✦ &nbsp;Your first design is 60 seconds away</div>
        </td></tr>
        <!-- Lien de secours -->
        <tr><td align="center" style="padding:22px 12px 0;">
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#55565e;line-height:1.7;">
            Button not working? Copy this link:<br>
            <a href="${link}" style="color:#8a8e9c;word-break:break-all;">${link}</a>
          </div>
        </td></tr>
        <!-- Footer -->
        <tr><td align="center" style="padding:26px 12px 0;">
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#44454c;line-height:1.8;">
            If you didn't create an account, you can safely ignore this email.<br>
            © 2026 INK.STUDIO — <a href="https://inkhay.com" style="color:#6a6e7e;text-decoration:none;">inkhay.com</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'INK.STUDIO <noreply@inkhay.com>', to: email, subject: 'Confirm your email — INK.STUDIO', html }),
    });
    if (!r.ok) console.error('❌ Resend:', (await r.text()).slice(0, 200));
  } catch (e) { console.error('❌ sendVerificationEmail:', e.message); }
}

function verifyResultPage(msg, ok) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>INK.STUDIO — Email</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@1,600&family=Inter:wght@400;500&family=Syne:wght@700;800&display=swap" rel="stylesheet">
    <style>
    body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#080808;color:#f6f6f9;font-family:Inter,Arial,sans-serif;text-align:center;padding:24px;overflow:hidden}
    .glow{position:fixed;width:70vmin;height:70vmin;border-radius:50%;background:radial-gradient(circle,rgba(207,210,220,0.06) 0%,transparent 65%);pointer-events:none}
    .logo{font-family:Syne,sans-serif;font-weight:800;letter-spacing:0.12em;font-size:0.95rem;margin-bottom:34px}
    .logo span{color:#7a7e8c}
    .box{max-width:460px;background:linear-gradient(180deg,#121216,#0c0c10);border:1px solid #232329;border-radius:22px;padding:44px 38px;box-shadow:0 40px 100px rgba(0,0,0,.55);animation:in .7s cubic-bezier(0.22,1,0.36,1) both}
    @keyframes in{from{opacity:0;transform:translateY(18px) scale(.97);filter:blur(6px)}to{opacity:1;transform:none;filter:blur(0)}}
    h1{font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-weight:600;font-size:1.7rem;margin:0 0 12px;line-height:1.3}
    .sub{color:#9a9daa;line-height:1.7;font-size:.9rem;margin:0}
    .sep{width:52px;height:1px;background:#3a3d48;margin:18px auto}
    a.btn{display:inline-block;margin-top:26px;background:#fff;color:#0a0a0e;text-decoration:none;padding:14px 34px;border-radius:13px;font-family:Syne,sans-serif;font-weight:700;font-size:.78rem;letter-spacing:.06em;text-transform:uppercase;transition:transform .3s cubic-bezier(0.34,1.56,0.64,1),box-shadow .3s}
    a.btn:hover{transform:translateY(-2px);box-shadow:0 12px 34px rgba(255,255,255,.14)}
    </style></head><body>
    <div class="glow"></div>
    <div class="logo">INK<span>.</span>STUDIO</div>
    <div class="box">
      <h1>${ok ? msg : msg}</h1>
      <div class="sep"></div>
      <p class="sub">${ok
        ? 'Your 30 free credits are now in your account.<br>Your first design is 60 seconds away.'
        : 'Something went wrong with this link — request a new one from the studio.'}</p>
      <a class="btn" href="/outil.html">${ok ? 'Start creating →' : 'Back to the studio'}</a>
    </div></body></html>`;
}

// Confirme le token, débloque les 30 crédits gratuits
// ── Liens bio traqués par réseau social ──
// inkhay.com/ig (Instagram) · /tt (TikTok) · /yt (YouTube) · /x (X/Twitter)
// Sert l'accueil SUR ce chemin (pas de redirection) → le beacon Cloudflare Analytics
// enregistre la vue sur /ig, /tt… → tu vois quel réseau amène du trafic, par chemin.
for (const bioPath of ['/ig', '/tt', '/yt', '/x']) {
  app.get(bioPath, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
}

app.get('/verify', async (req, res) => {
  if (!db) return res.status(503).send(verifyResultPage('Service unavailable.', false));
  const token = (req.query.token || '').toString();
  if (!token) return res.status(400).send(verifyResultPage('Invalid link.', false));
  try {
    const r = await db.query('SELECT id, email, name, email_verified, session_version FROM users WHERE verify_token=$1', [token]);
    const u = r.rows[0];
    if (!u) return res.send(verifyResultPage('Invalid or already-used link.', false));
    if (!u.email_verified) {
      await db.query(
        `UPDATE users SET email_verified=true, verify_token=NULL, credits_remaining = credits_remaining + $1, credits_reset_at = now() + interval '30 days' WHERE id=$2`,
        [PLAN_CREDITS.free, u.id]
      );
      sendWelcomeEmail(u.email, u.name, req).catch(() => {});   // bienvenue (non bloquant)
    }
    setSession(res, u.id, u.session_version);   // connecte l'utilisateur (même si le lien s'ouvre dans un autre navigateur)
    res.send(verifyResultPage('Email confirmed! Your 30 free credits are unlocked.', true));
  } catch (e) {
    console.error('❌ /verify:', e.message);
    res.status(500).send(verifyResultPage('Something went wrong, try again.', false));
  }
});

// Renvoyer l'email de vérification
app.post('/auth/resend-verification', authLimiter, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB indisponible' });
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'non_connecté' });
  if (user.email_verified) return res.json({ ok: true, already: true });
  let token = user.verify_token;
  if (!token) { token = newVerifyToken(); await db.query('UPDATE users SET verify_token=$1 WHERE id=$2', [token, user.id]); }
  await sendVerificationEmail(user.email, token, req);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────
// Mot de passe oublié — flux sécurisé
// (jeton crypto 30 min usage unique · réponse neutre · rate-limité · sessions invalidées)
// ─────────────────────────────────────────────────
function emailShell(title, bodyHtml) {
  // Coque commune des emails transactionnels (DA noir & argent, tables inline)
  return `<!doctype html><html><body style="margin:0;padding:0;background-color:#0a0a0c;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0c;padding:36px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
        <tr><td align="center" style="padding-bottom:26px;">
          <div style="font-family:Arial,Helvetica,sans-serif;font-weight:800;font-size:19px;letter-spacing:3px;color:#f6f6f9;">INK<span style="color:#7a7e8c;">.</span>STUDIO</div>
        </td></tr>
        <tr><td style="background-color:#111114;border:1px solid #232329;border-radius:18px;padding:42px 36px;" align="center">
          <div style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:28px;color:#ffffff;line-height:1.25;padding-bottom:6px;">${title}</div>
          <div style="width:52px;height:1px;background-color:#3a3d48;margin:16px auto 20px;"></div>
          ${bodyHtml}
        </td></tr>
        <tr><td align="center" style="padding:26px 12px 0;">
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#44454c;line-height:1.8;">
            © 2026 INK.STUDIO — <a href="https://inkhay.com" style="color:#6a6e7e;text-decoration:none;">inkhay.com</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

async function sendResendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) { console.warn('⚠ RESEND_API_KEY absent — email non envoyé'); return; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'INK.STUDIO <noreply@inkhay.com>', to, subject, html }),
  });
  if (!r.ok) console.error('❌ Resend:', (await r.text()).slice(0, 200));
}

async function sendResetEmail(email, token, req) {
  const link = `${baseUrl(req)}/reset-password?token=${encodeURIComponent(token)}`;
  const body = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#b8bac4;line-height:1.75;padding-bottom:8px;">
      Someone (hopefully you) asked to reset the password for this account.<br>This link expires in <span style="color:#ffffff;font-weight:bold;">30 minutes</span> and works once.
    </div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px auto 6px;"><tr>
      <td style="background-color:#ffffff;border-radius:12px;">
        <a href="${link}" style="display:inline-block;padding:15px 38px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#0a0a0e;text-decoration:none;">Reset my password</a>
      </td>
    </tr></table>
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#6a6e7e;padding-top:18px;">Didn't ask for this? You can safely ignore this email — your password stays unchanged.</div>`;
  await sendResendEmail(email, 'Reset your password — INK.STUDIO', emailShell('Reset your password.', body));
}

async function sendWelcomeEmail(email, name, req) {
  const first = (name || '').trim().split(' ')[0] || 'artist';
  const body = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#b8bac4;line-height:1.85;padding-bottom:8px;text-align:left;">
      Welcome, <span style="color:#fff;font-weight:bold;">${first}</span> — your 30 free credits are live. Here's the 3-step ritual:<br><br>
      <span style="color:#cfd2dc;">1.</span>&nbsp; <span style="color:#fff;font-weight:bold;">Describe</span> your tattoo idea in a few words<br>
      <span style="color:#cfd2dc;">2.</span>&nbsp; <span style="color:#fff;font-weight:bold;">Generate</span> a museum-grade design in under a minute<br>
      <span style="color:#cfd2dc;">3.</span>&nbsp; <span style="color:#fff;font-weight:bold;">See it on your skin</span> before you ever commit
    </div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px auto 6px;"><tr>
      <td style="background-color:#ffffff;border-radius:12px;">
        <a href="${baseUrl(req)}/outil.html" style="display:inline-block;padding:15px 38px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#0a0a0e;text-decoration:none;">Create my first design</a>
      </td>
    </tr></table>`;
  await sendResendEmail(email, 'Welcome to the studio — INK.STUDIO', emailShell('Welcome to the studio.', body));
}

// Demande de réinitialisation — réponse TOUJOURS neutre (pas d'énumération de comptes)
app.post('/auth/forgot-password', authLimiter, async (req, res) => {
  const neutral = { ok: true, message: 'If an account exists for this email, a reset link has been sent.' };
  if (!db) return res.json(neutral);
  const email = (req.body && req.body.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.json(neutral);
  try {
    const r = await db.query('SELECT id FROM users WHERE email=$1', [email]);
    if (r.rows[0]) {
      const token = crypto.randomBytes(32).toString('hex');   // 64 hex chars — indevinable
      await db.query(`UPDATE users SET reset_token=$1, reset_expires = now() + interval '30 minutes' WHERE id=$2`, [token, r.rows[0].id]);
      sendResetEmail(email, token, req).catch(e => console.error('❌ sendResetEmail:', e.message));
    }
  } catch (e) { console.error('❌ forgot-password:', e.message); }
  res.json(neutral);   // même réponse que le compte existe ou non
});

// Page de réinitialisation (formulaire, même DA que /verify)
app.get('/reset-password', async (req, res) => {
  const token = (req.query.token || '').toString();
  let valid = false;
  if (db && token) {
    try {
      const r = await db.query('SELECT id FROM users WHERE reset_token=$1 AND reset_expires > now()', [token]);
      valid = !!r.rows[0];
    } catch {}
  }
  if (!valid) return res.status(400).send(verifyResultPage('This reset link is invalid or has expired.', false));
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>INK.STUDIO — New password</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@1,600&family=Inter:wght@400;500&family=Syne:wght@700;800&display=swap" rel="stylesheet">
    <style>
    body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#080808;color:#f6f6f9;font-family:Inter,Arial,sans-serif;text-align:center;padding:24px}
    .logo{font-family:Syne,sans-serif;font-weight:800;letter-spacing:.12em;font-size:.95rem;margin-bottom:34px}.logo span{color:#7a7e8c}
    .box{max-width:420px;width:100%;background:linear-gradient(180deg,#121216,#0c0c10);border:1px solid #232329;border-radius:22px;padding:40px 34px;box-shadow:0 40px 100px rgba(0,0,0,.55)}
    h1{font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-weight:600;font-size:1.6rem;margin:0 0 18px}
    input{width:100%;box-sizing:border-box;background:#0c0c0e;border:1px solid #26262e;border-radius:12px;padding:14px 16px;color:#fff;font-size:.9rem;margin-bottom:12px;outline:none}
    input:focus{border-color:rgba(207,210,220,.45)}
    button{width:100%;padding:14px;border:none;border-radius:13px;background:#fff;color:#0a0a0e;font-family:Syne,sans-serif;font-weight:700;font-size:.78rem;letter-spacing:.06em;text-transform:uppercase;cursor:pointer}
    #msg{font-size:.8rem;margin-top:14px;color:#f87171;min-height:1.2em}
    #msg.ok{color:#34d399}
    </style></head><body>
    <div class="logo">INK<span>.</span>STUDIO</div>
    <div class="box">
      <h1>Choose a new password.</h1>
      <input type="password" id="pw1" placeholder="New password (6+ characters)" autocomplete="new-password">
      <input type="password" id="pw2" placeholder="Confirm new password" autocomplete="new-password">
      <button id="go">Save my new password</button>
      <p id="msg"></p>
    </div>
    <script>
      document.getElementById('go').addEventListener('click', async () => {
        const p1 = document.getElementById('pw1').value, p2 = document.getElementById('pw2').value, msg = document.getElementById('msg');
        msg.className = '';
        if (p1.length < 6) { msg.textContent = 'Password must be at least 6 characters.'; return; }
        if (p1 !== p2)     { msg.textContent = 'Passwords do not match.'; return; }
        try {
          const r = await fetch('/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: ${JSON.stringify(token)}, password: p1 }) });
          const d = await r.json();
          if (r.ok) { msg.className = 'ok'; msg.textContent = 'Password updated — redirecting…'; setTimeout(() => location.href = '/outil.html', 1400); }
          else msg.textContent = d.error || 'This link has expired — request a new one.';
        } catch { msg.textContent = 'Connection error — try again.'; }
      });
    </script></body></html>`);
});

// Application du nouveau mot de passe
app.post('/auth/reset-password', authLimiter, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Service unavailable.' });
  const token    = (req.body && req.body.token || '').toString();
  const password = req.body && req.body.password || '';
  if (!token || password.length < 6) return res.status(400).json({ error: 'Invalid request.' });
  try {
    const r = await db.query('SELECT id, session_version FROM users WHERE reset_token=$1 AND reset_expires > now()', [token]);
    const u = r.rows[0];
    if (!u) return res.status(400).json({ error: 'This link is invalid or has expired.' });
    const hash = await bcrypt.hash(password, 10);
    // Usage unique + invalidation de TOUTES les sessions existantes (version +1)
    await db.query(
      `UPDATE users SET password_hash=$1, reset_token=NULL, reset_expires=NULL, session_version = COALESCE(session_version,0) + 1 WHERE id=$2`,
      [hash, u.id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ reset-password:', e.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/auth/google', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB indisponible' });
  const credential = req.body && req.body.credential;
  if (!credential) return res.status(400).json({ error: 'credential manquant' });
  try {
    // Vérifie le token Google
    const v = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
    const p = await v.json();
    if (!v.ok || !p.email || (p.aud !== GOOGLE_CLIENT_ID)) {
      return res.status(401).json({ error: 'Token Google invalide' });
    }
    // Upsert user
    const r = await db.query(
      `INSERT INTO users (email, google_id, name, avatar_url, credits_remaining, email_verified)
       VALUES ($1,$2,$3,$4,$5,true)
       ON CONFLICT (email) DO UPDATE SET google_id=EXCLUDED.google_id, name=EXCLUDED.name, avatar_url=EXCLUDED.avatar_url, email_verified=true
       RETURNING *`,
      [p.email, p.sub, p.name || p.email.split('@')[0], p.picture || null, PLAN_CREDITS.free]
    );
    const user = r.rows[0];
    setSession(res, user.id, user.session_version);
    res.json({ user: publicUser(user) });
  } catch (e) {
    console.error('❌ /auth/google:', e.message);
    res.status(500).json({ error: 'Auth échouée' });
  }
});

// ── Inscription email + mot de passe ──
const bcrypt = require('bcryptjs');
app.post('/auth/register', registerLimiter, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB indisponible' });
  const email = (req.body && req.body.email || '').trim().toLowerCase();
  const password = req.body && req.body.password || '';
  const name = (req.body && req.body.name || '').trim() || email.split('@')[0];
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'email_invalide' });
  if (password.length < 6) return res.status(400).json({ error: 'mdp_trop_court' });
  try {
    const existing = await db.query('SELECT id, password_hash, google_id FROM users WHERE email=$1', [email]);
    if (existing.rows[0]) {
      if (existing.rows[0].password_hash) return res.status(409).json({ error: 'compte_existant' });
      // Compte créé via Google → on attache un mot de passe
      const hash = await bcrypt.hash(password, 10);
      const r = await db.query('UPDATE users SET password_hash=$1, name=COALESCE(name,$2) WHERE id=$3 RETURNING *', [hash, name, existing.rows[0].id]);
      setSession(res, r.rows[0].id, r.rows[0].session_version);
      return res.json({ user: publicUser(r.rows[0]) });
    }
    const hash = await bcrypt.hash(password, 10);
    const token = newVerifyToken();
    // Non vérifié + 0 crédit : les 30 crédits gratuits ne sont débloqués qu'après confirmation de l'email
    const r = await db.query(
      `INSERT INTO users (email, name, password_hash, credits_remaining, email_verified, verify_token) VALUES ($1,$2,$3,0,false,$4) RETURNING *`,
      [email, name, hash, token]
    );
    setSession(res, r.rows[0].id, r.rows[0].session_version);
    sendVerificationEmail(email, token, req);   // async, ne bloque pas la réponse
    res.json({ user: publicUser(r.rows[0]) });
  } catch (e) {
    console.error('❌ /auth/register:', e.message);
    res.status(500).json({ error: 'Inscription échouée' });
  }
});

// ── Connexion email + mot de passe ──
app.post('/auth/login', authLimiter, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'DB indisponible' });
  const email = (req.body && req.body.email || '').trim().toLowerCase();
  const password = req.body && req.body.password || '';
  if (!email || !password) return res.status(400).json({ error: 'champs_manquants' });
  try {
    const r = await db.query('SELECT * FROM users WHERE email=$1', [email]);
    const user = r.rows[0];
    if (!user || !user.password_hash) {
      // Pas de compte email (ou compte Google sans mot de passe)
      return res.status(401).json({ error: user ? 'utilise_google' : 'compte_introuvable' });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'mdp_incorrect' });
    setSession(res, user.id, user.session_version);
    res.json({ user: publicUser(user) });
  } catch (e) {
    console.error('❌ /auth/login:', e.message);
    res.status(500).json({ error: 'Connexion échouée' });
  }
});

// Profil de l'utilisateur connecté
app.get('/me', async (req, res) => {
  let u = await getSessionUser(req);
  if (!u) return res.status(401).json({ error: 'non connecté' });
  u = await applyMonthlyReset(u);
  res.json({ user: publicUser(u) });
});

// Déconnexion
app.post('/auth/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

// ═══════════════════════════════════════════════════
// STRIPE — abonnements (Checkout + Portail client + Webhook)
// Variables d'env requises (Railway) :
//   STRIPE_SECRET_KEY      sk_test_... puis sk_live_...
//   STRIPE_WEBHOOK_SECRET  whsec_...
//   STRIPE_PRICE_PRO       price_...  (14,99€/mois)
//   STRIPE_PRICE_STUDIO    price_...  (39,99€/mois)
//   PUBLIC_URL             https://ton-domaine (sinon déduit de la requête)
// ═══════════════════════════════════════════════════
let stripe = null;
// Préfère la clé LIVE si présente, sinon retombe sur la clé de test.
const STRIPE_KEY = process.env.STRIPE_LIVE_KEY || process.env.STRIPE_SECRET_KEY;
if (STRIPE_KEY) {
  try { stripe = require('stripe')(STRIPE_KEY); console.log('✓ Stripe activé (' + (STRIPE_KEY.includes('live') ? 'LIVE' : 'TEST') + ')'); }
  catch (e) { console.warn('⚠ Stripe init failed:', e.message); }
} else {
  console.warn('⚠ Clé Stripe absente — paiements désactivés');
}

// Abonnements : plan → { mensuel, annuel } (Price IDs Stripe — TEST). En LIVE, recréer et remplacer.
const STRIPE_PRICES = {
  starter:    { monthly: 'price_1TmzeTKzwO283mgwFG9fdixk', annual: 'price_1TmzeUKzwO283mgwnT79B03n' },
  pro:        { monthly: 'price_1TmzeUKzwO283mgw9LkBc1y9', annual: 'price_1TmzeVKzwO283mgw34538nY5' },
  studio:     { monthly: 'price_1TmzeVKzwO283mgwU9JtaHQB', annual: 'price_1TmzeWKzwO283mgwyhctx8pI' },
  studioplus: { monthly: 'price_1TmzeWKzwO283mgwTSNEjlVJ', annual: 'price_1TmzeXKzwO283mgwzxE72IQU' },
  atelier:    { monthly: 'price_1TmzeXKzwO283mgwfi3eMxtA', annual: 'price_1TmzeYKzwO283mgwk5csgrdo' },
};
// Packs de crédits (paiement unique) : clé → { price, crédits }
const PACK_PRICES = {
  mini:     { price: 'price_1TmzeYKzwO283mgwlal3EFAf', credits: 50 },
  standard: { price: 'price_1TmzeZKzwO283mgwUA9pRiLA', credits: 150 },
  maxi:     { price: 'price_1TmzeZKzwO283mgwjkTQ1P7m', credits: 500 },
};
// Price ID → nom de plan (webhook abonnements)
const PRICE_TO_PLAN = {};
for (const [plan, pr] of Object.entries(STRIPE_PRICES)) { PRICE_TO_PLAN[pr.monthly] = plan; PRICE_TO_PLAN[pr.annual] = plan; }
// Price ID → crédits (webhook packs)
const PRICE_TO_PACK_CREDITS = {};
for (const p of Object.values(PACK_PRICES)) PRICE_TO_PACK_CREDITS[p.price] = p.credits;

// Ajoute des crédits (achat de pack) sans changer le plan
async function addCredits(userId, amount) {
  if (!amount || !db) return;
  await db.query('UPDATE users SET credits_remaining = credits_remaining + $1 WHERE id=$2', [amount, userId]);
  console.log(`✓ +${amount} crédits → user #${userId} (pack)`);
}

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return `${proto}://${req.headers.host}`;
}

// Récupère (ou crée) le client Stripe lié à l'utilisateur
async function getOrCreateCustomer(user) {
  if (user.stripe_customer_id) {
    // Vérifie que le customer existe bien dans le MODE courant (test/live).
    // Un customer créé en TEST n'existe pas en LIVE → on en recrée un.
    try {
      const c = await stripe.customers.retrieve(user.stripe_customer_id);
      if (c && !c.deleted) return user.stripe_customer_id;
    } catch (e) {
      console.warn('⚠ customer Stripe introuvable (' + user.stripe_customer_id + '), recréation:', e.message);
    }
  }
  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name || undefined,
    metadata: { user_id: String(user.id) },
  });
  await db.query('UPDATE users SET stripe_customer_id=$1 WHERE id=$2', [customer.id, user.id]);
  return customer.id;
}

// Applique un plan à un utilisateur + recharge ses crédits
async function setUserPlan(userId, plan) {
  const cur = await db.query('SELECT plan FROM users WHERE id=$1', [userId]);
  if (!cur.rows[0]) return;
  const oldPlan = cur.rows[0].plan;
  // IDEMPOTENT : si le plan ne change pas (webhook/sync répétés), on ne retouche PAS les crédits.
  if (oldPlan === plan) return;
  if (plan === 'free') {
    // Annulation/retour free : on garde le solde de crédits déjà acquis (rien n'est perdu).
    await db.query(`UPDATE users SET plan='free' WHERE id=$1`, [userId]);
    console.log(`✓ Plan utilisateur #${userId} → free (crédits conservés)`);
  } else {
    // Souscription / upgrade : on AJOUTE les crédits du plan au solde existant (jamais perdus).
    const credits = PLAN_CREDITS[plan] || 0;
    await db.query(
      `UPDATE users SET plan=$1, credits_remaining = credits_remaining + $2, credits_reset_at = now() + interval '30 days' WHERE id=$3`,
      [plan, credits, userId]
    );
    console.log(`✓ Plan utilisateur #${userId} → ${plan} (+${credits} crédits, solde cumulé)`);
  }
}

// ── Créer une session de paiement (abonnement) ──
app.post('/create-checkout-session', async (req, res) => {
  if (!stripe || !db) return res.status(404).json({ error: 'paiement_indisponible' });
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'non_connecté' });

  const plan   = (req.body && req.body.plan   || '').trim();
  const pack   = (req.body && req.body.pack   || '').trim();
  const period = (req.body && req.body.period) === 'annual' ? 'annual' : 'monthly';

  try {
    const customerId = await getOrCreateCustomer(user);
    let session;
    if (pack) {
      // ── Pack de crédits : paiement unique ──
      const pk = PACK_PRICES[pack];
      if (!pk) return res.status(400).json({ error: 'plan_invalide' });
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: customerId,
        line_items: [{ price: pk.price, quantity: 1 }],
        allow_promotion_codes: true,
        client_reference_id: String(user.id),
        metadata: { user_id: String(user.id), pack, credits: String(pk.credits) },
        success_url: `${baseUrl(req)}/compte.html?pack=success`,
        cancel_url: `${baseUrl(req)}/pricing.html?checkout=cancel`,
      });
    } else {
      // ── Abonnement : mensuel ou annuel ──
      const priceId = STRIPE_PRICES[plan] && STRIPE_PRICES[plan][period];
      if (!priceId) return res.status(400).json({ error: 'plan_invalide' });
      session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        allow_promotion_codes: true,
        client_reference_id: String(user.id),
        metadata: { user_id: String(user.id), plan, period },
        success_url: `${baseUrl(req)}/compte.html?checkout=success`,
        cancel_url: `${baseUrl(req)}/pricing.html?checkout=cancel`,
      });
    }
    res.json({ url: session.url });
  } catch (e) {
    console.error('❌ create-checkout-session:', e.message);
    res.status(500).json({ error: 'stripe_error' });
  }
});

// ── Ouvrir le portail client (gérer/annuler l'abonnement) ──
app.post('/create-portal-session', async (req, res) => {
  if (!stripe || !db) return res.status(404).json({ error: 'paiement_indisponible' });
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'non_connecté' });
  if (!user.stripe_customer_id) return res.status(400).json({ error: 'pas_de_client' });
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${baseUrl(req)}/compte.html`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('❌ create-portal-session:', e.message);
    res.status(500).json({ error: 'stripe_error' });
  }
});

// ── ADMIN (owner uniquement) : créer un code promo Stripe ──
// Usage : /admin/create-promo?code=SARA20&percent=20&duration=once   (duration: once | forever)
// Pratique pour créer un code par influenceur sans ouvrir le dashboard Stripe.
app.get('/admin/create-promo', async (req, res) => {
  if (!stripe || !db) return res.status(503).json({ error: 'stripe_indisponible' });
  const user = await getSessionUser(req);
  if (!user || user.email !== OWNER_EMAIL) return res.status(403).json({ error: 'forbidden' });
  const code     = (req.query.code || '').toString().trim().toUpperCase();
  const percent  = parseInt(req.query.percent || '0', 10);
  const duration = (req.query.duration || 'once').toString() === 'forever' ? 'forever' : 'once';
  if (!/^[A-Z0-9]{3,20}$/.test(code)) return res.status(400).json({ error: 'code invalide (3-20 lettres/chiffres, ex: SARA20)' });
  if (!(percent >= 1 && percent <= 90))  return res.status(400).json({ error: 'percent invalide (1-90)' });
  try {
    const coupon = await stripe.coupons.create({ percent_off: percent, duration, name: `${code} (-${percent}%)` });
    const promo  = await stripe.promotionCodes.create({ coupon: coupon.id, code });
    res.json({ ok: true, code: promo.code, percent, duration, message: `Code ${promo.code} actif — les clients peuvent le taper au paiement.` });
  } catch (e) {
    console.error('❌ create-promo:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Synchronisation de l'abonnement (fallback fiable, ne dépend pas du webhook) ──
// Interroge Stripe directement et applique le plan correspondant à l'abonnement actif.
app.post('/sync-subscription', async (req, res) => {
  if (!stripe || !db) return res.status(404).json({ error: 'paiement_indisponible' });
  let user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'non_connecté' });
  if (!user.stripe_customer_id) return res.json({ plan: user.plan, changed: false, user: publicUser(user) });
  try {
    const subs = await stripe.subscriptions.list({ customer: user.stripe_customer_id, status: 'active', limit: 1 });
    const sub = subs.data[0];
    let targetPlan = 'free';
    if (sub) {
      const priceId = sub.items.data[0] && sub.items.data[0].price.id;
      targetPlan = PRICE_TO_PLAN[priceId] || user.plan;
    }
    const changed = targetPlan !== user.plan;
    if (changed) await setUserPlan(user.id, targetPlan);
    user = await getSessionUser(req);
    res.json({ plan: user.plan, changed, user: publicUser(user) });
  } catch (e) {
    console.error('❌ sync-subscription:', e.message);
    res.status(500).json({ error: 'stripe_error' });
  }
});

// ── Webhook Stripe (body brut requis) ──
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).send('stripe disabled');
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = secret
      ? stripe.webhooks.constructEvent(req.body, sig, secret)
      : JSON.parse(req.body.toString());   // dev sans secret (non sécurisé)
  } catch (e) {
    console.error('❌ webhook signature:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const userId = s.metadata && s.metadata.user_id || s.client_reference_id;
        // ── Pack de crédits (paiement unique) → ajoute les crédits, ne change pas le plan ──
        if (s.mode === 'payment') {
          let credits = s.metadata && parseInt(s.metadata.credits);
          if (!credits) {                       // sécurité : retrouve via le price acheté
            const items = await stripe.checkout.sessions.listLineItems(s.id, { limit: 1 });
            const priceId = items.data[0] && items.data[0].price.id;
            credits = PRICE_TO_PACK_CREDITS[priceId];
          }
          if (userId && credits) await addCredits(Number(userId), credits);
          break;
        }
        // ── Abonnement → applique le plan ──
        let plan = s.metadata && s.metadata.plan;
        if (s.subscription) {                   // sécurité : reconfirme via le price de l'abonnement
          const sub = await stripe.subscriptions.retrieve(s.subscription);
          const priceId = sub.items.data[0] && sub.items.data[0].price.id;
          if (PRICE_TO_PLAN[priceId]) plan = PRICE_TO_PLAN[priceId];
        }
        if (userId && plan) await setUserPlan(Number(userId), plan);
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const priceId = sub.items.data[0] && sub.items.data[0].price.id;
        const plan = PRICE_TO_PLAN[priceId];
        const r = await db.query('SELECT id FROM users WHERE stripe_customer_id=$1', [sub.customer]);
        if (r.rows[0]) {
          if (sub.status === 'active' && plan) await setUserPlan(r.rows[0].id, plan);
          else if (['canceled', 'unpaid', 'past_due'].includes(sub.status)) await setUserPlan(r.rows[0].id, 'free');
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const r = await db.query('SELECT id FROM users WHERE stripe_customer_id=$1', [sub.customer]);
        if (r.rows[0]) await setUserPlan(r.rows[0].id, 'free');
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (e) {
    console.error('❌ webhook handler:', e.message);
    res.status(500).send('handler error');
  }
});

// Images générées (volume persistant)
app.use('/gens', express.static(GENS_DIR));

// Historique de l'utilisateur connecté
app.get('/projects', async (req, res) => {
  const u = await getSessionUser(req);
  if (!u) return res.status(401).json({ error: 'non connecté' });
  try {
    const r = await db.query(
      `SELECT id, type, image_url, params, created_at FROM generations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 60`,
      [u.id]
    );
    res.json({ projects: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Suppression d'un projet
app.delete('/projects/:id', async (req, res) => {
  const u = await getSessionUser(req);
  if (!u) return res.status(401).json({ error: 'non connecté' });
  try {
    await db.query('DELETE FROM generations WHERE id=$1 AND user_id=$2', [req.params.id, u.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Diagnostic base de données (temporaire)
app.get('/db-health', async (req, res) => {
  if (!db) return res.json({ connected: false, reason: 'DATABASE_URL non défini' });
  try {
    const t = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('users','generations') ORDER BY table_name`);
    const u = await db.query('SELECT count(*)::int AS n FROM users');
    res.json({ connected: true, tables: t.rows.map(r => r.table_name), users: u.rows[0].n });
  } catch (e) {
    res.json({ connected: false, reason: e.message });
  }
});

// ── Download proxy (cross-origin image download) ──
app.get('/download', downloadLimiter, async (req, res) => {
  const { url, filename = 'ink-studio.jpg' } = req.query;
  if (!url) return res.status(400).send('Invalid URL');

  // Same-origin saved images (/gens/xxx.png) → stream directly from disk.
  if (url.startsWith('/gens/')) {
    const safe = path.basename(url.split('?')[0]);            // évite la traversée de répertoire
    const filePath = path.join(GENS_DIR, safe);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    const buf = fs.readFileSync(filePath);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', buf.length);
    return res.send(buf);
  }

  // data: URLs (génération non sauvegardée) → décodage base64.
  if (url.startsWith('data:')) {
    const m = url.match(/^data:(.+?);base64,(.*)$/);
    if (!m) return res.status(400).send('Invalid data URL');
    const buf = Buffer.from(m[2], 'base64');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', m[1] || 'image/png');
    res.setHeader('Content-Length', buf.length);
    return res.send(buf);
  }

  if (isBlockedUrl(url)) return res.status(400).send('Invalid URL');   // anti-SSRF (bloque interne/privé)
  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(502).send('Failed to fetch image');
    const buffer = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (e) {
    console.error('❌ /download :', e.message);
    res.status(500).send('Download error');
  }
});


// ─────────────────────────────────────────────────
// POST /generate — ÉTAPE 1 : génération du design
// Body  : sujet, style, ambiance, mot, elements, zone
// File  : inspiration (optionnel)
// Retour: { imageUrl, jobId, prompt, zone }
// ─────────────────────────────────────────────────
app.post('/generate', genLimiter, upload.array('inspiration', 4), async (req, res) => {
  const sujet      = (req.body.sujet    || req.body.description || '').trim();
  const style      = (req.body.style    || 'concept').trim();
  const ambiance   = (req.body.ambiance || 'epique').trim();
  const mot        = (req.body.mot      || '').trim();
  const elements   = (req.body.elements || '').trim();
  const zone       = (req.body.zone     || '').trim();
  const freePrompt = req.body.freePrompt === '1';
  const inspFiles  = req.files || [];   // jusqu'à 4 photos de référence

  if (!sujet) {
    inspFiles.forEach(f => { try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {} });
    return res.status(400).json({ error: 'Please describe your tattoo first.' });
  }

  // Free prompt: use the user's text directly, just add technical requirements
  const prompt = freePrompt
    ? `${sujet}. ${TECHNICAL_REQUIREMENTS}`
    : buildPrompt({ sujet, style, ambiance, mot, elements, zone, withReference: inspFiles.length > 0 });
  const inspPaths = [];   // chemins .jpg des références
  let gate = null;

  try {
    console.log('\n🎨 Nouvelle génération');
    console.log('   Sujet   :', sujet);
    console.log('   Style   :', style, '/ Ambiance :', ambiance);
    console.log('   Refs    :', inspFiles.length);

    for (const f of inspFiles) {
      const p = f.path + '.jpg';
      fs.renameSync(f.path, p);
      inspPaths.push(p);
    }

    // ── Crédits : réservation atomique AVANT génération (anti double-génération) ──
    gate = await checkCredits(req, res, 'design');
    if (!gate) return;
    const sessionUser = gate.user;

    let imageUrl, jobId = null, finalPrompt = prompt;

    if (process.env.OPENAI_API_KEY) {
      // ── Génération via OpenAI gpt-image-1 (rapide & stable) ──
      console.log('   Moteur  : OpenAI gpt-image-1');
      // Format : zone si fournie, sinon format par défaut du style
      const size = zone ? openAISizeForZone(zone) : sizeForFormat(getStyle(style).defaultFormat);
      // Choix d'encre explicite du client (chips du hub) : bw | color | redaccent.
      // Absent → comportement historique (N&B sauf demande couleur dans le texte / style couleur).
      const ink = ['bw', 'color', 'redaccent'].includes(req.body.ink) ? req.body.ink : null;
      const bw  = ink ? (ink === 'bw') : (!wantsColor(sujet) && !getStyle(style).colorByDefault);

      // Construction du prompt final.
      const styleObj = getStyle(style);
      let openaiPrompt;
      if (!freePrompt && styleObj.template) {
        // MODE TEMPLATE : prompt figé validé + injection du sujet uniquement (zéro dilution).
        const subj = (await enhanceSubject(sujet, { ambiance, zone })) || sujet;
        openaiPrompt = styleObj.template.replace(/\$\{SUBJECT\}/g, subj);
        console.log('   🏛️ Template style', style, '| sujet:', subj);
      } else if (!freePrompt) {
        // MODE ENRICHI : réécriture dans le style choisi.
        const enhanced = await enhancePrompt(sujet, style, { ambiance, zone });
        const designPrompt = enhanced || prompt;
        if (enhanced) console.log('   ✨ Prompt enrichi (style', style + ')');
        openaiPrompt = buildRenderWrapper(designPrompt, { bw });
      } else {
        // FREE PROMPT : texte brut de l'utilisateur.
        openaiPrompt = buildRenderWrapper(prompt, { bw });
      }

      // ── Directive d'encre explicite (ajoutée en fin de prompt, ne touche pas au défaut N&B) ──
      if (ink === 'color') {
        openaiPrompt += ' Render the tattoo in FULL COLOR: a rich, professional tattoo color palette with saturated pigments and clean color blending. Keep the background pure white.';
      } else if (ink === 'redaccent') {
        openaiPrompt += ' Render the tattoo strictly in black and grey with SELECTIVE DEEP CRIMSON RED ACCENTS on a few key elements only — no other colors. Keep the background pure white.';
      }

      // ── Log du PROMPT FINAL EXACT envoyé à gpt-image-1 (audit / debug) ──
      finalPrompt = openaiPrompt;
      console.log('   📐 Taille :', size, '| N&B :', bw);
      console.log('   ──────── PROMPT FINAL → gpt-image-1 ────────');
      console.log(openaiPrompt);
      console.log('   ─────────────────────────────────────────────');

      // Génération unique. Plusieurs références → édition multi-images ; sinon génération texte.
      let img = inspPaths.length
        ? await openAIEditMulti(openaiPrompt, inspPaths, size)
        : await generateWithOpenAI(openaiPrompt, null, size);
      imageUrl = await finishImage(img, { grayscale: bw });
      imageUrl = await brandIfFree(gate, imageUrl);
      console.log(bw ? '   ⚫ Rendu N&B' : '   🎨 Rendu couleur');
    } else {
      // Pas de clé OpenAI configurée → service indisponible (plus de fallback Higgsfield)
      throw new Error('The generation service is temporarily unavailable.');
    }

    // Crédits déjà réservés (atomique) ; on sauvegarde l'historique après succès
    const creditsLeft = await chargeAfter(gate);
    let savedUrl = null;
    if (db && sessionUser) {
      savedUrl = await saveGeneration(sessionUser.id, 'design', imageUrl, { sujet, style, ambiance, zone, ink: req.body.ink || 'bw', finalPrompt });
    }
    // Retourner l'URL /gens/ sauvegardée si dispo (évite d'envoyer une data URL géante au front)
    const responseUrl = savedUrl || imageUrl;

    res.json({ imageUrl: responseUrl, jobId, prompt, zone, credits: creditsLeft, finalPrompt });

  } catch (err) {
    await refundCredits(gate);
    console.error('❌ /generate :', err.message);
    res.status(500).json({ error: clientError(err) });
  } finally {
    inspPaths.forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {} });
  }
});

// ─────────────────────────────────────────────────
// POST /generate-on-body — ÉTAPE 2 : pose sur le corps
// Body  : designUrl (URL de l'image générée), zone, model (opt.)
// File  : photo
// Retour: { imageUrl, jobId, model }
// ─────────────────────────────────────────────────
app.post('/generate-on-body', genLimiter, upload.single('photo'), async (req, res) => {
  // designUrl = URL de l'image du design (retournée par /generate)
  const designUrl = (req.body.designUrl || '').trim();
  const zone      = (req.body.zone      || '').trim();
  const modelKey  = BODY_MODELS[req.body.model] ? req.body.model : DEFAULT_BODY_MODEL;

  if (!req.file)    return res.status(400).json({ error: 'No photo received.' });
  if (!designUrl)   return res.status(400).json({ error: 'Missing design URL. Generate a design first.' });
  if (!ZONE_PROMPTS[zone]) return res.status(400).json({ error: 'Invalid body zone.' });

  const photoPath = req.file.path + '.jpg';
  fs.renameSync(req.file.path, photoPath);

  let gate = null;
  try {
    gate = await checkCredits(req, res, 'body');
    if (!gate) return;
    console.log('\n📸 Rendu sur le corps — étape 2');
    console.log('   Zone   :', zone);
    console.log('   Modèle :', modelKey);

    const ZONE_BODYPART = {
      'avant-bras': 'forearm', 'bras-complet': 'arm', 'epaule': 'shoulder',
      'dos': 'back', 'pectoral': 'chest', 'cuisse': 'thigh', 'mollet': 'calf', 'main': 'hand',
    };
    const bodyPart = ZONE_BODYPART[zone] || 'body';

    // Prompt officiel utilisateur (préservation pixel-identique de la photo), rendu adaptable à la zone.
    // IMAGE 1 = photo du corps, IMAGE 2 = design.
    const prompt =
      `You are given two images: IMAGE 1 is a real photograph of a person, IMAGE 2 is a tattoo design on a white background. ` +
      `Edit only the ${bodyPart} skin area of IMAGE 1. Preserve the original photograph exactly as it is. ` +
      `Do not modify the person's pose, anatomy, lighting, colors, clothing, background, camera angle, or image composition. ` +
      `Apply the provided tattoo design from IMAGE 2 exactly as given, without redesigning or simplifying it. ` +
      `Warp the tattoo naturally to match the curvature of the ${bodyPart}, adjust opacity and skin texture realistically, and blend it as if it were a real healed black-and-grey tattoo. ` +
      `Keep the tattoo entirely on bare skin — never on clothing, fabric or background. ` +
      `The rest of the image must remain pixel-identical to the original photograph.`;

    // Récupère les octets du design (data URL OpenAI ou http) dans un fichier temporaire
    let designPath;
    if (designUrl.startsWith('data:')) {
      const designBuf = Buffer.from(designUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      designPath = path.join(os.tmpdir(), `design-${Date.now()}.png`);
      fs.writeFileSync(designPath, designBuf);
    } else {
      const dlRes = await fetch(designUrl);
      if (!dlRes.ok) throw new Error('Impossible de récupérer le design: ' + dlRes.status);
      const designBuf = Buffer.from(await dlRes.arrayBuffer());
      designPath = path.join(os.tmpdir(), `design-${Date.now()}.png`);
      fs.writeFileSync(designPath, designBuf);
    }

    console.log('   Moteur : OpenAI (edit photo + design)');
    let imageUrl;
    try {
      imageUrl = await openAIEditMulti(prompt, [photoPath, designPath], 'auto');
    } finally {
      if (designPath && fs.existsSync(designPath)) fs.unlinkSync(designPath);
    }
    imageUrl = await brandIfFree(gate, imageUrl);

    const credits = await chargeAfter(gate);
    try {
      if (gate.user) await saveGeneration(gate.user.id, 'on-body', imageUrl, { zone, model: 'gpt-image-1' });
    } catch {}

    res.json({ imageUrl, jobId: null, model: 'gpt-image-1', credits });

  } catch (err) {
    await refundCredits(gate);
    console.error('❌ /generate-on-body :', err.message);
    res.status(500).json({ error: clientError(err) });
  } finally {
    if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
  }
});

// ─────────────────────────────────────────────────
// POST /place-uploaded-design — PARCOURS 2
// Files : design (image uploadée) + photo
// Body  : zone
// Retour: { imageUrl }
// ─────────────────────────────────────────────────
app.post('/place-uploaded-design', upload.fields([
  { name: 'design', maxCount: 1 },
  { name: 'photo',  maxCount: 1 },
]), async (req, res) => {
  const zone = (req.body.zone || '').trim();

  if (!req.files?.design?.[0]) return res.status(400).json({ error: 'No design received.' });
  if (!req.files?.photo?.[0])  return res.status(400).json({ error: 'No photo received.' });
  if (!ZONE_PROMPTS[zone])     return res.status(400).json({ error: 'Invalid body zone.' });

  const designPath = req.files.design[0].path + '.jpg';
  const photoPath  = req.files.photo[0].path  + '.jpg';
  fs.renameSync(req.files.design[0].path, designPath);
  fs.renameSync(req.files.photo[0].path,  photoPath);

  let gate = null;
  try {
    gate = await checkCredits(req, res, 'place');
    if (!gate) return;
    console.log('\n🎨 Design uploadé — parcours 2');
    console.log('   Zone :', zone);

    const prompt =
      `Two images are provided: image 1 is a body photo, image 2 is a tattoo design on white background. ` +
      `Apply the tattoo design from image 2 onto the skin in image 1. ` +
      `${ZONE_PROMPTS[zone]} ` +
      `CRITICAL: preserve the EXACT same framing, crop, zoom level, angle, perspective, and composition as image 1 — do NOT zoom in, do NOT reframe, do NOT change the camera distance. ` +
      `The output image must have the identical framing as the input photo. ` +
      `The tattoo ink must follow the skin's natural texture, lighting, highlights and shadows from the photo. ` +
      `Photorealistic tattoo result, looks like a real tattoo on real skin, professional tattoo artist quality. ` +
      `Keep every detail of the background, clothing, and surroundings completely unchanged.`;

    // OpenAI en direct : photo du corps + design uploadé.
    console.log('   Moteur : OpenAI (edit photo + design uploadé)');
    const imageUrl = await brandIfFree(gate, await openAIEditMulti(prompt, [photoPath, designPath], 'auto'));

    const credits = await chargeAfter(gate);
    try {
      if (gate.user) await saveGeneration(gate.user.id, 'on-body', imageUrl, { zone, model: 'gpt-image-1' });
    } catch {}

    res.json({ imageUrl, credits });

  } catch (err) {
    await refundCredits(gate);
    console.error('❌ /place-uploaded-design :', err.message);
    res.status(500).json({ error: clientError(err) });
  } finally {
    if (fs.existsSync(designPath)) fs.unlinkSync(designPath);
    if (fs.existsSync(photoPath))  fs.unlinkSync(photoPath);
  }
});

// ─────────────────────────────────────────────────
// POST /generate-pet-tattoo — Mode animal
// File  : photo (photo de l'animal)
// Body  : style, details (texte libre), zone (optionnel)
// Retour: { imageUrl }
// ─────────────────────────────────────────────────
app.post('/generate-pet-tattoo', genLimiter, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo received.' });

  const style   = (req.body.style   || 'realism').trim();
  const details = (req.body.details || '').trim();
  const zone    = (req.body.zone    || '').trim();

  const photoPath = req.file.path + '.jpg';
  fs.renameSync(req.file.path, photoPath);

  const stylePrompts = {
    realism:    'photorealistic black and grey realism tattoo, ultra-detailed fur and eyes, deep contrast, fine lines',
    fineline:   'fine line tattoo, delicate single-needle style, minimal shading, elegant linework',
    geometric:  'geometric tattoo design, dotwork and sacred geometry patterns integrated with the animal portrait',
    watercolor: 'watercolor tattoo style, soft ink washes, painterly strokes, vibrant but controlled color bleeding',
    traditional:'bold traditional tattoo style, thick black outlines, solid fills, classic flash art aesthetic',
  };
  const styleDesc = stylePrompts[style] || stylePrompts.realism;

  const prompt =
    `Create a professional tattoo design inspired by the subject in the photo. ` +
    `Style: ${styleDesc}. ` +
    `Capture the most distinctive and recognizable features of the subject — whether it's an animal, person, landscape, or object. ` +
    (details ? `Additional details to include: ${details}. ` : '') +
    `White background, tattoo flash art composition, ready to tattoo. ` +
    `High resolution, professional tattoo artist quality.`;

  let gate = null;
  try {
    gate = await checkCredits(req, res, 'pet');
    if (!gate) return;
    console.log('\n🐾 Pet tattoo generation');
    console.log('   Style   :', style);
    console.log('   Details :', details || 'none');

    // edit : design de tatouage inspiré de la photo, fond blanc
    const petPrompt =
      `${prompt} Flat 2D tattoo flash design isolated on a pure solid white background (#FFFFFF), ` +
      `no photographic scene, no dark background. Centered, full design visible, clean crisp linework.`;
    const imageUrl = await brandIfFree(gate, await openAIEditMulti(petPrompt, [photoPath], '1024x1024'));

    const credits = await chargeAfter(gate);
    try {
      if (gate.user) await saveGeneration(gate.user.id, 'pet', imageUrl, { style, details, zone });
    } catch {}

    res.json({ imageUrl, zone, credits });

  } catch (err) {
    await refundCredits(gate);
    console.error('❌ /generate-pet-tattoo :', err.message);
    res.status(500).json({ error: clientError(err) });
  } finally {
    if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
  }
});

// ─────────────────────────────────────────────────
// POST /stencil — Outil Stencil via gpt-image-1 (photo → stencil Spirit violet)
// File  : image
// Retour: { imageUrl }
// ─────────────────────────────────────────────────
app.post('/stencil', genLimiter, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image received.' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY non configurée.' });

  const imgPath = req.file.path + '.png';
  fs.renameSync(req.file.path, imgPath);

  let gate = null;
  try {
    gate = await checkCredits(req, res, 'stencil');
    if (!gate) return;
    console.log('\n🖊 Stencil via OpenAI');
    const imageUrl = await brandIfFree(gate, await openAIEditMulti(STENCIL_PROMPT, [imgPath], 'auto'));
    const credits = await chargeAfter(gate);
    try {
      if (gate.user) await saveGeneration(gate.user.id, 'stencil', imageUrl, {});
    } catch {}
    res.json({ imageUrl, credits });
  } catch (err) {
    await refundCredits(gate);
    console.error('❌ /stencil :', err.message);
    res.status(500).json({ error: clientError(err) });
  } finally {
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }
});

// ─────────────────────────────────────────────────
// POST /merge-tattoos — Mode 4 : fusionner plusieurs designs
// Files : design0, design1, design2, design3 (2–4 images)
// Body  : style, details, count
// Retour: { imageUrl }
// ─────────────────────────────────────────────────
app.post('/merge-tattoos', genLimiter, upload.fields([
  { name: 'design0', maxCount: 1 },
  { name: 'design1', maxCount: 1 },
  { name: 'design2', maxCount: 1 },
  { name: 'design3', maxCount: 1 },
]), async (req, res) => {
  const count  = parseInt(req.body.count || '2');
  const style  = (req.body.style   || 'seamless').trim();
  const details= (req.body.details || '').trim();

  const tmpFiles = [];
  const base64Images = [];

  for (let i = 0; i < count; i++) {
    const key = `design${i}`;
    if (!req.files[key] || !req.files[key][0]) continue;
    const f = req.files[key][0];
    const p = f.path + '.jpg';
    fs.renameSync(f.path, p);
    tmpFiles.push(p);
    base64Images.push(fileToBase64(p));
  }

  if (base64Images.length < 2) {
    tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
    return res.status(400).json({ error: 'Please upload at least 2 designs.' });
  }

  const stylePrompts = {
    seamless:    'seamlessly blended into one cohesive tattoo composition, unified style and flow, harmonious design',
    collage:     'artistic collage tattoo, each element distinct but visually connected through shared space and linework',
    blackgrey:   'unified black and grey tattoo, smooth gradients, fine shading, all elements merged in monochromatic style',
    fineline:    'fine line tattoo fusion, delicate single-needle linework connecting all elements into one elegant composition',
    traditional: 'bold traditional tattoo style, thick outlines, all designs merged with classic flash art aesthetic',
  };
  const styleDesc = stylePrompts[style] || stylePrompts.seamless;

  // Prompt court & concret : gpt-image-2 raisonne moins → plus rapide + fusion plus nette.
  const prompt =
    `Combine these ${base64Images.length} tattoo designs into ONE unified ${styleDesc} tattoo. ` +
    `Keep the single most recognizable element from each design. ` +
    (details ? `${details}. ` : '');

  let gate = null;
  try {
    gate = await checkCredits(req, res, 'merge');
    if (!gate) return;
    console.log(`\n⚡ Merge tattoos — ${tmpFiles.length} designs, style: ${style}`);

    const mergePrompt =
      `${prompt} Flat 2D tattoo flash design on a pure solid white background (#FFFFFF), ` +
      `no photographic scene, no dark background, centered, clean crisp linework.`;
    // 'medium' = bon équilibre qualité/vitesse pour la fusion multi-images (le bug du spinner était côté front, corrigé).
    console.time('merge-openai');
    const imageUrl = await brandIfFree(gate, await openAIEditMulti(mergePrompt, tmpFiles, 'auto', 'medium', 180_000));
    console.timeEnd('merge-openai');

    const credits = await chargeAfter(gate);
    try {
      if (gate.user) await saveGeneration(gate.user.id, 'merge', imageUrl, { style, details, count: base64Images.length });
    } catch {}

    res.json({ imageUrl, credits });
  } catch (err) {
    await refundCredits(gate);
    console.error('❌ /merge-tattoos :', err.message);
    res.status(500).json({ error: clientError(err) });
  } finally {
    tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  }
});

// ─────────────────────────────────────────────────
// POST /lettering — Lettering Studio (prénoms, dates, citations)
// Body : text, font, details (opt.)
// Retour: { imageUrl, credits }
// ─────────────────────────────────────────────────
const LETTERING_FONTS = {
  finescript: 'elegant fine-line cursive script, single-needle delicate flowing calligraphy, thin graceful strokes with subtle flourishes',
  gothic:     'bold gothic blackletter lettering, dramatic angular fraktur style, strong dark strokes, medieval calligraphy',
  chicano:    'smooth chicano script lettering, west-coast style flowing cursive with confident thick-and-thin shading, classic barrio calligraphy',
  minimal:    'ultra-minimalist thin sans-serif lettering, clean geometric letterforms, precise even strokes, modern and understated',
  oldenglish: 'ornate old english lettering, traditional tattoo blackletter with decorative serifs and sharp pointed terminals',
};
app.post('/lettering', genLimiter, upload.none(), async (req, res) => {
  const text    = (req.body.text    || '').trim();
  const font    = LETTERING_FONTS[req.body.font] ? req.body.font : 'finescript';
  const details = (req.body.details || '').trim();
  if (!text) return res.status(400).json({ error: 'Please enter the text to letter.' });
  if (text.length > 80) return res.status(400).json({ error: 'Text too long (80 characters max).' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured.' });

  let gate = null;
  try {
    gate = await checkCredits(req, res, 'lettering');
    if (!gate) return;
    console.log('\n✒️ Lettering:', font, '—', text.slice(0, 40));

    const prompt =
      `Tattoo lettering design of the exact text "${text}" in ${LETTERING_FONTS[font]}. ` +
      `The text must be spelled EXACTLY as written, letter-perfect: "${text}". ` +
      (details ? `Additional direction: ${details}. ` : '') +
      `Black ink only, flat 2D tattoo lettering isolated on a pure solid white background (#FFFFFF). ` +
      `Perfectly legible, balanced composition, centered, professional tattoo lettering artist quality, high resolution. ` +
      `No skin, no mockup, no frame — lettering artwork only.`;

    // Génération texte pure (le point fort de gpt-image-2), format paysage adapté au lettering
    let imageUrl = await generateWithOpenAI(prompt, null, '1536x1024');
    imageUrl = await brandIfFree(gate, imageUrl);

    const credits = await chargeAfter(gate);
    try { if (gate.user) await saveGeneration(gate.user.id, 'lettering', imageUrl, { sujet: text, style: font, details }); } catch {}
    res.json({ imageUrl, credits });
  } catch (err) {
    await refundCredits(gate);
    console.error('❌ /lettering :', err.message);
    res.status(500).json({ error: clientError(err) });
  }
});

// ─────────────────────────────────────────────────
// POST /coverup — Cover-Up Studio (recouvrir un ancien tatouage)
// File : photo (le tatouage actuel sur la peau)
// Body : style, details (opt.)
// Retour: { imageUrl, credits }
// ─────────────────────────────────────────────────
const COVERUP_STYLES = {
  blackgrey: 'dense black and grey realism with deep rich shading and strong dark areas',
  baroque:   'ornate baroque black and grey composition — classical figures, drapery and dramatic chiaroscuro shading',
  floral:    'large dark peony and rose florals with dense petals and deep black shading',
  japanese:  'traditional japanese irezumi with waves, smoke and dense background shading',
  geometric: 'bold blackwork geometry with solid black fields, dotwork gradients and mandala patterns',
};

// Analyse professionnelle du tatouage existant (vision gpt-4o).
// Comme un vrai artiste cover-up : identifie le tatouage, sa densité, et la stratégie de recouvrement FAISABLE.
// Fail-open : null si erreur → le prompt générique prend le relais.
async function analyzeOldTattoo(photoPath) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) return null;
  try {
    const b64 = fs.readFileSync(photoPath).toString('base64');
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content:
            `You are a master cover-up tattoo artist analyzing a client's photo. Respond ONLY with compact JSON: ` +
            `{"tattoo":"what the existing tattoo depicts (5-12 words)","placement":"body part","density":"light|medium|dense",` +
            `"darkness":"faded|medium|dark","strategy":"one professional sentence: HOW to cover it feasibly (where the darkest zones of the new piece must sit, minimum size vs the old one)"}. ` +
            `If no tattoo is visible, return {"tattoo":"none"}.` },
          { role: 'user', content: [
            { type: 'text', text: 'Analyze this tattoo for a cover-up.' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64, detail: 'low' } },
          ] },
        ],
        temperature: 0.3, max_tokens: 220,
      }),
    });
    const data = await resp.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const json = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return json && json.tattoo && json.tattoo !== 'none' ? json : null;
  } catch (e) {
    console.warn('⚠ analyzeOldTattoo:', e.message);
    return null;
  }
}

app.post('/coverup', genLimiter, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo received.' });
  const style   = COVERUP_STYLES[req.body.style] ? req.body.style : 'blackgrey';
  const details = (req.body.details || '').trim();

  const photoPath = req.file.path + '.jpg';
  fs.renameSync(req.file.path, photoPath);

  let gate = null;
  try {
    gate = await checkCredits(req, res, 'coverup');
    if (!gate) return;
    console.log('\n🩹 Cover-up — style:', style);

    // ── Étape 1 : ANALYSE de l'ancien tatouage (comme un vrai artiste) ──
    const an = await analyzeOldTattoo(photoPath);
    if (an) console.log('   🔎 Analyse:', an.tattoo, '|', an.density, '/', an.darkness);

    // ── Étape 2 : conception du cover-up FAISABLE, informée par l'analyse + la demande du client ──
    const oldDesc = an
      ? `The existing tattoo is: ${an.tattoo} (on the ${an.placement || 'skin'}, ${an.density || 'medium'} ink density, ${an.darkness || 'medium'} darkness). ` +
        `Professional cover-up strategy for THIS tattoo: ${an.strategy || 'place the darkest zones of the new design directly over the old ink.'} `
      : `The photo shows a person's skin with an existing tattoo they want covered up. `;

    const prompt =
      oldDesc +
      `Design and apply a professional, REALISTICALLY FEASIBLE cover-up tattoo over it` +
      (details ? `, based on the client's request: "${details}"` : '') +
      `, executed in ${COVERUP_STYLES[style]}. ` +
      `Feasibility rules a real artist follows: the new design must be at least 2-3x larger than the old tattoo; ` +
      `its darkest, densest elements must sit EXACTLY over the old ink's darkest lines; ` +
      `busy detail and texture go where the old tattoo is, open skin and negative space go elsewhere; ` +
      `no trace of the original ink may remain visible. ` +
      `Preserve the person's skin, anatomy, pose, lighting and the photo's framing exactly — only the tattoo area changes. ` +
      `Photorealistic healed-tattoo result, professional cover-up artist quality.`;

    const imageUrl = await brandIfFree(gate, await openAIEditMulti(prompt, [photoPath], 'auto'));

    const credits = await chargeAfter(gate);
    try { if (gate.user) await saveGeneration(gate.user.id, 'coverup', imageUrl, { style, details, analysis: an || undefined }); } catch {}
    // L'analyse est renvoyée au front → affichée au client (crédibilité pro)
    res.json({ imageUrl, credits, analysis: an || null });
  } catch (err) {
    await refundCredits(gate);
    console.error('❌ /coverup :', err.message);
    res.status(500).json({ error: clientError(err) });
  } finally {
    if (fs.existsSync(photoPath)) try { fs.unlinkSync(photoPath); } catch {}
  }
});

// ─────────────────────────────────────────────────
// POST /chat — Concierge IA du site (gpt-4o-mini, rate-limité)
// Body: { messages: [{role:'user'|'assistant', content}] } (10 max, 500 chars/msg)
// ─────────────────────────────────────────────────
const CHAT_SYSTEM = `You are INK, the friendly concierge of INK.STUDIO (inkhay.com), a premium AI tattoo design studio.
Answer ONLY questions about INK.STUDIO, its tools, credits, plans and tattoo design guidance. If asked about anything else, politely steer back to INK.STUDIO.
Reply in the user's language. Be warm, concise (2-4 short sentences), never invent facts.

FACTS:
- Tools (in the Studio, inkhay.com/outil.html): Generate a design (10 credits), Lettering Studio for names/dates/quotes with 5 script styles (10), Cover-Up Studio that ANALYZES an old tattoo photo then designs a feasible cover-up (15), Instant Stencil (10), Merge 2-4 designs (15), Place on skin — see the tattoo on your own photo (15), Photo→Tattoo (10), Rework/inpainting (10). Ink options: Black & Grey (default), Full color, Red accent. Every result can be downloaded, shared, or printed at REAL size in cm with a calibration ruler.
- Free account: 30 free credits after confirming your email. No card required. Free-plan images carry a small INK.STUDIO watermark; paid plans have none.
- Plans (credits renew monthly, UNUSED CREDITS ROLL OVER on paid plans): Starter 7,99€/mo (150 cr), Pro 14,99€/mo (400 cr), Studio 39,99€/mo (1500 cr), Studio+ 89,99€/mo (4000 cr), Atelier 199,99€/mo (10000 cr). Annual billing = about 2 months free (e.g. Starter 79,90€/yr, Pro 149,90€/yr). Credit packs (one-time): Mini 50 cr = 5,99€, Standard 150 cr = 14,99€, Maxi 500 cr = 44,99€.
- Payments are processed securely by Stripe. Cancel anytime in one click from My account. Failed generations are automatically refunded in credits.
- Forgot password: "Forgot password?" link in the sign-in window.
- Human support: contact@inkhay.com. You cannot issue refunds or change accounts yourself — direct such requests to that email.`;

app.post('/chat', chatLimiter, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'chat_unavailable' });
  const raw = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
  const messages = raw.slice(-10).map(m => ({
    role: m && m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m && m.content || '').slice(0, 500),
  })).filter(m => m.content.trim());
  if (!messages.length) return res.status(400).json({ error: 'empty' });
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: CHAT_SYSTEM }, ...messages],
        temperature: 0.5, max_tokens: 320,
      }),
    });
    const data = await r.json();
    const reply = data.choices?.[0]?.message?.content;
    if (!reply) throw new Error(data.error?.message || 'no reply');
    res.json({ reply: reply.trim() });
  } catch (e) {
    console.error('❌ /chat:', e.message);
    res.status(500).json({ error: 'chat_error' });
  }
});

// ─────────────────────────────────────────────────
// Remove background (remove.bg)
// ─────────────────────────────────────────────────
app.post('/remove-bg', upload.single('image'), async (req, res) => {
  const apiKey = process.env.REMOVE_BG_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'REMOVE_BG_API_KEY not configured' });

  const file = req.file;
  const imageUrl = req.body.imageUrl;

  if (!file && !imageUrl) return res.status(400).json({ error: 'image or imageUrl required' });

  try {
    const FormData = require('form-data');
    const https = require('https');

    const form = new FormData();
    form.append('size', 'auto');
    if (file) {
      form.append('image_file', fs.createReadStream(file.path), { filename: file.originalname });
    } else {
      form.append('image_url', imageUrl);
    }

    const result = await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'api.remove.bg',
        path: '/v1.0/removebg',
        method: 'POST',
        headers: { ...form.getHeaders(), 'X-Api-Key': apiKey },
      };
      const chunks = [];
      const reqHttp = https.request(opts, r => {
        r.on('data', c => chunks.push(c));
        r.on('end', () => {
          if (r.statusCode !== 200) {
            const body = Buffer.concat(chunks).toString();
            return reject(new Error('remove.bg error: ' + body.slice(0, 200)));
          }
          resolve(Buffer.concat(chunks));
        });
      });
      reqHttp.on('error', reject);
      form.pipe(reqHttp);
    });

    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', 'attachment; filename="transparent.png"');
    res.send(result);
  } catch (err) {
    console.error('❌ /remove-bg:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (file) try { fs.unlinkSync(file.path); } catch {}
  }
});

// ─────────────────────────────────────────────────
// 404 : page brandée pour les navigations, JSON pour les appels API
// (placé APRÈS toutes les routes et le static — n'attrape que l'inconnu)
// ─────────────────────────────────────────────────
app.use((req, res) => {
  const wantsHtml = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
  if (wantsHtml) return res.status(404).sendFile(path.join(__dirname, '404.html'));
  res.status(404).json({ error: 'not_found' });
});

// ─────────────────────────────────────────────────
// Gestionnaire d'erreurs global : renvoie toujours du JSON (jamais une page HTML)
// → erreurs multer (trop de fichiers, fichier trop lourd) en 400 propre, reste en 500 JSON.
// ─────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const isMulter = err && (err.name === 'MulterError' || err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT');
  if (isMulter) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (10 MB max).' : 'Too many files (4 photos max).';
    return res.status(400).json({ error: msg });
  }
  console.error('❌ Erreur non gérée:', err && err.message);
  res.status(500).json({ error: 'server_error' });
});

// ─────────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Serveur démarré sur http://localhost:${PORT}`);
  console.log('   Ouvre index.html dans ton navigateur pour utiliser l\'app.');
  console.log('   Laisse ce terminal ouvert pendant que tu travailles.\n');
});
