# Local of ScreenFlow Dynamic

Sujet : Application SaaS de Digital Signage (Affichage Dynamique)

Instructions : Peux-tu créer une application complète d'affichage dynamique avec un Dashboard Administrateur et une vue "Player" ?

1. Interface & Design : > * Utilise Tailwind CSS et des composants Radix UI/Shadcn.

Design moderne, sombre (Dark Mode) pour le dashboard.

Le Dashboard doit permettre de gérer les écrans et le contenu.

2. Fonctionnalités du Dashboard :

Gestion de contenu : Un module d'upload pour Images (JPG, PNG) et Vidéos (MP4). Ajoute un emplacement pour les liens d'intégration (iFrame) pour diffuser des présentations Google Slides ou PPT Web.

Gestion des Écrans : Une liste des écrans connectés. Pour chaque écran, je veux pouvoir :

Changer l'orientation : Portrait ou Paysage (via une rotation CSS de la vue player).

Sélectionner la playlist ou le média à diffuser.

Voir le statut (En ligne/Hors ligne).

3. Le Mode "Player" (Affichage) :

Crée une route /player/:id qui affiche le contenu en plein écran.

Le contenu doit s'adapter automatiquement (object-cover) à l'orientation choisie (Paysage/Portrait).

Ajoute une transition fluide entre les médias.

4. Stack Technique : > * Utilise Supabase pour le stockage des fichiers (Buckets) et la base de données (table screens et media).

Gestion de l'état en temps réel pour que, si je change l'orientation sur le dashboard, l'écran tourne instantanément sans rafraîchir la page.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/4ea0ea4e-f0bc-4055-aade-2e845f4790d1).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
