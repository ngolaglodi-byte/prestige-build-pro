// ─── PROFESSIONAL AI SYSTEM FOR PRESTIGE BUILD PRO ───

const SYSTEM_PROMPT = `Tu es l'IA de développement professionnel de Prestige Technologie Compagnie — une agence spécialisée dans la numérisation d'entreprises.

## TON IDENTITÉ
Tu t'appelles "Prestige AI". Tu es un expert senior en développement logiciel avec 15 ans d'expérience. Tu parles comme un consultant professionnel, pas comme un assistant basique.

## TES CAPACITÉS
Tu peux construire ABSOLUMENT n'importe quel projet sans limite :
- Sites web (HTML, React, Vue, Next.js, Angular)
- Applications web complètes (SaaS, CRM, ERP, e-commerce)
- Applications mobiles (React Native, Flutter)
- Backends et APIs (Node.js, Python, PHP, Go, Rust)
- Bases de données (PostgreSQL, MySQL, MongoDB, Redis)
- Applications desktop (Electron, Tauri)
- Intelligence artificielle et automatisation
- Systèmes de paiement, authentification, notifications
- Tout autre type de logiciel existant

## TON COMPORTEMENT PROFESSIONNEL

### Avant de construire, tu ANALYSES et PROPOSES :
1. Identifie les besoins réels (parfois différents de ce qui est demandé)
2. Propose l'architecture technique la plus adaptée avec justification
3. Suggère des améliorations qui apportent de la valeur
4. Identifie les risques et contraintes
5. Estime la complexité et les délais

### Tu POSES DES QUESTIONS si nécessaire :
- "Pour ce projet, j'ai besoin de savoir : [question précise]"
- "Avez-vous des préférences pour [choix technique] ?"
- "Le client a-t-il mentionné [élément important] ?"

### Tu EXPLIQUES tes choix :
- "J'utilise React + Tailwind car [raison métier]"
- "J'ai ajouté [fonctionnalité] car elle sera utile pour [cas d'usage]"
- "Je recommande [option A] plutôt que [option B] parce que [justification]"

### Tu PROPOSES proactivement :
- Fonctionnalités manquantes mais importantes
- Optimisations de performance
- Meilleures pratiques de sécurité
- Intégrations utiles
- Plans d'évolution futurs

## FORMAT DE RÉPONSE POUR LE CODE

Quand tu génères du code, utilise EXACTEMENT ce format :

## Analyse professionnelle
[Ton analyse du projet en 2-3 phrases]

## Architecture recommandée
**Stack:** [Technologies choisies]
**Justification:** [Pourquoi ce choix]
**Structure:** [Organisation du code]

## Améliorations proposées
1. [Amélioration 1 avec valeur ajoutée]
2. [Amélioration 2 avec valeur ajoutée]
3. [Amélioration 3 avec valeur ajoutée]

## Code complet

### src/App.jsx
\`\`\`jsx
[code complet ici]
\`\`\`

### src/components/Header.jsx
\`\`\`jsx
[code complet ici]
\`\`\`

### src/styles/index.css
\`\`\`css
[code complet ici]
\`\`\`

## Instructions de déploiement
\`\`\`bash
npm install
npm run build
# Déployer le dossier dist/ sur Coolify
\`\`\`

## Prochaines étapes suggérées
- [Suggestion 1]
- [Suggestion 2]

## RÈGLES ABSOLUES
- Génère TOUJOURS du code complet et fonctionnel, jamais des exemples partiels
- Chaque fichier doit être prêt pour la production
- Utilise Tailwind CSS pour le style quand c'est du React
- Le code doit être commenté en français
- Adapte le style visuel au secteur d'activité du client
- Si tu construis un site pour un restaurant, il doit être chaleureux
- Si tu construis pour une fintech, il doit être sobre et professionnel
- Si tu construis pour une startup tech, il peut être moderne et créatif`;

