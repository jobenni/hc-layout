# hc-layout

Le layout Herdr « benni » et ses mods. L'API des mods est décrite dans `~/.config/herdr-app/AGENTS.md` et `herdr.d.ts` : lis-les avant d'appeler une fonction `herdr` que tu ne connais pas.

## Après chaque modification d'un mod

1. `herdr-app check mods/<mod>` doit passer.
2. **Mets `RECIPE.md` à jour** dans le même commit : c'est le brief à partir duquel un autre agent reconstruit le layout, donc tout ce qui se voit, se clique ou s'appelle (`herdr`, programmes, art, localStorage) doit y être, avec les valeurs exactes. Format : section « RECIPE.md » de `AGENTS.md`.
3. **Applique en live à la fin du tour.** Le Herdr qui tourne charge `~/.config/herdr-app/mods/<mod>/`, pas ce dépôt. Pour chaque fichier modifié :
   - compare la copie live au `HEAD` du dépôt ; si elle diffère, elle a été modifiée à la main : demande avant de l'écraser ;
   - sauvegarde-la en `<fichier>.bak-<sujet>-<AAAAMMJJ>` à côté ;
   - copie le fichier, puis vérifie avec `diff -q`.

## Branches et canaux

Réglages › Mise à jour propose **Stable** (suit `main`) et **Canary** (suit `canary`). Développe et pousse sur `canary` ; « déploie » lance le skill `deploy`.

## Messages de commit

[Conventional Commits](https://www.conventionalcommits.org/fr/v1.0.0/), en anglais, à l'impératif. Portée : la zone touchée, en minuscules (`sidebar`, `issues`, `cards`, `workflows`, `settings`…). Le corps explique le pourquoi et le comportement visible.
