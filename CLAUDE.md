# hc-layout

## Appliquer en live à la fin de chaque tour

Le Herdr qui tourne charge les mods depuis `~/.config/herdr-app/mods/<mod>/`, pas depuis ce dépôt. À la fin de chaque tour qui modifie un mod, copie les fichiers changés de `mods/<mod>/` vers `~/.config/herdr-app/mods/<mod>/` :

1. Compare la copie live au `HEAD` du dépôt. Si elle diffère, elle a été modifiée à la main : demande avant de l'écraser.
2. Sauvegarde le fichier live en `<fichier>.bak-<sujet>-<AAAAMMJJ>` à côté de lui.
3. Copie le fichier, puis vérifie avec `diff -q` qu'il est identique à celui du dépôt.

## Messages de commit

Suis [Conventional Commits](https://www.conventionalcommits.org/fr/v1.0.0/) : `<type>(<portée>): <description>`, en anglais, à l'impératif.

- Types : `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Portée : la zone touchée, en minuscules (`sidebar`, `issues`, `cards`, `workflows`, `settings`…).
- Le corps explique le pourquoi et le comportement visible ; un changement incompatible porte `!` après la portée et un pied `BREAKING CHANGE:`.
