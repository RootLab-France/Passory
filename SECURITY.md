# Politique de sécurité

Passory est un gestionnaire de mots de passe. Une faille dans ce logiciel peut exposer tout ce
qu'une personne y a confié. Les signalements sont donc pris au sérieux et traités en priorité.

## Signaler une vulnérabilité

Écrivez à **dpsi@rootlab.fr**, en français ou en anglais.

Merci de **ne pas ouvrir d'issue publique** pour une faille de sécurité, et de nous laisser le
temps de corriger avant toute publication.

Un rapport utile contient :

- la version de Passory et le système d'exploitation ;
- les étapes pour reproduire, aussi précises que possible ;
- l'impact que vous estimez, même approximativement ;
- toute preuve de concept, s'il y en a une.

## Ce à quoi vous pouvez vous attendre

Nous **visons** un accusé de réception sous 72 heures et une première évaluation sous 7 jours,
indiquant la sévérité retenue et si nous confirmons le problème. RootLab est une association
bénévole : ce sont des objectifs que nous nous donnons, pas un engagement contractuel.

Une faille élevée ou critique passe avant tout le reste, et le correctif est publié dès qu'il est
prêt. Votre nom est cité dans les remerciements de la version corrigée, si vous le souhaitez.

RootLab est une association loi 1901 sans ressources dédiées à cela : **nous n'offrons aucune
récompense financière**. Nous le disons franchement plutôt que de laisser espérer.

## Périmètre

Concerné : l'application de bureau, l'application Android, le protocole de transfert PCTP, le
format de coffre et de sauvegarde, et la chaîne de construction de ce dépôt.

Hors périmètre : une machine déjà compromise par un logiciel malveillant, un attaquant disposant
d'un accès physique à une session déverrouillée, et les services tiers que nous n'opérons pas.

## Limites connues

Elles sont documentées et assumées, inutile de les signaler : absence d'audit par un tiers
indépendant, absence de signature de code sur l'installeur Windows à ce jour, métadonnées
(types d'entrées, dates) non masquées dans le coffre.

## Versions suivies

Seule la dernière version publiée reçoit des correctifs de sécurité.
