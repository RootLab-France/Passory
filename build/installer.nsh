; installer.nsh — personnalisation du desinstalleur NSIS de Passory.
;
; A la desinstallation, Passory demande si les donnees personnelles doivent
; etre effacees. Par defaut elles sont CONSERVEES : desinstaller un
; gestionnaire de mots de passe ne doit pas detruire l'unique copie du
; coffre de quelqu'un. L'utilisateur choisit explicitement.
;
; La question n'est pas posee lors d'une mise a jour (${isUpdated}).

!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Supprimer egalement vos donnees Passory ?$\r$\n$\r$\nVotre coffre chiffre, vos reglages et les fichiers temporaires de l'application seront definitivement effaces.$\r$\n$\r$\nRepondez Non si vous comptez reinstaller Passory ou si vous n'avez pas d'autre sauvegarde." \
      /SD IDNO IDNO PassoryGarderDonnees

      ; Coffre, reglages et profil Chromium de l'application.
      RMDir /r "$APPDATA\Passory"
      ; Cache de l'updater (nom courant et ancien nom).
      RMDir /r "$LOCALAPPDATA\passory-updater"
      RMDir /r "$LOCALAPPDATA\passory-desktop-windows-app-updater"
      ; Dossier local eventuel.
      RMDir /r "$LOCALAPPDATA\Passory"

    PassoryGarderDonnees:
  ${endIf}
!macroend
