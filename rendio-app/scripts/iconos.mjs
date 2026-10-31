// Íconos y pantalla de carga de la app, desde la marca de Rendio (el avión con
// el punto naranja de rendio-turnos/assets/logo-icon.svg): node scripts/iconos.mjs
//
// Escribe directo en android/ e ios/ (los mismos nombres que trae Capacitor) y
// deja en recursos/ lo que piden las tiendas: ícono de 512 para Play y el
// gráfico destacado de 1024×500. Volver a correrlo si cambia el logo.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEGRO = '#0A0A0A';

// La marca sola, en la caja de 48 de logo-icon.svg, sin el círculo negro.
const MARCA = `<circle cx="9" cy="24" r="4" fill="#F4791F"/>
  <path d="M 9,22 L 38,18 L 41,14 L 43,15 L 42,21 L 44,22 L 44,26 L 42,27 L 43,33 L 41,34 L 38,30 L 9,26 Z"
        fill="#FFFFFF" transform="rotate(-12, 24, 24)"/>`;

// k = qué tanto de la caja ocupa la marca (1 = como en el logo).
function svg({ fondo = NEGRO, forma = 'cuadro', k = 1 } = {}) {
  const base = forma === 'circulo' ? `<circle cx="24" cy="24" r="24" fill="${fondo}"/>`
    : fondo ? `<rect width="48" height="48" fill="${fondo}"/>` : '';
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${base}
    <g transform="translate(24 24) scale(${k}) translate(-24 -24)">${MARCA}</g></svg>`);
}
// opaco: sin canal alfa (Apple rechaza íconos con transparencia).
async function png(buf, lado, destino, opaco = false) {
  mkdirSync(dirname(destino), { recursive: true });
  let img = sharp(buf, { density: 72 * Math.ceil(lado / 48) }).resize(lado, lado);
  if (opaco) img = img.flatten({ background: NEGRO }).removeAlpha();
  await img.png().toFile(destino);
}
// Pantalla de carga: negro con la marca al centro, del tamaño que ya tenga el archivo.
async function splash(destino, ancho, alto) {
  const lado = Math.round(Math.min(ancho, alto) * 0.28);
  const marca = await sharp(svg({ fondo: null, k: 1 }), { density: 72 * Math.ceil(lado / 48) }).resize(lado, lado).png().toBuffer();
  await sharp({ create: { width: ancho, height: alto, channels: 4, background: NEGRO } })
    .composite([{ input: marca, gravity: 'center' }]).png().toFile(destino);
}

const res = join(raiz, 'android/app/src/main/res');
const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

// iPhone: un solo ícono de 1024, cuadrado y sin transparencia (iOS redondea las puntas).
await png(svg({ k: 0.86 }), 1024, join(raiz, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'), true);
for (const n of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  await splash(join(raiz, 'ios/App/App/Assets.xcassets/Splash.imageset', n), 2732, 2732);
}

// Android: el clásico (cuadrado y redondo) y el adaptable (frente transparente
// sobre fondo negro; la marca dentro de la zona segura del 66 %).
for (const [d, f] of Object.entries(dens)) {
  await png(svg({ k: 0.86 }), Math.round(48 * f), join(res, `mipmap-${d}/ic_launcher.png`));
  await png(svg({ forma: 'circulo', k: 0.86 }), Math.round(48 * f), join(res, `mipmap-${d}/ic_launcher_round.png`));
  await png(svg({ fondo: null, k: 0.58 }), Math.round(108 * f), join(res, `mipmap-${d}/ic_launcher_foreground.png`));
}
// Las pantallas de carga que trae la plantilla, conservando sus medidas.
const splashes = ['drawable', ...['port', 'land'].flatMap((o) => Object.keys(dens).map((d) => `drawable-${o}-${d}`))];
for (const carpeta of splashes) {
  const p = join(res, carpeta, 'splash.png');
  const { width, height } = await sharp(p).metadata();
  await splash(p, width, height);
}

// Para las tiendas.
await png(svg({ k: 0.86 }), 512, join(raiz, 'recursos/play-icono-512.png'), true);
await png(svg({ k: 0.86 }), 1024, join(raiz, 'recursos/appstore-icono-1024.png'), true);
const logo = await sharp(join(raiz, '../rendio-turnos/assets/logo-enterprise.png')).resize({ width: 640 }).png().toBuffer();
// Fondo blanco: el logo completo es de letra negra.
await sharp({ create: { width: 1024, height: 500, channels: 3, background: '#FFFFFF' } })
  .composite([{ input: logo, gravity: 'center' }]).png().toFile(join(raiz, 'recursos/play-grafico-destacado-1024x500.png'));
console.log('íconos listos');
