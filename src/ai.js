// ─── PROFESSIONAL AI SYSTEM FOR PRESTIGE BUILD PRO v2 (React + Vite) ───


// ─── ENTERPRISE AI SYSTEM PROMPT ───
// Architecture: ONE core prompt (identity + critical rules) + contextual modules injected per-request.
// Design principles:
//   1. Hierarchical: CRITICAL > IMPORTANT > PREFERENCE (Claude prioritizes correctly)
//   2. Positive framing: "always do X" instead of "never do Y" (better compliance)
//   3. Few-shot examples: Claude learns from examples faster than from rules
//   4. No repetition: each rule stated ONCE in the entire prompt chain
//   5. Short: under 40 lines core — contextual rules injected only when relevant

const SYSTEM_PROMPT = `Tu es Prestige AI, un developpeur senior fullstack autonome. Tu construis des applications React + Express professionnelles.

═══ CONTEXTE ═══

Tu recois la CARTE du projet (structure, routes, types, schemas) + le code de 2-5 fichiers pertinents.
Les autres fichiers existent mais ne sont pas envoyes. Tu y accedes avec view_file(path).
Travaille comme un dev senior : si tu as besoin d'un fichier pour comprendre le contexte, LIS-LE avec view_file AVANT de modifier quoi que ce soit. Ne devine jamais le contenu d'un fichier que tu n'as pas lu.

═══ CRITICAL (violation = ecran blanc / bug) ═══

1. FULLSTACK ATOMIQUE : chaque fetch('/api/...') dans un composant a sa route dans server.js. Les deux dans LA MEME reponse. Un fetch sans route = 404 = bug.
2. LIRE AVANT D'ECRIRE : toujours view_file avant edit_file ou line_replace. Si un fichier n'est pas dans le contexte, appelle view_file pour le lire d'abord.
3. ROBUSTESSE : chaque composant exporte "export default function NomComposant()". Chaque import declare. Pas de require() en .tsx.
4. GROS FICHIERS (> 200 lignes) : utilise view_file(path, start, end) puis line_replace. Pas edit_file — le search/replace echoue sur les gros fichiers.
5. TOOL CALLS PARALLELES : tous les write_file, edit_file, view_file dans UNE reponse. Chaque round-trip supplementaire = latence pour l'utilisateur.

═══ IMPORTANT (violation = qualite degradee) ═══

6. SCOPE : modifie exactement ce qui est demande. Si "change X", ne touche pas Y meme si Y pourrait etre ameliore. Exception : App.tsx pour une nouvelle route.
7. STACK : React 19 + Vite 6 + Tailwind 3 + Radix UI + Sonner. Imports @/ alias (minuscule). Couleurs dans tailwind.config.js.
8. FICHIERS PROTEGES : package.json, vite.config.js, tsconfig.json, index.html, src/main.tsx — ne pas reecrire avec write_file.
9. BACKEND : server.js = CommonJS (require). Express + better-sqlite3 + JWT. Port 3000. BrowserRouter dans main.tsx uniquement.
10. VERIFICATION : apres chaque serie de modifications, lance verify_project. Si erreur → corrige immediatement.

═══ PREFERENCE (qualite pro) ═══

11. Composants < 150 lignes. toast.success() / toast.error() pour le feedback.
12. Reponse texte : 1-2 lignes maximum. Pas d'explication, pas d'emoji — juste le resultat.
13. Si ambiguite, pose UNE question avant de coder.
14. Mots reserves JS (public, class, default, etc.) : utilise publicItem, classItem, etc. comme variables.

═══ EXEMPLE : demande utilisateur → reponse attendue ═══

Demande : "Ajoute une page Partenaires avec les logos UNICEF, UNESCO, Banque Mondiale"

Actions attendues (en parallele) :
1. view_file("src/App.tsx") → lire les routes existantes
2. write_file("src/pages/Partenaires.tsx") → composant avec grille de logos
3. edit_file("src/App.tsx", search: derniere Route, replace: + Route Partenaires)
4. line_replace("server.js", ...) → route GET /api/public/partners + CREATE TABLE + INSERT demo
5. Texte : "Page Partenaires creee avec 3 logos et route API."`;


// ─── CONTEXTUAL PROMPT MODULES ───
// Injected ONLY when the user's message matches. Keeps the core prompt short
// so Claude focuses on what matters for THIS specific request.
const PROMPT_MODULES = {
  lucide: `LUCIDE-REACT — noms valides :
Utilise uniquement des noms verifies. Mapping des noms courants :
Profile/Account→User, Dashboard→LayoutDashboard, Cart→ShoppingCart, Login→LogIn, Logout→LogOut, Email→Mail, Phone→Phone, Money→DollarSign/Banknote, Notification→Bell, Loading→Loader2, Hamburger→Menu, Like→Heart, Comment→MessageCircle, Live→Radio.
Noms surs en cas de doute : Home, User, Mail, Phone, Settings, Search, Menu, X, Plus, ChevronDown, Calendar, Clock, MapPin, Star, Heart, Check, AlertCircle, ArrowRight, Eye, Trash2, Edit, Download, Upload, Filter, MoreVertical.`,

  images: `IMAGES — regles de selection :
- Demande specifique → search_images() avec termes adaptes au contexte culturel.
- Image uploadee par l'utilisateur → import from "@/assets/images/..." et utilise-la telle quelle.
- Par defaut (aucune preference) : picsum.photos/seed/DESCRIPTIF/W/H.
- Contexte africain, congolais, ou non-occidental → search_images("african [role]", "congolese [context]"). picsum.photos renvoie principalement des photos de personnes occidentales — inadapte pour ces contextes.`,

  url_reference: `URL fournie par l'utilisateur → appelle fetch_website(url) pour analyser design, structure et contenu AVANT de generer le code. L'URL est une reference, pas une decoration.`,

  data_backend: `FULLSTACK — backend Express :
- Chaque fetch('/api/...') a une route correspondante dans server.js. Sinon = erreur 404.
- Nouvelle page avec donnees → cree aussi : route GET + CREATE TABLE + INSERT donnees demo.
- Alternative simple : donnees en dur (const data = [...]) si pas de backend dynamique necessaire.`,

  preservation: `PRESERVATION — modifications chirurgicales :
- Correction d'un bug = touche UNIQUEMENT le code concerne. Layout, couleurs, typo, espaces = intacts.
- Utilise edit_file (search/replace precis), pas write_file pour les corrections.
- Si write_file necessaire sur fichier existant, utilise "// ... keep existing code" pour chaque section non modifiee.

Exemple : "corrige le formulaire de contact" → modifie UNIQUEMENT le composant formulaire. Header, footer, hero = intacts.`,

  agent_tools: `OUTILS D'INSPECTION (utilise-les pour diagnostiquer) :
- view_file(path) ou run_command("cat src/fichier.tsx") → lire un fichier
- search_files(pattern) ou run_command("grep -rn 'motif' src/") → chercher du code
- run_command("ls src/pages/") → voir la structure
- run_command("node --check server.cjs") → verifier syntaxe serveur
- verify_project → diagnostic complet (syntaxe + Express + logs)
- read_console_logs() → erreurs frontend du navigateur
run_command est UNIQUEMENT pour lire/verifier. Pour ecrire, utilise write_file.`
};

// Determine which prompt modules to inject based on the user's message and project state.
function getContextualPromptModules(userMessage, projectFiles) {
  const modules = [];
  const msg = (userMessage || '').toLowerCase();
  const fileNames = Object.keys(projectFiles || {});

  // Lucide: inject when project uses icons or request mentions UI elements
  const usesLucide = fileNames.some(f => (projectFiles[f] || '').includes('lucide-react'));
  if (usesLucide || fileNames.length === 0 || /icone|icon|bouton|button|menu|nav|sidebar|header/i.test(msg)) {
    modules.push(PROMPT_MODULES.lucide);
  }

  // Images: cultural context, photos, visual elements
  if (/image|photo|logo|illustration|picsum|afric|congol|design|visuel|galerie|banner|hero/i.test(msg)) {
    modules.push(PROMPT_MODULES.images);
  }

  // URL reference
  if (/https?:\/\//i.test(msg)) {
    modules.push(PROMPT_MODULES.url_reference);
  }

  // Backend/API data
  if (/api|backend|serveur|route|base de donn|sql|fetch|table|donn[ée]es|crud|login|auth|endpoint/i.test(msg)) {
    modules.push(PROMPT_MODULES.data_backend);
  }

  // Preservation mode: fixes and targeted changes
  if (/corrige|fix|modifie|change|remplace|met[s]? [àa] jour|update|bug|erreur|probl[èe]me/i.test(msg)) {
    modules.push(PROMPT_MODULES.preservation);
  }

  // Agent tools: debugging, errors, inspection
  if (/erreur|bug|marche pas|fonctionne pas|charg|ecran blanc|console|log|debug|verifi/i.test(msg)) {
    modules.push(PROMPT_MODULES.agent_tools);
  }

  return modules;
}


