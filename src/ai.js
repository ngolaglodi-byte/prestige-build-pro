// ─── PROFESSIONAL AI SYSTEM FOR PRESTIGE BUILD PRO v2 (React + Vite) ───

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
  return complexity === 'complex' ? 64000 : 32000;
}

function getModelForProject() {
  return 'claude-sonnet-4-20250514';
}

// ─── REACT + VITE MULTI-FILE SYSTEM PROMPT ───
const SYSTEM_PROMPT = `Tu es Prestige AI, un générateur de code expert React/Vite niveau senior. Tu génères des applications web fullstack COMPLÈTES et PROFESSIONNELLES avec React + Vite + TailwindCSS.

FORMAT DE SORTIE OBLIGATOIRE — utilise exactement ces marqueurs sans backticks markdown :

### package.json
{contenu JSON pur}

### vite.config.js
{config Vite}

### index.html
{HTML racine avec <div id="root"> et <script type="module" src="/src/main.jsx">}

### server.js
{backend Express}

### src/main.jsx
{point d'entrée React}

### src/index.css
{styles globaux Tailwind}

### src/App.jsx
{composant racine avec Router}

### src/components/Header.jsx
{composant Header}

### src/components/Footer.jsx
{composant Footer}

### src/pages/Home.jsx
{page d'accueil}

(+ autant de ### src/components/*.jsx et ### src/pages/*.jsx que nécessaire)

STACK TECHNIQUE OBLIGATOIRE :
- React 19.1.0 avec JSX
- Vite 6.3.5 + @vitejs/plugin-react 4.5.2
- TailwindCSS 4.1.7 via @tailwindcss/vite 4.1.7
- React Router DOM 7.6.1
- Lucide React 0.511.0 pour les icônes
- clsx 2.1.1 pour les classes conditionnelles
- Express 4.18.2 backend (server.js)
- better-sqlite3 9.4.3
- bcryptjs 2.4.3, jsonwebtoken 9.0.2, cors 2.8.5, helmet 7.1.0, compression 1.7.4

VERSIONS DANS package.json — SANS ^ (versions fixes) :
{
  "type": "module",
  "scripts": { "dev": "vite --host 0.0.0.0 --port 5173", "build": "vite build", "start": "node server.js" },
  "dependencies": { "react": "19.1.0", "react-dom": "19.1.0", "react-router-dom": "7.6.1", "lucide-react": "0.511.0", "clsx": "2.1.1", "express": "4.18.2", "better-sqlite3": "9.4.3", ... },
  "devDependencies": { "vite": "6.3.5", "@vitejs/plugin-react": "4.5.2", "tailwindcss": "4.1.7", "@tailwindcss/vite": "4.1.7" }
}

STRUCTURE vite.config.js OBLIGATOIRE :
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true, proxy: { '/api': 'http://localhost:3000', '/health': 'http://localhost:3000' } },
  build: { outDir: 'dist' }
});

STRUCTURE index.html OBLIGATOIRE (racine du projet, PAS dans public/) :
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>...</title></head>
<body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>
</html>

STRUCTURE src/index.css OBLIGATOIRE :
@import "tailwindcss";
(+ custom styles si nécessaire)

STRUCTURE src/main.jsx OBLIGATOIRE :
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);

STRUCTURE src/App.jsx OBLIGATOIRE :
- import { BrowserRouter, Routes, Route } from 'react-router-dom'
- Import de tous les composants et pages
- BrowserRouter > Routes avec toutes les <Route>
- Header et Footer inclus dans le layout

RÈGLES REACT :
1. Un composant = un fichier .jsx avec export default
2. Les composants dans src/components/, les pages dans src/pages/
3. Utiliser useState, useEffect, useCallback pour le state et les effets
4. fetch('/api/...') pour les appels backend (avec slash initial — Vite proxy s'en charge)
5. Icônes : import { Icon } from 'lucide-react' — JAMAIS de CDN icônes
6. Classes CSS : TailwindCSS classes dans className="..." — JAMAIS de CSS inline sauf cas exceptionnel
7. Responsive : classes Tailwind mobile-first (sm:, md:, lg:)
8. Animations : classes Tailwind (transition, hover:, group-hover:)
9. Navigation : <Link to="/page"> de react-router-dom — JAMAIS window.location
10. État global simple : props drilling ou context API si nécessaire

STRUCTURE server.js OBLIGATOIRE :
- Port 3000, route /health
- Sert dist/ en production : app.use(express.static('dist'))
- SQLite avec tables selon le secteur
- JWT auth, compte admin
- SPA fallback : app.get(/.*/, ...) qui sert dist/index.html
- Ordre : static → public routes → auth middleware → protected routes → SPA fallback
- À la FIN : // CREDENTIALS: email=admin@[nom-projet].com password=[MotDePasse]

QUALITÉ PROFESSIONNELLE OBLIGATOIRE :
- Design moderne avec TailwindCSS, inspiré des meilleures apps
- Responsive : mobile-first avec breakpoints Tailwind (sm, md, lg, xl)
- Animations Tailwind subtiles (transition, duration, hover:, group-hover:)
- Zéro lorem ipsum — contenu réel, professionnel, crédible
- Toutes les pages fonctionnelles avec navigation React Router
- Formulaires avec validation côté client (useState pour errors)
- Données de démonstration réalistes dans la DB
- Images via picsum.photos avec tailles appropriées

SÉCURITÉ OBLIGATOIRE :
- bcryptjs rounds=12, JWT signé, SQL préparé
- Validation des entrées, rate limiting
- process.env pour les clés API

PACKAGES NPM DISPONIBLES dans le container :
pdfkit, nodemailer, stripe, socket.io, multer, sharp, qrcode, exceljs, csv-parse, marked, axios

IMAGES : https://picsum.photos/800/600 ou https://images.unsplash.com/photo-XXXXX?w=800&q=80

FORMAT DE RÉPONSE :
- Pour une NOUVELLE génération : commence directement par ### package.json
- Pour une MODIFICATION : 1-2 lignes humaines puis les fichiers modifiés avec ### markers, termine par SUGGESTIONS:`;


