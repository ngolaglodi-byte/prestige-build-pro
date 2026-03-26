// ─── PROFESSIONAL AI SYSTEM FOR PRESTIGE BUILD PRO ───

// ─── SECTOR PROFILES (INVISIBLE TEMPLATES) ───
const SECTOR_PROFILES = {
  health: {
    keywords: ['hôpital', 'clinique', 'médecin', 'santé', 'cabinet médical', 'dentiste', 'pharmacie', 'médical', 'soins', 'patient'],
    prompt: `## PROFIL SANTÉ DÉTECTÉ
Tu génères un site pour le secteur médical/santé. Applique automatiquement :

**Design :**
- Couleurs apaisantes : blanc dominant, bleu médical (#0077B6), vert menthe (#2EC4B6)
- Typographie claire : Nunito, Open Sans ou Inter
- Espaces généreux, design épuré inspirant confiance

**Sections indispensables :**
- Header avec logo, numéro d'urgence visible, bouton RDV
- Hero rassurant avec photo d'équipe ou établissement
- Présentation de l'équipe médicale avec photos et spécialités
- Services médicaux avec icônes explicites
- Prise de rendez-vous en ligne (formulaire ou intégration Doctolib)
- Horaires et urgences bien visibles
- Certifications et accréditations
- Témoignages patients
- Contact avec carte et infos d'accès

**Accessibilité WCAG :**
- Contraste suffisant, police lisible min 16px
- Navigation clavier, attributs aria
- Textes alternatifs sur images`
  },
  restaurant: {
    keywords: ['restaurant', 'café', 'bistro', 'traiteur', 'cuisine', 'pizzeria', 'brasserie', 'gastronomie', 'chef', 'menu'],
    prompt: `## PROFIL RESTAURANT / FOOD DÉTECTÉ
Tu génères un site pour la restauration. Applique automatiquement :

**Design :**
- Ambiance chaleureuse : couleurs terre (marron, crème, or)
- Typographie élégante : Playfair Display pour titres, Lato pour texte
- Grande photo hero appétissante occupant l'écran

**Sections indispensables :**
- Header avec logo, bouton réservation, horaires
- Hero plein écran avec photo signature du restaurant
- Menu interactif organisé par catégories
- Galerie photos des plats en grille attractive
- À propos du chef et de l'établissement
- Réservation en ligne (formulaire avec date/heure/couverts)
- Horaires d'ouverture bien visibles
- Localisation avec carte Google Maps
- Avis clients TripAdvisor/Google style

**Ambiance visuelle :**
- Photos haute qualité des plats
- Animations subtiles au scroll
- Icônes food élégantes`
  },
  ecommerce: {
    keywords: ['boutique', 'vente', 'produits', 'shop', 'magasin', 'e-commerce', 'acheter', 'panier', 'commande', 'livraison'],
    prompt: `## PROFIL E-COMMERCE DÉTECTÉ
Tu génères une boutique en ligne. Applique automatiquement :

**Design :**
- Design moderne et clean
- Mise en avant des produits
- CTA visibles : Ajouter au panier, Acheter maintenant

**Sections indispensables :**
- Header avec logo, recherche, panier, compte
- Hero promotionnel avec produit vedette
- Catalogue produits avec filtres (catégorie, prix, taille)
- Fiches produits détaillées (images, description, prix, variantes)
- Panier persistant avec récapitulatif
- Checkout simplifié avec Stripe
- Avis clients par produit
- Section promotions et nouveautés
- Footer avec CGV, livraison, retours

**Fonctionnalités :**
- Filtres dynamiques
- Zoom sur images produit
- Indicateur stock
- Produits similaires`
  },
  corporate: {
    keywords: ['entreprise', 'société', 'services', 'b2b', 'consulting', 'conseil', 'cabinet', 'agence', 'industrie', 'groupe'],
    prompt: `## PROFIL CORPORATE / ENTREPRISE DÉTECTÉ
Tu génères un site d'entreprise professionnel. Applique automatiquement :

**Design :**
- Style sobre et professionnel
- Couleurs corporate : bleu marine, gris, touches d'accent
- Typographie business : Poppins, Roboto

**Sections indispensables :**
- Header avec logo, navigation, bouton contact
- Hero impactant avec proposition de valeur
- Services détaillés avec icônes et descriptions
- Chiffres clés animés (clients, projets, années)
- Équipe dirigeante avec photos et LinkedIn
- Témoignages clients B2B
- Logos clients de référence
- Actualités / Blog
- Formulaire de contact business
- Footer complet avec mentions légales

**Ton :**
- Professionnel mais accessible
- Chiffres et résultats concrets
- Call-to-action clairs`
  },
  saas: {
    keywords: ['application', 'logiciel', 'plateforme', 'saas', 'startup', 'tech', 'solution', 'outil', 'software', 'cloud'],
    prompt: `## PROFIL SAAS / TECH DÉTECTÉ
Tu génères une landing page SaaS moderne. Applique automatiquement :

**Design :**
- Style moderne tech : gradients subtils, glassmorphism
- Couleurs vives : violet, bleu électrique, accents néon
- Typographie moderne : Inter, DM Sans

**Sections indispensables :**
- Header sticky avec logo, features, pricing, CTA "Essayer gratuit"
- Hero avec headline percutante, sous-titre, CTA et visual produit
- Section features avec icônes Lucide et descriptions
- Démonstration interactive ou vidéo
- Pricing avec 3 tiers (Free, Pro, Enterprise)
- Intégrations (logos partenaires)
- Témoignages avec photos et entreprises
- FAQ technique accordéon
- CTA final "Commencer maintenant"

**Animations :**
- Fade-in au scroll
- Hover effects sur cards
- Curseur personnalisé (optionnel)`
  },
  education: {
    keywords: ['école', 'formation', 'cours', 'université', 'académie', 'apprentissage', 'enseignement', 'étudiant', 'professeur', 'diplôme'],
    prompt: `## PROFIL ÉDUCATION DÉTECTÉ
Tu génères un site éducatif. Applique automatiquement :

**Design :**
- Couleurs inspirantes : bleu savoir, orange dynamique, blanc
- Typographie lisible : Nunito, Source Sans Pro
- Interface intuitive et accessible

**Sections indispensables :**
- Header avec logo, formations, connexion espace élève
- Hero motivant avec accroche et bouton inscription
- Catalogue des formations avec filtres
- Fiches formation (durée, niveau, objectifs, programme)
- Profils formateurs avec expertise
- Témoignages étudiants avec résultats
- Calendrier des sessions
- Processus d'inscription étape par étape
- Certifications et reconnaissances
- Blog éducatif / ressources

**Fonctionnalités :**
- Recherche de formations
- Inscription en ligne
- Espace membre`
  },
  realestate: {
    keywords: ['immobilier', 'agence', 'appartements', 'maisons', 'location', 'achat', 'vente immobilière', 'logement', 'propriété', 'bien'],
    prompt: `## PROFIL IMMOBILIER DÉTECTÉ
Tu génères un site immobilier. Applique automatiquement :

**Design :**
- Style premium : noir, or, blanc
- Photos immobilières plein format
- Typographie élégante : Cormorant Garamond, Montserrat

**Sections indispensables :**
- Header avec logo, recherche rapide, espace propriétaire
- Hero avec barre de recherche avancée (localisation, type, budget)
- Biens en vedette avec photos, prix, caractéristiques
- Filtres avancés (surface, chambres, parking, etc.)
- Fiches propriétés complètes avec galerie, plan, caractéristiques
- Carte interactive des biens
- Profils agents avec contact direct
- Estimation en ligne
- Guides acheteur/vendeur/locataire

**Fonctionnalités :**
- Recherche avec filtres
- Favoris
- Alertes email`
  },
  hotel: {
    keywords: ['hôtel', 'resort', 'chambre', 'voyage', 'tourisme', 'hébergement', 'réservation', 'séjour', 'vacances', 'spa'],
    prompt: `## PROFIL HÔTELLERIE / TOURISME DÉTECTÉ
Tu génères un site hôtelier. Applique automatiquement :

**Design :**
- Ambiance luxueuse : couleurs chaudes, or, beige
- Photos plein écran inspirantes
- Typographie élégante : Libre Baskerville, Raleway

**Sections indispensables :**
- Header avec logo, langues, bouton réservation
- Hero immersif avec vidéo ou slider des lieux
- Moteur de réservation (dates, chambres, personnes)
- Présentation des chambres avec galerie et tarifs
- Services et équipements (spa, restaurant, piscine)
- Galerie photos immersive
- Localisation et activités à proximité
- Avis guests
- Offres spéciales et packages

**Expérience :**
- Navigation fluide
- Lazy loading images
- Disponibilités en temps réel`
  },
  portfolio: {
    keywords: ['portfolio', 'photographe', 'designer', 'artiste', 'créatif', 'freelance', 'studio', 'création', 'graphiste', 'illustrateur'],
    prompt: `## PROFIL CRÉATIF / PORTFOLIO DÉTECTÉ
Tu génères un portfolio créatif. Applique automatiquement :

**Design :**
- Design minimal mettant en valeur les œuvres
- Fond neutre : blanc, noir ou gris clair
- Typographie design : Playfair Display, Helvetica Neue

**Sections indispensables :**
- Header minimal avec logo/nom et navigation
- Hero impactant avec une œuvre signature
- Galerie projets en grille avec hover effects
- Fiches projet avec images, contexte, processus
- À propos avec photo et biographie
- Process créatif / méthode de travail
- Clients et collaborations
- Contact avec formulaire de brief

**Effets visuels :**
- Transitions smooth entre pages
- Curseur personnalisé
- Animations au scroll subtiles
- Lightbox pour images`
  },
  nonprofit: {
    keywords: ['association', 'ong', 'humanitaire', 'bénévolat', 'don', 'solidarité', 'fondation', 'caritative', 'aide', 'cause'],
    prompt: `## PROFIL ONG / ASSOCIATION DÉTECTÉ
Tu génères un site associatif. Applique automatiquement :

**Design :**
- Couleurs engagées selon la cause
- Photos émotionnelles de terrain
- Design accessible et chaleureux

**Sections indispensables :**
- Header avec logo, mission, bouton don
- Hero émotionnel avec appel à l'action
- Mission et valeurs de l'association
- Impact et chiffres (personnes aidées, projets)
- Projets en cours avec avancement
- Comment aider (don, bénévolat, parrainage)
- Formulaire de don sécurisé Stripe
- Équipe et bénévoles
- Actualités / Blog
- Transparence financière (rapports)

**Appels à l'action :**
- Boutons don visibles
- Formulaires d'engagement
- Partage social`
  },
  dashboard: {
    keywords: ['dashboard', 'admin', 'gestion', 'back-office', 'erp', 'tableau de bord', 'analytics', 'statistiques', 'crm', 'interne'],
    prompt: `## PROFIL DASHBOARD / APP INTERNE DÉTECTÉ
Tu génères une interface admin/dashboard. Applique automatiquement :

**Design :**
- Interface fonctionnelle : sidebar + contenu principal
- Couleurs sobres : gris, bleu, accents pour actions
- Composants UI clairs : cards, tables, boutons

**Sections indispensables :**
- Sidebar navigation avec icônes
- Header avec recherche, notifications, profil
- Dashboard avec KPIs en cards
- Graphiques interactifs (Chart.js ou Recharts)
- Tableaux de données avec tri et pagination
- Formulaires CRUD complets
- Gestion utilisateurs et rôles
- Paramètres et configuration
- Export de données (CSV, PDF)

**Fonctionnalités :**
- State management
- Filtres et recherche
- Actions groupées
- Notifications toast`
  },
  fitness: {
    keywords: ['sport', 'fitness', 'salle de sport', 'coach', 'nutrition', 'musculation', 'entraînement', 'gym', 'crossfit', 'yoga'],
    prompt: `## PROFIL FITNESS / SPORT DÉTECTÉ
Tu génères un site fitness. Applique automatiquement :

**Design :**
- Style énergique : noir, couleurs vives (orange, vert)
- Photos dynamiques de personnes en action
- Typographie forte : Bebas Neue, Oswald

**Sections indispensables :**
- Header avec logo, planning, espace membre
- Hero motivant avec CTA "Commencer"
- Planning des cours interactif
- Présentation des activités (CrossFit, Yoga, etc.)
- Profils coachs avec spécialités
- Formules d'abonnement avec prix
- Galerie transformations avant/après
- Témoignages membres
- Blog nutrition/santé
- Contact et localisation

**Énergie visuelle :**
- Animations dynamiques
- Compteurs animés
- Progress bars`
  }
};