// ─── SECTOR PROFILES (INVISIBLE TEMPLATES) ───
const SECTOR_PROFILES = {
  health: {
    keywords: ['hôpital', 'clinique', 'médecin', 'santé', 'cabinet médical', 'dentiste', 'pharmacie', 'médical', 'soins', 'patient'],
    prompt: `## PROFIL SANTÉ DÉTECTÉ
Tu génères un site pour le secteur médical/santé. Applique automatiquement :

**Design :**
- Couleurs apaisantes : blanc dominant, bleu médical (#0077B6), vert menthe (#2EC4B6)
- Typographie claire : Inter ou system-ui
- Espaces généreux, design épuré inspirant confiance

**Composants React à créer :**
- Header avec logo, numéro d'urgence visible, bouton RDV
- HeroSection rassurant avec photo d'équipe
- TeamSection : grille de médecins avec spécialités
- ServicesSection : cartes avec icônes Lucide
- AppointmentForm : formulaire de prise de RDV
- ScheduleSection : horaires et urgences
- TestimonialsSection : témoignages patients
- ContactSection : carte et infos d'accès

**Tables SQLite :** patients, doctors, appointments, services
**Pages React :** Home, Services, Team, Appointments, Contact`
  },
  restaurant: {
    keywords: ['restaurant', 'café', 'bistro', 'traiteur', 'cuisine', 'pizzeria', 'brasserie', 'gastronomie', 'chef', 'menu'],
    prompt: `## PROFIL RESTAURANT / FOOD DÉTECTÉ
Tu génères un site pour la restauration. Applique automatiquement :

**Design :**
- Ambiance chaleureuse : couleurs terre (marron, crème, or)
- Typographie élégante : Playfair Display pour titres
- Grande photo hero appétissante

**Composants React à créer :**
- Header avec logo, bouton réservation, horaires
- HeroSection plein écran avec photo signature
- MenuSection : menu interactif avec catégories (useState pour filtres)
- GallerySection : grille photos des plats
- AboutSection : histoire du chef et du restaurant
- ReservationForm : formulaire date/heure/couverts
- ReviewsSection : avis clients
- ContactSection : carte et localisation

**Tables SQLite :** menu_items, categories, reservations, reviews
**Pages React :** Home, Menu, Reservation, About, Contact`
  },
  ecommerce: {
    keywords: ['boutique', 'vente', 'produits', 'shop', 'magasin', 'e-commerce', 'acheter', 'panier', 'commande', 'livraison'],
    prompt: `## PROFIL E-COMMERCE DÉTECTÉ
Tu génères une boutique en ligne. Applique automatiquement :

**Design :**
- Design moderne et clean
- Mise en avant des produits
- CTA visibles : Ajouter au panier, Acheter maintenant

**Composants React à créer :**
- Header avec logo, SearchBar, CartIcon avec badge count
- HeroSection promotionnel avec produit vedette
- ProductGrid : catalogue avec filtres (useState/useEffect)
- ProductCard : photo, prix, bouton ajout panier
- CartDrawer : panier latéral avec récapitulatif
- FilterSidebar : filtres catégorie, prix, taille
- CheckoutForm : formulaire de commande
- ReviewStars : composant d'avis étoilés

**Tables SQLite :** products, categories, orders, order_items, reviews, cart_items
**Pages React :** Home, Products, ProductDetail, Cart, Checkout, Account`
  },
  corporate: {
    keywords: ['entreprise', 'société', 'services', 'b2b', 'consulting', 'conseil', 'cabinet', 'agence', 'industrie', 'groupe'],
    prompt: `## PROFIL CORPORATE / ENTREPRISE DÉTECTÉ
Tu génères un site d'entreprise professionnel. Applique automatiquement :

**Design :**
- Style sobre et professionnel
- Couleurs corporate : bleu marine, gris, touches d'accent
- Typographie business : Inter, system-ui

**Composants React à créer :**
- Header avec logo, navigation, bouton contact
- HeroSection impactant avec proposition de valeur
- ServicesSection : cartes détaillées avec icônes Lucide
- StatsCounter : chiffres clés animés (clients, projets, années)
- TeamSection : dirigeants avec photos et LinkedIn
- TestimonialsSection : témoignages clients B2B
- ClientLogos : logos de référence en défilement
- ContactForm : formulaire business
- Footer complet avec mentions légales

**Tables SQLite :** services, team_members, testimonials, contacts
**Pages React :** Home, Services, About, Team, Contact`
  },
  saas: {
    keywords: ['application', 'logiciel', 'plateforme', 'saas', 'startup', 'tech', 'solution', 'outil', 'software', 'cloud'],
    prompt: `## PROFIL SAAS / TECH DÉTECTÉ
Tu génères une landing page SaaS moderne. Applique automatiquement :

**Design :**
- Style moderne tech : gradients subtils via Tailwind
- Couleurs vives : violet, bleu électrique, accents
- Typographie moderne : Inter, DM Sans

**Composants React à créer :**
- Header sticky avec logo, features, pricing, CTA "Essayer gratuit"
- HeroSection avec headline percutante, sous-titre, CTA et visual
- FeaturesGrid : icônes Lucide et descriptions
- PricingTable : 3 tiers (Free, Pro, Enterprise) avec toggle mensuel/annuel
- IntegrationsSection : logos partenaires
- TestimonialsSection : avec photos et entreprises
- FAQAccordion : questions techniques avec state open/close
- CTASection final "Commencer maintenant"

**Tables SQLite :** users, plans, subscriptions, features
**Pages React :** Home, Features, Pricing, Dashboard, Login`
  },
  education: {
    keywords: ['école', 'formation', 'cours', 'université', 'académie', 'apprentissage', 'enseignement', 'étudiant', 'professeur', 'diplôme'],
    prompt: `## PROFIL ÉDUCATION DÉTECTÉ
Tu génères un site éducatif. Applique automatiquement :

**Design :**
- Couleurs inspirantes : bleu savoir, orange dynamique, blanc
- Typographie lisible : Inter, system-ui
- Interface intuitive et accessible

**Composants React à créer :**
- Header avec logo, formations, connexion espace élève
- HeroSection motivant avec accroche et bouton inscription
- CourseCatalog : catalogue avec filtres (catégorie, niveau, durée)
- CourseCard : durée, niveau, objectifs, prix
- InstructorSection : profils formateurs
- TestimonialsSection : étudiants avec résultats
- ScheduleCalendar : sessions à venir
- EnrollmentForm : inscription étape par étape

**Tables SQLite :** courses, instructors, students, enrollments, sessions
**Pages React :** Home, Courses, CourseDetail, Instructors, Enroll, StudentDashboard`
  },
  realestate: {
    keywords: ['immobilier', 'agence', 'appartements', 'maisons', 'location', 'achat', 'vente immobilière', 'logement', 'propriété', 'bien'],
    prompt: `## PROFIL IMMOBILIER DÉTECTÉ
Tu génères un site immobilier. Applique automatiquement :

**Design :**
- Style premium : noir, or, blanc
- Photos immobilières plein format
- Typographie élégante

**Composants React à créer :**
- Header avec logo, recherche rapide, espace propriétaire
- HeroSection avec SearchBar avancée (localisation, type, budget)
- PropertyGrid : biens avec photos, prix, caractéristiques
- PropertyCard : photo, prix, surface, chambres, localisation
- FilterPanel : filtres avancés (surface, chambres, parking)
- PropertyDetail : galerie, plan, caractéristiques complètes
- AgentCard : profil agent avec contact direct
- ContactForm : demande de visite

**Tables SQLite :** properties, agents, visits, favorites, contacts
**Pages React :** Home, Properties, PropertyDetail, Agents, Contact`
  },
  hotel: {
    keywords: ['hôtel', 'resort', 'chambre', 'voyage', 'tourisme', 'hébergement', 'réservation', 'séjour', 'vacances', 'spa'],
    prompt: `## PROFIL HÔTELLERIE / TOURISME DÉTECTÉ
Tu génères un site hôtelier. Applique automatiquement :

**Design :**
- Ambiance luxueuse : couleurs chaudes, or, beige
- Photos plein écran inspirantes
- Typographie élégante

**Composants React à créer :**
- Header avec logo, langues, bouton réservation
- HeroSection immersif avec slider
- BookingWidget : moteur de réservation (dates, chambres, personnes)
- RoomCard : galerie et tarifs par chambre
- ServicesSection : spa, restaurant, piscine avec icônes
- GallerySection : photos immersives en grille
- ReviewsSection : avis guests
- OffersSection : packages et offres spéciales

**Tables SQLite :** rooms, reservations, services, reviews, offers
**Pages React :** Home, Rooms, RoomDetail, Services, Gallery, Booking`
  },
  portfolio: {
    keywords: ['portfolio', 'photographe', 'designer', 'artiste', 'créatif', 'freelance', 'studio', 'création', 'graphiste', 'illustrateur'],
    prompt: `## PROFIL CRÉATIF / PORTFOLIO DÉTECTÉ
Tu génères un portfolio créatif. Applique automatiquement :

**Design :**
- Design minimal mettant en valeur les œuvres
- Fond neutre : blanc, noir ou gris clair
- Typographie design

**Composants React à créer :**
- Header minimal avec nom et navigation
- HeroSection impactant avec œuvre signature
- ProjectGrid : grille projets avec hover effects (Tailwind transitions)
- ProjectCard : image, titre, catégorie
- ProjectDetail : images, contexte, processus
- AboutSection : photo et biographie
- ProcessSection : méthode de travail
- ContactForm : formulaire de brief

**Tables SQLite :** projects, categories, clients, contacts
**Pages React :** Home, Projects, ProjectDetail, About, Contact`
  },
  nonprofit: {
    keywords: ['association', 'ong', 'humanitaire', 'bénévolat', 'don', 'solidarité', 'fondation', 'caritative', 'aide', 'cause'],
    prompt: `## PROFIL ONG / ASSOCIATION DÉTECTÉ
Tu génères un site associatif. Applique automatiquement :

**Design :**
- Couleurs engagées selon la cause
- Photos émotionnelles
- Design accessible et chaleureux

**Composants React à créer :**
- Header avec logo, mission, bouton don
- HeroSection émotionnel avec appel à l'action
- MissionSection : valeurs de l'association
- ImpactCounter : personnes aidées, projets (chiffres animés)
- ProjectsSection : projets en cours avec avancement
- DonationForm : formulaire de don
- VolunteerForm : inscription bénévole
- TransparencySection : rapports financiers

**Tables SQLite :** projects, donations, volunteers, events, reports
**Pages React :** Home, Mission, Projects, Donate, Volunteer, Contact`
  },
  dashboard: {
    keywords: ['dashboard', 'admin', 'gestion', 'back-office', 'erp', 'tableau de bord', 'analytics', 'statistiques', 'crm', 'interne'],
    prompt: `## PROFIL DASHBOARD / APP INTERNE DÉTECTÉ
Tu génères une interface admin/dashboard. Applique automatiquement :

**Design :**
- Interface fonctionnelle : Sidebar + contenu principal
- Couleurs sobres : gris, bleu, accents pour actions
- Composants UI clairs : cards, tables, boutons

**Composants React à créer :**
- Sidebar : navigation avec icônes Lucide, collapsible
- TopBar : recherche, notifications badge, profil dropdown
- StatCard : KPI card avec icône, valeur, variation
- DataTable : tableau triable avec pagination (useState)
- ChartCard : wrapper pour Chart.js (useEffect pour init)
- FormModal : modal CRUD avec validation
- UserManagement : liste utilisateurs avec rôles
- SettingsPanel : configuration

**Tables SQLite :** selon domaine métier + users, roles, audit_logs
**Pages React :** Dashboard, Users, Settings, Reports + pages métier`
  },
  fitness: {
    keywords: ['sport', 'fitness', 'salle de sport', 'coach', 'nutrition', 'musculation', 'entraînement', 'gym', 'crossfit', 'yoga'],
    prompt: `## PROFIL FITNESS / SPORT DÉTECTÉ
Tu génères un site fitness. Applique automatiquement :

**Design :**
- Style énergique : noir, couleurs vives (orange, vert)
- Photos dynamiques
- Typographie forte

**Composants React à créer :**
- Header avec logo, planning, espace membre
- HeroSection motivant avec CTA "Commencer"
- ScheduleGrid : planning des cours interactif (useState pour jour)
- ClassCard : activité, coach, horaire, places
- CoachCard : photo, spécialités, certifications
- PricingSection : formules d'abonnement
- TransformationGallery : avant/après
- TestimonialsSection : membres
- ContactSection : localisation

**Tables SQLite :** classes, coaches, members, subscriptions, schedules
**Pages React :** Home, Schedule, Classes, Coaches, Pricing, Contact`
  }
};

// ─── DETECT SECTOR FROM BRIEF ───
function detectSectorProfile(brief) {
  if (!brief) return null;
  const b = brief.toLowerCase();

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
  'système', 'systeme', 'gestion', 'admin', 'clinique', 'medical', 'médical',
  'upload', 'fichier', 'socket', 'temps réel', 'stripe', 'paiement',
  'calendrier', 'réservation', 'api externe', 'intégration', 'webhook',
  'notification', 'email', 'marketplace', 'multi-vendeur'
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
  return complexity === 'complex' ? 64000 : 32000;
}

function getModelForProject() {
  return 'claude-sonnet-4-20250514';
}



