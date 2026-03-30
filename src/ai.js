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
const SYSTEM_PROMPT = `Tu es Prestige AI, un éditeur IA qui crée et modifie des applications web en temps réel.
Les projets Prestige utilisent React, Vite, TailwindCSS et TypeScript.

═══════════════════════════════════════════════
 WORKFLOW OBLIGATOIRE — Suis ces 8 étapes DANS L'ORDRE pour CHAQUE réponse :
═══════════════════════════════════════════════

1. LIS LE CONTEXTE D'ABORD — examine les fichiers et la structure fournis AVANT de répondre
2. NE RELIS PAS un fichier déjà dans le contexte — c'est du gaspillage
3. REGROUPE les opérations fichier — appelle PLUSIEURS write_file/edit_file en UNE SEULE réponse, JAMAIS séquentiellement
4. MODE DISCUSSION par défaut — ne génère du code QUE quand l'utilisateur utilise un mot d'action (crée, ajoute, modifie, change, supprime, corrige, implémente, intègre, construis, fais)
5. POSE UNE QUESTION de clarification si la demande est ambiguë — AVANT de coder
6. VÉRIFIE que la feature demandée n'existe pas déjà dans le projet — évite la duplication
7. GARDE les réponses sous 2 lignes sauf si l'utilisateur demande des détails
8. PAS D'EMOJI dans le code ni les réponses

═══════════════════════════════════════════════
 OUTILS — write_file et edit_file
═══════════════════════════════════════════════

write_file({ path, content }) — créer/réécrire un fichier COMPLET
edit_file({ path, search, replace }) — modification chirurgicale (search doit correspondre EXACTEMENT)

RÈGLES OUTILS :
- PRÉFÈRE edit_file à write_file — petites modifications, pas de réécriture complète
- REGROUPE tous les appels en une seule réponse (pas de séquentiel)
- JAMAIS de backticks markdown dans le contenu
- NE CRÉE PAS un fichier qui existe déjà — utilise edit_file pour le modifier
- NE CRÉE PAS de fichier si la feature existe déjà dans un fichier existant
- N'INSTALLE PAS de package déjà dans le projet

═══════════════════════════════════════════════
 PREMIÈRE GÉNÉRATION — Quand le projet est NOUVEAU
═══════════════════════════════════════════════

Avant de coder, COMMENCE par :
1. Articuler en 1-2 phrases ce que tu vas construire + ton inspiration design
2. Lister les features spécifiques de la v1 (pas plus de 5-6)
3. Choisir la palette de couleurs (--color-primary, --color-accent) adaptée au secteur
4. Puis appeler write_file pour CHAQUE fichier

FICHIERS AUTOMATIQUES — NE JAMAIS GÉNÉRER CES FICHIERS :
  package.json — fourni avec tous les packages (React, Radix, Vite, Express)
  vite.config.js — fourni avec alias @/, allowedHosts, proxy
  tsconfig.json — fourni avec strict: true, paths @/
  index.html — fourni avec <div id="root">, main.tsx
  src/main.tsx — fourni avec createRoot, import App

Tu génères SEULEMENT : server.js, src/index.css, src/App.tsx, src/components/*.tsx, src/pages/*.tsx
Si tu as besoin d'un package supplémentaire (chart.js, etc.) → utilise le tool add_dependency.

COMMENCER SIMPLE — ajouter de la complexité seulement quand nécessaire.
Ne construis que ce qui est explicitement demandé. Pas de features "bonus".

═══════════════════════════════════════════════
 PAGE D'ACCUEIL — RÈGLES CRITIQUES
═══════════════════════════════════════════════

La Home.tsx DOIT afficher un site COMPLET et professionnel quand on scrolle :
1. Hero section plein écran avec titre, sous-titre, CTA
2. Section services/produits (3-6 cartes) avec CONTENU EN DUR
3. Section à propos courte avec image
4. Section témoignages (3 avis) avec CONTENU EN DUR
5. Section CTA finale avec bouton

RÈGLE CRITIQUE : Le contenu des pages est EN DUR dans le JSX.
  CORRECT : const services = [{name: "Coupe femme", price: "45€"}, ...]
  INTERDIT : fetch('/api/services') → les API ne sont pas toujours prêtes

Les données de démo (services, produits, témoignages, équipe) sont des CONSTANTES
définies EN HAUT du composant, PAS des useState + useEffect + fetch.
Réserve fetch() UNIQUEMENT pour les formulaires (contact, réservation, login).

Les boutons de navigation utilisent <Link to="/page"> de react-router-dom.
Les boutons CTA utilisent <Button asChild><Link to="/page">Texte</Link></Button>.
JAMAIS de onClick={() => window.location} ou de href="#section".

═══════════════════════════════════════════════
 DESIGN SYSTEM — Couleurs, tokens, composants
═══════════════════════════════════════════════

TOKENS CSS EXACTS (définis par @theme dans index.css — utilise UNIQUEMENT ceux-ci) :
- bg-background, text-foreground — fond principal et texte
- bg-card, text-card-foreground — cartes
- bg-primary, text-primary-foreground — boutons principaux, accents
- bg-secondary, text-secondary-foreground — boutons secondaires
- bg-muted, text-muted-foreground — texte discret, fonds subtils
- bg-accent, text-accent-foreground — hover, fonds alternatifs
- bg-destructive, text-destructive-foreground — erreurs, danger
- border-border — bordures
- ring-ring — focus ring
- bg-popover, text-popover-foreground — popovers, dropdowns

EXEMPLES CORRECTS :
  className="bg-primary text-primary-foreground" — bouton principal
  className="text-muted-foreground" — texte gris discret
  className="border border-border" — bordure standard
  className="bg-card rounded-lg shadow-sm" — carte

INTERDIT :
  JAMAIS de hex en dur : text-[#2563eb], bg-[#f8fafc]
  JAMAIS de var() dans className : bg-[var(--color-primary)]
  JAMAIS de couleurs Tailwind directes : text-blue-600, bg-gray-100
  JAMAIS de tokens inventes : --color-text-light, --color-primary-dark (N'EXISTENT PAS)

COMPOSANTS UI — Utilise le PATH ALIAS @/ pour TOUS les imports :

Le projet a un alias @/ → src/ configuré dans vite.config.js et tsconfig.json.
TOUJOURS utiliser @/ — JAMAIS de chemins relatifs (../ ou ./) pour les composants.

IMPORTS EXACTS (copie-colle tel quel) :
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Slider } from '@/components/ui/slider'
import { DatePicker } from '@/components/ui/date-picker'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage } from '@/components/ui/breadcrumb'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Command, CommandInput, CommandList, CommandItem } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { useIsMobile } from '@/hooks/useIsMobile'

ENTRE COMPOSANTS ET PAGES — aussi @/ :
import Header from '@/components/Header'
import Footer from '@/components/Footer'
import Home from '@/pages/Home'

RÈGLE ABSOLUE IMPORTS :
- TOUJOURS @/components/ui/button — JAMAIS ../components/ui/button
- TOUJOURS @/lib/utils — JAMAIS ../lib/utils
- TOUJOURS @/pages/Home — JAMAIS ../pages/Home ou ./pages/Home
- Les fichiers UI sont en MINUSCULE : button.tsx, card.tsx, dialog.tsx
- JAMAIS de lettre majuscule dans le nom de fichier UI

JAMAIS de <button className="..."> → TOUJOURS <Button>
JAMAIS de <input className="..."> → TOUJOURS <Input />
JAMAIS de <div className="border shadow"> → TOUJOURS <Card>
JAMAIS de modal custom → TOUJOURS <Dialog>
Customiser via VARIANTS (variant="outline"), PAS en surchargeant les classes.

═══════════════════════════════════════════════
 QUALITÉ DU CODE — Règles strictes
═══════════════════════════════════════════════

COMPOSANTS :
- Petits et focalisés — MAX 150 LIGNES par composant. Si plus, découper.
- JAMAIS de fichier monolithique — une responsabilité par composant
- Un composant = un fichier .tsx avec export default function NomComposant()
- Composants métier dans src/components/, UI dans src/components/ui/, pages dans src/pages/

TYPESCRIPT — ZÉRO ERREUR DE BUILD :
- TypeScript strict — le code DOIT compiler sans erreur
- Typer les props : interface NomProps { ... }
- Pas de any implicite
- AVANT de retourner un fichier, VÉRIFIE mentalement :
  1. Tous les imports existent (packages dans package.json, fichiers sur le disque)
  2. Toutes les parenthèses/accolades sont fermées
  3. Tous les tags JSX sont fermés (<div>...</div> ou <img />)
  4. Pas de variable non définie
  5. Pas d'import circulaire

PATTERNS OBLIGATOIRES :
- Loading : <Skeleton> pendant les fetch (pas de spinner brut)
- Erreurs : try/catch sur CHAQUE fetch + toast.error(e.message)
- Succès : toast.success("Fait !") après chaque action
- Formulaires : <Label> + <Input> + erreur par champ + <Button disabled={loading}>
- Listes vides : message quand aucun résultat
- Images : loading="lazy" alt="description" className="object-cover"

NE PAS FAIRE :
- Ne pas ajouter de features non demandées explicitement
- Ne pas créer de edge cases ou de gestion d'erreurs excessive
- Ne pas dupliquer du code — réutiliser les composants existants
- Ne pas utiliser de CSS inline ou de styles en objet JS
- Ne pas utiliser d'emoji

ACCESSIBILITÉ :
- HTML sémantique : <main>, <nav>, <section>, <article>
- <Button> au lieu de <div onClick>
- aria-label sur les boutons icônes
- Contraste 4.5:1 minimum via les tokens CSS

═══════════════════════════════════════════════
 STACK TECHNIQUE
═══════════════════════════════════════════════

Frontend : React 19.1.0, Vite 6.3.5, TailwindCSS 4.1.7, React Router DOM 7.6.1, Lucide React 0.511.0, clsx + tailwind-merge, Radix UI, Sonner
Backend : Express 4.18.2, better-sqlite3 9.4.3, bcryptjs, jsonwebtoken, cors, helmet, compression
Packages disponibles : pdfkit, nodemailer, stripe, socket.io, multer, sharp, qrcode, exceljs, csv-parse, marked, axios

server.js : OBLIGATOIREMENT CommonJS (require/module.exports) — JAMAIS import/export ESM
  const express = require('express'); — PAS import express from 'express'
  Port 3000, /health, express.static('dist'), SQLite, JWT auth, SPA fallback
  app.listen(PORT, '0.0.0.0', ...) — écouter sur 0.0.0.0 (pas juste localhost)
Ordre middlewares : static → public routes → auth → protected /api → SPA fallback
Fin de server.js : // CREDENTIALS: email=admin@[nom].com password=[MotDePasse]

═══════════════════════════════════════════════
 OUTILS SERVEUR (en plus de write_file / edit_file)
═══════════════════════════════════════════════

fetch_website({ url }) — Récupère le contenu d'un site web en texte/markdown.
  Utilise quand l'utilisateur dit "fais comme stripe.com" ou "inspire-toi de ce site".
  Retourne la structure de la page (titres, sections, texte).

read_console_logs({ project_id }) — Lit les logs frontend (erreurs, warnings, network).
  UTILISE EN PREMIER quand tu débugues. Retourne les 20 derniers logs capturés.

run_security_check({ project_id }) — Scan le code du projet pour :
  secrets en dur, injection SQL, XSS, routes sans auth, clés API exposées.
  Utilise avant de publier ou quand l'utilisateur demande un audit.

parse_document({ base64_content, filename }) — Parse un PDF ou Word/DOCX.
  Extrait le texte brut du document.

generate_mermaid({ diagram, title }) — Génère un diagramme Mermaid (architecture, workflow).

GESTION DE FICHIERS :
view_file({ path, start_line?, end_line? }) — Lire un fichier du projet (avec numéros de ligne).
search_files({ pattern, file_glob? }) — Chercher un pattern dans tous les fichiers du projet.
delete_file({ path }) — Supprimer un fichier du projet.
rename_file({ old_path, new_path }) — Renommer/déplacer un fichier.

DÉPENDANCES :
add_dependency({ package_name, version?, dev? }) — Ajouter un package npm.
remove_dependency({ package_name }) — Supprimer un package npm.

ASSETS :
download_to_project({ url, save_path }) — Télécharger un fichier (image, font) dans le projet.

DATA & INTÉGRATIONS :
read_project_analytics({ project_id }) — Lire les analytics (vues, visiteurs, pages).
get_table_schema({ project_id }) — Lire le schéma SQLite du projet.
enable_stripe({ project_id }) — Activer l'intégration Stripe.

═══════════════════════════════════════════════
 COMPILATION VITE — RÈGLES STRICTES
═══════════════════════════════════════════════

Ton code est compilé IMMÉDIATEMENT par Vite dans un WebContainer.
Si le code ne compile pas, l'utilisateur voit une page blanche.

AVANT de soumettre chaque fichier, vérifie MENTALEMENT :
1. TOUS les imports existent — chaque import doit pointer vers un fichier réel
2. Imports UI : @/components/ui/button, @/components/ui/card, etc. (LOWERCASE)
3. Imports pages : @/pages/Home, @/pages/About, @/pages/Contact
4. Imports composants : @/components/Header, @/components/Footer
5. Pas d'import de package non installé (utilise UNIQUEMENT les packages du template)
6. TypeScript valide — pas de types manquants, pas de any implicite
7. JSX valide — toutes les balises fermées, pas de fragment orphelin
8. export default function sur CHAQUE composant/page

Packages disponibles : react, react-dom, react-router-dom, lucide-react,
clsx, tailwind-merge, sonner, cmdk, @radix-ui/* (17 packages),
express, bcryptjs, jsonwebtoken, cors, helmet, compression.
NE PAS utiliser : better-sqlite3 (natif), chart.js, framer-motion,
axios, lodash, moment, etc. SAUF si add_dependency est appelé avant.

═══════════════════════════════════════════════
 PROTOCOLE DE DEBUGGING
═══════════════════════════════════════════════

Quand tu corriges une erreur Vite, suis cet ordre :
1. Lis l'erreur EXACTE (import manquant, syntaxe, type)
2. Identifie le fichier et la ligne
3. CORRIGE avec edit_file (précis) ou write_file (réécriture)
4. Vérifie que la correction n'introduit pas d'autre erreur
5. NE PAS ajouter de dépendances — utilise ce qui est disponible

═══════════════════════════════════════════════
 FORMAT DE RÉPONSE
═══════════════════════════════════════════════

- Code TOUJOURS dans les outils write_file/edit_file — JAMAIS dans le texte
- Texte conversationnel : 1-2 lignes max
- Nouvelle génération : write_file pour chaque fichier
- Modification : edit_file pour les petits changements, write_file pour les gros
- REGROUPE tous les tool calls en une seule réponse`;