// ─── CONVERSATION CONTEXT BUILDER ───
function buildConversationContext(project, messages, userMessage) {
  const context = [];

  // Project context as first message
  if (project) {
    const projectContext = `CONTEXTE DU PROJET:
Titre: ${project.title || 'Non défini'}
Client: ${project.client_name || 'Non défini'}
Type: ${project.project_type || 'Non défini'}
Brief: ${project.brief || 'Non défini'}
Sous-domaine: ${project.subdomain ? project.subdomain + '.prestige-build.dev' : 'Non défini'}
APIs requises: ${project.apis ? JSON.parse(project.apis || '[]').join(', ') : 'Aucune'}

${project.generated_code ? 'Code déjà généré: ' + project.generated_code.substring(0, 500) + '...' : 'Aucun code généré encore.'}`;

    context.push({ role: 'user', content: projectContext });
    context.push({ role: 'assistant', content: 'Bien compris. Je prends en compte ce contexte. Comment puis-je vous aider ?' });
  }

  // Previous messages
  if (messages && messages.length > 0) {
    messages.forEach(m => {
      context.push({ role: m.role, content: m.content });
    });
  }

  // Current user message
  context.push({ role: 'user', content: userMessage });

  return context;
}

// ─── SMART BRIEF ANALYZER ───
function analyzeBrief(brief) {
  const analysis = {
    projectType: 'web',
    complexity: 'medium',
    suggestedStack: [],
    questions: [],
    risks: []
  };

  const b = brief.toLowerCase();

  // Detect type
  if (b.includes('mobile') || b.includes('app ios') || b.includes('android')) analysis.projectType = 'mobile';
  else if (b.includes('dashboard') || b.includes('analytics') || b.includes('statistiques')) analysis.projectType = 'dashboard';
  else if (b.includes('api') || b.includes('backend') || b.includes('serveur')) analysis.projectType = 'backend';
  else if (b.includes('e-commerce') || b.includes('boutique') || b.includes('vente en ligne')) analysis.projectType = 'ecommerce';
  else if (b.includes('logiciel') || b.includes('erp') || b.includes('crm')) analysis.projectType = 'software';

  // Suggest stack
  if (analysis.projectType === 'mobile') analysis.suggestedStack = ['React Native', 'Expo', 'Firebase'];
  else if (analysis.projectType === 'ecommerce') analysis.suggestedStack = ['Next.js', 'Stripe', 'Supabase'];
  else if (analysis.projectType === 'dashboard') analysis.suggestedStack = ['React', 'Recharts', 'Tailwind'];
  else analysis.suggestedStack = ['React', 'Vite', 'Tailwind CSS'];

  // Detect complexity
  const complexityWords = ['paiement', 'authentification', 'base de données', 'temps réel', 'api', 'integration'];
  const count = complexityWords.filter(w => b.includes(w)).length;
  if (count >= 3) analysis.complexity = 'high';
  else if (count >= 1) analysis.complexity = 'medium';
  else analysis.complexity = 'low';

  // Generate questions if needed
  if (!b.includes('couleur') && !b.includes('style') && !b.includes('design')) {
    analysis.questions.push('Quel style visuel souhaitez-vous ? (moderne, classique, minimaliste, coloré)');
  }
  if (!b.includes('langue') && !b.includes('francais') && !b.includes('anglais')) {
    analysis.questions.push('Le site est-il en français, anglais, ou multilingue ?');
  }

  return analysis;
}

// ─── BUILD PROFESSIONAL PROMPT ───
function buildProfessionalPrompt(userMessage, project, availableApis) {
  let prompt = userMessage;

  if (availableApis && availableApis.length > 0) {
    prompt += `\n\n[APIs disponibles dans le système: ${availableApis.map(a => `${a.name} (${a.service})`).join(', ')}. Utilise-les si pertinent.]`;
  }

  return prompt;
}

module.exports = {
  SYSTEM_PROMPT,
  buildConversationContext,
  analyzeBrief,
  buildProfessionalPrompt
};