// ─── CHAT SYSTEM PROMPT (modifications on existing projects) ───
// Same architecture as SYSTEM_PROMPT — hierarchical, positive, example-driven.
// Key difference: CHAT is for SURGICAL edits on existing code. SYSTEM is for NEW generation.
const CHAT_SYSTEM_PROMPT = `Tu es Prestige AI, un developpeur senior autonome. Tu modifies des applications React existantes avec precision chirurgicale.

═══ CONTEXTE ═══

Tu recois la CARTE du projet (structure, routes, types, schemas) + le code de 2-5 fichiers pertinents.
Pour tout autre fichier, utilise view_file(path) pour le lire. Ne suppose jamais le contenu d'un fichier non lu.
Si tu dois modifier un fichier qui n'est pas dans le contexte : view_file d'abord, puis edit_file/line_replace.

═══ CRITICAL ═══

1. SCOPE : modifie UNIQUEMENT les fichiers concernes par la demande. "Modifie Reports.tsx" = tu touches Reports.tsx et rien d'autre. Exception : App.tsx pour une nouvelle route.
2. LIRE PUIS ECRIRE : view_file(path) avant chaque edit_file ou line_replace. Si le fichier n'est pas dans le contexte, appelle view_file d'abord.
3. FULLSTACK ATOMIQUE : chaque nouveau fetch('/api/...') a sa route backend dans la meme reponse.
4. GROS FICHIERS (> 200 lignes) : view_file(path, start, end) → line_replace. Pas edit_file — le matching echoue.
5. TOOL CALLS PARALLELES : toutes les operations dans UNE reponse.

═══ IMPORTANT ═══

6. METHODE : view_file → edit_file/line_replace → verify_project. C'est tout. Pas d'exploration, pas de refactoring.
7. STACK : React 19 + Vite 6 + Tailwind 3 + Radix UI + Sonner. Imports @/ alias. server.js = CommonJS.
8. ROBUSTESSE : export default function, imports declares, pas de require() en .tsx, pas de mots reserves JS comme variables.
9. COMPOSANTS UI : Button, Card, Input, Dialog, etc. depuis @/components/ui/. cn() depuis @/lib/utils. toast depuis sonner.
10. VERIFICATION : apres modifications → verify_project. Si erreur → corrige immediatement. Tu es responsable du resultat.

═══ PREFERENCE ═══

11. Reponse texte : 1-2 lignes. Pas de code dans le texte, pas d'explication.
12. Si ambiguite → pose UNE question avant de coder.
13. Modules NPM disponibles : pdfkit, nodemailer, stripe, socket.io, multer, sharp, qrcode, exceljs, csv-parse, marked, axios.

═══ EXEMPLE ═══

Demande : "Remplace les donnees mock dans Reports.tsx par des vrais appels API"

1. view_file("src/pages/internal/Reports.tsx") → lire le code actuel
2. view_file("server.js", 100, 150) → verifier les routes existantes
3. edit_file("src/pages/internal/Reports.tsx", search: "const reports = [...]", replace: "const [reports, setReports] = useState([]); useEffect(() => { fetch('/api/internal/reports').then(...)...")
4. line_replace("server.js", ...) → ajouter route GET /api/internal/reports + SELECT * FROM reports
5. Texte : "Reports.tsx connecte a l'API. Route GET /api/internal/reports creee."`;

// ─── SECTOR SUGGESTIONS ───
const SECTOR_SUGGESTIONS = {
  health: [
    'Ajouter un système de prise de rendez-vous en ligne',
    'Créer un espace patient sécurisé avec historique médical',
    'Intégrer une carte Google Maps pour localiser le cabinet',
    'Ajouter un formulaire de contact d\'urgence',
    'Créer une page FAQ santé avec les questions fréquentes',
  ],
  restaurant: [
    'Ajouter un système de réservation en ligne',
    'Créer un menu interactif avec filtres (végétarien, sans gluten)',
    'Intégrer un système de commande à emporter',
    'Ajouter une galerie photos des plats',
    'Créer un programme de fidélité client',
  ],
  ecommerce: [
    'Ajouter des filtres de recherche avancés (prix, catégorie)',
    'Créer un système d\'avis clients avec étoiles',
    'Intégrer un système de codes promo',
    'Ajouter une page de suivi de commande',
    'Créer des suggestions de produits similaires',
  ],
  corporate: [
    'Ajouter une section témoignages clients animée',
    'Créer une page équipe avec photos et bios',
    'Intégrer un formulaire de demande de devis',
    'Ajouter un blog/actualités de l\'entreprise',
    'Créer une page carrières avec offres d\'emploi',
  ],
  saas: [
    'Ajouter un tableau de pricing comparatif',
    'Créer un dashboard utilisateur avec statistiques',
    'Intégrer un système d\'onboarding étape par étape',
    'Ajouter une page changelog/mises à jour',
    'Créer une section FAQ avec recherche',
  ],
  education: [
    'Ajouter un catalogue de cours avec filtres',
    'Créer un espace étudiant avec suivi de progression',
    'Intégrer un système de quiz/évaluation',
    'Ajouter un calendrier des formations',
    'Créer un système de certificats téléchargeables',
  ],
  realestate: [
    'Ajouter une recherche avancée avec filtres (prix, surface, quartier)',
    'Créer des fiches bien détaillées avec galerie photos',
    'Intégrer un simulateur de crédit immobilier',
    'Ajouter un formulaire de visite en ligne',
    'Créer une carte interactive des biens disponibles',
  ],
  hotel: [
    'Ajouter un moteur de réservation avec calendrier',
    'Créer une galerie immersive des chambres',
    'Intégrer un système d\'avis clients TripAdvisor-style',
    'Ajouter une page spa/services avec réservation',
    'Créer un programme de fidélité hôtelier',
  ],
  fitness: [
    'Ajouter un planning interactif des cours',
    'Créer un espace membre avec suivi de progression',
    'Intégrer un système d\'abonnement en ligne',
    'Ajouter des vidéos d\'exercices par catégorie',
    'Créer un calculateur IMC/calories',
  ],
  portfolio: [
    'Ajouter des filtres par catégorie (branding, web, print)',
    'Créer des études de cas détaillées avec process',
    'Intégrer un formulaire de brief pour les clients',
    'Ajouter un carrousel interactif des projets',
    'Créer une page processus de travail avec timeline',
  ],
  nonprofit: [
    'Créer un système de suivi des campagnes de dons',
    'Ajouter un espace bénévole avec inscriptions',
    'Intégrer un tableau de bord d\'impact',
    'Créer un blog/actualités de l\'association',
    'Ajouter un système d\'événements avec localisation',
  ],
  dashboard: [
    'Créer des graphiques analytics interactifs (Chart.js)',
    'Ajouter un système de notifications/alertes',
    'Implémenter l\'export de données (CSV, PDF)',
    'Créer un système de rapports automatisés',
    'Ajouter un mode dark système-wide',
  ],
  default: [
    'Ajouter un formulaire de contact avec validation',
    'Créer une section témoignages clients animée',
    'Intégrer des animations Tailwind au scroll',
    'Ajouter un mode dark avec toggle',
    'Optimiser le SEO avec meta tags et sémantique HTML',
  ]
};

function getSuggestionsForSector(brief) {
  if (!brief) return SECTOR_SUGGESTIONS.default;
  const b = brief.toLowerCase();
  if (b.match(/santé|médical|hôpital|clinique|docteur|médecin/)) return SECTOR_SUGGESTIONS.health;
  if (b.match(/restaurant|boulangerie|café|bistro|cuisine|menu/)) return SECTOR_SUGGESTIONS.restaurant;
  if (b.match(/e-commerce|boutique|magasin|vente|produit/)) return SECTOR_SUGGESTIONS.ecommerce;
  if (b.match(/corporate|entreprise|société|cabinet|conseil/)) return SECTOR_SUGGESTIONS.corporate;
  if (b.match(/saas|logiciel|plateforme|dashboard|application/)) return SECTOR_SUGGESTIONS.saas;
  if (b.match(/éducation|école|formation|cours|université/)) return SECTOR_SUGGESTIONS.education;
  if (b.match(/immobilier|agence|bien|appartement|maison/)) return SECTOR_SUGGESTIONS.realestate;
  if (b.match(/hôtel|hébergement|chambre|réservation|séjour/)) return SECTOR_SUGGESTIONS.hotel;
  if (b.match(/fitness|sport|gym|salle|coach|musculation/)) return SECTOR_SUGGESTIONS.fitness;
  if (b.match(/portfolio|photographe|designer|artiste|créatif|freelance/)) return SECTOR_SUGGESTIONS.portfolio;
  if (b.match(/association|ong|humanitaire|bénévolat|don|fondation/)) return SECTOR_SUGGESTIONS.nonprofit;
  if (b.match(/dashboard|admin|gestion|back.?office|erp|tableau de bord|crm/)) return SECTOR_SUGGESTIONS.dashboard;
  return SECTOR_SUGGESTIONS.default;
}