// ─── CHAT SYSTEM PROMPT (for modifications after initial generation) ───
const CHAT_SYSTEM_PROMPT = `Tu es un développeur React expert qui modifie des projets web React + Vite + TailwindCSS.
Tu parles naturellement en français, comme un collègue senior bienveillant.

CONTEXTE IMPORTANT :
Tu modifies le code du PROJET CLIENT (pas Prestige Build Pro qui est l'outil).
Le projet client est une application React + Vite avec son propre design, ses propres routes et sa propre base de données.

COMMENT TU TRAVAILLES :
Tu reçois les fichiers concernés par la modification.
1. Réponds avec un court message humain (2 lignes max)
2. Retourne UNIQUEMENT les fichiers que tu as RÉELLEMENT modifiés avec ### markers
3. NE RETOURNE PAS un fichier si tu ne l'as pas modifié
4. Termine avec SUGGESTIONS: suivi de 3 idées séparées par |

RÈGLE CRITIQUE — FICHIERS MULTI :
- Le projet a PLUSIEURS fichiers : package.json, vite.config.js, index.html, server.js, src/main.jsx, src/App.jsx, src/index.css, src/components/*.jsx, src/pages/*.jsx
- Retourne SEULEMENT les fichiers modifiés
- Pour un changement de couleur → seulement ### src/index.css ou le composant concerné
- Pour une nouvelle page → ### src/pages/NewPage.jsx + ### src/App.jsx (pour la route)
- Pour une nouvelle feature complète → les fichiers nécessaires (composants + pages + server.js si API)
- Tu PEUX créer de nouveaux fichiers (### src/components/NewComponent.jsx)

RÈGLES REACT :
- Composants fonctionnels avec hooks (useState, useEffect, useCallback)
- TailwindCSS pour le styling — classes dans className
- Lucide React pour les icônes : import { Icon } from 'lucide-react'
- React Router pour la navigation : <Link to="/...">
- fetch('/api/...') pour le backend
- Un composant = un fichier .jsx

PACKAGES NPM PRÉ-INSTALLÉS :
pdfkit, nodemailer, stripe, socket.io, multer, sharp, qrcode, exceljs, csv-parse, marked, axios

COMMANDES / :
/couleurs [nom] — changer palette | /style [site] — s'inspirer d'un site | /section [nom] — ajouter une section
/dark — dark mode | /mobile — optimiser mobile | /seo — optimiser SEO | /premium — effets avancés

SÉCURITÉ : bcrypt rounds=12, SQL préparé, JWT, process.env pour les clés API`;

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
  default: [
    'Améliorer le design responsive mobile',
    'Ajouter un formulaire de contact avec validation',
    'Intégrer des animations Tailwind subtiles',
    'Ajouter une section témoignages',
    'Optimiser le SEO avec les meta tags',
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
    components: [], // list of component names to modify
    pages: []       // list of page names to modify
  };

  // CSS/style changes
  if (m.match(/couleur|color|css|style|design|police|font|thème|dark|theme|tailwind/)) {
    files.indexCss = true;
  }
  // Layout/header/footer changes
  if (m.match(/header|menu|navigation|navbar|nav/)) {
    files.components.push('Header');
  }
  if (m.match(/footer|pied de page/)) {
    files.components.push('Footer');
  }
  // Backend changes
  if (m.match(/api|route|endpoint|base de données|table|sql|auth|login|password|email|envoi|notification|upload|pdf|stripe|paiement|webhook|socket|temps réel|chat|export|import|middleware/)) {
    files.serverJs = true;
  }
  // Package changes
  if (m.match(/package|dépendance|module|install|npm|version/)) {
    files.packageJson = true;
  }
  // Routing changes
  if (m.match(/route|page|navigation|lien|menu/)) {
    files.appJsx = true;
  }
  // If adding a feature, likely touches backend + new components
  if (m.match(/ajoute|ajout|crée|créer|intègre|implémente|nouveau|nouvelle/)) {
    files.serverJs = true;
    files.appJsx = true;
  }
  // If nothing detected, assume component-level change
  if (!files.packageJson && !files.serverJs && !files.indexCss && files.components.length === 0 && files.pages.length === 0 && !files.appJsx) {
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
function buildConversationContext(project, messages, userMessage, configuredKeys) {
  const context = [];

  if (project && project.generated_code) {
    const files = parseCodeFiles(project.generated_code);
    const affected = detectAffectedFiles(userMessage);

    // Build project structure overview
    let structure = 'PROJET REACT "' + (project.title || 'Sans titre') + '"\nBrief: ' + (project.brief || '-') + '\n';
    if (configuredKeys && configuredKeys.length > 0) {
      structure += 'APIs: ' + configuredKeys.map(k => k.env_name).join(', ') + '\n';
    }

    // Extract structure from code
    const serverJs = files['server.js'] || '';
    const routes = (serverJs.match(/app\.(get|post|put|delete)\(['"`/][^,]+/g) || []).slice(0, 20);
    const tables = (serverJs.match(/CREATE TABLE IF NOT EXISTS (\w+)/g) || []).map(t => t.replace('CREATE TABLE IF NOT EXISTS ', ''));

    const appJsx = files['src/App.jsx'] || '';
    const reactRoutes = (appJsx.match(/<Route\s+path="([^"]+)"/g) || []);
    const components = Object.keys(files).filter(f => f.startsWith('src/components/'));
    const pages = Object.keys(files).filter(f => f.startsWith('src/pages/'));

    structure += '\nSTRUCTURE REACT:\n';
    structure += '  Composants: ' + (components.length ? components.join(', ') : 'aucun') + '\n';
    structure += '  Pages: ' + (pages.length ? pages.join(', ') : 'aucune') + '\n';
    structure += '  Routes React: ' + (reactRoutes.length ? reactRoutes.join(', ') : 'aucune') + '\n';
    structure += '  Routes API: ' + (routes.length ? routes.join(', ') : 'aucune') + '\n';
    structure += '  Tables SQLite: ' + (tables.length ? tables.join(', ') : 'aucune') + '\n';
    structure += '\nTu modifies CE projet React. Retourne UNIQUEMENT les fichiers modifiés avec ### markers.';

    let projectContext = structure;

    // Determine which files to send
    const filesToSend = [];
    const isMajor = /backend|dashboard|admin|complet|système|fonctionnalit/i.test(userMessage);

    if (isMajor) {
      // Send all files for major changes
      Object.keys(files).forEach(f => filesToSend.push(f));
    } else {
      // Send only affected files
      if (affected.appJsx && files['src/App.jsx']) filesToSend.push('src/App.jsx');
      if (affected.serverJs && files['server.js']) filesToSend.push('server.js');
      if (affected.packageJson && files['package.json']) filesToSend.push('package.json');
      if (affected.indexCss && files['src/index.css']) filesToSend.push('src/index.css');
      if (affected.mainJsx && files['src/main.jsx']) filesToSend.push('src/main.jsx');
      if (affected.viteConfig && files['vite.config.js']) filesToSend.push('vite.config.js');

      // Send affected components
      for (const comp of affected.components) {
        const key = `src/components/${comp}.jsx`;
        if (files[key]) filesToSend.push(key);
      }
      for (const page of affected.pages) {
        const key = `src/pages/${page}.jsx`;
        if (files[key]) filesToSend.push(key);
      }
    }

    const allFileNames = Object.keys(files);
    const notSent = allFileNames.filter(f => !filesToSend.includes(f));

    projectContext += `\n\nFICHIERS DU PROJET REACT (retourne SEULEMENT ceux modifiés avec ### markers):`;
    for (const fn of filesToSend) {
      projectContext += `\n\n### ${fn}\n${files[fn]}`;
    }
    if (notSent.length > 0) {
      projectContext += `\n\nFICHIERS NON ENVOYÉS (NE PAS les retourner sauf si nécessaire): ${notSent.join(', ')}`;
    }

    context.push({ role: 'user', content: projectContext });
    context.push({ role: 'assistant', content: `Compris. Je connais la structure React du projet. Qu'est-ce que vous souhaitez modifier ?` });
  } else if (project) {
    let projectContext = `PROJET: "${project.title || 'Sans titre'}" — ${project.brief || 'pas de brief'}`;
    if (configuredKeys && configuredKeys.length > 0) {
      projectContext += `\nAPIs configurées: ${configuredKeys.map(k => k.env_name).join(', ')}`;
    }
    context.push({ role: 'user', content: projectContext });
    context.push({ role: 'assistant', content: `Je connais votre projet. Dites-moi ce que vous souhaitez.` });
  }

  // Last 4 chat messages
  if (messages && messages.length > 0) {
    const chatMessages = messages.filter(m => !m.content.startsWith('### ')).slice(-4);
    chatMessages.forEach(m => {
      context.push({ role: m.role, content: m.content.substring(0, 500) });
    });
  }

  context.push({ role: 'user', content: userMessage });
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

module.exports = {
  SYSTEM_PROMPT,
  CHAT_SYSTEM_PROMPT,
  SECTOR_PROFILES,
  detectSectorProfile,
  getSuggestionsForSector,
  buildConversationContext,
  analyzeBrief,
  buildProfessionalPrompt,
  detectProjectComplexity,
  getMaxTokensForProject,
  getModelForProject
};
