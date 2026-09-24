import { loadCatalog } from './catalog.mjs';

const catalog = await loadCatalog(process.argv[2]);
console.log(JSON.stringify(catalog.publicCatalog, null, 2));
