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

// ─── REACT + VITE MULTI-FILE SYSTEM PROMPT ───
const SYSTEM_PROMPT = `Tu es Prestige AI, un générateur de code expert React/Vite niveau senior. Tu génères des applications web fullstack COMPLÈTES et PROFESSIONNELLES avec React + Vite + TailwindCSS.

FORMAT DE SORTIE — utilise les outils write_file et edit_file :

Pour CRÉER ou RÉÉCRIRE un fichier, utilise l'outil write_file :
  write_file({ path: "src/components/Header.jsx", content: "le code complet du fichier" })

Pour MODIFIER chirurgicalement un fichier existant, utilise l'outil edit_file :
  edit_file({ path: "src/index.css", search: "bg-amber-600", replace: "bg-blue-800" })

RÈGLE : utilise write_file pour les nouveaux fichiers et les gros changements.
         utilise edit_file pour les petites modifications (couleur, texte, fix).
         JAMAIS de backticks markdown autour du code.
         Le contenu de write_file doit être le code COMPLET du fichier, prêt à écrire.

Fichiers typiques d'un projet :
  package.json, vite.config.js, index.html, server.js,
  src/main.jsx, src/index.css, src/App.jsx,
  src/components/Header.jsx, src/components/Footer.jsx,
  src/pages/Home.jsx, src/pages/About.jsx, src/pages/Contact.jsx

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
1. Un composant = un fichier .jsx avec export default function NomComposant()
2. Les composants dans src/components/, les pages dans src/pages/
3. Hooks : useState, useEffect, useCallback, useMemo — JAMAIS de hooks conditionnels
4. fetch('/api/...') pour les appels backend (avec slash initial — Vite proxy s'en charge)
5. Icônes : import { Icon } from 'lucide-react' — JAMAIS de CDN icônes
6. Classes CSS : TailwindCSS dans className="..." — JAMAIS de CSS inline
7. Responsive : mobile-first (sm:, md:, lg:, xl:)
8. Animations : transition-all duration-300, hover:, group-hover:, focus:ring-2
9. Navigation : <Link to="/page"> de react-router-dom — JAMAIS window.location
10. État global : props pour petits arbres | useContext + Provider pour auth, thème, panier

PATTERNS PROFESSIONNELS OBLIGATOIRES :
- Loading states : const [loading, setLoading] = useState(false) + skeleton/spinner pendant fetch
- Error states : const [error, setError] = useState(null) + try/catch sur CHAQUE fetch + message d'erreur UI
- Formulaires : validation temps réel (onChange ou onBlur), messages d'erreur par champ, disable submit pendant envoi
- Images : <img loading="lazy" alt="description pertinente" className="object-cover" />
- Listes vides : toujours afficher un état vide ("Aucun résultat", illustration)

ACCESSIBILITÉ (WCAG AA) :
- HTML sémantique : <main>, <nav>, <section>, <article>, <button> (pas de <div onClick>)
- ARIA : aria-label sur les boutons icônes, aria-labelledby sur les sections
- Focus visible : focus:ring-2 focus:ring-offset-2 sur TOUS les éléments interactifs
- Contraste : texte sombre sur fond clair (ratio 4.5:1 minimum)
- Clavier : tous les éléments interactifs accessibles via Tab

STRUCTURE server.js OBLIGATOIRE :
- Port 3000, route /health
- Sert dist/ en production : app.use(express.static(path.join(__dirname, 'dist')))
- SQLite avec tables selon le secteur + timestamps (created_at, updated_at)
- Contraintes : NOT NULL, UNIQUE, FOREIGN KEY appropriés
- Index sur colonnes de recherche/filtrage fréquentes
- JWT auth, compte admin avec mot de passe fort (crypto.randomBytes(8).toString('hex'))
- SPA fallback : app.get(/.*/, ...) qui sert dist/index.html
- Ordre : static → public routes (/health, /api/auth/*) → auth middleware → protected /api/* → SPA fallback
- À la FIN : // CREDENTIALS: email=admin@[nom-projet].com password=[MotDePasse]
- Validation : typeof checks, trim(), longueur max sur TOUTES les entrées
- Rate limiting simple : Map en mémoire, max 5 req/min sur login, 100/min général

QUALITÉ PROFESSIONNELLE OBLIGATOIRE :
- Design moderne avec TailwindCSS, inspiré des meilleures apps SaaS
- Responsive : mobile-first avec breakpoints Tailwind (sm, md, lg, xl)
- Animations Tailwind subtiles (transition-all duration-300, hover:scale-105, group-hover:)
- Zéro lorem ipsum — contenu réel, professionnel, crédible en français
- Toutes les pages fonctionnelles avec navigation React Router
- Toast/notifications pour feedback utilisateur (succès, erreur)
- Données de démonstration réalistes pré-remplies dans la DB
- Images : https://picsum.photos/800/600 avec alt text descriptif, loading="lazy"

SÉCURITÉ OBLIGATOIRE :
- bcryptjs rounds=12, JWT signé avec expiration 24h
- SQL : UNIQUEMENT requêtes préparées db.prepare('...').run(...)
- XSS : échapper les sorties, Content-Security-Policy via helmet
- Validation serveur : vérifier type, longueur, format de TOUTES les entrées
- process.env pour TOUTES les clés/secrets — JAMAIS en dur dans le code

PACKAGES NPM DISPONIBLES dans le container (utilise-les librement) :
pdfkit (PDF), nodemailer (emails), stripe (paiements), socket.io (temps réel),
multer (uploads), sharp (images), qrcode (QR codes), exceljs (Excel),
csv-parse (CSV), marked (Markdown), axios (HTTP)

INTÉGRATIONS API EXTERNES — quand demandé, intègre proprement :
- Stripe : checkout session côté serveur, webhook pour confirmation, UI Tailwind
- Google Maps : iframe embed ou API avec clé via process.env.GOOGLE_MAPS_KEY
- Twilio/SMS : envoi côté serveur uniquement, clés dans env vars
- Email (nodemailer) : SMTP config via env vars, templates HTML
- Upload (multer) : limits 10MB, fileFilter par type, stockage /data/uploads/
- Socket.io : namespace par fonctionnalité, auth JWT sur connection

IMAGES : https://picsum.photos/800/600 ou Unsplash avec alt descriptif et loading="lazy"

FORMAT DE RÉPONSE :
- Utilise TOUJOURS les outils write_file/edit_file pour le code
- Texte conversationnel court (2 lignes max) en dehors des outils
- Pour une NOUVELLE génération : appelle write_file pour chaque fichier
- Pour une MODIFICATION : appelle edit_file pour les petits changements, write_file pour les gros`;