// ─── SMART FILE DETECTION (React multi-file) ───
function detectAffectedFiles(message) {
  const m = message.toLowerCase();
  const files = {
    packageJson: false,
    viteConfig: false,
    serverJs: false,
    indexHtml: false,
    mainJsx: false,
    appJsx: false,
    indexCss: false,
    components: [],
    pages: []
  };

  // CSS/style/theme changes
  if (m.match(/couleur|color|css|style|police|font|thème|dark|theme|tailwind|palette|gradient|ombre|shadow|spacing|margin|padding/)) {
    files.indexCss = true;
  }
  // Layout/header changes
  if (m.match(/header|navbar|barre de navigation|logo|menu principal/)) {
    files.components.push('Header');
  }
  // Footer changes
  if (m.match(/footer|pied de page|copyright|mentions légales/)) {
    files.components.push('Footer');
  }
  // Backend/API changes
  if (m.match(/api|endpoint|base de données|table|sql|auth|login|password|envoi|notification|upload|pdf|stripe|paiement|webhook|socket|temps réel|chat|export csv|import csv|middleware|serveur|backend|route api/)) {
    files.serverJs = true;
  }
  // Package/dependency changes
  if (m.match(/package|dépendance|module|install|npm|version|librairie/)) {
    files.packageJson = true;
  }
  // Vite/build config
  if (m.match(/vite|proxy|build|hmr|config vite/)) {
    files.viteConfig = true;
  }
  // HTML meta/title changes
  if (m.match(/title|titre page|meta|favicon|og:|open graph|seo head/)) {
    files.indexHtml = true;
  }
  // React routing / page addition
  if (m.match(/nouvelle page|ajouter.*page|route react|navigation|lien|menu/)) {
    files.appJsx = true;
  }
  // Feature addition — likely touches backend + components + routing
  if (m.match(/ajoute|ajout|crée|créer|intègre|implémente|nouveau|nouvelle|construis/)) {
    files.serverJs = true;
    files.appJsx = true;
  }
  // Specific page mentions
  if (m.match(/page d'accueil|home|hero|landing/)) files.pages.push('Home');
  if (m.match(/contact|formulaire de contact/)) files.pages.push('Contact');
  if (m.match(/à propos|about/)) files.pages.push('About');
  if (m.match(/menu|carte|plats/)) files.pages.push('Menu');
  if (m.match(/réservation|booking/)) files.pages.push('Reservation');
  if (m.match(/galerie|gallery|photos/)) files.pages.push('Gallery');
  if (m.match(/pricing|tarifs|abonnement/)) files.pages.push('Pricing');

  // If nothing detected, assume component-level change
  const hasAny = files.packageJson || files.serverJs || files.indexCss || files.viteConfig ||
    files.indexHtml || files.appJsx || files.components.length > 0 || files.pages.length > 0;
  if (!hasAny) {
    files.appJsx = true;
  }
  return files;
}

// Parse generated code into individual files (supports multi-file React structure)
function parseCodeFiles(code) {
  if (!code) return {};
  const result = {};
  const sections = code.split(/### /).filter(s => s.trim());
  for (const s of sections) {
    const nl = s.indexOf('\n');
    if (nl === -1) continue;
    const fn = s.substring(0, nl).trim();
    const content = s.substring(nl + 1).trim();
    if (fn && content) result[fn] = content;
  }
  return result;
}

// ─── CONVERSATION CONTEXT BUILDER (React multi-file) ───
// projectMemory: optional string of free-form preferences saved by the agent on the
// project (e.g., "client n'aime pas le bleu", "toujours sobre"). Injected at the TOP
// of the context so Claude sees it before everything else.
function buildConversationContext(project, messages, userMessage, configuredKeys, llmSelectedFiles, projectMemory) {
  const context = [];

  // ── Read .prestige/rules.md (learned rules from past errors) ──
  let projectRules = '';
  if (project && project.id) {
    try {
      const fs = require('fs');
      const pathMod = require('path');
      const DOCKER_PROJECTS_DIR = process.env.DOCKER_PROJECTS_DIR || '/data/projects';
      const rulesPath = pathMod.join(DOCKER_PROJECTS_DIR, String(project.id), '.prestige', 'rules.md');
      if (fs.existsSync(rulesPath)) {
        const rulesContent = fs.readFileSync(rulesPath, 'utf8').trim();
        if (rulesContent.length > 0) {
          projectRules = rulesContent;
        }
      }
    } catch (_) { /* rules file not found or unreadable — not critical */ }
  }

  if (project && project.generated_code) {
    const files = parseCodeFiles(project.generated_code);
    const affected = detectAffectedFiles(userMessage);
    const allFileNames = Object.keys(files);

    // ════════════════════════════════════════════════════════════════════
    // PART 1: PROJECT MAP (~2K tokens) — sent to EVERY request
    // Claude sees the full architecture without reading every file.
    // This is the "carte" of the project: structure, routes, types, schemas.
    // ════════════════════════════════════════════════════════════════════

    let projectMap = '';

    // Inject learned rules FIRST (highest priority)
    if (projectRules) {
      projectMap += `RÈGLES DU PROJET (apprises des erreurs précédentes) :\n${projectRules}\n\n`;
    }
    if (projectMemory && typeof projectMemory === 'string' && projectMemory.trim().length > 0) {
      projectMap += `MEMOIRE PROJET :\n${projectMemory.trim()}\n\n`;
    }

    projectMap += `PROJET REACT "${project.title || 'Sans titre'}" — ${allFileNames.length} fichiers\nBrief: ${project.brief || '-'}\n`;

    if (configuredKeys && configuredKeys.length > 0) {
      projectMap += 'APIs: ' + configuredKeys.map(k => k.env_name).join(', ') + '\n';
    }

    // ── Backend summary (routes + tables — NOT the full server.js code) ──
    const serverJs = files['server.js'] || '';
    const serverLines = serverJs.split('\n').length;
    const routes = (serverJs.match(/app\.(get|post|put|delete)\s*\(\s*['"`]([^'"`]+)/g) || [])
      .map(r => r.replace(/app\.(get|post|put|delete)\s*\(\s*['"`]/, (m, method) => method.toUpperCase() + ' '))
      .slice(0, 30);
    const tables = (serverJs.match(/CREATE TABLE IF NOT EXISTS (\w+)/g) || []).map(t => t.replace('CREATE TABLE IF NOT EXISTS ', ''));

    if (serverJs) {
      projectMap += `\nBACKEND (server.js — ${serverLines} lignes) :\n`;
      projectMap += `  Routes (${routes.length}): ${routes.join(', ') || 'aucune'}\n`;
      projectMap += `  Tables (${tables.length}): ${tables.join(', ') || 'aucune'}\n`;
    }

    // ── React routes ──
    const appJsx = files['src/App.tsx'] || '';
    const reactRoutes = (appJsx.match(/<Route\s+path="([^"]+)"/g) || []).map(r => r.match(/path="([^"]+)"/)?.[1]).filter(Boolean);
    if (reactRoutes.length > 0) {
      projectMap += `  Routes React: ${reactRoutes.join(', ')}\n`;
    }

    // ── TypeScript interfaces & SQL schemas ──
    const tsInterfaces = [];
    const sqlSchemas = [];

    for (const [fn, content] of Object.entries(files)) {
      if (!content) continue;

      if (fn.endsWith('.tsx') || fn.endsWith('.ts')) {
        // Extract interfaces
        const ifaceRegex = /(?:export\s+)?interface\s+(\w+)\s*\{([^}]*)\}/g;
        let match;
        while ((match = ifaceRegex.exec(content)) !== null) {
          const fields = (match[2].match(/(\w+)\s*[?:]?\s*:/g) || [])
            .map(f => f.replace(/\s*[?:]?\s*:$/, '').trim()).filter(Boolean);
          if (fields.length > 0) tsInterfaces.push(`  ${match[1]} (${fn}): { ${fields.join(', ')} }`);
        }
        // Extract type aliases
        const typeRegex = /(?:export\s+)?type\s+(\w+)\s*=\s*\{([^}]*)\}/g;
        while ((match = typeRegex.exec(content)) !== null) {
          const fields = (match[2].match(/(\w+)\s*[?:]?\s*:/g) || [])
            .map(f => f.replace(/\s*[?:]?\s*:$/, '').trim()).filter(Boolean);
          if (fields.length > 0) tsInterfaces.push(`  ${match[1]} (${fn}): { ${fields.join(', ')} }`);
        }
      }

      if (fn === 'server.js' || fn.endsWith('.js')) {
        const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([^)]+)\)/gi;
        let match;
        while ((match = tableRegex.exec(content)) !== null) {
          const columns = match[2].split(',').map(c => c.trim().split(/\s+/)[0])
            .filter(c => c && !c.match(/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|INDEX)$/i));
          if (columns.length > 0) sqlSchemas.push(`  ${match[1]}(${columns.join(', ')})`);
        }
      }
    }

    if (tsInterfaces.length > 0 || sqlSchemas.length > 0) {
      projectMap += '\nTYPES & SCHEMAS (noms de champs EXACTS) :\n';
      if (tsInterfaces.length > 0) projectMap += tsInterfaces.join('\n') + '\n';
      if (sqlSchemas.length > 0) projectMap += sqlSchemas.join('\n') + '\n';
    }

    // ── File tree with metadata (like Lovable: name + size + key info) ──
    projectMap += `\nFICHIERS DU PROJET (${allFileNames.length}) :\n`;
    for (const fn of allFileNames) {
      const content = files[fn] || '';
      const lines = content.split('\n').length;

      if (fn === 'server.js' || fn === 'src/App.tsx' || fn === 'package.json') {
        // Already summarized above — just show size
        projectMap += `  ${fn} (${lines} lignes)\n`;
      } else if (fn.startsWith('src/components/') || fn.startsWith('src/pages/') || fn.startsWith('src/hooks/') || fn.startsWith('src/lib/')) {
        // Components/pages: show imports + hooks (1 line per file)
        const deps = (content.match(/from\s+['"]([^'"]+)['"]/g) || [])
          .map(i => i.match(/['"]([^'"]+)['"]/)?.[1] || '').filter(Boolean);
        const hasFetch = content.includes('fetch(');
        let info = `  ${fn} (${lines}L)`;
        if (deps.length > 0) info += ` deps:[${deps.slice(0, 4).join(', ')}${deps.length > 4 ? '...' : ''}]`;
        if (hasFetch) info += ' [fetch]';
        projectMap += info + '\n';
      } else {
        projectMap += `  ${fn} (${lines}L)\n`;
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // PART 2: FILE SELECTION — only 2-5 relevant files sent as full code
    // Claude uses view_file() to read any other file it needs.
    // ════════════════════════════════════════════════════════════════════

    const MAX_FILES_TO_SEND = 5;
    const filesToSend = [];
    const isMajor = /redesign complet|refonte|tout changer|full rewrite|système complet|erp|multi.?rôle|plan validé|INSTRUCTION OBLIGATOIRE/i.test(userMessage);

    if (isMajor || allFileNames.length <= 8) {
      allFileNames.forEach(f => filesToSend.push(f));
    } else if (llmSelectedFiles && llmSelectedFiles.length > 0) {
      for (const f of llmSelectedFiles) { if (files[f] && filesToSend.length < MAX_FILES_TO_SEND) filesToSend.push(f); }
    } else {
      const msgLower = userMessage.toLowerCase();

      // Priority 1: Files mentioned by name
      for (const fn of allFileNames) {
        if (filesToSend.length >= MAX_FILES_TO_SEND) break;
        const baseName = fn.split('/').pop().replace(/\.(tsx|ts|jsx|js)$/, '').toLowerCase();
        if (baseName.length > 2 && msgLower.includes(baseName) && !filesToSend.includes(fn)) filesToSend.push(fn);
      }

      // Priority 2: Files mentioned by path
      const pathMatches = userMessage.match(/src\/[^\s:,'"]+\.(tsx|ts|jsx)/g);
      if (pathMatches) {
        for (const p of pathMatches) {
          if (files[p] && !filesToSend.includes(p) && filesToSend.length < MAX_FILES_TO_SEND) filesToSend.push(p);
        }
      }

      // Priority 3: Concept matching
      const conceptKeywords = msgLower.match(/actualit|partenaire|centre|contact|equipe|service|produit|propos|mission|blog|galerie|t[ée]moignage|formation|public.?cible|accueil|rapport|notification|dashboard|profil|param/g);
      if (conceptKeywords) {
        for (const fn of allFileNames) {
          if (filesToSend.length >= MAX_FILES_TO_SEND || filesToSend.includes(fn)) continue;
          const fnLower = fn.toLowerCase();
          for (const kw of conceptKeywords) {
            if (fnLower.includes(kw.substring(0, 5))) { filesToSend.push(fn); break; }
          }
        }
      }

      // Priority 4: server.js only if backend is touched
      if (affected.serverJs && files['server.js'] && !filesToSend.includes('server.js')) filesToSend.push('server.js');

      // Priority 5: Fallback to detectAffectedFiles
      if (filesToSend.length === 0) {
        for (const comp of affected.components) {
          const key = `src/components/${comp}.tsx`;
          if (files[key] && filesToSend.length < MAX_FILES_TO_SEND) filesToSend.push(key);
        }
        for (const page of affected.pages) {
          const key = `src/pages/${page}.tsx`;
          if (files[key] && filesToSend.length < MAX_FILES_TO_SEND) filesToSend.push(key);
        }
      }
    }

    // Always include App.tsx (small, needed for routing)
    if (!filesToSend.includes('src/App.tsx') && files['src/App.tsx']) filesToSend.push('src/App.tsx');

    const uniqueFiles = [...new Set(filesToSend)].slice(0, isMajor ? 999 : MAX_FILES_TO_SEND + 1);
    const notSent = allFileNames.filter(f => !uniqueFiles.includes(f));

    // ════════════════════════════════════════════════════════════════════
    // PART 3: Assemble context — map + selected file contents
    // ════════════════════════════════════════════════════════════════════

    let projectContext = projectMap;
    projectContext += `\n══ CODE DES FICHIERS PERTINENTS (${uniqueFiles.length}/${allFileNames.length}) ══`;
    for (const fn of uniqueFiles) {
      projectContext += `\n\n### ${fn}\n${files[fn]}`;
    }
    if (notSent.length > 0) {
      projectContext += `\n\n══ AUTRES FICHIERS (utilise view_file pour les lire AVANT de les modifier) ══\n${notSent.join(', ')}`;
    }

    context.push({ role: 'user', content: projectContext });
    context.push({ role: 'assistant', content: `Compris. Je connais la structure React du projet. Qu'est-ce que vous souhaitez modifier ?` });
  } else if (project) {
    let projectContext = `PROJET: "${project.title || 'Sans titre'}" — ${project.brief || 'pas de brief'}`;
    if (projectMemory && typeof projectMemory === 'string' && projectMemory.trim().length > 0) {
      projectContext = `MEMOIRE PROJET (preferences persistantes a respecter) :\n${projectMemory.trim()}\n\n` + projectContext;
    }
    if (configuredKeys && configuredKeys.length > 0) {
      projectContext += `\nAPIs configurées: ${configuredKeys.map(k => k.env_name).join(', ')}`;
    }
    context.push({ role: 'user', content: projectContext });
    context.push({ role: 'assistant', content: `Je connais votre projet. Dites-moi ce que vous souhaitez.` });
  }

  // Last 4 chat messages — NORMALIZED for Anthropic API requirements:
  //   1. Only 'user' and 'assistant' roles are accepted ('plan', 'system', etc. are dropped)
  //   2. Consecutive same-role messages MUST be merged (API rejects user→user or assistant→assistant)
  //   3. Empty content is rejected
  // Without this normalization, approving a plan (which inserts 'plan' + 'user' markers
  // in history) produces an invalid message sequence → Anthropic 400 Bad Request.
  if (messages && messages.length > 0) {
    const validMessages = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
      .filter(m => m.content && typeof m.content === 'string' && !m.content.startsWith('### '))
      .filter(m => m.content.trim().length > 0);

    // Take more than 4 — we may collapse after merging consecutive same-role
    const candidates = validMessages.slice(-8);

    // Merge consecutive same-role messages (preserves content, ensures strict alternation)
    const merged = [];
    for (const m of candidates) {
      const last = merged[merged.length - 1];
      const truncated = m.content.substring(0, 1000);
      if (last && last.role === m.role) {
        last.content = last.content + '\n\n' + truncated;
      } else {
        merged.push({ role: m.role, content: truncated });
      }
    }

    // Keep only the last 4 after merging, and push to context
    for (const m of merged.slice(-4)) {
      context.push(m);
    }
  }

  // Ensure the final userMessage doesn't create two consecutive 'user' messages.
  // If the last context entry is already 'user', merge into it.
  const lastContextMsg = context[context.length - 1];
  if (lastContextMsg && lastContextMsg.role === 'user') {
    lastContextMsg.content = lastContextMsg.content + '\n\n' + userMessage;
  } else {
    context.push({ role: 'user', content: userMessage });
  }

  return context;
}

// ─── SMART BRIEF ANALYZER ───
function analyzeBrief(brief) {
  const analysis = {
    projectType: 'web',
    complexity: 'medium',
    suggestedStack: ['React', 'Vite', 'TailwindCSS'],
    questions: [],
    risks: []
  };

  const b = brief.toLowerCase();

  if (b.includes('dashboard') || b.includes('analytics')) analysis.projectType = 'dashboard';
  else if (b.includes('e-commerce') || b.includes('boutique')) analysis.projectType = 'ecommerce';
  else if (b.includes('logiciel') || b.includes('erp') || b.includes('crm')) analysis.projectType = 'software';

  const complexityWords = ['paiement', 'authentification', 'base de données', 'temps réel', 'api', 'integration'];
  const count = complexityWords.filter(w => b.includes(w)).length;
  if (count >= 3) analysis.complexity = 'high';
  else if (count >= 1) analysis.complexity = 'medium';
  else analysis.complexity = 'low';

  return analysis;
}

// ─── BUILD PROFESSIONAL PROMPT ───
function buildProfessionalPrompt(userMessage, project, availableApis) {
  let prompt = userMessage;
  if (availableApis && availableApis.length > 0) {
    prompt += `\n\n[APIs disponibles: ${availableApis.map(a => `${a.name} (${a.service})`).join(', ')}]`;
  }
  return prompt;
}

// ─── LLM FILE SELECTION (like Lovable's GPT-4 Mini pre-selection) ───
// Uses a fast/cheap model to decide which files are relevant BEFORE sending to Sonnet.
// Reduces context size → fewer errors, faster generation, lower cost.
function buildFileSelectionPrompt(projectStructure, userMessage) {
  return `Tu es un assistant de sélection de fichiers. Un utilisateur veut modifier un projet React.

STRUCTURE DU PROJET:
${projectStructure}

DEMANDE DE L'UTILISATEUR: "${userMessage}"

Réponds avec UNIQUEMENT la liste des fichiers à envoyer au développeur, un par ligne.
Inclus TOUJOURS src/App.tsx.
Inclus les fichiers directement concernés par la demande.
Si la demande touche le style/couleurs, inclus src/index.css.
Si la demande touche le backend/API, inclus server.js.
N'inclus PAS package.json, vite.config.js, tsconfig.json, index.html, src/main.tsx (ils sont canoniques).
N'inclus PAS les fichiers src/components/ui/* (ils sont canoniques).

FICHIERS:`;
}

function parseFileSelectionResponse(response) {
  if (!response) return [];
  return response.split('\n')
    .map(l => l.trim().replace(/^[-•*]\s*/, '').replace(/^`|`$/g, ''))
    .filter(l => l && (l.endsWith('.tsx') || l.endsWith('.ts') || l.endsWith('.js') || l.endsWith('.css') || l.endsWith('.json')))
    .filter(l => !l.includes('node_modules'));
}

// ─── BACK-TESTING: Validate generated code quality ───
// Runs automated checks after generation to catch common issues
function runBackTests(files) {
  const issues = [];

  // Test 1: Every fetch('/api/...') in frontend must have a matching route in server.js
  // The backend runs on port 3000, Vite proxies /api → localhost:3000.
  // If a page fetches '/api/public/news' but server.js has no such route → 404 error.
  const serverCode = files['server.js'] || '';
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    // Extract all API URLs from fetch() calls
    const fetchUrls = content.match(/fetch\s*\(\s*[`'"]([^`'"]+)[`'"]/g) || [];
    for (const f of fetchUrls) {
      const url = f.match(/fetch\s*\(\s*[`'"]([^`'"]+)/)?.[1];
      if (!url || !url.startsWith('/api/')) continue;
      // Normalize: /api/public/news → /api/public/news (remove query params)
      const cleanUrl = url.split('?')[0].replace(/\/\d+$/, '/:id').replace(/\$\{[^}]+\}/g, ':id');
      // Check if server.js has a matching route
      if (!serverCode) {
        // No server.js at all → fetch will definitely fail
        issues.push({
          file: fn,
          issue: 'FETCH_NO_ROUTE',
          message: `fetch('${url}') mais server.js n'existe pas. Cree server.js avec la route, OU remplace par des donnees en dur (const data = [...]).`
        });
      } else if (!serverCode.includes(cleanUrl) && !serverCode.includes(url.split('?')[0])) {
        // Fuzzy check: maybe the route uses a different pattern
        const routePart = cleanUrl.replace('/api/', '').split('/')[0];
        if (!serverCode.includes(`'/api/${routePart}`) && !serverCode.includes(`"/api/${routePart}`)) {
          issues.push({
            file: fn,
            issue: 'FETCH_NO_ROUTE',
            message: `fetch('${url}') n'a PAS de route correspondante dans server.js. Ajoute la route GET dans server.js avec les donnees, OU remplace par des donnees en dur (const data = [...]).`
          });
        }
      }
    }
  }

  // Test 2: server.js must be CommonJS
  const server = files['server.js'] || '';
  if (server && /^import\s+\w+\s+from\s+['"]/m.test(server)) {
    issues.push({ file: 'server.js', issue: 'ESM_IMPORTS', message: 'server.js uses ESM imports — must be CommonJS (require)' });
  }

  // Test 3: server.js must listen on 0.0.0.0
  if (server && !server.includes("'0.0.0.0'") && !server.includes('"0.0.0.0"')) {
    issues.push({ file: 'server.js', issue: 'LOCALHOST_ONLY', message: 'server.js does not listen on 0.0.0.0 — container will be unreachable' });
  }

  // Test 4: No invalid color tokens
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx') && !fn.endsWith('.ts')) continue;
    if (fn.startsWith('src/components/ui/') || fn.startsWith('src/lib/') || fn.startsWith('src/hooks/')) continue;
    const invalidTokens = content.match(/var\(--color-[a-z-]+\)/g) || [];
    if (invalidTokens.length > 0) {
      issues.push({ file: fn, issue: 'VAR_IN_CLASSNAME', message: `Uses var() in className: ${invalidTokens.slice(0, 3).join(', ')}` });
    }
    const hexInClass = content.match(/className="[^"]*#[0-9a-fA-F]{3,8}[^"]*"/g) || [];
    if (hexInClass.length > 0) {
      issues.push({ file: fn, issue: 'HEX_IN_CLASSNAME', message: 'Uses hex colors in className' });
    }
  }

  // Test 5: All imports resolve to existing files
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx') && !fn.endsWith('.ts')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    const imports = content.match(/from ['"]@\/([^'"]+)['"]/g) || [];
    for (const imp of imports) {
      const importPath = imp.match(/from ['"]@\/([^'"]+)['"]/)?.[1];
      if (!importPath) continue;
      if (importPath.startsWith('components/ui/') || importPath.startsWith('lib/') || importPath.startsWith('hooks/')) continue;
      const resolved = 'src/' + importPath + (importPath.endsWith('.tsx') || importPath.endsWith('.ts') ? '' : '.tsx');
      if (!files[resolved] && !files[resolved.replace('.tsx', '.ts')]) {
        issues.push({ file: fn, issue: 'MISSING_IMPORT', message: `Imports @/${importPath} but file not found` });
      }
    }
  }

  // Test 6: App.tsx routes must match existing page files
  const app = files['src/App.tsx'] || '';
  const routeImports = app.match(/import\s+(\w+)\s+from\s+['"]@\/pages\/(\w+)['"]/g) || [];
  for (const ri of routeImports) {
    const pageName = ri.match(/from\s+['"]@\/pages\/(\w+)['"]/)?.[1];
    if (pageName && !files[`src/pages/${pageName}.tsx`]) {
      issues.push({ file: 'src/App.tsx', issue: 'MISSING_PAGE', message: `Route imports @/pages/${pageName} but file not generated` });
    }
  }

  // Test 7: index.css must have @tailwind directives (Tailwind 3)
  const css = files['src/index.css'] || '';
  if (css && !css.includes('@tailwind base')) {
    issues.push({ file: 'src/index.css', issue: 'NO_TAILWIND', message: 'Missing @tailwind base/components/utilities directives' });
  }

  // Test 8: JSX fragments must be properly closed (<> must have </>)
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx') && !fn.endsWith('.jsx')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    const opens = (content.match(/<>/g) || []).length;
    const closes = (content.match(/<\/>/g) || []).length;
    if (opens > closes) {
      issues.push({ file: fn, issue: 'UNCLOSED_FRAGMENT', message: `${opens} fragment(s) <> but only ${closes} closing </> — JSX will crash` });
    }
  }

  // Test 9: App.tsx must NOT contain BrowserRouter (it's in main.tsx)
  if (app && /import.*BrowserRouter/.test(app)) {
    issues.push({ file: 'src/App.tsx', issue: 'DUPLICATE_ROUTER', message: 'BrowserRouter must be in main.tsx, not App.tsx — causes double router error' });
  }

  // Test 10: No hardcoded Tailwind color classes — use semantic tokens (bg-primary, text-muted-foreground, etc.)
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    if (/className="[^"]*\b(bg-gray-|text-gray-|bg-blue-|text-blue-|bg-red-|text-red-|bg-green-|text-green-|border-gray-)/.test(content)) {
      issues.push({ file: fn, issue: 'HARDCODED_COLORS', message: 'Uses hardcoded Tailwind colors (bg-gray-*, text-blue-*) — use semantic tokens (bg-muted, text-primary, bg-secondary, etc.)' });
    }
  }

  // Test 11: index.css must not use theme() function
  if (css && css.includes('theme(')) {
    issues.push({ file: 'src/index.css', issue: 'THEME_FUNCTION', message: 'Uses theme() function — not supported. Colors are in tailwind.config.js.' });
  }

  // Test 12: index.css should be minimal — colors belong in tailwind.config.js
  if (css && /var\(--color-/.test(css)) {
    issues.push({ file: 'src/index.css', issue: 'CSS_VARS_IN_CSS', message: 'Uses var(--color-*) in index.css — colors must be in tailwind.config.js as hsl() values.' });
  }

  // Test 13: picsum.photos without seed (random images on refresh)
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    const randomPicsum = (content.match(/picsum\.photos\/\d+\/\d+/g) || []).filter(u => !u.includes('seed'));
    if (randomPicsum.length > 0) {
      issues.push({ file: fn, issue: 'RANDOM_IMAGES', message: `${randomPicsum.length} image(s) picsum sans seed — change to picsum.photos/seed/descriptif/W/H` });
    }
  }

  // Test 14: Duplicate imports in any file
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx') && !fn.endsWith('.ts')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    const imports = content.match(/^import .+$/gm) || [];
    const unique = new Set(imports);
    if (imports.length !== unique.size) {
      issues.push({ file: fn, issue: 'DUPLICATE_IMPORTS', message: `${imports.length - unique.size} import(s) en double` });
    }
  }

  // Test 15: Component without export default
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx')) continue;
    if (fn.startsWith('src/components/ui/') || fn === 'src/main.tsx') continue;
    if (!content.includes('export default') && !content.includes('export {')) {
      issues.push({ file: fn, issue: 'NO_EXPORT', message: 'Missing export default — component will not render' });
    }
  }

  // ─── LUCIDE-REACT HALLUCINATION CHECK (ERROR — triggers auto-fix loop) ───
  // Claude often invents lucide icon names that don't exist (Live, Profile, Dashboard, etc.).
  // The runtime error "does not provide an export named X" causes a blank iframe.
  // We catch the most common hallucinations BEFORE the user sees the white screen.
  //
  // This is NOT a complete validation against the full lucide-react export list — just a
  // blacklist of confirmed hallucinations. False positives = zero. False negatives possible
  // (rare hallucination not in this list); those are caught by the runtime visual check.
  const LUCIDE_HALLUCINATIONS = {
    'Live': 'Radio (ou Video, Wifi)',
    'LiveStream': 'Radio',
    'Streaming': 'Radio',
    'Profile': 'User (ou UserCircle)',
    'Account': 'User',
    'Person': 'User',
    'Dashboard': 'LayoutDashboard',
    'Cart': 'ShoppingCart',
    'Login': 'LogIn (camelCase!)',
    'Logout': 'LogOut',
    'Email': 'Mail',
    'Phonenumber': 'Phone',
    'Cash': 'Banknote',
    'Money': 'DollarSign (ou Banknote)',
    'Notification': 'Bell',
    'Loading': 'Loader2',
    'Spinner': 'Loader2',
    'Hamburger': 'Menu',
    'Like': 'Heart (ou ThumbsUp)',
    'Comment': 'MessageCircle (ou MessageSquare)',
    'Visa': '(aucune icone de marque, utiliser CreditCard)',
    'Mastercard': '(aucune icone de marque, utiliser CreditCard)',
    'Paypal': '(aucune icone de marque, utiliser CreditCard)',
    'Hashtag': 'Hash',
    'Ticktok': '(non disponible)',
    'Instagram_': 'Instagram'
  };
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx') && !fn.endsWith('.ts')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    // Match: import { X, Y, Z } from 'lucide-react'   (handles multi-line)
    const importRe = /import\s*\{([^}]+)\}\s*from\s*['"]lucide-react['"]/g;
    let im;
    while ((im = importRe.exec(content)) !== null) {
      const icons = im[1].split(',')
        .map(s => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      for (const icon of icons) {
        if (LUCIDE_HALLUCINATIONS[icon]) {
          issues.push({
            file: fn,
            issue: 'INVALID_LUCIDE_ICON',
            // ERROR severity → triggers the existing auto-fix loop in server.js
            message: `Icone lucide "${icon}" n'existe PAS. Remplacer par : ${LUCIDE_HALLUCINATIONS[icon]}`
          });
        }
      }
    }
  }

  // ─── MISSING NPM IMPORTS CHECK (ERROR — triggers auto-fix loop) ───
  // Catches the #1 cause of blank screens: Claude uses a React/Router/Lucide symbol
  // without importing it. The error only surfaces at RUNTIME (browser ReferenceError),
  // not at Vite compile time, so the build check doesn't catch it.
  //
  // Example: <Link> used in Header.tsx without `import { Link } from 'react-router-dom'`
  // → "Uncaught ReferenceError: Link is not defined" → blank iframe
  const NPM_SYMBOL_IMPORTS = {
    // React Router DOM — JSX components (check <Symbol usage)
    'Link': { from: 'react-router-dom', checkJsx: true },
    'NavLink': { from: 'react-router-dom', checkJsx: true },
    'Navigate': { from: 'react-router-dom', checkJsx: true },
    'Outlet': { from: 'react-router-dom', checkJsx: true },
    'Routes': { from: 'react-router-dom', checkJsx: true },
    'Route': { from: 'react-router-dom', checkJsx: true },
    // React Router DOM — hooks (check symbol( usage)
    'useNavigate': { from: 'react-router-dom', checkHook: true },
    'useParams': { from: 'react-router-dom', checkHook: true },
    'useLocation': { from: 'react-router-dom', checkHook: true },
    'useSearchParams': { from: 'react-router-dom', checkHook: true },
    // React — hooks
    'useState': { from: 'react', checkHook: true },
    'useEffect': { from: 'react', checkHook: true },
    'useRef': { from: 'react', checkHook: true },
    'useMemo': { from: 'react', checkHook: true },
    'useCallback': { from: 'react', checkHook: true },
    'useContext': { from: 'react', checkHook: true },
    'useReducer': { from: 'react', checkHook: true },
  };
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx') && !fn.endsWith('.ts') && !fn.endsWith('.jsx')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    if (fn === 'src/main.tsx') continue; // main.tsx has special imports
    for (const [symbol, info] of Object.entries(NPM_SYMBOL_IMPORTS)) {
      let isUsed = false;
      if (info.checkJsx && new RegExp(`<${symbol}[\\s/>]`).test(content)) isUsed = true;
      if (info.checkHook && new RegExp(`\\b${symbol}\\s*\\(`).test(content)) isUsed = true;
      if (!isUsed) continue;
      // Check if the symbol is imported somewhere in the file
      // Handles: { Link }, { Link, NavLink }, { useNavigate as nav }
      const importRegex = new RegExp(`import\\s+[^;]*\\b${symbol}\\b[^;]*from\\s+['"]${info.from}['"]`);
      if (!importRegex.test(content)) {
        issues.push({
          file: fn,
          issue: 'MISSING_NPM_IMPORT',
          // ERROR severity → triggers auto-fix loop (Claude adds the import)
          message: `'${symbol}' est utilisé mais pas importé. Ajouter : import { ${symbol} } from '${info.from}'`
        });
      }
    }
  }

  // ─── BROKEN IMPORT SYNTAX (ERROR — Babel parser crash → blank screen) ───
  // Claude sometimes generates truncated/malformed import statements, especially
  // multi-line imports where the `import {` gets cut off but `} from '...'` remains.
  // Babel can't parse this → Vite crash → blank iframe.
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx') && !fn.endsWith('.ts') && !fn.endsWith('.jsx')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Detect orphan `} from '...'` without a preceding `import {`
      if (/^\}\s*from\s+['"]/.test(line)) {
        // Check if a previous line has `import {` that's still open
        let hasOpenImport = false;
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          if (/import\s*\{/.test(lines[j]) && !lines[j].includes('}')) {
            hasOpenImport = true;
            break;
          }
        }
        if (!hasOpenImport) {
          issues.push({
            file: fn,
            issue: 'BROKEN_IMPORT_SYNTAX',
            message: `Ligne ${i + 1}: "} from '...'" sans "import {" correspondant — import tronqué. Réécrire l'import complet sur une seule ligne.`
          });
        }
      }
    }
    // Check for unclosed braces in the file (common syntax error)
    const opens = (content.match(/\{/g) || []).length;
    const closes = (content.match(/\}/g) || []).length;
    if (opens !== closes && Math.abs(opens - closes) > 2) {
      issues.push({
        file: fn,
        issue: 'UNBALANCED_BRACES',
        severity: 'warning',
        message: `${opens} "{" vs ${closes} "}" — accolades déséquilibrées, probable erreur de syntaxe`
      });
    }
  }

  // ─── REQUIRE() IN TSX/JSX FILES (ERROR — Vite can't handle CommonJS in ESM) ───
  // Claude sometimes writes require() in React files (confusing frontend ESM with backend CJS).
  // Vite transpiles ESM only — require() causes "require is not defined" at runtime → blank.
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx') && !fn.endsWith('.jsx')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    // Match require('...') but NOT inside strings/comments (heuristic: start of line or after space/;)
    if (/(?:^|[;\s])(?:const|let|var)\s+\w+\s*=\s*require\s*\(/m.test(content)) {
      issues.push({
        file: fn,
        issue: 'REQUIRE_IN_TSX',
        message: 'require() dans un fichier TSX/JSX — utiliser import { ... } from "..." (ESM). require() ne fonctionne pas dans Vite.'
      });
    }
  }

  // ─── FETCH WITHOUT ERROR HANDLING (ERROR — silent failures → blank screen) ───
  // If a fetch() call has no .catch() or try/catch, a network error silently kills the component.
  // The user sees a blank screen with zero indication of what went wrong.
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx') && !fn.endsWith('.jsx')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    // Count fetch() calls vs catch/try-catch patterns
    const fetchCalls = (content.match(/\bfetch\s*\(/g) || []).length;
    const catchHandlers = (content.match(/\.catch\s*\(|catch\s*\(/g) || []).length;
    const toastErrors = (content.match(/toast\.error|toast\(/g) || []).length;
    // If there are fetches but zero error handling → flag
    if (fetchCalls > 0 && catchHandlers === 0 && toastErrors === 0) {
      issues.push({
        file: fn,
        issue: 'FETCH_NO_ERROR_HANDLING',
        message: `${fetchCalls} fetch() sans try/catch ni .catch() — ajouter error handling avec toast.error() pour éviter les écrans blancs silencieux`
      });
    }
  }

  // ─── RESERVED WORD AS VARIABLE NAME (ERROR — Babel crash → blank screen) ───
  // Claude sometimes uses JS reserved words as parameter names in .map() callbacks
  // (e.g., `publicCibles.map((public, index) =>` where "public" is a reserved word).
  // Babel parser crashes instantly → blank iframe with "Unexpected reserved word" error.
  const JS_RESERVED_WORDS = new Set([
    'break', 'case', 'catch', 'continue', 'debugger', 'default', 'delete', 'do',
    'else', 'finally', 'for', 'function', 'if', 'in', 'instanceof', 'new',
    'return', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void',
    'while', 'with', 'class', 'const', 'enum', 'export', 'extends', 'import',
    'super', 'implements', 'interface', 'let', 'package', 'private', 'protected',
    'public', 'static', 'yield', 'await', 'async'
  ]);
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx') && !fn.endsWith('.ts') && !fn.endsWith('.jsx')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    // Check .map((reservedWord, ...) => and .map((reservedWord) =>
    const mapParams = content.matchAll(/\.map\s*\(\s*\(([^)]+)\)\s*=>/g);
    for (const match of mapParams) {
      const params = match[1].split(',').map(p => p.trim().split(':')[0].trim());
      for (const param of params) {
        if (JS_RESERVED_WORDS.has(param)) {
          issues.push({
            file: fn,
            issue: 'RESERVED_WORD_VARIABLE',
            message: `"${param}" est un mot réservé JavaScript utilisé comme variable dans .map(). Renommer en "${param}Item" ou "${param}Data".`
          });
        }
      }
    }
    // Also check arrow functions: (reserved) => and destructuring
    const arrowParams = content.matchAll(/(?:const|let|var)\s+(\w+)\s*=/g);
    // Skip — too many false positives for const. Focus on .map() and .forEach() callbacks
    const forEachParams = content.matchAll(/\.forEach\s*\(\s*\(([^)]+)\)\s*=>/g);
    for (const match of forEachParams) {
      const params = match[1].split(',').map(p => p.trim().split(':')[0].trim());
      for (const param of params) {
        if (JS_RESERVED_WORDS.has(param)) {
          issues.push({
            file: fn,
            issue: 'RESERVED_WORD_VARIABLE',
            message: `"${param}" est un mot réservé JavaScript utilisé comme variable dans .forEach(). Renommer en "${param}Item" ou "${param}Data".`
          });
        }
      }
    }
    // Check .filter(), .find(), .reduce(), .some(), .every() too
    const iteratorParams = content.matchAll(/\.(filter|find|reduce|some|every)\s*\(\s*\(([^)]+)\)\s*=>/g);
    for (const match of iteratorParams) {
      const params = match[2].split(',').map(p => p.trim().split(':')[0].trim());
      for (const param of params) {
        if (JS_RESERVED_WORDS.has(param)) {
          issues.push({
            file: fn,
            issue: 'RESERVED_WORD_VARIABLE',
            message: `"${param}" est un mot réservé JavaScript utilisé comme variable dans .${match[1]}(). Renommer en "${param}Item" ou "${param}Data".`
          });
        }
      }
    }
  }

  // ─── UNSAFE DATA ACCESS (ERROR — .map()/.length on undefined → crash → blank) ───
  // When Claude fetches data and immediately calls .map() without checking if data exists,
  // a null/undefined response crashes the component → blank screen.
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx') && !fn.endsWith('.jsx')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    // Pattern: useState([]) then {data.map()} is safe. But {data && data.map()} or {data?.map()} is safer.
    // Check for .map( without prior null check on the same variable — heuristic
    const mapCalls = content.match(/\b(\w+)\.map\s*\(/g) || [];
    for (const mapCall of mapCalls) {
      const varName = mapCall.match(/\b(\w+)\.map/)?.[1];
      if (!varName) continue;
      // Skip if the variable is initialized with [] or there's a null check nearby
      const hasInit = new RegExp(`\\b${varName}\\b[^=]*=\\s*\\[`).test(content) || // useState([])
                      new RegExp(`\\b${varName}\\b[^=]*=\\s*useState\\s*\\(\\[`).test(content);
      const hasNullCheck = new RegExp(`${varName}\\s*&&\\s*${varName}\\.map|${varName}\\?\\.map|\\(${varName}\\s*\\|\\|\\s*\\[\\]\\)\\.map`).test(content);
      if (!hasInit && !hasNullCheck) {
        issues.push({
          file: fn,
          issue: 'UNSAFE_MAP_CALL',
          severity: 'warning', // warning not error — too many false positives possible
          message: `${varName}.map() sans vérification null — utiliser ${varName}?.map() ou (${varName} || []).map() pour éviter crash si données non chargées`
        });
      }
    }
  }

  // ─── STRICT DESIGN-SYSTEM CHECKS (warning-only — visible in logs, not auto-fixed) ───
  // Goal: enforce semantic tokens like Lovable. Warnings won't trigger expensive auto-fix loops
  // but will surface in server logs so we can tighten them later if false-positive rate is low.

  // Test 16 (warning): raw absolute colors (white/black) — should use bg-background, text-foreground
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    const matches = content.match(/className="[^"]*\b(bg|text|border)-(white|black)\b[^"]*"/g) || [];
    if (matches.length > 0) {
      issues.push({
        file: fn,
        issue: 'RAW_WHITE_BLACK',
        severity: 'warning',
        message: `${matches.length} usage(s) de bg-white/text-black/etc — preferer bg-background, text-foreground (semantic tokens)`
      });
    }
  }

  // Test 17 (warning): inline style with color/background — should use Tailwind classes
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    const inlineColor = content.match(/style=\{\{[^}]*\b(color|background|backgroundColor|borderColor)\s*:/g) || [];
    if (inlineColor.length > 0) {
      issues.push({
        file: fn,
        issue: 'INLINE_STYLE_COLOR',
        severity: 'warning',
        message: `${inlineColor.length} style={{}} avec color/background — utiliser des classes Tailwind semantiques`
      });
    }
  }

  // Test 18 (warning): extended hardcoded Tailwind palette beyond Test 10
  // (Test 10 catches gray/blue/red/green; this catches the rest)
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    const extendedPalette = /className="[^"]*\b(bg|text|border|ring|from|to|via)-(yellow|orange|amber|lime|emerald|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose|slate|zinc|neutral|stone)-\d+/.test(content);
    if (extendedPalette) {
      issues.push({
        file: fn,
        issue: 'EXTENDED_HARDCODED_PALETTE',
        severity: 'warning',
        message: 'Couleurs Tailwind brutes (yellow/purple/pink/etc.) — preferer les tokens semantiques (bg-primary, bg-accent, bg-secondary)'
      });
    }
  }

  // ─── useEffect WITHOUT DEPENDENCY ARRAY (ERROR — infinite re-render loop) ───
  // useEffect(() => { setState(x) }) without [] re-runs every render → infinite loop → browser tab crash.
  // Must have at least [] (run once) or [deps] (run on change).
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx') && !fn.endsWith('.jsx')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    // Match useEffect(() => { ... }) without second argument
    // Pattern: useEffect( <callback> ) without comma after callback closing
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // useEffect(() => {  with no dependency array on same or nearby lines
      if (/useEffect\s*\(\s*\(\s*\)\s*=>\s*\{/.test(line)) {
        // Look for the closing of useEffect — should have , [...]) or , [dep])
        // Check next 30 lines for the closing pattern
        let found = false;
        let depth = 0;
        for (let j = i; j < Math.min(i + 30, lines.length); j++) {
          for (const ch of lines[j]) {
            if (ch === '{' || ch === '(') depth++;
            if (ch === '}' || ch === ')') depth--;
          }
          // If we find }, [  or }, [] → has deps array
          if (/\}\s*,\s*\[/.test(lines[j])) { found = true; break; }
          if (depth <= 0) break;
        }
        if (!found) {
          issues.push({
            file: fn,
            issue: 'USEEFFECT_NO_DEPS',
            message: `useEffect() sans tableau de dépendances (ligne ${i + 1}) → boucle infinie. Ajoute [] pour exécuter une seule fois, ou [dep1, dep2] pour exécuter au changement.`
          });
        }
      }
    }
  }

  // ─── CIRCULAR IMPORTS (WARNING — bundle bloat, potential crash) ───
  // If A imports B and B imports A → circular dependency.
  // Vite handles some cases but it can cause undefined imports at runtime → blank screen.
  const importGraph = {};
  for (const [fn, content] of Object.entries(files)) {
    if (!fn.endsWith('.tsx') && !fn.endsWith('.ts')) continue;
    if (fn.startsWith('src/components/ui/')) continue;
    const imports = content.match(/from\s+['"]@\/([^'"]+)['"]/g) || [];
    importGraph[fn] = imports.map(i => {
      const p = i.match(/from\s+['"]@\/([^'"]+)['"]/)?.[1];
      if (!p) return null;
      const resolved = 'src/' + p + (p.endsWith('.tsx') || p.endsWith('.ts') ? '' : '.tsx');
      return files[resolved] ? resolved : (files[resolved.replace('.tsx', '.ts')] ? resolved.replace('.tsx', '.ts') : null);
    }).filter(Boolean);
  }
  // Detect cycles (simple DFS)
  for (const startFile of Object.keys(importGraph)) {
    const visited = new Set();
    const stack = [startFile];
    while (stack.length > 0) {
      const current = stack.pop();
      if (visited.has(current)) {
        if (current === startFile && visited.size > 1) {
          issues.push({
            file: startFile,
            issue: 'CIRCULAR_IMPORT',
            severity: 'warning',
            message: `Import circulaire détecté — ${startFile} s'importe lui-même via une chaîne de dépendances. Peut causer des imports undefined au runtime.`
          });
          break;
        }
        continue;
      }
      visited.add(current);
      for (const dep of (importGraph[current] || [])) {
        stack.push(dep);
      }
    }
  }

  return issues;
}

// ─── PLAN MODE — produces a markdown plan, NEVER code ───
// Used by /api/plan/start. Claude is called with NO tools and this prompt.
// The plan is then shown to the user for approval before any code is generated.
const PLAN_SYSTEM_PROMPT = `Tu es Prestige AI en MODE PLANIFICATION. Tu analyses le code reel du projet et produis un plan d'action precis en Markdown. Pas de code, pas d'outils.

═══ METHODE ═══

1. LIS tout le code fourni — routes, imports, tables SQL, structure des composants.
2. DIAGNOSTIQUE en citant les fichiers et lignes specifiques. "Header.tsx a un lien /partenaires mais PartenairesPage n'existe pas" — pas "Verifier Header.tsx".
3. PRESCRIS des corrections avec fichier exact, contenu actuel, contenu de remplacement.
4. FULLSTACK : si une page utilise fetch('/api/...'), le plan inclut la route backend.

═══ CONTRAINTES ═══

- Zero outil (pas de write_file, edit_file, view_file). Markdown uniquement.
- Francais uniquement. Pas de blocs de code (\`\`\`).
- Detaille selon la complexite : plan simple = court, plan architecture = exhaustif.
- Si ambiguite → propose 2 interpretations dans la section Objectif.
- Si des PROBLEMES AUTOMATIQUES sont listes avant le code, inclus leurs corrections dans le plan.

═══ STRUCTURE IMPOSEE (4 sections) ═══

## Objectif
1-2 phrases reformulant la demande.

## Diagnostic (base sur le code lu)
Pour chaque fichier examine :
- Ce qui FONCTIONNE (confirme avec details)
- Ce qui MANQUE ou est INCORRECT (probleme specifique + impact)

Exemple :
- src/pages/Mission.tsx — EXISTE, contient 3 axes strategiques, il en manque 1 (appui aux initiatives locales)
- src/pages/Partenaires.tsx — N'EXISTE PAS — cela cause un ecran blanc quand on clique sur le lien dans le Header
- server.js — route GET /api/public/partners absente → fetch dans Partenaires.tsx retournera 404

## Corrections a appliquer
Liste numerotee, chronologique. Pour chaque correction :
- Fichier exact (chemin complet)
- Action : creer / modifier / supprimer
- Contenu : texte actuel → texte de remplacement, ou structure du nouveau fichier

Exemple :
1. Creer src/pages/Partenaires.tsx — page avec grille 3 colonnes, logos UNICEF/UNESCO/Banque Mondiale, import depuis @/components/ui/card
2. Dans src/App.tsx — ajouter import Partenaires from '@/pages/Partenaires' et Route path="/partenaires"
3. Dans server.js — ajouter route GET /api/public/partners + CREATE TABLE partners + INSERT de 4 partenaires demo
4. Dans Header.tsx — corriger "/contacts" → "/contact" (sans s)

## Risques et points d'attention
Pieges, dependances, interactions entre fichiers. Si aucun risque : "Aucun risque majeur."`;

// ─── PLAN CONTEXT BUILDER (lighter than buildConversationContext) ───
// For Plan Mode we send file LIST + structure only — never full file contents.
// Plans are cheap (< 4000 tokens output) and fast (~2-4s).
function buildPlanContext(project, history, userMessage) {
  const lines = [];

  // ── Read .prestige/rules.md (learned rules from past errors) ──
  const projectId = project?.id;
  const DOCKER_PROJECTS_DIR = process.env.DOCKER_PROJECTS_DIR || '/data/projects';
  const projDir = projectId ? require('path').join(DOCKER_PROJECTS_DIR, String(projectId)) : null;

  if (projDir) {
    try {
      const fs = require('fs');
      const rulesPath = require('path').join(projDir, '.prestige', 'rules.md');
      if (fs.existsSync(rulesPath)) {
        const rulesContent = fs.readFileSync(rulesPath, 'utf8').trim();
        if (rulesContent.length > 0) {
          lines.push(`# RÈGLES DU PROJET (apprises des erreurs précédentes)`);
          lines.push(rulesContent);
          lines.push('');
        }
      }
    } catch (_) {}
  }

  if (project && project.brief) {
    lines.push(`# Contexte projet`);
    lines.push(`Brief initial : ${project.brief}`);
    if (project.title) lines.push(`Titre : ${project.title}`);
    lines.push('');
  }

  // ── Send FULL file content so plan sees the REAL code ──
  let hasCode = false;
  let files = {};

  // 1. Try reading from DISK first (most up-to-date — includes manual changes)
  if (projDir) {
    try {
      const fs = require('fs');
      const pathMod = require('path');
      if (fs.existsSync(projDir)) {
        const readDir = (dir, prefix) => {
          const result = {};
          for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
            if (f.name === 'node_modules' || f.name === '.git' || f.name === 'dist' || f.name === 'data') continue;
            const fullPath = pathMod.join(dir, f.name);
            const relPath = prefix ? `${prefix}/${f.name}` : f.name;
            if (f.isDirectory()) {
              Object.assign(result, readDir(fullPath, relPath));
            } else if (/\.(tsx|ts|jsx|js|css|json|html)$/.test(f.name) && f.name !== 'package-lock.json') {
              try {
                const content = fs.readFileSync(fullPath, 'utf8');
                if (content.length < 50000) result[relPath] = content; // Skip huge files
              } catch (_) {}
            }
          }
          return result;
        };
        const diskFiles = readDir(projDir, '');
        if (Object.keys(diskFiles).length > 0) {
          files = diskFiles;
        }
      }
    } catch (_) {}
  }

  // 2. Fallback: parse from DB generated_code
  if (Object.keys(files).length === 0 && project && project.generated_code && project.generated_code.length > 100) {
    try {
      files = parseCodeFiles(project.generated_code);
    } catch (_) {}
  }

  // 3. Build context from files
  const fileNames = Object.keys(files);
  if (fileNames.length > 0) {
    hasCode = true;

    // Run back-tests and include results in plan context
    const backTestIssues = runBackTests(files);
    const errors = backTestIssues.filter(i => i.severity !== 'warning');
    const warnings = backTestIssues.filter(i => i.severity === 'warning');

    if (errors.length > 0 || warnings.length > 0) {
      lines.push(`# PROBLÈMES DÉTECTÉS AUTOMATIQUEMENT (${errors.length} erreur(s), ${warnings.length} avertissement(s))`);
      for (const issue of [...errors, ...warnings]) {
        lines.push(`- ${issue.severity === 'warning' ? '⚠' : '❌'} ${issue.file} — ${issue.issue}: ${issue.message}`);
      }
      lines.push('');
    }

    lines.push(`# Code actuel du projet (${fileNames.length} fichiers LUS DEPUIS LE DISQUE) — LIS TOUT avant de planifier`);
    lines.push('');
    for (const fn of fileNames) {
      const content = files[fn] || '';
      lines.push(`### ${fn}`);
      lines.push(content);
      lines.push('');
    }
  }
  if (!hasCode) {
    lines.push(`# Etat du projet`);
    lines.push(`Aucun code genere pour le moment — c'est un projet neuf.`);
    lines.push('');
  }

  // Recent conversation context (last 4 user/plan messages, content truncated)
  const recent = (history || [])
    .filter(m => m && (m.role === 'user' || m.role === 'plan'))
    .slice(-4);
  if (recent.length > 0) {
    lines.push(`# Conversation recente`);
    for (const m of recent) {
      const snippet = (m.content || '').substring(0, 220).replace(/\s+/g, ' ');
      lines.push(`- ${m.role} : ${snippet}${(m.content || '').length > 220 ? '...' : ''}`);
    }
    lines.push('');
  }

  lines.push(`# Demande actuelle`);
  lines.push(userMessage || '(vide)');

  return [{ role: 'user', content: lines.join('\n') }];
}

// Build auto-fix prompt from back-test issues
// Warnings (severity: 'warning') are EXCLUDED — they're logged for visibility but never auto-fixed.
function buildAutoFixPrompt(issues) {
  if (!issues || issues.length === 0) return null;
  const errors = issues.filter(i => i.severity !== 'warning');
  if (errors.length === 0) return null;
  const grouped = {};
  for (const i of errors) {
    if (!grouped[i.file]) grouped[i.file] = [];
    grouped[i.file].push(i.message);
  }
  let prompt = `Le projet a ${errors.length} problème(s) détecté(s) automatiquement. Corrige-les :\n\n`;
  for (const [file, msgs] of Object.entries(grouped)) {
    prompt += `### ${file}\n${msgs.map(m => `- ${m}`).join('\n')}\n\n`;
  }
  prompt += `UTILISE edit_file pour corriger — PAS write_file. Ne touche QUE les lignes problematiques. PRESERVE le design, layout, et structure existants INTACTS.
RAPPEL : server.js = CommonJS (require). Couleurs = classes Tailwind semantiques (bg-primary, text-muted-foreground). Contenu pages = EN DUR (pas de fetch pour l'affichage).`;
  return prompt;
}

// ─── PARTNER MODE PROMPT ───
// When the user is exploring, hesitating, or needs guidance — not giving direct orders.
// Claude acts as a senior dev consultant: proposes, questions, suggests alternatives.
// This is for non-developers who don't know exactly what they want.
const PARTNER_SYSTEM_PROMPT = `Tu es Prestige AI, un consultant developpement senior. L'utilisateur n'est PAS developpeur — il a besoin de ton expertise pour prendre les bonnes decisions.

═══ TON ROLE ═══

Tu es un PARTENAIRE, pas un executant. L'utilisateur explore une idee ou un besoin. Ton job :
1. COMPRENDRE ce qu'il veut vraiment (pas juste ce qu'il dit)
2. PROPOSER 2-3 options concretes avec avantages/inconvenients
3. POSER 1-2 questions precises pour affiner
4. RECOMMANDER la meilleure option avec justification

═══ FORMAT DE REPONSE ═══

Structure chaque reponse ainsi :

**Ce que je comprends :** [reformule le besoin en 1 phrase]

**Mes propositions :**
1. [Option A] — [description courte] → [avantage principal]
2. [Option B] — [description courte] → [avantage principal]
3. [Option C si pertinent] — [description courte] → [avantage principal]

**Ma recommandation :** [laquelle et pourquoi en 1 phrase]

**Pour affiner :** [1-2 questions courtes et precises]

═══ REGLES ═══

- Reponds en FRANCAIS, ton professionnel mais accessible (pas de jargon technique)
- Sois CONCRET : "une page avec un formulaire nom/email/message" pas "un systeme de contact"
- Propose des solutions REALISABLES avec la stack du projet (React + Tailwind + Express + SQLite)
- Si le projet existe deja, base tes propositions sur ce qui est DEJA EN PLACE (la carte du projet est fournie)
- Si l'utilisateur valide une option, termine par : "Dis-moi 'ok' ou 'option [numero]' et je le code immediatement."
- Pas de code dans la reponse. Juste de la consultation.
- Maximum 10-15 lignes. Clair, structure, actionnable.

═══ EXEMPLE ═══

Utilisateur : "Je voudrais ameliorer mon site"

**Ce que je comprends :** Tu veux rendre ton site plus professionnel et attractif.

**Mes propositions :**
1. **Page temoignages** — Ajouter une section avec les avis de tes clients → renforce la confiance des visiteurs
2. **Formulaire de contact ameliore** — Remplacer le formulaire basique par un avec choix de sujet + reponse automatique par email → plus professionnel
3. **Dashboard statistiques** — Voir combien de visiteurs, quelles pages sont les plus vues → comprendre ton audience

**Ma recommandation :** Les temoignages clients — c'est le changement le plus visible avec le moins d'effort.

**Pour affiner :** Tu as deja des temoignages a afficher, ou je genere des exemples ? Et tu preferes les afficher sur la page d'accueil ou sur une page dediee ?`;

module.exports = {
  SYSTEM_PROMPT,
  CHAT_SYSTEM_PROMPT,
  PLAN_SYSTEM_PROMPT,
  PARTNER_SYSTEM_PROMPT,
  PROMPT_MODULES,
  getContextualPromptModules,
  buildPlanContext,
  SECTOR_PROFILES,
  detectSectorProfile,
  getSuggestionsForSector,
  buildConversationContext,
  analyzeBrief,
  buildProfessionalPrompt,
  detectProjectComplexity,
  getMaxTokensForProject,
  getModelForProject,
  buildFileSelectionPrompt,
  parseFileSelectionResponse,
  parseCodeFiles,
  runBackTests,
  buildAutoFixPrompt
};
