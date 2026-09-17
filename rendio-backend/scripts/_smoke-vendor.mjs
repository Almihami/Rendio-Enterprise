// REQUIERE jsdom: cd rendio-backend && npm install --no-save jsdom
//
// Comprueba que las librerías LOCALES de /vendor definen los globales que la app
// espera. Nace del 25-ago: dev seguía cargándolas de un CDN y cuando el CDN no
// respondía la app salía cruda — el jefe abrió el enlace y vio una pantalla gris
// con dos letras gigantes.
import { JSDOM } from 'jsdom';
import { readFileSync, existsSync } from 'fs';
const APP='../rendio-turnos/';
let ok=0,bad=0; const t=(n,c,d='')=>{if(c){ok++;console.log('  ✓ '+n)}else{bad++;console.log('  ✗ '+n+(d?' → '+d:''))}};

// 1. index.html no puede pedirle nada a un CDN de terceros.
const html=readFileSync(APP+'index.html','utf8');
const fuera=[...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m=>m[1])
  .filter(u=>!u.includes('fonts.googleapis.com') && !u.includes('fonts.gstatic.com'));
t('index.html no carga scripts ni estilos de un CDN', fuera.length===0, fuera.join(' · '));

// 2. Los archivos existen.
const libs=['vendor/tailwind-3.4.17.js','vendor/supabase-js-2.111.0.min.js','vendor/exceljs-4.4.0.min.js',
  'vendor/leaflet/leaflet.js','vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png','vendor/leaflet/images/marker-shadow.png'];
for(const l of libs) t('existe '+l, existsSync(APP+l));

// 3. Y definen lo que la app busca.
// runScripts:'dangerously' es imprescindible: sin él jsdom NO ejecuta los
// <script> que se insertan, y la prueba diría que ninguna librería define nada.
const dom=new JSDOM('<!doctype html><html><head></head><body></body></html>',{runScripts:'dangerously',pretendToBeVisual:true,url:'http://localhost/'});
const w=dom.window;
const cargar=(f)=>{ const s=w.document.createElement('script'); s.textContent=readFileSync(APP+f,'utf8'); w.document.head.appendChild(s); };
try { cargar('vendor/supabase-js-2.111.0.min.js'); } catch(e){}
t('supabase-js define window.supabase.createClient', typeof w.supabase?.createClient==='function');
try { cargar('vendor/leaflet/leaflet.js'); } catch(e){}
t('leaflet define window.L con map()', typeof w.L?.map==='function');
try { cargar('vendor/tailwind-3.4.17.js'); } catch(e){}
t('tailwind define window.tailwind.config', !!w.tailwind && 'config' in w.tailwind, typeof w.tailwind);

// 4. El service worker tiene que guardarlas, o al segundo arranque sin red vuelve el problema.
const sw=readFileSync(APP+'sw.js','utf8');
for(const l of ['vendor/tailwind-3.4.17.js','vendor/supabase-js-2.111.0.min.js','vendor/leaflet/leaflet.js','vendor/leaflet/leaflet.css'])
  t('el service worker cachea '+l.split('/').pop(), sw.includes("'/"+l+"'"));

console.log(`\n${ok}/${ok+bad} pasaron${bad?' · '+bad+' FALLARON':''}`);
process.exit(bad?1:0);
