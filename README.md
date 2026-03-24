# 🏗️ Prestige Build Pro

**Solution professionnelle de génération de sites web par Intelligence Artificielle**

> Développé par **Glody Dimputu Ngola** pour **Prestige Technologie Compagnie**

---

## 📋 Description

**Prestige Build Pro** est une plateforme SaaS innovante permettant la création automatisée de sites web professionnels grâce à l'intelligence artificielle Claude d'Anthropic. Conçue pour les agences de digitalisation et les équipes de développement, elle offre une interface intuitive pour générer, prévisualiser et déployer des projets web complets en quelques minutes.

## ✨ Fonctionnalités Principales

### 🤖 Génération IA Avancée
- **Génération depuis brief textuel** : Décrivez votre projet et l'IA génère le code complet
- **Génération depuis image** : Importez une maquette ou capture d'écran et reproduisez le design automatiquement
- **Détection automatique du secteur** : Santé, Restaurant, E-commerce, Corporate, SaaS, Éducation, Immobilier, Hôtellerie, Portfolio, ONG, Dashboard, Fitness
- **Contenu contextuel** : Génération automatique de textes, témoignages, tarifs adaptés au secteur

### 👁️ Prévisualisation Instantanée
- **Preview en temps réel** : Visualisez le résultat instantanément
- **Support multi-framework** : HTML, React (CDN), Vue (CDN)
- **Mode responsive** : Testez sur Desktop, Tablette et Mobile
- **Console d'erreurs** : Debugging intégré avec affichage des erreurs JavaScript

### 🚀 Déploiement et Publication
- **Publication en un clic** : Déployez sur un sous-domaine personnalisé
- **QR Code automatique** : Partagez facilement avec les clients
- **Analytics intégrés** : Suivi des visites, clics et formulaires

### 👥 Collaboration en Temps Réel
- **SSE (Server-Sent Events)** : Notifications en direct
- **Multi-utilisateurs** : Support admin et agents
- **Historique des versions** : Restauration facile des versions précédentes

### 🎨 Mode Présentation Client
- **Présentation guidée** : Présentez le projet aux clients de manière professionnelle
- **Narration automatique** : Descriptions de chaque section
- **Approbation intégrée** : Le client peut approuver et publier directement

## 🛠️ Stack Technique

| Composant | Technologie |
|-----------|-------------|
| **Backend** | Node.js (HTTP natif) |
| **Base de données** | SQLite (better-sqlite3) |
| **Authentification** | JWT (jsonwebtoken) |
| **Hachage** | bcryptjs |
| **IA** | Claude (Anthropic API) |
| **Frontend** | HTML/CSS/JavaScript vanilla |
| **Container** | Docker |

## 📁 Structure du Projet

```
prestige-build-pro/
├── server.js              # Serveur HTTP principal avec toutes les API
├── package.json           # Dépendances NPM
├── Dockerfile             # Configuration Docker
├── src/
│   ├── ai.js              # Système IA professionnel avec détection de secteur
│   └── compiler.js        # Moteur de compilation et build de projets
├── public/
│   └── index.html         # Interface SPA complète (frontend)
├── scripts/
│   └── watch-proxy.sh     # Script de monitoring de santé Caddy
└── ptc-logo-transparent.png
```

## 🚀 Installation

### Prérequis
- Node.js >= 18.0.0
- npm ou yarn
- Clé API Anthropic (Claude)

### Installation locale

```bash
# Cloner le repository
git clone https://github.com/ngolaglodi-byte/prestige-build-pro.git
cd prestige-build-pro

# Installer les dépendances
npm install

# Configurer les variables d'environnement
export ANTHROPIC_API_KEY="votre_clé_api"
export JWT_SECRET="votre_secret_jwt"
export PORT=3000

# Démarrer le serveur
npm start
```

### Déploiement Docker

```bash
# Construire l'image
docker build -t prestige-build-pro .

# Exécuter le conteneur
docker run -d \
  -p 3000:3000 \
  -v prestige-data:/data \
  -e ANTHROPIC_API_KEY="votre_clé_api" \
  -e JWT_SECRET="votre_secret_jwt" \
  -e PUBLISH_DOMAIN="votre-domaine.com" \
  prestige-build-pro
```

## ⚙️ Configuration

### Variables d'Environnement

