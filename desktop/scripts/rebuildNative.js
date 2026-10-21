const { rebuild } = require('@electron/rebuild');

// Las pruebas con Node pueden reemplazar el binario sin invalidar la marca
// de electron-rebuild. Forzar la reconstrucción evita empaquetar esa ABI vieja.
module.exports = async ({ appDir, electronVersion, platform, arch }) => {
  await rebuild({
    buildPath: appDir,
    electronVersion,
    platform: platform.nodeName,
    arch,
    force: true,
    onlyModules: ['better-sqlite3'],
  });
  // Mantener el tratamiento habitual de dependencias de electron-builder para
  // que también las incluya en el archivo ASAR.
  return true;
};
