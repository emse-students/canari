### Fixed - un `bun install` dans un worktree desarmait les hooks de tous les autres

`core.hooksPath` vit dans le repertoire git COMMUN, partage par chaque `git worktree`, et
l'installeur ecrivait un chemin ABSOLU : `findGitRoot` s'arrete sur un worktree, dont le `.git` est
un FICHIER. Une installation dans un worktree repointait donc les hooks du depot entier vers lui, et
une fois ce worktree disparu git n'executait plus aucun hook - sans rien dire. Quatrieme occurrence
le 2026-09-24, chacune trouvee par hasard, parce que la post-condition ne demandait que "non vide",
ce qu'un chemin absolu satisfait.
[development](docs/wiki/development.md#corehookspath-is-shared-by-every-worktree-and-must-stay-relative).
