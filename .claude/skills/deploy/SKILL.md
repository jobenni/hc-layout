---
name: deploy
description: Ship the work in progress of the Canary channel to the Stable channel. It squash-merges the `canary` branch into `main` as one Conventional Commit, pushes `main`, then realigns `canary` on `main`. Use when Johan says "déploie", "déployer", "mets en prod", "passe en stable", "ship", "deploy", or invokes /deploy.
---

# Déployer Canary vers Stable

Deux canaux de mise à jour (Réglages › Mise à jour) : **Stable** suit `main`, **Canary** suit `canary`. Le développement se fait sur `canary` ; déployer, c'est faire de tout ce qui est sur `canary` un seul commit sur `main`.

« Déploie » vaut accord pour pousser `main` et réécrire `canary` sur `origin`. Ne demande rien de plus, sauf si une étape ci-dessous dit de s'arrêter.

## 1. Partir d'un état sûr

```bash
git status --porcelain          # doit être vide
git fetch origin --prune
```

- Arbre de travail sale : arrête-toi et montre ce qui n'est pas commité. Ne commite rien à la place de Johan.
- `git switch canary`. Si le `canary` local diffère d'`origin/canary` :
  - en avance seulement (`git rev-list --count origin/canary..canary` > 0, l'inverse = 0) : `git push origin canary` ;
  - en retard seulement : `git merge --ff-only origin/canary` ;
  - divergé : arrête-toi et explique.

## 2. Absorber ce qui a été poussé directement sur main

```bash
git rebase origin/main
```

En cas de conflit : `git rebase --abort`, arrête-toi et liste les fichiers en conflit. Après un rebase qui a réécrit quelque chose, `git push --force-with-lease origin canary`.

## 3. Vérifier qu'il y a quelque chose à déployer

```bash
git log --oneline origin/main..canary
```

Vide : réponds « rien à déployer » et arrête-toi.

Lance `herdr-app check mods/<mod>` sur chaque mod modifié (`git diff --name-only origin/main..canary -- mods/`). Un échec : arrête-toi.

## 4. Squash dans main

```bash
git switch main
git merge --ff-only origin/main
git merge --squash canary
```

Rédige un seul message [Conventional Commits](https://www.conventionalcommits.org/fr/v1.0.0/), en anglais, à l'impératif (règles du `CLAUDE.md`) :

- Le type et la portée viennent du changement principal (`feat` s'il y a au moins une fonctionnalité). Plusieurs zones sans dominante : pas de portée.
- Le corps explique le comportement visible, puis liste les commits de `canary` livrés (`- <sujet>`).
- `!` et un pied `BREAKING CHANGE:` si l'un d'eux en portait.
- Termine par la ligne `Co-Authored-By` demandée par la session.

```bash
git commit -F <fichier-du-message>
git push origin main
```

## 5. Réaligner canary sur main

Le squash laisse `canary` avec des commits que `main` n'a pas : sans réalignement, le prochain déploiement réappliquerait tout.

```bash
git diff --quiet main canary    # doit réussir : même contenu
git switch canary
git reset --hard main
git push --force-with-lease origin canary
```

Si le `diff` n'est pas vide, ne réinitialise rien : arrête-toi et montre la différence.

## 6. Finir

Reste sur `canary`. Réponds en une ou deux lignes : le commit créé sur `main` (hash court et titre) et le nombre de commits de `canary` qu'il regroupe. Les installations Stable verront la mise à jour à leur prochaine vérification (une minute au plus).
