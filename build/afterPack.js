// Runs after electron-builder lays out the app folder.
// Windows: set the exe icon + version info without wine (resedit is pure JS).
// macOS: ad-hoc sign the bundle with rcodesign (codesign isn't available on Linux).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async (ctx) => {
  const name = ctx.packager.appInfo.productFilename;
  if (ctx.electronPlatformName === 'win32') {
    const ResEdit = await require('resedit/cjs').load();
    const exePath = path.join(ctx.appOutDir, `${name}.exe`);
    const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
    const res = ResEdit.NtExecutableResource.from(exe);
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
    const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
    const target = groups[0] || { id: 1, lang: 1033 };
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries, target.id, target.lang, iconFile.icons.map((i) => i.data));
    const vis = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
    if (vis.length) {
      const vi = vis[0];
      const langs = vi.getAllLanguagesForStringValues();
      const lang = langs[0] || { lang: 1033, codepage: 1200 };
      vi.setStringValues(lang, {
        FileDescription: 'Claude 桌宠',
        ProductName: 'ClaudePet',
        CompanyName: 'Fan-made',
        OriginalFilename: `${name}.exe`,
        InternalName: name,
        LegalCopyright: 'Fan-made, non-commercial',
      });
      const v = ctx.packager.appInfo.version.split('.').map(Number);
      vi.setFileVersion(v[0], v[1], v[2], 0, lang.lang);
      vi.setProductVersion(v[0], v[1], v[2], 0, lang.lang);
      vi.outputToResourceEntries(res.entries);
    }
    res.outputResource(exe);
    fs.writeFileSync(exePath, Buffer.from(exe.generate()));
    console.log('  • afterPack: exe icon/version set');
  }
  if (ctx.electronPlatformName === 'darwin') {
    const app = path.join(ctx.appOutDir, `${name}.app`);
    const rc = process.env.RCODESIGN;
    if (rc && fs.existsSync(rc)) {
      execFileSync(rc, ['sign', app], { stdio: 'inherit' });
      console.log('  • afterPack: ad-hoc signed', app);
    } else {
      console.log('  • afterPack: RCODESIGN not set, bundle left unsigned');
    }
  }
};
