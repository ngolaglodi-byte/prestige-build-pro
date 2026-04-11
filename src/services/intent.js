/**
 * Intent Classification + Clarification Protocol
 * Extracted from server.js lines 2280-2451
 */
const { log } = require('../config');

module.exports = function(ctx) {
  // Will be set after initialization
  let callClaudeAPI;

  function setDeps(deps) {
    callClaudeAPI = deps.callClaudeAPI;
  }

  // ─── INTENT CLASSIFIER (Claude Haiku 4.5) ───
  const INTENT_PROMPT = `Tu es un classifieur d'intentions. Tu reponds UNIQUEMENT avec un JSON strict.

Ton job : determiner si le message utilisateur demande de coder, de discuter, ou s'il est trop vague.

Categories :
- "code" : l'utilisateur veut creer/modifier/supprimer/corriger du code (verbes d'action OU constat de bug a fixer)
- "discuss" : pure question sans action attendue (comment ca marche, c'est quoi, explique-moi)
- "clarify" : trop vague, devrait demander une precision avant d'agir

Exemples :
- "Ajoute une page contact" -> {"intent":"code","confidence":0.98}
- "Le bouton est trop petit" -> {"intent":"code","confidence":0.92}
- "Tu peux ajouter une FAQ ?" -> {"intent":"code","confidence":0.95}
- "Comment marche le router ?" -> {"intent":"discuss","confidence":0.97}
- "Site web" -> {"intent":"clarify","confidence":0.9}

Reponds UNIQUEMENT avec le JSON, rien d'autre.`;

  async function classifyIntent(message) {
    if (!message || typeof message !== 'string' || message.trim().length < 3) {
      return { intent: 'clarify', confidence: 1, source: 'fast-path' };
    }
    try {
      const sys = [{ type: 'text', text: INTENT_PROMPT }];
      const msgs = [{ role: 'user', content: `Message: "${message.substring(0, 500)}"` }];
      const reply = await callClaudeAPI(sys, msgs, 100, null, {
        model: 'claude-haiku-4-5-20251001'
      });
      if (typeof reply !== 'string') throw new Error('non-string reply');
      const jsonMatch = reply.match(/\{[^}]*"intent"[^}]*\}/);
      if (!jsonMatch) throw new Error('no JSON found');
      const parsed = JSON.parse(jsonMatch[0]);
      if (!['code', 'discuss', 'clarify'].includes(parsed.intent)) throw new Error('invalid intent');
      const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
      return { intent: parsed.intent, confidence, source: 'haiku' };
    } catch (e) {
      log('warn', 'intent', 'Haiku classifier failed, using regex fallback', { error: e.message });
      return classifyIntentRegex(message);
    }
  }

  function classifyIntentRegex(message) {
    const msg = (message || '').toLowerCase();
    const isQuestion = /^(comment|pourquoi|qu'est-ce|c'est quoi|explique|quel|quelle|est-ce que|combien|où|quand)\b/.test(msg)
      && !/\b(crée|ajoute|modifie|change|supprime|corrige|implémente|intègre|construis|fais|mets|retire)\b/.test(msg);
    return {
      intent: isQuestion ? 'discuss' : 'code',
      confidence: 0.6,
      source: 'fallback'
    };
  }

  // ─── CLARIFICATION PROTOCOL ───
  const TECHNICAL_KEYWORDS = [
    'page', 'route', 'composant', 'component', 'table', 'api', 'endpoint',
    'database', 'auth', 'login', 'admin', 'dashboard', 'form', 'formulaire',
    'header', 'footer', 'hero', 'menu', 'sidebar', 'card', 'modal', 'sql',
    'crud', 'rest', 'jwt', 'stripe', 'payment', 'checkout', 'panier', 'cart',
    'utilisateur', 'user', 'profil', 'profile', 'inscription', 'register',
    'liste', 'list', 'détail', 'detail', 'recherche', 'search', 'filtre', 'filter',
    'contact', 'services', 'reservation', 'rdv', 'galerie', 'gallery',
    'newsletter', 'blog', 'article', 'avis', 'review', 'temoignage', 'testimonial',
    'equipe', 'team', 'about', 'apropos', 'tarif', 'pricing', 'faq'
  ];

  function needsClarification(message, project) {
    if (!message || typeof message !== 'string') return false;
    const trimmed = message.trim();
    if (project && project.generated_code && project.generated_code.length > 500) return false;
    const tokens = trimmed.toLowerCase().split(/[^a-zà-ÿ0-9]+/).filter(Boolean);
    const wordCount = tokens.length;
    if (wordCount < 6) return true;
    if (wordCount < 14) {
      const tokenSet = new Set(tokens);
      const techHits = TECHNICAL_KEYWORDS.filter(k => tokenSet.has(k)).length;
      if (techHits < 1) return true;
    }
    return false;
  }

  const CLARIFICATION_SYSTEM_PROMPT = `Tu es Prestige AI. Le brief de l'utilisateur est trop vague pour generer une application de qualite. Tu dois lui poser EXACTEMENT 3 questions courtes et concretes pour clarifier son besoin.

REGLES STRICTES :
- 3 questions, ni plus ni moins
- Format : une question par ligne, pas de numerotation, pas de tirets
- Chaque question doit etre actionnable et fermee (oui/non, choix court, ou identification d'un element manquant)
- Francais uniquement
- AUCUN texte avant ou apres les questions
- Ne pose JAMAIS de question sur les couleurs ou le design (ce sera fait automatiquement)

EXEMPLES de bonnes questions :
- Quel est le secteur d'activite ? (restaurant, sante, ecommerce, autre)
- Avez-vous besoin d'un espace administrateur pour gerer le contenu ?
- Quelles sont les 3 sections principales que la page d'accueil doit contenir ?

EXEMPLES de mauvaises questions (a EVITER) :
- Quelle palette de couleurs preferez-vous ? (interdit)
- Aimez-vous le design moderne ? (trop vague)
- Quel est le but de votre projet ? (trop vague et ouvert)`;

  const FALLBACK_CLARIFICATION_QUESTIONS = [
    "Quel est le secteur d'activite (restaurant, sante, ecommerce, services, autre) ?",
    "Avez-vous besoin d'un espace administrateur pour gerer le contenu ?",
    "Quelles sont les 3 sections principales que doit contenir la page d'accueil ?"
  ];

  async function generateClarificationQuestions(message, userId, projectId) {
    try {
      const sys = [{ type: 'text', text: CLARIFICATION_SYSTEM_PROMPT }];
      const msgs = [{ role: 'user', content: `Brief original : "${message}"\n\nGenere les 3 questions de clarification.` }];
      const reply = await callClaudeAPI(sys, msgs, 400, { userId, projectId, operation: 'clarify' }, {});
      if (!reply || typeof reply !== 'string') return FALLBACK_CLARIFICATION_QUESTIONS;
      const questions = reply
        .split('\n')
        .map(l => l.trim().replace(/^[-*•\d.)]+\s*/, '').replace(/^Q\d+\s*[:.-]\s*/i, ''))
        .filter(l => l.length > 8 && l.length < 220 && /[?]/.test(l))
        .slice(0, 3);
      if (questions.length === 0) return FALLBACK_CLARIFICATION_QUESTIONS;
      while (questions.length < 3) questions.push(FALLBACK_CLARIFICATION_QUESTIONS[questions.length]);
      return questions;
    } catch (e) {
      log('warn', 'clarify', 'LLM call failed, using fallback', { error: e.message });
      return FALLBACK_CLARIFICATION_QUESTIONS;
    }
  }

  return {
    classifyIntent,
    classifyIntentRegex,
    needsClarification,
    generateClarificationQuestions,
    setDeps
  };
};