| Variable | Description | Défaut |
|----------|-------------|--------|
| `PORT` | Port du serveur | 3000 |
| `ANTHROPIC_API_KEY` | Clé API Claude | - |
| `JWT_SECRET` | Secret pour les tokens JWT | Auto-généré |
| `DB_PATH` | Chemin de la base SQLite | ./prestige-pro.db |
| `PREVIEWS_DIR` | Répertoire des previews | /tmp/previews |
| `BUILDS_DIR` | Répertoire des builds | /tmp/pb-builds |
| `SITES_DIR` | Répertoire des sites publiés | /data/sites |
| `PUBLISH_DOMAIN` | Domaine de publication | prestige-build.dev |
| `PUBLIC_URL` | URL publique de l'application | - |

## 🔐 Comptes par Défaut

| Email | Mot de passe | Rôle |
|-------|--------------|------|
| admin@prestige-build.dev | Admin2026! | Admin |

> ⚠️ **Important** : Changez le mot de passe administrateur en production !

## 📡 API Endpoints

### Authentification
- `POST /api/login` - Connexion utilisateur

### Projets
- `GET /api/projects` - Liste des projets
- `POST /api/projects` - Créer un projet
- `GET /api/projects/:id` - Détails d'un projet
- `PUT /api/projects/:id` - Mettre à jour un projet
- `DELETE /api/projects/:id` - Supprimer un projet
- `POST /api/projects/:id/publish` - Publier un projet

### Génération IA
- `POST /api/generate/stream` - Générer du code (streaming SSE)
- `POST /api/generate/image` - Générer depuis une image (streaming SSE)

### Preview & Build
- `POST /api/preview/:id/refresh` - Rafraîchir le preview
- `POST /api/compile` - Compiler un projet
- `GET /api/builds/:id` - Statut d'un build

### Versioning
- `GET /api/projects/:id/versions` - Historique des versions
- `POST /api/projects/:id/versions/:vid/restore` - Restaurer une version

### Analytics
- `GET /api/projects/:id/analytics` - Statistiques du projet
- `POST /api/track/:id` - Enregistrer un événement analytics

### Collaboration
- `GET /api/projects/:id/stream` - SSE pour collaboration temps réel

### Administration
- `GET /api/users` - Liste des utilisateurs
- `POST /api/users` - Créer un utilisateur
- `DELETE /api/users/:id` - Supprimer un utilisateur
- `GET /api/apikeys` - Liste des clés API
- `POST /api/apikeys` - Ajouter une clé API

### Utilitaires
- `GET /health` - Vérification de santé
- `GET /api/stats` - Statistiques globales

## 🔒 Sécurité

- **Authentification JWT** avec expiration 7 jours
- **Validation des chemins** pour prévenir les traversées de répertoire
- **Sanitization des sous-domaines** pour éviter les injections
- **Hachage bcrypt** pour les mots de passe
- **CORS** configuré pour les requêtes cross-origin

## 📊 Secteurs Supportés

Le système détecte automatiquement le secteur d'activité et adapte :
- La palette de couleurs
- La typographie
- Les sections recommandées
- Le ton et le style du contenu

**Secteurs disponibles :**
1. 🏥 Santé (Médecins, Cliniques, Pharmacies)
2. 🍽️ Restaurant (Cafés, Bistros, Traiteurs)
3. 🛒 E-commerce (Boutiques, Ventes en ligne)
4. 🏢 Corporate (Entreprises, Cabinets, Agences)
5. 💻 SaaS (Applications, Startups tech)
6. 📚 Éducation (Écoles, Formations)
7. 🏠 Immobilier (Agences, Locations)
8. 🏨 Hôtellerie (Hôtels, Tourisme)
9. 🎨 Portfolio (Créatifs, Photographes)
10. 💚 ONG (Associations, Fondations)
11. 📊 Dashboard (Admin, Gestion interne)
12. 💪 Fitness (Sport, Coaching)

## 🤝 Support

Pour toute question ou assistance technique, contactez Prestige Technologie Compagnie.

## 📄 Licence

Logiciel propriétaire - Usage réservé aux clients de Prestige Technologie Compagnie.

---

<div align="center">

**Prestige Build Pro** — Créez des sites web professionnels avec l'IA

*Développé par* **Glody Dimputu Ngola**

---

© 2024-2026 **Prestige Technologie Compagnie**. Tous droits réservés.

</div>
