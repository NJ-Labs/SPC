# Patched SheetJS package

`xlsx-0.20.3.tgz` is the unmodified official SheetJS Community Edition distribution downloaded from:

https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz

SHA-256: `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`

License: Apache-2.0; a copy from the distribution is in `SHEETJS-LICENSE.txt`. The package includes its own license and notices.

The npm registry's `xlsx` release remains at 0.18.5 and has known vulnerabilities. Version 0.20.3 fixes the reported prototype pollution and regular-expression denial-of-service issues. This local, pinned tarball also keeps corporate installations from depending on a separately trusted CDN. npm records its SHA-512 integrity in `package-lock.json`.

To update: obtain a newer official release with TLS verification enabled, verify its package metadata and license, record its checksum here, and update the local file dependency in `package.json` and lockfile. Run the workbook worker regressions, full frontend tests, build, and `npm audit`.
