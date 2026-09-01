# Zorg dat de hooks de Node uit .nvmrc gebruiken, niet die van de aanroepende shell.
#
# Git-hooks erven de omgeving van wat de commit doet: een terminal die al open stond vóór
# een `nvm install`, of de Git-knop in een editor die nvm nooit heeft ingeladen. Sinds
# `engines.node` in package.json staat, faalt pnpm daar hard op — een blokkerende commit
# die niets met de wijziging te maken heeft.
#
# Best effort: bestaat nvm niet, dan doen we niets en loopt de hook zoals hij altijd liep.
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" --no-use
  nvm use >/dev/null 2>&1 || true
fi