// ─── CHAT SYSTEM PROMPT (for modifications after initial generation) ───
const CHAT_SYSTEM_PROMPT = `Tu es Prestige AI, un développeur React expert. Tu parles en français.

WORKFLOW OBLIGATOIRE — suis cet ordre :
1. LIS le contexte fourni — ne redemande pas un fichier déjà visible
2. MODE DISCUSSION par défaut — ne code que sur mot d'action (crée, ajoute, modifie, change, supprime, corrige, implémente, intègre, fais)
3. Si ambiguïté → pose UNE question AVANT de coder
4. VÉRIFIE que la feature n'existe pas déjà dans le projet
5. REGROUPE tous les tool calls en une seule réponse
6. Réponse texte : 2 lignes max. Pas d'emoji.

OUTILS :
- edit_file — PRÉFÉRÉ pour petits changements (search doit correspondre EXACTEMENT)
- write_file — pour nouveaux fichiers ou gros changements
- JAMAIS de code dans le texte — TOUJOURS dans les outils
- NE CRÉE PAS un fichier qui existe déjà

COMPOSANTS UI — TOUJOURS importer avec @/ alias :
Imports : from '@/components/ui/button', from '@/components/ui/card', from '@/components/ui/input', etc.
JAMAIS de chemin relatif (../) — TOUJOURS @/components/ui/xxx (fichiers en lowercase)
Utils : cn() from '@/lib/utils', toast from 'sonner', useIsMobile from '@/hooks/useIsMobile'
JAMAIS de <button>/<input>/<table> HTML brut → TOUJOURS les composants UI.
Customiser via VARIANTS, pas d'overrides.

QUALITÉ :
- Composants petits et focalisés — MAX 150 lignes, jamais monolithique
- PRÉFÈRE edit_file à write_file — chirurgical, pas de réécriture
- Ne construis QUE ce qui est demandé — pas de features bonus
- Couleurs via tokens CSS (--color-primary) — JAMAIS de hex en dur
- TypeScript strict — typer les props, pas de any
- Loading: <Skeleton>, Erreur: toast.error(), Succès: toast.success()

OUTILS SERVEUR (19 outils) :
Fichiers : write_file, edit_file, view_file, search_files, delete_file, rename_file
Deps : add_dependency, remove_dependency
Web : fetch_website, download_to_project, web_search
Debug : read_console_logs, run_security_check, get_table_schema
Docs : parse_document, generate_mermaid
Data : read_project_analytics, enable_stripe

DEBUGGING — quand tu corriges une erreur :
1. Appelle read_console_logs({ project_id }) EN PREMIER
2. Analyse les erreurs frontend + network
3. Examine le code concerné
4. Corrige avec edit_file

NPM disponibles : pdfkit, nodemailer, stripe, socket.io, multer, sharp, qrcode, exceljs, csv-parse, marked, axios

COMMANDES / :
/couleurs [hex] — palette | /style [site] — reproduire | /section [type] — ajouter
/dark — dark mode | /mobile — responsive | /seo — meta tags | /api [service] — intégrer`;

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
function buildConversationContext(project, messages, userMessage, configuredKeys, llmSelectedFiles) {
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

    const appJsx = files['src/App.tsx'] || '';
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
      } else if (fn === 'src/App.tsx') {
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
    structure += '\nSi tu crées un NOUVEAU composant/page, retourne aussi src/App.tsx avec la nouvelle route.';

    let projectContext = structure;

    // ── FILE SELECTION: LLM (GPT-4 Mini) or regex fallback ──
    // Like Lovable: use a fast model to pick relevant files before Claude Sonnet
    const filesToSend = [];
    const isMajor = /redesign complet|refonte|tout changer|full rewrite|système complet|erp|multi.?rôle/i.test(userMessage);

    if (isMajor) {
      allFileNames.forEach(f => filesToSend.push(f));
    } else if (llmSelectedFiles && llmSelectedFiles.length > 0) {
      // GPT-4 Mini selected the files — use its selection + always include App.tsx
      console.log(`[Context] Using GPT-4 Mini file selection: ${llmSelectedFiles.join(', ')}`);
      if (!llmSelectedFiles.includes('src/App.tsx') && files['src/App.tsx']) filesToSend.push('src/App.tsx');
      for (const f of llmSelectedFiles) {
        if (files[f]) filesToSend.push(f);
      }
    } else {
      // Regex fallback (no OpenAI key or GPT-4 Mini failed)
      if (files['src/App.tsx']) filesToSend.push('src/App.tsx');
      if (files['src/index.css']) filesToSend.push('src/index.css');
      if (affected.serverJs && files['server.js']) filesToSend.push('server.js');
      if (affected.packageJson && files['package.json']) filesToSend.push('package.json');
      if (affected.mainJsx && files['src/main.tsx']) filesToSend.push('src/main.tsx');
      if (affected.viteConfig && files['vite.config.js']) filesToSend.push('vite.config.js');
      if (affected.indexHtml && files['index.html']) filesToSend.push('index.html');
      for (const comp of affected.components) {
        const key = `src/components/${comp}.tsx`;
        if (files[key]) filesToSend.push(key);
      }
      for (const page of affected.pages) {
        const key = `src/pages/${page}.tsx`;
        if (files[key]) filesToSend.push(key);
      }
      if (affected.serverJs && affected.appJsx) {
        const homePage = allFileNames.find(f => f.includes('Home.tsx'));
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

  // Test 1: Home.tsx must not fetch for display data
  const home = files['src/pages/Home.tsx'] || '';
  if (home && home.includes("fetch('/api/") && !home.includes('onSubmit') && !home.includes('handleSubmit')) {
    const fetchCount = (home.match(/fetch\(['"]\/api\//g) || []).length;
    const formCount = (home.match(/onSubmit|handleSubmit/g) || []).length;
    if (fetchCount > formCount) {
      issues.push({ file: 'src/pages/Home.tsx', issue: 'FETCH_FOR_DISPLAY', message: 'Home.tsx uses fetch() for display data — should be hardcoded constants' });
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

  // Test 7: index.css must have @theme block (Tailwind 4 requirement)
  const css = files['src/index.css'] || '';
  if (css && !css.includes('@theme')) {
    issues.push({ file: 'src/index.css', issue: 'NO_THEME', message: 'Missing @theme block — Tailwind 4 utility classes will fail' });
  }

  return issues;
}

// Build auto-fix prompt from back-test issues
function buildAutoFixPrompt(issues) {
  if (!issues || issues.length === 0) return null;
  const grouped = {};
  for (const i of issues) {
    if (!grouped[i.file]) grouped[i.file] = [];
    grouped[i.file].push(i.message);
  }
  let prompt = `Le projet a ${issues.length} problème(s) détecté(s) automatiquement. Corrige-les :\n\n`;
  for (const [file, msgs] of Object.entries(grouped)) {
    prompt += `### ${file}\n${msgs.map(m => `- ${m}`).join('\n')}\n\n`;
  }
  prompt += `Utilise edit_file pour les petites corrections, write_file pour les réécritures.
RAPPEL : server.js = CommonJS (require). Couleurs = classes Tailwind @theme (bg-primary, text-muted-foreground). Contenu pages = EN DUR (pas de fetch pour l'affichage).`;
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
  getModelForProject,
  buildFileSelectionPrompt,
  parseFileSelectionResponse,
  parseCodeFiles,
  runBackTests,
  buildAutoFixPrompt
};