// ─── CHAT SYSTEM PROMPT (for modifications after initial generation) ───
const CHAT_SYSTEM_PROMPT = `Tu es un développeur React expert qui modifie des projets web React + Vite + TailwindCSS.
Tu parles naturellement en français, comme un collègue senior bienveillant.

MODES DE FONCTIONNEMENT :

MODE DISCUSSION (par défaut) — quand l'utilisateur pose une question, demande un avis, ou n'utilise pas de mot d'action :
→ Réponds en texte uniquement (pas d'outils, pas de code)
→ Pose des questions de clarification si besoin
→ Exemple : "Comment fonctionne le menu ?" → explique, ne code pas

MODE CODE — quand l'utilisateur utilise un mot d'ACTION explicite :
Mots d'action : crée, créer, ajoute, ajouter, modifie, modifier, change, changer, supprime, supprimer, corrige, corriger, implémente, implémenter, intègre, construis, fais, mets, retire
→ Utilise les outils write_file / edit_file
→ Message texte court (2 lignes max) + appels d'outils

Si tu n'es PAS SÛR du mode → demande : "Voulez-vous que je modifie le code ou juste une explication ?"

CONTEXTE :
Tu modifies le code du PROJET CLIENT (pas Prestige Build Pro qui est l'outil).
Le projet client est une application React + Vite avec son propre design, ses propres routes et sa propre base de données.

COMMENT TU TRAVAILLES :
Tu reçois les fichiers concernés par la modification.
1. Réponds avec un court message humain (2 lignes max) en texte
2. Utilise les OUTILS write_file et edit_file pour modifier le code
3. Ne mets JAMAIS le code dans le texte — TOUJOURS dans les outils

OUTILS DISPONIBLES :

edit_file — pour les PETITES modifications (couleur, texte, style, fix) :
  edit_file({ path: "src/index.css", search: "bg-amber-600", replace: "bg-blue-800" })
  edit_file({ path: "src/components/Header.jsx", search: "Bella Vita", replace: "Le Fournil" })
  Règles : search doit correspondre EXACTEMENT au code existant.

write_file — pour les GROS changements ou nouveaux fichiers :
  write_file({ path: "src/pages/NewPage.jsx", content: "le code complet" })
  write_file({ path: "src/App.jsx", content: "le fichier complet avec la nouvelle route" })

QUAND UTILISER QUEL OUTIL :
- Changement couleur/texte/style → edit_file (chirurgical)
- Correction de bug → edit_file
- Nouveau composant/page → write_file
- Refactoring d'un composant → write_file
- Ajout d'une route → edit_file sur src/App.jsx

RÈGLE CRITIQUE :
- Modifie SEULEMENT les fichiers qui changent
- Tu PEUX créer de nouveaux fichiers via write_file
- Pour une nouvelle page → write_file la page + edit_file App.jsx (ajouter import + Route)

RÈGLES REACT :
- Composants fonctionnels avec hooks (useState, useEffect, useCallback)
- TailwindCSS pour le styling — classes dans className
- Lucide React pour les icônes : import { Icon } from 'lucide-react'
- React Router : <Link to="/..."> pour navigation, useNavigate() pour programmatique
- fetch('/api/...') avec try/catch + loading state + error handling
- Un composant = un fichier .jsx avec export default

PATTERNS À RESPECTER DANS LES MODIFICATIONS :
- Garder le code existant intact — modifications chirurgicales
- Conserver les imports existants, ajouter les nouveaux
- Conserver les routes existantes dans App.jsx, ajouter les nouvelles
- Si ajout d'état global : useContext + Provider, wrap dans App.jsx
- Toast/notification pour feedback utilisateur après action

PACKAGES NPM PRÉ-INSTALLÉS (utilise-les directement dans server.js) :
pdfkit (PDF), nodemailer (emails), stripe (paiements), socket.io (temps réel),
multer (uploads 10MB max), sharp (images), qrcode, exceljs (Excel), csv-parse, marked, axios

COMMANDES / (quand l'utilisateur tape un slash) :
/couleurs [hex ou nom] — changer la palette complète (primary, secondary, accent)
/style [nom de site] — reproduire le style de stripe.com, airbnb.com, etc.
/section [type] — ajouter hero, pricing, testimonials, faq, team, gallery, contact
/dark — activer dark mode avec classes Tailwind dark:
/mobile — optimiser le responsive mobile (menu hamburger, touch targets 44px)
/seo — meta tags, Open Graph, sémantique HTML, alt texts
/api [service] — intégrer Stripe, Google Maps, Twilio, etc.

SÉCURITÉ : bcrypt rounds=12, SQL préparé, JWT, process.env pour les clés API
ACCESSIBILITÉ : HTML sémantique, aria-label sur icônes, focus visible, contraste AA`;

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

    // Build detailed file map with imports and exports for each file
    structure += '\nSTRUCTURE REACT COMPLÈTE:\n';
    const allFileNames = Object.keys(files);
    for (const fn of allFileNames) {
      const content = files[fn] || '';
      const size = content.length;
      if (fn === 'server.js') {
        structure += `\n  ${fn} (${size} chars)\n`;
        structure += `    Routes API: ${routes.slice(0, 15).join(', ') || 'aucune'}\n`;
        structure += `    Tables: ${tables.join(', ') || 'aucune'}\n`;
      } else if (fn === 'src/App.jsx') {
        const imports = (content.match(/import\s+(\w+)/g) || []).map(i => i.replace('import ', ''));
        structure += `\n  ${fn} (${size} chars)\n`;
        structure += `    Routes: ${reactRoutes.join(', ') || 'aucune'}\n`;
        structure += `    Imports: ${imports.join(', ')}\n`;
      } else if (fn.startsWith('src/components/') || fn.startsWith('src/pages/')) {
        // Show imports and exports for each component so AI understands relationships
        const imports = (content.match(/import\s+.*from\s+['"]([^'"]+)['"]/g) || [])
          .map(i => i.match(/from\s+['"]([^'"]+)['"]/)?.[1] || '').filter(Boolean);
        const hasState = content.includes('useState');
        const hasEffect = content.includes('useEffect');
        const hasFetch = content.includes('fetch(');
        const props = content.match(/export default function \w+\((\{[^}]+\}|\w+)\)/)?.[1] || 'none';
        structure += `\n  ${fn} (${size} chars)`;
        if (imports.length) structure += ` — imports: ${imports.join(', ')}`;
        if (hasState || hasEffect || hasFetch) {
          const hooks = [];
          if (hasState) hooks.push('useState');
          if (hasEffect) hooks.push('useEffect');
          if (hasFetch) hooks.push('fetch');
          structure += ` — hooks: ${hooks.join(', ')}`;
        }
        structure += '\n';
      } else if (fn === 'package.json') {
        try {
          const pkg = JSON.parse(content);
          structure += `\n  ${fn} — ${pkg.name || 'project'}\n`;
          structure += `    Deps: ${Object.keys(pkg.dependencies || {}).join(', ')}\n`;
        } catch { structure += `\n  ${fn}\n`; }
      } else {
        structure += `\n  ${fn} (${size} chars)\n`;
      }
    }
    structure += '\nTu modifies CE projet React. Retourne UNIQUEMENT les fichiers modifiés avec ### markers.';
    structure += '\nSi tu crées un NOUVEAU composant/page, retourne aussi src/App.jsx avec la nouvelle route.';

    let projectContext = structure;

    // Determine which files to send (full content)
    const filesToSend = [];
    const isMajor = /redesign complet|refonte|tout changer|full rewrite|système complet|erp|multi.?rôle/i.test(userMessage);

    if (isMajor) {
      // Send all files for major changes
      allFileNames.forEach(f => filesToSend.push(f));
    } else {
      // ALWAYS send App.jsx (routing context) and index.css (styling context)
      if (files['src/App.jsx']) filesToSend.push('src/App.jsx');
      if (files['src/index.css']) filesToSend.push('src/index.css');

      // Send specifically affected files
      if (affected.serverJs && files['server.js']) filesToSend.push('server.js');
      if (affected.packageJson && files['package.json']) filesToSend.push('package.json');
      if (affected.mainJsx && files['src/main.jsx']) filesToSend.push('src/main.jsx');
      if (affected.viteConfig && files['vite.config.js']) filesToSend.push('vite.config.js');
      if (affected.indexHtml && files['index.html']) filesToSend.push('index.html');

      // Send affected components
      for (const comp of affected.components) {
        const key = `src/components/${comp}.jsx`;
        if (files[key]) filesToSend.push(key);
      }
      for (const page of affected.pages) {
        const key = `src/pages/${page}.jsx`;
        if (files[key]) filesToSend.push(key);
      }

      // If adding a feature, also send the main page to understand context
      if (affected.serverJs && affected.appJsx) {
        // Feature addition — send Home page too for layout understanding
        const homePage = allFileNames.find(f => f.includes('Home.jsx'));
        if (homePage && !filesToSend.includes(homePage)) filesToSend.push(homePage);
      }
    }

    // Deduplicate
    const uniqueFiles = [...new Set(filesToSend)];
    const notSent = allFileNames.filter(f => !uniqueFiles.includes(f));

    projectContext += `\n\nFICHIERS DU PROJET (contenu complet — retourne SEULEMENT ceux que tu MODIFIES):`;
    for (const fn of uniqueFiles) {
      projectContext += `\n\n### ${fn}\n${files[fn]}`;
    }
    if (notSent.length > 0) {
      projectContext += `\n\nFICHIERS NON ENVOYÉS (tu connais leur structure ci-dessus — demande-les si besoin): ${notSent.join(', ')}`;
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
      context.push({ role: m.role, content: m.content.substring(0, 1000) });
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