// ─── DETECT SECTOR FROM BRIEF ───
function detectSectorProfile(brief) {
  if (!brief) return null;
  const b = brief.toLowerCase();
  
  // Score each sector by counting keyword matches
  let bestMatch = null;
  let highestScore = 0;
  
  for (const [sector, profile] of Object.entries(SECTOR_PROFILES)) {
    let score = 0;
    for (const keyword of profile.keywords) {
      if (b.includes(keyword)) {
        score++;
      }
    }
    if (score > highestScore) {
      highestScore = score;
      bestMatch = profile.prompt;
    }
  }
  
  return highestScore > 0 ? bestMatch : null;
}

// ─── COMPLEXITY DETECTION FOR MAX TOKENS ───
const COMPLEX_PROJECT_KEYWORDS = [
  'portail', 'erp', 'complet', 'dashboard', 'multi-rôles', 'multi-roles',
  'hôpital', 'hospital', 'e-commerce', 'ecommerce', 'boutique', 'plateforme',
  'système', 'systeme', 'gestion', 'admin', 'clinique', 'medical', 'médical'
];

function detectProjectComplexity(brief) {
  if (!brief) return 'simple';
  const b = brief.toLowerCase();
  for (const keyword of COMPLEX_PROJECT_KEYWORDS) {
    if (b.includes(keyword)) {
      return 'complex';
    }
  }
  return 'simple';
}

function getMaxTokensForProject(brief) {
  const complexity = detectProjectComplexity(brief);
  return complexity === 'complex' ? 16000 : 8000;
}

function getModelForProject(brief) {
  const complexity = detectProjectComplexity(brief);
  return complexity === 'complex' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
}

const SYSTEM_PROMPT = `Tu es Prestige AI, un générateur de code expert niveau senior. Tu génères des applications web fullstack COMPLÈTES et PROFESSIONNELLES.

FORMAT DE SORTIE OBLIGATOIRE — utilise exactement ces marqueurs sans backticks markdown :

### package.json
{contenu JSON pur}

### server.js
{code JavaScript pur}

### public/index.html
{code HTML pur}

VERSIONS OBLIGATOIRES — utilise EXACTEMENT ces versions dans package.json et server.js :
- express 4.18.2 — JAMAIS express 5.x
- better-sqlite3 9.4.3
- bcryptjs 2.4.3
- jsonwebtoken 9.0.2
- cors 2.8.5
- helmet 7.1.0
- compression 1.7.4

SYNTAXE EXPRESS 4.18.2 OBLIGATOIRE :
- Route catch-all OBLIGATOIRE : app.get(/.*/, (req, res) => {...}) — JAMAIS app.get('*') ni app.get('/*')
- Middleware : app.use(express.json()) — pas bodyParser séparé
- Static files : app.use(express.static('public'))
- Error handler : (err, req, res, next) avec 4 paramètres

ORDRE DES MIDDLEWARES — RÈGLE ABSOLUE :
1. app.use(express.json())
2. app.use(express.static('public'))  ← AVANT toute auth — les fichiers statiques sont PUBLICS
3. app.get('/health', ...) et app.post('/api/auth/login', ...) ← routes publiques SANS auth
4. Middleware JWT auth UNIQUEMENT sur /api/* (sauf login) : app.use('/api', authMiddleware)
5. Routes /api/* protégées
6. app.get(/.*/, ...) catch-all qui sert index.html
La page index.html et tous les fichiers statiques (CSS, JS, images) sont TOUJOURS accessibles sans authentification. Seules les routes /api/* (sauf /api/auth/login et /api/auth/register) nécessitent un token JWT.

RÈGLES ABSOLUES :
1. JAMAIS de backticks markdown \`\`\` dans ta réponse
2. JAMAIS de texte explicatif avant ou après le code
3. Le code commence directement après le marqueur ### filename
4. public/index.html : HTML/CSS/JS vanilla UNIQUEMENT — INTERDIT : require(), exports, import, process, __dirname
   IMPORTANT pour les fetch : utiliser des URLs RELATIVES sans slash initial.
   CORRECT : fetch('api/menu')  fetch('api/auth/login')
   INTERDIT : fetch('/api/menu')  fetch('/api/auth/login')
   Le site sera servi derrière un reverse proxy avec un préfixe de chemin. Les URLs absolues (/api/...) casseront le routage.
5. package.json : JSON strict valide UNIQUEMENT — dépendances avec versions fixes (sans ^)
6. server.js : écoute sur PORT 3000, sert /public, route /health, crée les tables SQLite au démarrage
7. COMPTE ADMIN OBLIGATOIRE : crée un compte admin avec email basé sur le nom/secteur du projet (ex: admin@monrestaurant.com, admin@luxehotel.com) et mot de passe fort (ex: Admin2024!, Prestige2024!). À la TOUTE FIN du fichier server.js, ajoute ce commentaire exact sur une seule ligne :
// CREDENTIALS: email=admin@[nom-projet].com password=[MotDePasse]

QUALITÉ PROFESSIONNELLE OBLIGATOIRE :
- Design moderne inspiré des meilleures applications SaaS mondiales
- Animations CSS subtiles — transitions, fade-in, hover effects
- Responsive mobile-first avec breakpoints 320px, 768px, 1024px, 1440px
- Typographie Google Fonts appropriée au secteur
- Palette de couleurs harmonieuse et professionnelle
- Zéro lorem ipsum — contenu réel, professionnel, crédible
- Navigation complète avec toutes les pages fonctionnelles
- Formulaires avec validation JavaScript
- Données de démonstration réalistes pré-remplies dans la DB

PROFILS SECTORIELS — appliqués automatiquement selon le brief :

SANTÉ : tables patients/médecins/rendez-vous/dossiers, rôles admin/médecin/patient/infirmier, design blanc et bleu médical, prise de RDV en ligne, urgences visibles

RESTAURANT : tables menu/commandes/réservations/tables, design chaleureux et appétissant, menu interactif avec photos Unsplash, réservation en ligne, caisse simple

E-COMMERCE : tables produits/commandes/panier/clients, catalogue avec filtres, panier fonctionnel, checkout, gestion stock admin, avis clients

CORPORATE : tables services/équipe/témoignages/contacts, hero professionnel, stats animées, formulaire contact, design sérieux et élégant

SAAS : tables users/plans/features/analytics, landing page moderne style Linear, pricing tiers, dashboard utilisateur, onboarding

ÉDUCATION : tables cours/étudiants/formateurs/inscriptions, catalogue formations, espace étudiant, progression, certificats

IMMOBILIER : tables biens/agents/visites/clients, recherche avec filtres, fiches détaillées, carte placeholder, contact agent

HÔTELLERIE : tables chambres/réservations/clients/services, galerie immersive, booking en ligne, services et équipements

FITNESS : tables cours/coachs/membres/séances, planning interactif, abonnements, suivi progression

DASHBOARD/ERP : tables selon domaine métier, sidebar navigation, tableaux Chart.js, CRUD complet, exports, rôles multiples

GÉNÈRE TOUJOURS DANS TOUS LES PROJETS :
- Navigation sticky avec menu hamburger mobile
- Footer complet avec liens et copyright
- Page 404 élégante
- Loader animé au démarrage
- Scroll to top button
- Meta tags SEO
- Smooth scroll
- Animations fade-in avec IntersectionObserver
- Messages de succès/erreur sur tous les formulaires
- Protection JWT sur toutes les routes API sensibles`;


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
  SECTOR_PROFILES,
  detectSectorProfile,
  buildConversationContext,
  analyzeBrief,
  buildProfessionalPrompt,
  detectProjectComplexity,
  getMaxTokensForProject,
  getModelForProject
};
